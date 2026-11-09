//! The scope and schema rules of automatic curation: what the v40 -> v41 step
//! adds, and why an employee's lessons are never touched.
//!
//! Kept beside `curation_tests` rather than inside it so neither file outgrows
//! the module budget, and split by responsibility: that file pins the guardrails
//! a pass must honour, this one pins who the pass may touch at all.

use rusqlite::params;

use super::curation::*;
use super::model::*;
use super::repository::*;
use super::tombstones;
use crate::db::{migration_backup_path, Database};

fn open(dir: &tempfile::TempDir) -> Database {
    Database::open(&dir.path().join("pi.sqlite")).unwrap()
}

fn scope(dir: &tempfile::TempDir, db: &Database, name: &str) -> MemoryScope {
    let path = dir.path().join(name);
    std::fs::create_dir_all(&path).unwrap();
    db.learned_memory_scope_for_path(path.to_str().unwrap())
        .unwrap()
}

fn make(
    db: &Database,
    scope: &MemoryScope,
    kind: &str,
    content: &str,
    origin: &str,
) -> MemoryEntryRecord {
    match db
        .create_memory_entry(CreateMemoryRequest {
            scope: scope.clone(),
            kind: kind.to_string(),
            content: content.to_string(),
            rationale: Some("observed".into()),
            origin: origin.to_string(),
            evidence: if origin == ORIGIN_EXTRACTED {
                EVIDENCE_INFERRED.to_string()
            } else {
                EVIDENCE_USER_STATED.to_string()
            },
            status: if origin == ORIGIN_EXTRACTED {
                STATUS_SUGGESTED.to_string()
            } else {
                STATUS_ACTIVE.to_string()
            },
            source_session_id: None,
            source_message_ids: Vec::new(),
            override_tombstone: false,
        })
        .unwrap()
    {
        CreateMemoryOutcome::Created(entry) => *entry,
        CreateMemoryOutcome::Duplicate(entry) => *entry,
        CreateMemoryOutcome::Rejected(rejection) => panic!("write refused: {}", rejection.code),
    }
}

fn entry(db: &Database, id: &str) -> MemoryEntryRecord {
    db.conn()
        .query_row(
            "SELECT id, scope_kind, scope_key, kind, content, rationale, status, origin, evidence,
                    source_session_id, source_message_ids, fingerprint, revision, superseded_by,
                    created_at, updated_at, last_used_at, use_count
               FROM memory_entries WHERE id = ?1",
            params![id],
            |row| {
                let raw: String = row.get(10)?;
                Ok(MemoryEntryRecord {
                    id: row.get(0)?,
                    scope_kind: row.get(1)?,
                    scope_key: row.get(2)?,
                    kind: row.get(3)?,
                    content: row.get(4)?,
                    rationale: row.get(5)?,
                    status: row.get(6)?,
                    origin: row.get(7)?,
                    evidence: row.get(8)?,
                    source_session_id: row.get(9)?,
                    source_message_ids: tombstones::parse_ids(&raw),
                    fingerprint: row.get(11)?,
                    revision: row.get(12)?,
                    superseded_by: row.get(13)?,
                    created_at: row.get(14)?,
                    updated_at: row.get(15)?,
                    last_used_at: row.get(16)?,
                    use_count: row.get(17)?,
                })
            },
        )
        .unwrap()
}

fn count(db: &Database, sql: &str) -> i64 {
    db.conn().query_row(sql, [], |row| row.get(0)).unwrap()
}

// ---- schema v40 -> v41 -----------------------------------------------------

