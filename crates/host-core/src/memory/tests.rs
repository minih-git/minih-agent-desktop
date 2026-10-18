//! Learned-memory domain tests (ADR agent-long-term-memory, milestone M1).

use rusqlite::params;

use super::model::*;
use super::repository::*;
use super::{secrets, tombstones};
use crate::db::{canonical_project_path, migration_backup_path, Database, SCHEMA_VERSION};

pub(super) fn open(dir: &tempfile::TempDir) -> Database {
    Database::open(&dir.path().join("pi.sqlite")).unwrap()
}

/// A real directory, because project paths are canonicalized on the way in.
pub(super) fn project_dir(dir: &tempfile::TempDir, name: &str) -> String {
    let path = dir.path().join(name);
    std::fs::create_dir_all(&path).unwrap();
    canonical_project_path(path.to_str().unwrap()).unwrap()
}

fn insert_message(db: &Database, session_id: &str, id: &str, role: &str, seq: i64) {
    db.conn()
        .execute(
            "INSERT INTO messages
               (id, session_id, turn_id, seq, role, tool_name, is_error, text, created_at, streaming)
             VALUES (?1, ?2, NULL, ?3, ?4, NULL, 0, 'message text', 1, 0)",
            params![id, session_id, seq, role],
        )
        .unwrap();
}

pub(super) fn session_with_message(
    db: &Database,
    project: &str,
    message_id: &str,
    role: &str,
) -> String {
    let session = crate::sessions::create_session(
        db,
        Some("Memory session".into()),
        None,
        None,
        None,
        Some(project.to_string()),
    )
    .unwrap();
    insert_message(db, &session.id, message_id, role, 1);
    session.id
}

pub(super) fn request(
    scope: &MemoryScope,
    kind: &str,
    content: &str,
    origin: &str,
) -> CreateMemoryRequest {
    CreateMemoryRequest {
        scope: scope.clone(),
        kind: kind.to_string(),
        content: content.to_string(),
        rationale: None,
        origin: origin.to_string(),
        evidence: EVIDENCE_USER_STATED.to_string(),
        status: STATUS_ACTIVE.to_string(),
        source_session_id: None,
        source_message_ids: Vec::new(),
        override_tombstone: false,
    }
}

pub(super) fn created(outcome: CreateMemoryOutcome) -> MemoryEntryRecord {
    match outcome {
        CreateMemoryOutcome::Created(entry) => *entry,
        other => panic!("expected a stored entry, got {}", describe(&other)),
    }
}

fn describe(outcome: &CreateMemoryOutcome) -> String {
    match outcome {
        CreateMemoryOutcome::Created(entry) => format!("created {}", entry.id),
        CreateMemoryOutcome::Duplicate(entry) => format!("duplicate {}", entry.id),
        CreateMemoryOutcome::Rejected(rejection) => format!("rejected {}", rejection.code),
    }
}

fn rejection_of(outcome: &CreateMemoryOutcome) -> &MemoryRejection {
    match outcome {
        CreateMemoryOutcome::Rejected(rejection) => rejection,
        other => panic!("expected a rejection, got {}", describe(other)),
    }
}

// ---- schema v25 -> v26 -----------------------------------------------------

#[test]
fn v25_database_gains_learned_memory_without_touching_pinned_memory() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("pi.sqlite");
    let project = project_dir(&dir, "app");
    let session_id = {
        let db = Database::open(&path).unwrap();
        db.set_project_memory(&project, "Keep the API stable.")
            .unwrap();
        let session = crate::sessions::create_session(
            &db,
            Some("Kept".into()),
            None,
            None,
            None,
            Some(project.clone()),
        )
        .unwrap();
        // A v25 file has no learned-memory tables at all.
        db.conn()
            .execute_batch(
                "DROP TABLE memory_entries_fts;
                 DROP TABLE memory_entries;
                 DROP TABLE memory_tombstones;
                 DROP TABLE memory_session_state;",
            )
            .unwrap();
        db.conn().pragma_update(None, "user_version", 25).unwrap();
        session.id
    };

    let db = Database::open(&path).unwrap();
    assert_eq!(SCHEMA_VERSION, 26);
    let version: i64 = db
        .conn()
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap();
    assert_eq!(version, 26);
    assert!(migration_backup_path(&path, 25).exists());
    for table in [
        "memory_entries",
        "memory_tombstones",
        "memory_session_state",
    ] {
        let count: i64 = db
            .conn()
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 0, "{table} must start empty");
    }
    // Pinned memory and its session are exactly as they were.
    assert_eq!(
        db.get_project_memory(&project).unwrap().content,
        "Keep the API stable."
    );
    assert!(crate::sessions::get_session(&db, &session_id)
        .unwrap()
        .is_some());
    // The migrated schema accepts writes on both new tables.
    let scope = db.learned_memory_scope_for_path(&project).unwrap();
    created(
        db.create_memory_entry(request(&scope, KIND_FACT, "Rust host.", ORIGIN_USER_UI))
            .unwrap(),
    );
    let state = db.set_memory_session_excluded(&session_id, true).unwrap();
    assert!(state.excluded);
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

