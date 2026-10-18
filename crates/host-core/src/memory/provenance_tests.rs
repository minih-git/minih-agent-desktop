//! Provenance tests: which messages may stand in for something the user said
//! (ADR agent-long-term-memory §3).

use rusqlite::params;

use super::model::*;
use super::tests::{created, open, project_dir, rejection_of, request, session_with_message};
use crate::db::Database;

fn ui(role: &str, content: &str) -> crate::sessions::UiMessage {
    serde_json::from_value(serde_json::json!({
        "id": uuid::Uuid::new_v4().to_string(),
        "role": role,
        "content": content,
        "createdAt": crate::db::ms_to_ts(crate::db::now_ms()),
    }))
    .unwrap()
}

/// A real agent-to-agent delivery into `target`: the queued ledger record, the
/// turn it owns, and the user-role transcript row the delivery path appends for
/// it. Returns that row's message id.
///
/// Nothing here writes the transcript by hand: the point of the test it serves is
/// that the delivered row looks like a user message to a naive provenance check.
fn delivered_message(db: &Database, source: &str, target: &str) -> String {
    let sent = crate::session_collaboration::handle(
        db,
        "session.collaboration.send",
        &serde_json::json!({
            "sourceSessionId": source,
            "sessionId": target,
            "pluginId": "pi.session-orchestrator",
            "content": "Review the change",
            "idempotencyKey": "memory-provenance",
            "kind": "task"
        }),
    )
    .unwrap();
    let message_id = sent["message"]["id"].as_str().unwrap().to_string();
    let turn =
        crate::session_collaboration::begin_turn(db, target, &message_id, None, None).unwrap();
    crate::sessions::append_message(db, target, &ui("user", "Review the change"), Some(&turn))
        .unwrap();
    let id: String = db
        .conn()
        .query_row(
            "SELECT id FROM messages WHERE session_id = ?1 AND turn_id = ?2",
            params![target, turn],
            |row| row.get(0),
        )
        .unwrap();
    id
}

// ---- provenance ------------------------------------------------------------

#[test]
fn preference_requires_a_user_message_of_its_own_session() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(&dir);
    let project = project_dir(&dir, "app");
    let scope = db.learned_memory_scope_for_path(&project).unwrap();
    let user_session = session_with_message(&db, &project, "u1", "user");
    let tool_session = session_with_message(&db, &project, "t1", "tool");
    let assistant_session = session_with_message(&db, &project, "a1", "assistant");

    // Tool output, assistant text, another session's message, and no citation at
    // all are all refused.
    for (session_id, message_id) in [
        (tool_session.as_str(), "t1"),
        (assistant_session.as_str(), "a1"),
        (user_session.as_str(), "a1"),
    ] {
        let mut write = request(
            &scope,
            KIND_PREFERENCE,
            "Prefers terse replies.",
            ORIGIN_EXPLICIT,
        );
        write.source_session_id = Some(session_id.to_string());
        write.source_message_ids = vec![message_id.to_string()];
        let outcome = db.create_memory_entry(write).unwrap();
        assert_eq!(
            rejection_of(&outcome).code,
            REJECT_PROVENANCE_REQUIRED,
            "{session_id}/{message_id} must not support a preference"
        );
    }
    let mut uncited = request(
        &scope,
        KIND_PREFERENCE,
        "Prefers terse replies.",
        ORIGIN_EXPLICIT,
    );
    uncited.source_session_id = Some(user_session.clone());
    assert_eq!(
        rejection_of(&db.create_memory_entry(uncited).unwrap()).code,
        REJECT_PROVENANCE_REQUIRED
    );

    // The user's own message is the evidence a preference needs.
    let mut cited = request(
        &scope,
        KIND_PREFERENCE,
        "Prefers terse replies.",
        ORIGIN_EXPLICIT,
    );
    cited.source_session_id = Some(user_session.clone());
    cited.source_message_ids = vec!["u1".to_string()];
    let entry = created(db.create_memory_entry(cited).unwrap());
    assert_eq!(entry.kind, KIND_PREFERENCE);
    assert_eq!(entry.source_message_ids, vec!["u1".to_string()]);
    assert_eq!(entry.origin, ORIGIN_EXPLICIT);
    assert_eq!(entry.revision, 1);

    // A tool-role message never supports a preference, but a fact may be
    // recorded as verified.
    let mut verified = request(&scope, KIND_FACT, "The host is Rust.", ORIGIN_USER_UI);
    verified.evidence = EVIDENCE_VERIFIED.to_string();
    created(db.create_memory_entry(verified).unwrap());
    let mut wrong_kind = request(&scope, KIND_REFERENCE, "See the runbook.", ORIGIN_USER_UI);
    wrong_kind.evidence = EVIDENCE_INFERRED.to_string();
    created(db.create_memory_entry(wrong_kind).unwrap());
}