#[test]
fn a_v40_database_gains_curation_tables_without_touching_memory() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("pi.sqlite");
    let project = scope(&dir, &Database::open(&path).unwrap(), "app");
    let (note_id, tombstoned) = {
        let db = Database::open(&path).unwrap();
        let note = make(
            &db,
            &project,
            KIND_FACT,
            "Kept across the migration.",
            ORIGIN_USER_UI,
        );
        let forgotten = make(
            &db,
            &project,
            KIND_FACT,
            "Forgotten before the upgrade.",
            ORIGIN_USER_UI,
        );
        db.delete_memory_entry(&forgotten.id).unwrap();
        db.conn()
            .execute_batch(
                "DROP TABLE memory_revisions;
                 DROP TABLE memory_curation_state;
                 DROP TABLE memory_curation_rejections;",
            )
            .unwrap();
        db.conn().pragma_update(None, "user_version", 40).unwrap();
        (note.id, forgotten.id)
    };

    let db = Database::open(&path).unwrap();
    let version: i64 = db
        .conn()
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap();
    assert_eq!(version, crate::db::SCHEMA_VERSION);
    assert!(migration_backup_path(&path, 40).exists());
    for table in [
        "memory_revisions",
        "memory_curation_state",
        "memory_curation_rejections",
    ] {
        assert_eq!(
            count(&db, &format!("SELECT COUNT(*) FROM {table}")),
            0,
            "{table} must start empty"
        );
    }
    // The note, its tombstone, and the scope it belongs to are untouched.
    let kept = entry(&db, &note_id);
    assert_eq!(kept.content, "Kept across the migration.");
    assert_eq!(kept.status, STATUS_ACTIVE);
    assert_eq!(count(&db, "SELECT COUNT(*) FROM memory_tombstones"), 1);
    assert_eq!(count(&db, "SELECT COUNT(*) FROM memory_entries"), 1);
    // A note the user forgot stays forgotten through the new writer.
    assert!(
        db.conn()
            .execute(
                "DELETE FROM memory_entries WHERE id = ?1",
                params![tombstoned]
            )
            .unwrap()
            == 0
    );
}

// ---- the bot scope is not this feature's to curate --------------------------

/// The refusal a caller gets, so a test can say which scope was refused.
fn refusal<T>(outcome: anyhow::Result<T>) -> String {
    outcome
        .err()
        .expect("the bot scope must be refused")
        .to_string()
}

/// One employee lesson, written the way the employee layer writes one: the host
/// stores a `bot`-scope extraction active, not as a suggestion (schema v39).
fn lesson(db: &Database, bot: &MemoryScope, content: &str) -> MemoryEntryRecord {
    match db
        .create_memory_entry(CreateMemoryRequest {
            scope: bot.clone(),
            kind: KIND_FACT.to_string(),
            content: content.to_string(),
            rationale: None,
            origin: ORIGIN_EXTRACTED.to_string(),
            evidence: EVIDENCE_INFERRED.to_string(),
            status: STATUS_ACTIVE.to_string(),
            source_session_id: None,
            source_message_ids: Vec::new(),
            override_tombstone: false,
        })
        .unwrap()
    {
        CreateMemoryOutcome::Created(entry) => *entry,
        CreateMemoryOutcome::Duplicate(entry) => *entry,
        CreateMemoryOutcome::Rejected(rejection) => panic!("write refused: {}", rejection.code),
    }
}

/// An employee's lessons are learned memory in a scope automatic curation does
/// not own (schema v39). Writing one must still work: the dirty marker skips
/// that scope rather than refusing the write, so no pass is ever queued for it
/// and the employee layer keeps working with this switch untouched.
#[test]
fn a_bot_scope_write_succeeds_and_is_never_queued() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(&dir);
    let bot = MemoryScope::bot("employee-1");
    let stored = lesson(&db, &bot, "The suite runs with --locked.");
    assert_eq!(stored.scope_kind, SCOPE_BOT);
    assert_eq!(stored.status, STATUS_ACTIVE);
    // Nothing was queued, and no bookkeeping row exists for the scope.
    assert!(db.dirty_memory_curation_scopes().unwrap().is_empty());
    assert_eq!(count(&db, "SELECT COUNT(*) FROM memory_curation_state"), 0);
    // The lesson itself is stored exactly as it was written.
    let reread = entry(&db, &stored.id);
    assert_eq!(reread.content, "The suite runs with --locked.");
    assert_eq!(reread.status, STATUS_ACTIVE);
}

