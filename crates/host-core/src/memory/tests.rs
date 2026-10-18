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

/// A message row inside a real turn of the session. The provenance rule only
/// accepts messages that belong to a turn, so a test that wants to prove "the
/// user's own message passes" must not fabricate a turn-less row.
fn insert_message(db: &Database, session_id: &str, turn_id: &str, id: &str, role: &str, seq: i64) {
    db.conn()
        .execute(
            "INSERT INTO messages
               (id, session_id, turn_id, seq, role, tool_name, is_error, text, created_at, streaming)
             VALUES (?1, ?2, ?3, ?4, ?5, NULL, 0, 'message text', 1, 0)",
            params![id, session_id, turn_id, seq, role],
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
    let turn = crate::sessions::begin_turn(db, &session.id, None, None).unwrap();
    insert_message(db, &session.id, &turn, message_id, role, 1);
    // The turn is settled immediately: the message keeps the turn reference the
    // provenance rule needs, while the session stays free to receive a delivery
    // or to be forked.
    db.conn()
        .execute(
            "UPDATE turns SET status = 'completed', ended_at = ?2 WHERE id = ?1",
            params![turn, crate::db::now_ms()],
        )
        .unwrap();
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

pub(super) fn rejection_of(outcome: &CreateMemoryOutcome) -> &MemoryRejection {
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

/// The cited messages are checked when a preference is created, and the source
/// session may be deleted afterwards. Re-checking on every edit would make the
/// entry permanently uneditable; only a kind change into a provenance-bearing
/// kind needs the check again.
#[test]
fn deleting_the_source_session_does_not_block_editing_a_preference() {
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
    let entry = created(db.create_memory_entry(write).unwrap());

    crate::sessions::delete_session(&db, &session).unwrap();
    let remaining: i64 = db
        .conn()
        .query_row(
            "SELECT COUNT(*) FROM messages WHERE session_id = ?1",
            params![session],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(remaining, 0, "the cited message cascades with its session");

    let updated = match db
        .update_memory_entry(UpdateMemoryRequest {
            id: entry.id.clone(),
            revision: entry.revision,
            content: Some("Prefers terse replies, with reasons.".to_string()),
            rationale: None,
            kind: None,
            scope: None,
        })
        .unwrap()
    {
        UpdateMemoryOutcome::Updated(entry) => *entry,
        _ => panic!("editing an existing preference must not need its old source"),
    };
    assert_eq!(updated.content, "Prefers terse replies, with reasons.");
    assert_eq!(updated.revision, entry.revision + 1);
    // The citation is preserved, and the other rules still run.
    assert_eq!(updated.source_message_ids, vec!["u1".to_string()]);
    let credential = db
        .update_memory_entry(UpdateMemoryRequest {
            id: entry.id.clone(),
            revision: updated.revision,
            content: Some(format!("{}{}", "sk-", "a1b2c3d4e5f6g7h8i9j0k1l2")),
            rationale: None,
            kind: None,
            scope: None,
        })
        .unwrap();
    match credential {
        UpdateMemoryOutcome::Rejected(rejection) => {
            assert_eq!(rejection.code, REJECT_CREDENTIAL_DETECTED)
        }
        _ => panic!("the credential detector still runs on an edit"),
    }

    // Turning another kind into a preference for the first time does check.
    let fact = created(
        db.create_memory_entry(request(
            &scope,
            KIND_FACT,
            "Deploys on Fridays.",
            ORIGIN_USER_UI,
        ))
        .unwrap(),
    );
    let promoted = db
        .update_memory_entry(UpdateMemoryRequest {
            id: fact.id.clone(),
            revision: fact.revision,
            content: None,
            rationale: None,
            kind: Some(KIND_PREFERENCE.to_string()),
            scope: None,
        })
        .unwrap();
    match promoted {
        UpdateMemoryOutcome::Rejected(rejection) => {
            assert_eq!(rejection.code, REJECT_PROVENANCE_REQUIRED)
        }
        _ => panic!("a new preference must cite what the user stated"),
    }
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
    // Idempotent: the second delete has no row left to forget.
    assert!(!db.delete_memory_entry(&entry.id).unwrap());
    assert!(db
        .list_memory_entries(&scope, None, None, 10, 0)
        .unwrap()
        .is_empty());

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

    let rejected = db.decide_memory_suggestion(&entry.id, false).unwrap();
    assert!(matches!(rejected, SuggestionOutcome::Rejected));
    assert_eq!(
        rejection_of(&db.create_memory_entry(suggestion).unwrap()).code,
        REJECT_TOMBSTONED
    );
    // Deciding again is a miss: the suggestion is gone, not archived.
    assert!(matches!(
        db.decide_memory_suggestion(&entry.id, true).unwrap(),
        SuggestionOutcome::NotFound
    ));
}

/// Deleting is a host guarantee, not a status change: the row and its index
/// entries are removed, so nothing can bring the text back, while the tombstone
/// keeps the identity that blocks the same evidence.
#[test]
fn delete_erases_the_row_and_keeps_a_content_free_tombstone() {
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
    write.source_session_id = Some(session);
    write.source_message_ids = vec!["u1".to_string()];
    let entry = created(db.create_memory_entry(write).unwrap());

    assert!(db.delete_memory_entry(&entry.id).unwrap());
    let rows: i64 = db
        .conn()
        .query_row(
            "SELECT COUNT(*) FROM memory_entries WHERE id = ?1",
            params![entry.id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(rows, 0, "the deleted row is gone, not archived");
    let indexed: i64 = db
        .conn()
        .query_row(
            "SELECT COUNT(*) FROM memory_entries_fts WHERE memory_entries_fts MATCH 'terse'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(indexed, 0, "the full-text index follows the deleted row");
    assert!(db
        .search_memory_entries(SearchMemoryRequest {
            scopes: std::slice::from_ref(&scope),
            query: "terse",
            kinds: &[],
            limit: 8,
            record_use: false,
        })
        .unwrap()
        .is_empty());

    // Neither hiding nor restoring can reach a row that no longer exists.
    assert!(matches!(
        db.set_memory_entry_status(&entry.id, STATUS_ARCHIVED)
            .unwrap(),
        StatusMemoryOutcome::NotFound
    ));
    assert!(matches!(
        db.set_memory_entry_status(&entry.id, STATUS_ACTIVE)
            .unwrap(),
        StatusMemoryOutcome::NotFound
    ));

    // The tombstone keeps the fingerprint and the cited messages, and has no
    // column that could hold the text.
    let (fingerprint, ids): (String, String) = db
        .conn()
        .query_row(
            "SELECT fingerprint, source_message_ids FROM memory_tombstones",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(
        fingerprint,
        tombstones::fingerprint(KIND_PREFERENCE, "Prefers terse replies.")
    );
    assert_eq!(ids, "[\"u1\"]");
    let has_content: bool = db
        .conn()
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info('memory_tombstones') WHERE name = 'content')",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(!has_content, "a tombstone carries no content");
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
    let accepted = match db.decide_memory_suggestion(&entry.id, true).unwrap() {
        SuggestionOutcome::Accepted(entry) => *entry,
        _ => panic!("expected an accepted suggestion"),
    };
    assert_eq!(accepted.status, STATUS_ACTIVE);
    assert_eq!(accepted.revision, 2);
}

/// Extraction is the only writer that may produce a suggestion, and a suggestion
/// is the only thing extraction may produce (ADR §4). Enforced by the host, not
/// by the caller that happens to pass `status`.
#[test]
fn extraction_only_ever_produces_a_suggestion() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(&dir);
    let project = project_dir(&dir, "app");
    let scope = db.learned_memory_scope_for_path(&project).unwrap();

    // An extracted entry may not be created directly as active.
    let mut extracted = request(&scope, KIND_FACT, "Deploys on Fridays.", ORIGIN_EXTRACTED);
    assert_eq!(
        rejection_of(&db.create_memory_entry(extracted.clone()).unwrap()).code,
        REJECT_INVALID_FIELD
    );

    // No other writer may create a suggestion.
    for origin in [ORIGIN_EXPLICIT, ORIGIN_USER_UI] {
        let mut write = request(&scope, KIND_FACT, "Deploys on Fridays.", origin);
        write.status = STATUS_SUGGESTED.to_string();
        assert_eq!(
            rejection_of(&db.create_memory_entry(write).unwrap()).code,
            REJECT_INVALID_FIELD,
            "{origin} cannot create a suggestion"
        );
    }

    // The supported pair still works; accepting it is covered by the suggestion
    // tests and the RPC contract test.
    extracted.status = STATUS_SUGGESTED.to_string();
    let entry = created(db.create_memory_entry(extracted).unwrap());
    assert_eq!(entry.status, STATUS_SUGGESTED);
    assert_eq!(entry.origin, ORIGIN_EXTRACTED);
}