// ---- content rules ---------------------------------------------------------

#[test]
fn content_limits_and_duplicates_are_enforced() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(&dir);
    let project = project_dir(&dir, "app");
    let scope = db.learned_memory_scope_for_path(&project).unwrap();

    let blank = db
        .create_memory_entry(request(&scope, KIND_FACT, "   ", ORIGIN_USER_UI))
        .unwrap();
    assert_eq!(rejection_of(&blank).code, REJECT_EMPTY_CONTENT);

    let oversized = "x".repeat(MAX_CONTENT_BYTES + 1);
    let too_large = db
        .create_memory_entry(request(&scope, KIND_FACT, &oversized, ORIGIN_USER_UI))
        .unwrap();
    assert_eq!(rejection_of(&too_large).code, REJECT_CONTENT_TOO_LARGE);

    let mut with_rationale = request(&scope, KIND_FACT, "Host is Rust.", ORIGIN_USER_UI);
    with_rationale.rationale = Some("y".repeat(MAX_RATIONALE_BYTES + 1));
    assert_eq!(
        rejection_of(&db.create_memory_entry(with_rationale).unwrap()).code,
        REJECT_RATIONALE_TOO_LARGE
    );

    let unknown = db
        .create_memory_entry(request(&scope, "guess", "Host is Rust.", ORIGIN_USER_UI))
        .unwrap();
    assert_eq!(rejection_of(&unknown).code, REJECT_INVALID_FIELD);

    // The same content in the same scope is one memory, not two.
    let first = created(
        db.create_memory_entry(request(&scope, KIND_FACT, "Host is Rust.", ORIGIN_USER_UI))
            .unwrap(),
    );
    let again = db
        .create_memory_entry(request(
            &scope,
            KIND_FACT,
            "  HOST   IS rust. ",
            ORIGIN_USER_UI,
        ))
        .unwrap();
    match again {
        CreateMemoryOutcome::Duplicate(entry) => assert_eq!(entry.id, first.id),
        other => panic!("expected a duplicate, got {}", describe(&other)),
    }
    // A different scope is a different memory.
    let other_project = project_dir(&dir, "other");
    let other_scope = db.learned_memory_scope_for_path(&other_project).unwrap();
    let elsewhere = created(
        db.create_memory_entry(request(
            &other_scope,
            KIND_FACT,
            "Host is Rust.",
            ORIGIN_USER_UI,
        ))
        .unwrap(),
    );
    assert_ne!(elsewhere.id, first.id);
}

#[test]
fn credentials_are_refused_without_echoing_the_text() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(&dir);
    let project = project_dir(&dir, "app");
    let scope = db.learned_memory_scope_for_path(&project).unwrap();

    // Built from parts so no real-looking credential is committed as a literal.
    let samples = [
        format!("{}{}", "sk-", "a1b2c3d4e5f6g7h8i9j0k1l2"),
        format!("{}://user:{}@example.com", "https", "hunter2secret"),
        format!("api_key = {}", "0123456789abcdef0123456789abcdef"),
        format!("-----BEGIN {} PRIVATE KEY-----", "RSA"),
    ];
    for sample in &samples {
        assert!(
            secrets::looks_like_credential(sample),
            "detector must catch a credential shape"
        );
        let outcome = db
            .create_memory_entry(request(&scope, KIND_FACT, sample, ORIGIN_USER_UI))
            .unwrap();
        let rejection = rejection_of(&outcome);
        assert_eq!(rejection.code, REJECT_CREDENTIAL_DETECTED);
        assert!(!rejection.message.contains(sample.as_str()));
        assert!(!rejection.message.contains("sk-"));
        assert!(!rejection.message.contains("hunter2"));
    }
    // Ordinary prose that merely mentions a secret-shaped word is still stored.
    let stored = created(
        db.create_memory_entry(request(
            &scope,
            KIND_REFERENCE,
            "Rotate the api key in the provider settings.",
            ORIGIN_USER_UI,
        ))
        .unwrap(),
    );
    assert_eq!(
        stored.content,
        "Rotate the api key in the provider settings."
    );
    let count: i64 = db
        .conn()
        .query_row("SELECT COUNT(*) FROM memory_entries", [], |row| row.get(0))
        .unwrap();
    assert_eq!(count, 1);
}