/// Every entry point that takes a scope refuses the `bot` one by name. The
/// switch is a user setting, so the caller cannot be trusted to filter; the
/// host answers instead of pretending there was nothing to do.
#[test]
fn every_curation_entry_point_refuses_the_bot_scope() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(&dir);
    let bot = MemoryScope::bot("employee-1");
    let note = lesson(&db, &bot, "A lesson.");
    let ids = vec![note.id.clone()];

    let cases: Vec<(&str, String)> = vec![
        (
            "activate",
            refusal(db.activate_memory_suggestions(&bot, &ids, None)),
        ),
        (
            "claim",
            refusal(db.claim_memory_curation(&bot, "owner", "2026-11-15", CURATION_LEASE_MS)),
        ),
        (
            "claim-refusal",
            refusal(db.memory_curation_claim_refusal(&bot, "2026-11-15")),
        ),
        (
            "complete",
            refusal(db.complete_memory_curation(&bot, "owner", "2026-11-15")),
        ),
        (
            "fail",
            refusal(db.fail_memory_curation(&bot, "owner", "boom")),
        ),
        ("input", refusal(db.memory_curation_input(&bot))),
        ("dirty", refusal(db.memory_curation_dirty(&bot))),
        ("apply", refusal(db.apply_memory_curation(&bot, &[], None))),
        ("list", refusal(db.memory_curation_batches(&bot, 0, 10))),
        ("count", refusal(db.count_memory_curation_changes(&bot, 0))),
    ];
    for (name, message) in cases {
        assert!(
            message.contains("'bot'"),
            "{name} must refuse the bot scope, said: {message}"
        );
    }
    // Refusing changed nothing: the lesson is untouched and still unqueued.
    assert_eq!(entry(&db, &note.id).status, STATUS_ACTIVE);
    assert_eq!(count(&db, "SELECT COUNT(*) FROM memory_curation_state"), 0);
    assert_eq!(count(&db, "SELECT COUNT(*) FROM memory_revisions"), 0);
}

/// The two per-scope tables refuse the scope themselves, so a caller that
/// bypasses the host rule (a direct write, a future code path) cannot create a
/// queue entry for an employee's lessons either.
#[test]
fn the_curation_tables_refuse_a_bot_row() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(&dir);
    for statement in [
        "INSERT INTO memory_curation_state (scope_kind, scope_key, dirty_since)
         VALUES ('bot', 'employee-1', 1)",
        "INSERT INTO memory_curation_rejections
           (scope_kind, scope_key, target_fingerprint, created_at)
         VALUES ('bot', 'employee-1', 'f', 1)",
    ] {
        assert!(
            db.conn().execute(statement, []).is_err(),
            "the table must refuse a bot row: {statement}"
        );
    }
}

/// No pass can produce a record for an employee's lesson, but a hand-written or
/// repaired row must not be able to archive one: the undo refuses the batch
/// before it writes anything.
#[test]
fn undo_refuses_a_batch_that_names_an_employee_lesson() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(&dir);
    let bot = MemoryScope::bot("employee-1");
    let note = lesson(&db, &bot, "A lesson.");
    db.conn()
        .execute(
            "INSERT INTO memory_revisions
               (batch_id, entry_id, op, actor, before_json, after_json, reason, created_at)
             VALUES ('batch-bot', ?1, 'merge_new', 'auto', NULL,
                     '{\"content\":\"A lesson.\",\"status\":\"active\",\"revision\":1}', NULL, ?2)",
            params![note.id, crate::db::now_ms()],
        )
        .unwrap();

    let message = refusal(db.undo_memory_curation("batch-bot"));
    assert!(
        message.contains("'bot'"),
        "the undo must refuse a bot batch, said: {message}"
    );
    assert_eq!(entry(&db, &note.id).status, STATUS_ACTIVE);
    assert_eq!(
        count(
            &db,
            "SELECT COUNT(*) FROM memory_revisions WHERE undone_at IS NOT NULL"
        ),
        0
    );
}
