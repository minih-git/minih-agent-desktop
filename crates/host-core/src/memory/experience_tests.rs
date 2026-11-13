//! The experience state machine: one archive, one extraction, three ways to end.
//!
//! These tests are about *state*, not about models: Main owns the model call, so
//! everything here drives the host's five transitions and the rules they carry —
//! the archive stamps exactly one pending row, `done` is terminal, a failure
//! keeps the task archived and counts its attempts, and a lesson the person
//! deleted never comes back.

use rusqlite::params;
use serde_json::json;

use super::experience::*;
use super::model::*;
use super::tests::open;
use crate::db::Database;

/// An employee, its task, and the task's own session — the shape `task.create`
/// leaves behind, without the workspace work.
fn seed_task(db: &Database, task_id: &str) -> String {
    let session_id = format!("session-{task_id}");
    db.conn()
        .execute(
            "INSERT OR IGNORE INTO sessions (id, title, role, created_at, updated_at)
             VALUES ('employee-1', 'Employee', 'bot', 1, 1)",
            [],
        )
        .unwrap();
    db.conn()
        .execute(
            "INSERT OR IGNORE INTO sessions (id, title, role, owner_session_id, created_at, updated_at)
             VALUES (?1, ?1, 'task', 'employee-1', 1, 1)",
            params![session_id],
        )
        .unwrap();
    db.conn()
        .execute(
            "INSERT INTO tasks (id, employee_session_id, session_id, title, origin, stage, created_at)
             VALUES (?1, 'employee-1', ?2, 'Fix the gate', 'steward', 'person/accept', 1)",
            params![task_id, session_id],
        )
        .unwrap();
    session_id
}

fn state(db: &Database, task_id: &str) -> ExperienceState {
    let raw: Option<String> = db
        .conn()
        .query_row(
            "SELECT experience_json FROM tasks WHERE id = ?1",
            params![task_id],
            |row| row.get(0),
        )
        .unwrap();
    ExperienceState::status_of(raw.as_deref())
}

fn archive(db: &Database, task_id: &str) {
    crate::tasks::archive(db, &json!({ "taskId": task_id })).unwrap();
}

fn candidate(kind: &str, content: &str) -> ExperienceCandidate {
    ExperienceCandidate {
        kind: kind.into(),
        content: content.into(),
        rationale: None,
    }
}

#[test]
fn archiving_stamps_exactly_one_pending_extraction() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(&dir);
    seed_task(&db, "task-1");
    // An open task owes nothing yet.
    assert!(db.experience_pending(10).unwrap().is_empty());
    archive(&db, "task-1");
    let stamped = state(&db, "task-1");
    assert_eq!(stamped.status, EXPERIENCE_PENDING);
    assert_eq!(stamped.attempts, 0);
    let pending = db.experience_pending(10).unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].task_id, "task-1");
    assert_eq!(pending[0].employee_session_id, "employee-1");

    // A second archive click keeps the first stamp: still one pending row, and
    // still the same one.
    archive(&db, "task-1");
    assert_eq!(db.experience_pending(10).unwrap().len(), 1);
    assert_eq!(state(&db, "task-1").status, EXPERIENCE_PENDING);
}

#[test]
fn a_completed_task_is_done_and_never_learns_twice() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(&dir);
    seed_task(&db, "task-1");
    archive(&db, "task-1");
    let claimed = db.experience_claim("task-1", 60_000).unwrap();
    assert!(claimed.is_some());
    // A second claim while the first lease is live is refused, so two runs in
    // the same process cannot both write.
    assert!(db.experience_claim("task-1", 60_000).unwrap().is_none());

    let complete = db
        .experience_complete(
            "task-1",
            &[
                candidate("fact", "the gate needs cargo fmt before clippy"),
                candidate("reference", "the migration test needs a v38 fixture"),
            ],
        )
        .unwrap();
    assert_eq!(complete.stored, 2);
    assert!(!complete.already_done);
    let done = state(&db, "task-1");
    assert_eq!(done.status, EXPERIENCE_DONE);
    assert_eq!(done.entry_ids.len(), 2);
    assert!(db.experience_pending(10).unwrap().is_empty());

    // The second run writes nothing, and the entries stay what they were.
    let again = db
        .experience_complete("task-1", &[candidate("fact", "a different lesson")])
        .unwrap();
    assert!(again.already_done);
    assert_eq!(again.stored, 0);
    let entries = db.experience_list("employee-1").unwrap();
    assert_eq!(entries.len(), 2);
    // Each lesson names the task it came from, which is what the settings page
    // shows beside it.
    assert_eq!(entries[0]["sourceTaskId"], json!("task-1"));
    assert_eq!(
        entries[0]["sourceTaskShortId"],
        json!(crate::tasks::short_id("task-1"))
    );
}

#[test]
fn the_switch_being_off_is_recorded_instead_of_a_model_call() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(&dir);
    seed_task(&db, "task-1");
    archive(&db, "task-1");
    let skipped = db.experience_skip("task-1").unwrap();
    assert_eq!(skipped.status, EXPERIENCE_SKIPPED_DISABLED);
    assert!(db.experience_pending(10).unwrap().is_empty());
    // Nothing was learned, so the employee has no lessons.
    assert!(db.experience_list("employee-1").unwrap().is_empty());
}