/// A delivered agent message is stored with role `user`, so only the delivery
/// ledger distinguishes it from something the user typed. Every cited message
/// must qualify, not merely one of them.
#[test]
fn a_delivered_message_never_supports_a_preference() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(&dir);
    let project = project_dir(&dir, "app");
    let scope = db.learned_memory_scope_for_path(&project).unwrap();
    let sender = session_with_message(&db, &project, "s1", "user");
    let target = session_with_message(&db, &project, "u1", "user");
    let delivered = delivered_message(&db, &sender, &target);

    // The delivered row is a user-role message in the cited session, and the
    // naive check accepted it.
    let role: String = db
        .conn()
        .query_row(
            "SELECT role FROM messages WHERE id = ?1 AND session_id = ?2",
            params![delivered, target],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(role, "user");

    let mut write = request(
        &scope,
        KIND_PREFERENCE,
        "Prefers terse replies.",
        ORIGIN_EXPLICIT,
    );
    write.source_session_id = Some(target.clone());
    write.source_message_ids = vec![delivered.clone()];
    let outcome = db.create_memory_entry(write).unwrap();
    let rejection = rejection_of(&outcome);
    assert_eq!(rejection.code, REJECT_PROVENANCE_REQUIRED);
    assert!(
        !rejection.message.contains("Review the change"),
        "a refusal never repeats the cited text: {}",
        rejection.message
    );

    // The user's own message in the same session still qualifies.
    let mut own = request(
        &scope,
        KIND_PREFERENCE,
        "Prefers terse replies.",
        ORIGIN_EXPLICIT,
    );
    own.source_session_id = Some(target.clone());
    own.source_message_ids = vec!["u1".to_string()];
    created(db.create_memory_entry(own).unwrap());

    // Every cited message must qualify, so one delivered row poisons the set.
    let mut mixed = request(
        &scope,
        KIND_FEEDBACK,
        "Prefers short reviews.",
        ORIGIN_EXPLICIT,
    );
    mixed.source_session_id = Some(target.clone());
    mixed.source_message_ids = vec!["u1".to_string(), delivered];
    assert_eq!(
        rejection_of(&db.create_memory_entry(mixed).unwrap()).code,
        REJECT_PROVENANCE_REQUIRED
    );

    // A citation that names another session's message is refused too.
    let mut foreign = request(
        &scope,
        KIND_FEEDBACK,
        "Prefers short reviews.",
        ORIGIN_EXPLICIT,
    );
    foreign.source_session_id = Some(sender);
    foreign.source_message_ids = vec!["u1".to_string()];
    assert_eq!(
        rejection_of(&db.create_memory_entry(foreign).unwrap()).code,
        REJECT_PROVENANCE_REQUIRED
    );
}

