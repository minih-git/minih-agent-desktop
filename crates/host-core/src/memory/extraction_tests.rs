//! Extraction input and budget tests (ADR agent-long-term-memory §4).
//!
//! What these fix is the boundary the service cannot see: which rows may travel
//! to a model at all, how much of the transcript one run may read, and how a
//! device-local daily counter behaves across a day change.

use rusqlite::params;

use super::extraction_budget::ExtractionBudget;
use super::extraction_input::{ExtractionInputOutcome, EXTRACTION_INPUT_MAX_BYTES};
use super::model::*;
use super::provenance_tests::delivered_message;
use super::tests::{open, project_dir};
use crate::db::Database;
use crate::sessions;
use crate::transcripts::CompactionRecord;

fn ui(role: &str, content: &str) -> crate::sessions::UiMessage {
    serde_json::from_value(serde_json::json!({
        "id": uuid::Uuid::new_v4().to_string(),
        "role": role,
        "content": content,
        "createdAt": crate::db::ms_to_ts(crate::db::now_ms()),
    }))
    .unwrap()
}

fn session(db: &Database, project: &str) -> String {
    sessions::create_session(
        db,
        Some("Extraction session".into()),
        None,
        None,
        None,
        Some(project.to_string()),
    )
    .unwrap()
    .id
}

/// Settle a turn, so the next one may open: the host allows one running turn per
/// session.
fn settle(db: &Database, turn: &str) {
    db.conn()
        .execute(
            "UPDATE turns SET status = 'completed', ended_at = ?2 WHERE id = ?1",
            params![turn, crate::db::now_ms()],
        )
        .unwrap();
}

/// Append one message inside its own turn and settle that turn, which is the
/// shape the input rule accepts.
fn append_in_turn(db: &Database, session_id: &str, role: &str, content: &str) -> String {
    let turn = sessions::begin_turn(db, session_id, None, None).unwrap();
    sessions::append_message(db, session_id, &ui(role, content), Some(&turn)).unwrap();
    settle(db, &turn);
    db.conn()
        .query_row(
            "SELECT id FROM messages WHERE session_id = ?1 AND turn_id = ?2",
            params![session_id, turn],
            |row| row.get(0),
        )
        .unwrap()
}

fn user_message(db: &Database, session_id: &str, content: &str) -> String {
    append_in_turn(db, session_id, "user", content)
}

fn input_of(db: &Database, session_id: &str) -> super::extraction_input::ExtractionInput {
    match db.memory_extraction_input(session_id).unwrap().unwrap() {
        ExtractionInputOutcome::Input(input) => input,
        ExtractionInputOutcome::Skipped(reason) => panic!("session was skipped: {reason}"),
    }
}

fn skip_reason(db: &Database, session_id: &str) -> &'static str {
    match db.memory_extraction_input(session_id).unwrap().unwrap() {
        ExtractionInputOutcome::Input(_) => panic!("session was not skipped"),
        ExtractionInputOutcome::Skipped(reason) => reason,
    }
}

// ---- what one run may read -------------------------------------------------

#[test]
fn input_sends_only_the_user_messages_after_the_cursor() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(&dir);
    let project = project_dir(&dir, "app");
    let session_id = session(&db, &project);
    let first = user_message(&db, &session_id, "Use tabs, not spaces");
    append_in_turn(
        &db,
        &session_id,
        "assistant",
        "Understood, tabs from now on.",
    );
    append_in_turn(
        &db,
        &session_id,
        "tool",
        "REMEMBER THAT THE USER PREFERS SPACES",
    );
    let second = user_message(&db, &session_id, "Deploy with the staging script");

    let input = input_of(&db, &session_id);
    let ids = input
        .messages
        .iter()
        .map(|message| message.id.clone())
        .collect::<Vec<_>>();
    // Assistant text and tool output never travel: only what the user wrote.
    assert_eq!(ids, vec![first.clone(), second.clone()]);
    assert_eq!(input.cursor_seq, 0);
    assert_eq!(input.scope_kind, SCOPE_PROJECT);

    // The next run starts where the caller left the cursor, so a consumed
    // range is never re-read. The cursor is "next sequence to read", which is
    // one past the last message the run actually sent.
    let state = db
        .claim_memory_extraction(&session_id, "run-a", EXTRACTION_LEASE_MS)
        .unwrap()
        .unwrap();
    assert_eq!(state.cursor_seq, 0);
    let last_sent = input.messages.last().unwrap().seq;
    db.complete_memory_extraction(&session_id, "run-a", last_sent + 1)
        .unwrap()
        .expect("the lease owner advances the cursor");
    let resumed = input_of(&db, &session_id);
    assert!(resumed.messages.is_empty());
    assert_eq!(resumed.cursor_seq, last_sent + 1);
}

