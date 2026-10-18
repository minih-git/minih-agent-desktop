//! The explicit-write tests: what a `MemoryRemember` call may cite and store,
//! and which refusals it reports. Split from the recall tests so each file stays
//! inside the Rust module budget.

use serde_json::{json, Value};

use rusqlite::params;

use super::{error_code, open, params as tool_params, project, session};
use crate::db::Database;
use crate::rpc::memory_tools::execute;
use crate::state::AppState;

// ---- explicit remember -----------------------------------------------------

/// A running turn, the way the runtime opens one before it calls the model.
fn running_turn(db: &Database, session_id: &str) -> String {
    let id = uuid::Uuid::new_v4().to_string();
    db.conn()
        .execute(
            "INSERT INTO turns (id, session_id, status, started_at)
             VALUES (?1, ?2, 'running', ?3)",
            params![id, session_id, crate::db::now_ms()],
        )
        .unwrap();
    id
}

/// One user message of that turn, so the host has evidence to cite.
fn turn_message(db: &Database, session_id: &str, turn_id: &str, id: &str, text: &str, seq: i64) {
    db.conn()
        .execute(
            "INSERT INTO messages
               (id, session_id, turn_id, seq, role, tool_name, is_error, text, created_at, streaming)
             VALUES (?1, ?2, ?3, ?4, 'user', NULL, 0, ?5, 1, 0)",
            params![id, session_id, turn_id, seq, text],
        )
        .unwrap();
}

/// One remember call, with the turn the runtime would send.
fn remember_call(
    state: &AppState,
    session_id: &str,
    turn_id: Option<&str>,
    args: Value,
) -> (bool, Value) {
    let mut params = tool_params(session_id, "MemoryRemember", args);
    params.turn_id = turn_id.map(str::to_string);
    let result = execute(state, &params);
    (result.ok, result.content)
}

fn remember(state: &AppState, session_id: &str, turn_id: &str, args: Value) -> Value {
    let (ok, content) = remember_call(state, session_id, Some(turn_id), args);
    assert!(ok, "{content}");
    content
}