/// A forked session copies its prefix with fresh ids and no turn reference, so a
/// delivered message would otherwise lose the only index evidence that separates
/// it from something the user typed.
#[test]
fn a_forked_delivery_never_supports_a_preference() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(&dir);
    let project = project_dir(&dir, "app");
    let scope = db.learned_memory_scope_for_path(&project).unwrap();
    let sender = session_with_message(&db, &project, "s1", "user");
    let source = session_with_message(&db, &project, "u1", "user");
    let delivered = delivered_message(&db, &sender, &source);
    // A session that still owns a running turn cannot be forked.
    let delivery_turn: String = db
        .conn()
        .query_row(
            "SELECT turn_id FROM messages WHERE id = ?1",
            params![delivered],
            |row| row.get(0),
        )
        .unwrap();
    db.conn()
        .execute(
            "UPDATE turns SET status = 'completed', ended_at = ?2 WHERE id = ?1",
            params![delivery_turn, crate::db::now_ms()],
        )
        .unwrap();

    let branch = match crate::sessions::fork_session_through(&db, &source, None, None).unwrap() {
        crate::sessions::ForkSessionResult::Created(detail) => detail.summary.id,
        _ => panic!("expected a forked session"),
    };
    // The copy keeps the role and the text, and the fork remaps its id.
    let (copied_id, copied_turn, copied_role): (String, Option<String>, String) = db
        .conn()
        .query_row(
            "SELECT id, turn_id, role FROM messages
             WHERE session_id = ?1 AND text = 'Review the change'",
            params![branch],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(copied_role, "user");
    assert_ne!(copied_id, delivered, "the fork remaps message ids");
    assert!(
        copied_turn.is_none(),
        "a forked prefix carries no turn reference"
    );

    let mut write = request(
        &scope,
        KIND_PREFERENCE,
        "Prefers terse replies.",
        ORIGIN_EXPLICIT,
    );
    write.source_session_id = Some(branch.clone());
    write.source_message_ids = vec![copied_id];
    let outcome = db.create_memory_entry(write).unwrap();
    let rejection = rejection_of(&outcome);
    assert_eq!(rejection.code, REJECT_PROVENANCE_REQUIRED);
    assert!(!rejection.message.contains("Review the change"));

    // A message the user writes in the branch after the fork still qualifies.
    let turn = crate::sessions::begin_turn(&db, &branch, None, None).unwrap();
    crate::sessions::append_message(
        &db,
        &branch,
        &ui("user", "Please keep replies terse"),
        Some(&turn),
    )
    .unwrap();
    let own: String = db
        .conn()
        .query_row(
            "SELECT id FROM messages WHERE session_id = ?1 AND turn_id = ?2",
            params![branch, turn],
            |row| row.get(0),
        )
        .unwrap();
    let mut accepted = request(
        &scope,
        KIND_PREFERENCE,
        "Prefers terse replies.",
        ORIGIN_EXPLICIT,
    );
    accepted.source_session_id = Some(branch);
    accepted.source_message_ids = vec![own];
    created(db.create_memory_entry(accepted).unwrap());
}

#[test]
fn verified_basis_is_refused_for_kinds_that_cannot_be_verified() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(&dir);
    let project = project_dir(&dir, "app");
    let scope = db.learned_memory_scope_for_path(&project).unwrap();
    let session = session_with_message(&db, &project, "u1", "user");
    let mut write = request(
        &scope,
        KIND_PREFERENCE,
        "Prefers terse replies.",
        ORIGIN_EXPLICIT,
    );
    write.evidence = EVIDENCE_VERIFIED.to_string();
    write.source_session_id = Some(session);
    write.source_message_ids = vec!["u1".to_string()];
    assert_eq!(
        rejection_of(&db.create_memory_entry(write).unwrap()).code,
        REJECT_PROVENANCE_REQUIRED
    );
}

/// `user_stated` is a claim about what the user said, for every kind, not only
/// for the two that must cite the user. A fact that arrived with another agent's
/// delivery is recorded as `verified` instead (ADR §3.1).
#[test]
fn a_delivered_message_never_supports_a_user_stated_fact() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(&dir);
    let project = project_dir(&dir, "app");
    let scope = db.learned_memory_scope_for_path(&project).unwrap();
    let sender = session_with_message(&db, &project, "s1", "user");
    let target = session_with_message(&db, &project, "u1", "user");
    let delivered = delivered_message(&db, &sender, &target);

    let mut fact = request(
        &scope,
        KIND_FACT,
        "The gateway deploys on Fridays.",
        ORIGIN_EXPLICIT,
    );
    fact.evidence = EVIDENCE_USER_STATED.to_string();
    fact.source_session_id = Some(target.clone());
    fact.source_message_ids = vec![delivered.clone()];
    let refused = db.create_memory_entry(fact).unwrap();
    let rejection = rejection_of(&refused);
    assert_eq!(rejection.code, REJECT_PROVENANCE_REQUIRED);
    assert!(!rejection.message.contains("Review the change"));

    // The same fact, marked as something the agent observed, is accepted: the
    // delivery is not evidence that the user said it, but it is the session the
    // agent was working in.
    let mut verified = request(
        &scope,
        KIND_FACT,
        "The gateway deploys on Fridays.",
        ORIGIN_EXPLICIT,
    );
    verified.evidence = EVIDENCE_VERIFIED.to_string();
    verified.source_session_id = Some(target.clone());
    verified.source_message_ids = vec![delivered];
    created(db.create_memory_entry(verified).unwrap());

    // A reference behaves the same way, and a fact with no delivery among its
    // citations still counts as user-stated.
    let mut own = request(&scope, KIND_FACT, "The host core is Rust.", ORIGIN_EXPLICIT);
    own.evidence = EVIDENCE_USER_STATED.to_string();
    own.source_session_id = Some(target.clone());
    own.source_message_ids = vec!["u1".to_string()];
    created(db.create_memory_entry(own).unwrap());
}