// ---- updates and forgetting ------------------------------------------------

#[test]
fn update_is_compare_and_set_on_revision() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(&dir);
    let project = project_dir(&dir, "app");
    let scope = db.learned_memory_scope_for_path(&project).unwrap();
    let entry = created(
        db.create_memory_entry(request(&scope, KIND_FACT, "Host is Rust.", ORIGIN_USER_UI))
            .unwrap(),
    );

    let updated = db
        .update_memory_entry(UpdateMemoryRequest {
            id: entry.id.clone(),
            revision: entry.revision,
            content: Some("Host core is Rust.".to_string()),
            rationale: None,
            kind: None,
            scope: None,
        })
        .unwrap();
    let updated = match updated {
        UpdateMemoryOutcome::Updated(entry) => *entry,
        _ => panic!("expected an update"),
    };
    assert_eq!(updated.content, "Host core is Rust.");
    assert_eq!(updated.revision, 2);
    assert_eq!(
        updated.fingerprint,
        tombstones::fingerprint(KIND_FACT, "Host core is Rust.")
    );

    // The stale revision is refused and the stored row is unchanged.
    let stale = db
        .update_memory_entry(UpdateMemoryRequest {
            id: entry.id.clone(),
            revision: entry.revision,
            content: Some("Overwritten.".to_string()),
            rationale: None,
            kind: None,
            scope: None,
        })
        .unwrap();
    assert!(matches!(stale, UpdateMemoryOutcome::RevisionConflict));
    let stored = db
        .list_memory_entries(&scope, None, None, 10, 0)
        .unwrap()
        .remove(0);
    assert_eq!(stored.content, "Host core is Rust.");
    assert_eq!(stored.revision, 2);

    // An unknown id is a miss, not a conflict.
    assert!(matches!(
        db.update_memory_entry(UpdateMemoryRequest {
            id: "missing".to_string(),
            revision: 1,
            content: Some("x".to_string()),
            rationale: None,
            kind: None,
            scope: None,
        })
        .unwrap(),
        UpdateMemoryOutcome::NotFound
    ));
}

#[test]
fn archive_and_restore_hide_without_forgetting() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(&dir);
    let project = project_dir(&dir, "app");
    let scope = db.learned_memory_scope_for_path(&project).unwrap();
    let entry = created(
        db.create_memory_entry(request(&scope, KIND_FACT, "Host is Rust.", ORIGIN_USER_UI))
            .unwrap(),
    );

    let archived = match db
        .set_memory_entry_status(&entry.id, STATUS_ARCHIVED)
        .unwrap()
    {
        StatusMemoryOutcome::Updated(entry) => *entry,
        _ => panic!("expected an archive"),
    };
    assert_eq!(archived.status, STATUS_ARCHIVED);
    let tombstones: i64 = db
        .conn()
        .query_row("SELECT COUNT(*) FROM memory_tombstones", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(tombstones, 0, "hiding an entry is not forgetting it");
    assert!(db
        .list_memory_entries(&scope, Some(STATUS_ACTIVE), None, 10, 0)
        .unwrap()
        .is_empty());

    let restored = match db
        .set_memory_entry_status(&entry.id, STATUS_ACTIVE)
        .unwrap()
    {
        StatusMemoryOutcome::Updated(entry) => *entry,
        _ => panic!("expected a restore"),
    };
    assert_eq!(restored.status, STATUS_ACTIVE);
    // Hiding an entry frees its content for a new one; unhiding the hidden copy
    // would duplicate the live one.
    let archived = match db
        .set_memory_entry_status(&entry.id, STATUS_ARCHIVED)
        .unwrap()
    {
        StatusMemoryOutcome::Updated(entry) => *entry,
        _ => panic!("expected an archive"),
    };
    assert_eq!(archived.status, STATUS_ARCHIVED);
    let recreated = created(
        db.create_memory_entry(request(&scope, KIND_FACT, "Host is Rust.", ORIGIN_USER_UI))
            .unwrap(),
    );
    assert_ne!(recreated.id, archived.id);
    assert!(matches!(
        db.set_memory_entry_status(&archived.id, STATUS_ACTIVE)
            .unwrap(),
        StatusMemoryOutcome::Duplicate
    ));
    // The live copy round-trips through hide and unhide.
    assert!(matches!(
        db.set_memory_entry_status(&recreated.id, STATUS_ARCHIVED)
            .unwrap(),
        StatusMemoryOutcome::Updated(_)
    ));
    let live = match db
        .set_memory_entry_status(&recreated.id, STATUS_ACTIVE)
        .unwrap()
    {
        StatusMemoryOutcome::Updated(entry) => *entry,
        _ => panic!("expected a restore"),
    };
    assert_eq!(live.status, STATUS_ACTIVE);
}