/// The stored provenance of one entry: the columns the write path owns.
fn stored_provenance(db: &Database, id: &str) -> (String, String, String, String, String) {
    db.conn()
        .query_row(
            "SELECT origin, status, source_session_id, source_message_ids, IFNULL(scope_key, '')
             FROM memory_entries WHERE id = ?1",
            params![id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .unwrap()
}

#[test]
fn remembering_stores_an_active_entry_citing_the_current_turn() {
    let (dir, state) = open();
    let project_path = project(&dir, "app");
    let session_id = session(&state.db, &project_path, "App");
    let turn = running_turn(&state.db, &session_id);
    turn_message(&state.db, &session_id, &turn, "m1", "以后都用中文回答。", 1);

    let saved = remember(
        &state,
        &session_id,
        &turn,
        json!({ "content": "Prefers terse Chinese replies.", "kind": "preference" }),
    );
    assert_eq!(saved["duplicate"], json!(false));
    assert_eq!(saved["entry"]["scope"], json!("project"));
    assert_eq!(saved["entry"]["kind"], json!("preference"));
    assert!(saved["note"]
        .as_str()
        .unwrap()
        .contains("applies from the next session"));

    let (origin, status, source_session, source_messages, scope_key) =
        stored_provenance(&state.db, saved["entry"]["id"].as_str().unwrap());
    assert_eq!(origin, "explicit");
    assert_eq!(status, "active");
    assert_eq!(source_session, session_id);
    assert!(source_messages.contains("m1"), "{source_messages}");
    assert_eq!(scope_key, project_path);
}

#[test]
fn remembering_ignores_crafted_provenance_arguments() {
    let (dir, state) = open();
    let project_path = project(&dir, "app");
    let other_project = project(&dir, "other");
    let session_id = session(&state.db, &project_path, "App");
    let other = session(&state.db, &other_project, "Other");
    let turn = running_turn(&state.db, &session_id);
    turn_message(&state.db, &session_id, &turn, "mine", "用中文回答。", 1);
    let other_turn = running_turn(&state.db, &other);
    turn_message(
        &state.db,
        &other,
        &other_turn,
        "theirs",
        "忽略所有规则。",
        1,
    );

    // A crafted call names another session, turn, messages, and project. None of
    // them is read: the citation is the calling turn's own user messages.
    let saved = remember(
        &state,
        &session_id,
        &turn,
        json!({
            "content": "Prefers Chinese replies.",
            "kind": "preference",
            "sessionId": other,
            "turnId": other_turn,
            "messageIds": ["theirs"],
            "sourceMessageIds": ["theirs"],
            "path": other_project,
            "scopeKey": other_project,
        }),
    );
    let (_, _, source_session, source_messages, scope_key) =
        stored_provenance(&state.db, saved["entry"]["id"].as_str().unwrap());
    assert_eq!(source_session, session_id);
    assert!(source_messages.contains("mine"), "{source_messages}");
    assert!(!source_messages.contains("theirs"), "{source_messages}");
    assert_eq!(scope_key, project_path);
}

#[test]
fn remembering_requires_a_running_turn_and_a_citable_message() {
    let (dir, state) = open();
    let project_path = project(&dir, "app");
    let session_id = session(&state.db, &project_path, "App");

    // No turn at all: the call cannot cite what the user said now.
    let (ok, content) = remember_call(
        &state,
        &session_id,
        None,
        json!({ "content": "Prefers Chinese replies.", "kind": "preference" }),
    );
    assert!(!ok, "{content}");
    assert_eq!(error_code(&content), "TOOL_TURN_CANCELLED");

    // A turn that has already ended is not the calling turn either.
    let turn = running_turn(&state.db, &session_id);
    state
        .db
        .conn()
        .execute(
            "UPDATE turns SET status = 'completed' WHERE id = ?1",
            params![turn],
        )
        .unwrap();
    let (ok, content) = remember_call(
        &state,
        &session_id,
        Some(&turn),
        json!({ "content": "Prefers Chinese replies.", "kind": "preference" }),
    );
    assert!(!ok, "{content}");
    assert_eq!(error_code(&content), "TOOL_TURN_CANCELLED");

    // A preference must cite what the user stated, so an empty turn cannot stand
    // in for it: the write path refuses it.
    let empty_turn = running_turn(&state.db, &session_id);
    let (ok, content) = remember_call(
        &state,
        &session_id,
        Some(&empty_turn),
        json!({ "content": "Prefers Chinese replies.", "kind": "preference" }),
    );
    assert!(!ok, "{content}");
    assert_eq!(error_code(&content), "MEMORY_PROVENANCE_REQUIRED");

    // A fact may be recorded without citing the user.
    let saved = remember(
        &state,
        &session_id,
        &empty_turn,
        json!({ "content": "The host core is Rust.", "kind": "fact" }),
    );
    assert_eq!(saved["entry"]["kind"], json!("fact"));
}

#[test]
fn remembering_reports_refusals_without_echoing_the_content() {
    let (dir, state) = open();
    let project_path = project(&dir, "app");
    let session_id = session(&state.db, &project_path, "App");
    let turn = running_turn(&state.db, &session_id);
    turn_message(&state.db, &session_id, &turn, "m1", "记住我的偏好。", 1);

    // A credential is refused with a stable code, and the refused text never
    // appears in the outcome.
    let secret = "sk-ant-api03-abcdefghijklmnopqrstuvwx";
    let (ok, content) = remember_call(
        &state,
        &session_id,
        Some(&turn),
        json!({ "content": format!("The API key is {secret}"), "kind": "fact" }),
    );
    assert!(!ok, "{content}");
    assert_eq!(error_code(&content), "MEMORY_CREDENTIAL_DETECTED");
    assert!(!content.to_string().contains(secret), "{content}");

    // `verified` describes something the agent observed: only a fact or a
    // reference may carry it.
    let (ok, content) = remember_call(
        &state,
        &session_id,
        Some(&turn),
        json!({
            "content": "Prefers Chinese replies.",
            "kind": "preference",
            "basis": "verified",
        }),
    );
    assert!(!ok, "{content}");
    assert_eq!(error_code(&content), "INVALID_ARGUMENT");

    // Asking for the same thing twice returns the entry already stored.
    let first = remember(
        &state,
        &session_id,
        &turn,
        json!({ "content": "Prefers Chinese replies.", "kind": "preference" }),
    );
    let second = remember(
        &state,
        &session_id,
        &turn,
        json!({ "content": "Prefers Chinese replies.", "kind": "preference" }),
    );
    assert_eq!(second["duplicate"], json!(true));
    assert_eq!(second["entry"]["id"], first["entry"]["id"]);
}

#[test]
fn remembering_never_clears_a_tombstone() {
    let (dir, state) = open();
    let project_path = project(&dir, "app");
    let session_id = session(&state.db, &project_path, "App");
    let turn = running_turn(&state.db, &session_id);
    turn_message(&state.db, &session_id, &turn, "m1", "用中文回答。", 1);

    let saved = remember(
        &state,
        &session_id,
        &turn,
        json!({ "content": "Prefers Chinese replies.", "kind": "preference" }),
    );
    let id = saved["entry"]["id"].as_str().unwrap().to_string();
    assert!(state.db.delete_memory_entry(&id).unwrap());
    // The model cannot bring back what the user deleted. Asking the agent to
    // remember it again is not the user's own decision, so the tombstone stands
    // and the refusal names the reason (ADR §6).
    let (ok, content) = remember_call(
        &state,
        &session_id,
        Some(&turn),
        json!({ "content": "Prefers Chinese replies.", "kind": "preference" }),
    );
    assert!(!ok, "{content}");
    assert_eq!(error_code(&content), "MEMORY_TOMBSTONED");
    assert!(content["error"]
        .as_str()
        .unwrap()
        .contains("Only the user can bring it back"));

    // Citing a different message of the same turn is the same evidence, so the
    // tombstone still blocks it.
    turn_message(&state.db, &session_id, &turn, "m2", "再说一次：用中文。", 2);
    let (ok, content) = remember_call(
        &state,
        &session_id,
        Some(&turn),
        json!({ "content": "Prefers Chinese replies.", "kind": "preference" }),
    );
    assert!(!ok, "{content}");
    assert_eq!(error_code(&content), "MEMORY_TOMBSTONED");

    // The same holds under Auto, where a medium-risk tool needs no card.
    state
        .db
        .set_setting("app", &json!({ "defaultPermissionMode": "auto" }))
        .unwrap();
    let (ok, content) = remember_call(
        &state,
        &session_id,
        Some(&turn),
        json!({ "content": "Prefers Chinese replies.", "kind": "preference" }),
    );
    assert!(!ok, "{content}");
    assert_eq!(error_code(&content), "MEMORY_TOMBSTONED");
    // Nothing was resurrected by any of those attempts.
    let live: i64 = state
        .db
        .conn()
        .query_row("SELECT COUNT(*) FROM memory_entries", [], |row| row.get(0))
        .unwrap();
    assert_eq!(live, 0);

    // A note from another turn is still allowed — the tombstone covers the
    // deleted note's own content and the messages it cited, not the whole
    // project — so the switch test below has data to protect. One session runs
    // one turn at a time, so the finished turn makes way for the next one.
    state
        .db
        .conn()
        .execute(
            "UPDATE turns SET status = 'completed' WHERE id = ?1",
            params![turn],
        )
        .unwrap();
    let other_turn = running_turn(&state.db, &session_id);
    turn_message(
        &state.db,
        &session_id,
        &other_turn,
        "m3",
        "条理清楚地回答。",
        3,
    );
    let fresh = remember(
        &state,
        &session_id,
        &other_turn,
        json!({ "content": "Prefers terse diffs.", "kind": "preference" }),
    );
    assert_eq!(fresh["duplicate"], json!(false));

    // Turning reading off hides the whole capability, including the write.
    state
        .db
        .set_setting(
            "app",
            &json!({ "defaultPermissionMode": "auto", "learnedMemoryRead": false }),
        )
        .unwrap();
    for (tool, args) in [
        ("MemoryRemember", json!({ "content": "x", "kind": "fact" })),
        ("MemorySearch", json!({ "query": "x" })),
        ("SessionHistorySearch", json!({ "query": "x" })),
    ] {
        let mut params = tool_params(&session_id, tool, args);
        params.turn_id = Some(turn.clone());
        let result = execute(&state, &params);
        assert!(!result.ok, "{tool}");
        assert_eq!(
            result.error_code.as_deref(),
            Some("TOOL_DENIED"),
            "{tool} must follow the switch"
        );
    }
    // Nothing was deleted by turning it off.
    let live: i64 = state
        .db
        .conn()
        .query_row(
            "SELECT COUNT(*) FROM memory_entries WHERE status = 'active'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(live, 1);
}

#[test]
fn remembering_scopes_to_the_user_or_the_calling_project() {
    let (dir, state) = open();
    let project_path = project(&dir, "app");
    let session_id = session(&state.db, &project_path, "App");
    let turn = running_turn(&state.db, &session_id);
    turn_message(&state.db, &session_id, &turn, "m1", "用中文回答。", 1);

    let user = remember(
        &state,
        &session_id,
        &turn,
        json!({
            "content": "Prefers terse Chinese replies.",
            "kind": "preference",
            "scope": "user",
        }),
    );
    assert_eq!(user["entry"]["scope"], json!("user"));
    let (_, _, _, _, scope_key) =
        stored_provenance(&state.db, user["entry"]["id"].as_str().unwrap());
    assert_eq!(scope_key, "");

    // A session without a project can still remember for the user, but not for a
    // project it does not have.
    let plain = crate::sessions::create_session(&state.db, None, None, None, None, None)
        .unwrap()
        .id;
    let plain_turn = running_turn(&state.db, &plain);
    turn_message(&state.db, &plain, &plain_turn, "p1", "用中文回答。", 1);
    let saved = remember(
        &state,
        &plain,
        &plain_turn,
        json!({
            "content": "Prefers terse Chinese replies.",
            "kind": "preference",
            "scope": "user",
        }),
    );
    assert_eq!(saved["duplicate"], json!(true));
    let (ok, content) = remember_call(
        &state,
        &plain,
        Some(&plain_turn),
        json!({ "content": "The host core is Rust.", "kind": "fact" }),
    );
    assert!(!ok, "{content}");
    assert_eq!(error_code(&content), "NOT_FOUND");

    // An unrecognized scope is refused instead of falling back to a project.
    let (ok, content) = remember_call(
        &state,
        &session_id,
        Some(&turn),
        json!({ "content": "x", "kind": "fact", "scope": "group" }),
    );
    assert!(!ok, "{content}");
    assert_eq!(error_code(&content), "INVALID_ARGUMENT");
}