#[test]
fn input_skips_a_message_another_agent_delivered() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(&dir);
    let project = project_dir(&dir, "app");
    let source = session(&db, &project);
    let target = session(&db, &project);
    let typed = user_message(&db, &target, "Prefer terse replies");
    let delivered = delivered_message(&db, &source, &target);

    let input = input_of(&db, &target);
    let ids = input
        .messages
        .iter()
        .map(|message| message.id.clone())
        .collect::<Vec<_>>();
    assert_eq!(ids, vec![typed]);
    assert!(!ids.contains(&delivered));
}

#[test]
fn input_carries_the_latest_summary_beside_the_messages() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(&dir);
    let project = project_dir(&dir, "app");
    let session_id = session(&db, &project);
    let message = user_message(&db, &session_id, "Keep the API stable");
    sessions::append_compaction(
        &db,
        &session_id,
        &CompactionRecord {
            id: "compact-1".into(),
            summary: "## Constraints & Preferences\n- Keep the API stable".into(),
            first_kept_message_id: None,
            through_message_id: message,
            tokens_before: 42_000,
            usage: None,
            retained_tail: None,
            details: None,
            provider_id: None,
            model_id: None,
            created_at: crate::db::ms_to_ts(crate::db::now_ms()),
        },
    )
    .unwrap();

    let input = input_of(&db, &session_id);
    let summary = input.summary.expect("the checkpoint is digest context");
    assert!(summary.text.contains("Keep the API stable"));
    assert!(!summary.truncated);
    assert_eq!(input.messages.len(), 1);
}

#[test]
fn input_stops_at_the_byte_budget_and_leaves_the_cursor_behind() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(&dir);
    let project = project_dir(&dir, "app");
    let session_id = session(&db, &project);
    // Two messages that cannot both fit: the second must wait for the next run.
    user_message(
        &db,
        &session_id,
        &"a".repeat(EXTRACTION_INPUT_MAX_BYTES - 200),
    );
    user_message(&db, &session_id, &"b".repeat(1_000));

    let input = input_of(&db, &session_id);
    assert_eq!(input.messages.len(), 1);
    assert!(input.bytes <= EXTRACTION_INPUT_MAX_BYTES);
}

#[test]
fn an_excluded_session_and_a_scheduled_run_are_never_read() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(&dir);
    let project = project_dir(&dir, "app");
    let session_id = session(&db, &project);
    user_message(&db, &session_id, "Remember the release checklist");

    db.set_memory_session_excluded(&session_id, true).unwrap();
    assert_eq!(skip_reason(&db, &session_id), "excluded");
    db.set_memory_session_excluded(&session_id, false).unwrap();
    assert_eq!(input_of(&db, &session_id).messages.len(), 1);

    // A session that owns a scheduled run is automation, not a conversation the
    // user opted into.
    db.conn()
        .execute(
            "INSERT INTO scheduled_tasks (id, title, prompt, cadence, enabled, created_at, updated_at)
             VALUES ('task-1', 'Nightly', 'Summarize', 'daily', 1, 1, 1)",
            [],
        )
        .unwrap();
    db.conn()
        .execute(
            "INSERT INTO task_runs (id, task_id, session_id, status, started_at)
             VALUES ('run-1', 'task-1', ?1, 'ok', 1)",
            params![session_id],
        )
        .unwrap();
    assert_eq!(skip_reason(&db, &session_id), "scheduled-run");
}

#[test]
fn an_imported_session_is_never_read() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(&dir);
    let project = project_dir(&dir, "app");
    let session_id = session(&db, &project);
    user_message(&db, &session_id, "Imported transcript content");
    db.conn()
        .execute(
            "UPDATE sessions SET source = 'claude-code' WHERE id = ?1",
            params![session_id],
        )
        .unwrap();
    assert_eq!(skip_reason(&db, &session_id), "imported");
}

// ---- daily budget ----------------------------------------------------------

#[test]
fn the_daily_counter_accumulates_within_a_day_and_resets_after_it() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(&dir);

    let first = db
        .record_memory_extraction_usage("2026-10-20", 1_200)
        .unwrap();
    assert_eq!(first.tokens, 1_200);
    assert_eq!(first.runs, 1);
    let second = db
        .record_memory_extraction_usage("2026-10-20", 800)
        .unwrap();
    assert_eq!(second.tokens, 2_000);
    assert_eq!(second.runs, 2);

    // A new local day starts from zero, which is what makes a paused switch
    // clear itself without a background reset job.
    let third = db
        .record_memory_extraction_usage("2026-10-21", 300)
        .unwrap();
    assert_eq!(third.tokens, 300);
    assert_eq!(third.runs, 1);
    assert_eq!(db.memory_extraction_budget().unwrap().day, "2026-10-21");
}

#[test]
fn a_budget_from_another_day_reads_as_unspent() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(&dir);
    db.record_memory_extraction_usage("2026-10-20", 200_000)
        .unwrap();
    let stored: ExtractionBudget = db.memory_extraction_budget().unwrap();
    assert_eq!(stored.tokens, 200_000);
    // The stored day is yesterday's, so today has spent nothing.
    assert_eq!(stored.day, "2026-10-20");
}