#[test]
fn a_failed_run_keeps_the_task_archived_and_is_retried_at_most_three_times() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(&dir);
    seed_task(&db, "task-1");
    archive(&db, "task-1");

    let first = db.experience_fail("task-1", "MODEL_CALL_FAILED").unwrap();
    assert_eq!(first.status, "failed:MODEL_CALL_FAILED");
    assert_eq!(first.attempts, 1);
    assert_eq!(db.experience_pending(10).unwrap().len(), 1);
    // The archive is untouched: a failed extraction is not a failed task.
    assert_eq!(state(&db, "task-1").status, "failed:MODEL_CALL_FAILED");

    db.experience_fail("task-1", "MODEL_CALL_FAILED").unwrap();
    assert_eq!(db.experience_pending(10).unwrap().len(), 1);
    let last = db.experience_fail("task-1", "BUDGET_EXHAUSTED").unwrap();
    assert_eq!(last.attempts, EXPERIENCE_MAX_ATTEMPTS);
    assert_eq!(last.status, EXPERIENCE_EXHAUSTED);
    // The cap is final: nothing is retried, and nothing is ever learned from it.
    assert!(db.experience_pending(10).unwrap().is_empty());
}

#[test]
fn a_deleted_lesson_never_comes_back() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(&dir);
    seed_task(&db, "task-1");
    archive(&db, "task-1");
    db.experience_complete(
        "task-1",
        &[candidate("fact", "the gate needs cargo fmt first")],
    )
    .unwrap();
    let entries = db.experience_list("employee-1").unwrap();
    let id = entries[0]["id"].as_str().unwrap().to_string();
    assert!(db.delete_memory_entry(&id).unwrap());

    // The next task that learns the same thing is refused by the tombstone, and
    // its run reports the refusal instead of resurrecting the entry.
    seed_task(&db, "task-2");
    archive(&db, "task-2");
    let complete = db
        .experience_complete(
            "task-2",
            &[candidate("fact", "the gate needs cargo fmt first")],
        )
        .unwrap();
    assert_eq!(complete.stored, 0);
    assert_eq!(complete.refused, 1);
    assert!(db.experience_list("employee-1").unwrap().is_empty());
}

#[test]
fn an_input_carries_the_tasks_own_facts_and_its_transcript_tail() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(&dir);
    db.conn()
        .execute(
            "INSERT INTO projects (path, name, created_at, last_opened_at)
             VALUES ('/repo/a', 'repo', 1, 1)",
            [],
        )
        .unwrap();
    let session_id = seed_task(&db, "task-1");
    db.conn()
        .execute(
            "UPDATE tasks SET branch = 'fix/gate', result_json = ?1,
                    blocker_json = ?2, project_id = (SELECT id FROM projects WHERE path = '/repo/a')
              WHERE id = 'task-1'",
            params![
                json!({ "summary": "the gate is green" }).to_string(),
                json!({ "status": "blocked", "where": "the v38 fixture" }).to_string()
            ],
        )
        .unwrap();
    for (seq, role, text) in [
        (1, "user", "fix the gate"),
        (2, "assistant", "cargo fmt then clippy"),
        (3, "tool", "tool output that is not material"),
    ] {
        db.conn()
            .execute(
                "INSERT INTO messages (id, session_id, seq, role, text, created_at, streaming, is_error)
                 VALUES (?1, ?2, ?3, ?4, ?5, 1, 0, 0)",
                params![format!("m-{seq}"), session_id, seq, role, text],
            )
            .unwrap();
    }
    archive(&db, "task-1");
    let input = db.experience_input("task-1").unwrap().unwrap();
    assert_eq!(input.task_id, "task-1");
    assert_eq!(input.short_id, crate::tasks::short_id("task-1"));
    assert_eq!(input.employee_name, "the employee");
    assert_eq!(input.project_path.as_deref(), Some("/repo/a"));
    assert_eq!(input.branch.as_deref(), Some("fix/gate"));
    assert_eq!(input.result.unwrap()["summary"], json!("the gate is green"));
    assert_eq!(input.blocker.unwrap()["where"], json!("the v38 fixture"));
    // The transcript keeps the two conversational roles and drops tool output,
    // and it is ordered oldest first, which is how the prompt reads it.
    let texts: Vec<&str> = input
        .messages
        .iter()
        .map(|message| message.text.as_str())
        .collect();
    assert_eq!(texts, vec!["fix the gate", "cargo fmt then clippy"]);
    assert!(!input.truncated);
}

#[test]
fn a_long_transcript_keeps_its_tail_and_says_it_was_cut() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(&dir);
    let session_id = seed_task(&db, "task-1");
    // Two messages, each larger than the whole budget: only the newest survives,
    // and it is cut, because sending nothing would spend a call to learn nothing.
    for (seq, text) in [
        (1, "old".repeat(20_000)),
        (2, format!("new{}", "x".repeat(40_000))),
    ] {
        db.conn()
            .execute(
                "INSERT INTO messages (id, session_id, seq, role, text, created_at, streaming, is_error)
                 VALUES (?1, ?2, ?3, 'assistant', ?4, 1, 0, 0)",
                params![format!("m-{seq}"), session_id, seq, text],
            )
            .unwrap();
    }
    archive(&db, "task-1");
    let input = db.experience_input("task-1").unwrap().unwrap();
    assert!(input.truncated);
    assert_eq!(input.messages.len(), 1);
    assert!(input.messages[0].text.starts_with("new"));
    assert!(input.messages[0].truncated);
    assert!(input.bytes <= 16 * 1024);
}