#[test]
fn delete_blocks_the_same_evidence_until_the_user_insists() {
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
    write.source_session_id = Some(session.clone());
    write.source_message_ids = vec!["u1".to_string()];
    let entry = created(db.create_memory_entry(write.clone()).unwrap());

    assert!(db.delete_memory_entry(&entry.id).unwrap());
    // Idempotent, and the entry is archived rather than erased.
    assert!(db.delete_memory_entry(&entry.id).unwrap());
    assert_eq!(
        db.list_memory_entries(&scope, Some(STATUS_ARCHIVED), None, 10, 0)
            .unwrap()
            .len(),
        1
    );

    // The same content, and anything citing the same message, stays forgotten.
    let again = db.create_memory_entry(write.clone()).unwrap();
    assert_eq!(rejection_of(&again).code, REJECT_TOMBSTONED);
    let mut restated = request(
        &scope,
        KIND_PREFERENCE,
        "Prefers very terse replies.",
        ORIGIN_EXPLICIT,
    );
    restated.source_session_id = Some(session);
    restated.source_message_ids = vec!["u1".to_string()];
    assert_eq!(
        rejection_of(&db.create_memory_entry(restated).unwrap()).code,
        REJECT_TOMBSTONED
    );

    // An explicit request to remember it again clears the tombstone.
    let mut override_write = write.clone();
    override_write.override_tombstone = true;
    let restored = created(db.create_memory_entry(override_write).unwrap());
    assert_eq!(restored.content, "Prefers terse replies.");
    let tombstones: i64 = db
        .conn()
        .query_row("SELECT COUNT(*) FROM memory_tombstones", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(tombstones, 0);

    // Only the explicit origin may override.
    let entry = created(
        db.create_memory_entry(request(&scope, KIND_FACT, "Host is Rust.", ORIGIN_USER_UI))
            .unwrap(),
    );
    db.delete_memory_entry(&entry.id).unwrap();
    let mut extracted = request(&scope, KIND_FACT, "Host is Rust.", ORIGIN_EXTRACTED);
    extracted.status = STATUS_SUGGESTED.to_string();
    extracted.override_tombstone = true;
    assert_eq!(
        rejection_of(&db.create_memory_entry(extracted).unwrap()).code,
        REJECT_TOMBSTONED
    );
}

#[test]
fn rejecting_a_suggestion_keeps_it_from_coming_back() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(&dir);
    let project = project_dir(&dir, "app");
    let scope = db.learned_memory_scope_for_path(&project).unwrap();
    let session = session_with_message(&db, &project, "u1", "user");
    let mut suggestion = request(&scope, KIND_FACT, "Deploys on Fridays.", ORIGIN_EXTRACTED);
    suggestion.status = STATUS_SUGGESTED.to_string();
    suggestion.source_session_id = Some(session.clone());
    suggestion.source_message_ids = vec!["u1".to_string()];
    let entry = created(db.create_memory_entry(suggestion.clone()).unwrap());
    assert_eq!(entry.status, STATUS_SUGGESTED);
    assert!(db
        .search_memory_entries(SearchMemoryRequest {
            scopes: std::slice::from_ref(&scope),
            query: "Fridays",
            kinds: &[],
            limit: 8,
            record_use: false,
        })
        .unwrap()
        .is_empty());

    let rejected = db
        .decide_memory_suggestion(&entry.id, false)
        .unwrap()
        .unwrap();
    assert_eq!(rejected.status, STATUS_ARCHIVED);
    assert_eq!(
        rejection_of(&db.create_memory_entry(suggestion).unwrap()).code,
        REJECT_TOMBSTONED
    );
    // Deciding again is a miss: the entry is no longer a suggestion.
    assert!(db
        .decide_memory_suggestion(&entry.id, true)
        .unwrap()
        .is_none());
}

#[test]
fn accepting_a_suggestion_activates_it() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(&dir);
    let project = project_dir(&dir, "app");
    let scope = db.learned_memory_scope_for_path(&project).unwrap();
    let mut suggestion = request(&scope, KIND_FACT, "Deploys on Fridays.", ORIGIN_EXTRACTED);
    suggestion.status = STATUS_SUGGESTED.to_string();
    let entry = created(db.create_memory_entry(suggestion).unwrap());
    let accepted = db
        .decide_memory_suggestion(&entry.id, true)
        .unwrap()
        .unwrap();
    assert_eq!(accepted.status, STATUS_ACTIVE);
    assert_eq!(accepted.revision, 2);
}
