//! The inspection's conditions, its boundaries, and its calm (0.5 slice 5).
//!
//! The clock is injected, so every threshold is checked on both sides of its
//! edge without waiting hours: a task one millisecond short of two hours is not
//! an anomaly, and a task exactly at it is. The other half of the test file is
//! about restraint — no notice while work is moving, no repeat inside 24 hours,
//! and one merged notice however many tasks are stuck.

use rusqlite::params;
use serde_json::json;

use super::*;

const MINUTE: i64 = 60 * 1000;

fn database() -> (tempfile::TempDir, Database) {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
    (dir, db)
}

fn steward(db: &Database) {
    db.conn()
        .execute(
            "INSERT OR IGNORE INTO sessions (id, title, role, bot_profile_json, created_at, updated_at)
             VALUES ('steward', 'Super Agent', 'bot',
                     '{\"name\":\"Super Agent\",\"permissionMode\":\"ask\",\"mustAsk\":[],\"observe\":false,\"definition\":\"steward\"}',
                     1, 1)",
            [],
        )
        .unwrap();
}

fn employee(db: &Database) {
    db.conn()
        .execute(
            "INSERT OR IGNORE INTO sessions (id, title, role, bot_profile_json, created_at, updated_at)
             VALUES ('employee-1', 'Router 后端', 'bot',
                     '{\"name\":\"Router 后端\",\"permissionMode\":\"ask\",\"mustAsk\":[],\"observe\":false}',
                     1, 1)",
            [],
        )
        .unwrap();
}

struct TaskSeed<'a> {
    id: &'a str,
    stage: &'a str,
    origin: &'a str,
    stage_changed_at: Option<i64>,
    accepted_at: Option<i64>,
}

impl<'a> Default for TaskSeed<'a> {
    fn default() -> Self {
        Self {
            id: "task-1",
            stage: "working",
            origin: "steward",
            stage_changed_at: None,
            accepted_at: None,
        }
    }
}

fn task(db: &Database, seed: TaskSeed<'_>) -> String {
    employee(db);
    let session_id = format!("session-{}", seed.id);
    db.conn()
        .execute(
            "INSERT OR IGNORE INTO sessions (id, title, role, owner_session_id, created_at, updated_at)
             VALUES (?1, ?1, 'task', 'employee-1', 1, 1)",
            params![session_id],
        )
        .unwrap();
    db.conn()
        .execute(
            "INSERT INTO tasks
               (id, employee_session_id, session_id, title, origin, stage, stage_changed_at,
                accepted_at, created_at)
             VALUES (?1, 'employee-1', ?2, '修一下登录超时', ?3, ?4, ?5, ?6, 1)",
            params![
                seed.id,
                session_id,
                seed.origin,
                seed.stage,
                seed.stage_changed_at,
                seed.accepted_at
            ],
        )
        .unwrap();
    session_id
}

/// The ledger rows an inspection could have written.
fn notices_written(db: &Database) -> Vec<String> {
    let mut statement = db
        .conn()
        .prepare("SELECT content FROM session_collaboration_messages ORDER BY created_at")
        .unwrap();
    statement
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<rusqlite::Result<Vec<String>>>()
        .unwrap()
}

fn findings(value: &Value) -> Vec<(String, String, bool)> {
    value["findings"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| {
            (
                item["condition"].as_str().unwrap().to_string(),
                item["shortId"].as_str().unwrap().to_string(),
                item["direct"].as_bool().unwrap(),
            )
        })
        .collect()
}

#[test]
fn a_waiting_answer_is_reported_at_two_hours_and_not_a_minute_earlier() {
    let (_dir, db) = database();
    steward(&db);
    let now = 10_000_000_000;
    task(
        &db,
        TaskSeed {
            stage: "person/answer",
            stage_changed_at: Some(now - 2 * 60 * MINUTE + 1),
            ..TaskSeed::default()
        },
    );
    let early = inspect(&db, now).unwrap();
    assert!(
        findings(&early).is_empty(),
        "one minute short is not an anomaly"
    );
    assert!(notices_written(&db).is_empty());

    // One minute later the same task is overdue: the boundary is inclusive.
    let late = inspect(&db, now + 1).unwrap();
    assert_eq!(findings(&late)[0].0, "answer-wait");
    let written = notices_written(&db);
    assert_eq!(written.len(), 1);
    let payload: Value = serde_json::from_str(&written[0]).unwrap();
    assert_eq!(payload["reason"], json!("inspection"));
    assert_eq!(payload["entries"].as_array().unwrap().len(), 1);
}

#[test]
fn finished_work_is_reported_at_a_day_unless_it_was_accepted() {
    let (_dir, db) = database();
    steward(&db);
    let now = 10_000_000_000;
    task(
        &db,
        TaskSeed {
            id: "task-open",
            stage: "person/accept",
            stage_changed_at: Some(now - ACCEPT_WAIT_MS),
            ..TaskSeed::default()
        },
    );
    task(
        &db,
        TaskSeed {
            id: "task-accepted",
            stage: "person/accept",
            stage_changed_at: Some(now - ACCEPT_WAIT_MS - MINUTE),
            // The person already said the work is fine; the merge can wait.
            accepted_at: Some(now - MINUTE),
            ..TaskSeed::default()
        },
    );
    let result = inspect(&db, now).unwrap();
    let reported = findings(&result);
    assert_eq!(reported.len(), 1);
    assert_eq!(reported[0].0, "accept-wait");
    assert_eq!(result["findings"][0]["taskId"], json!("task-open"));
}

#[test]
fn a_stuck_task_is_reported_after_four_hours_with_or_without_its_stage() {
    let (_dir, db) = database();
    steward(&db);
    let now = 10_000_000_000;
    task(
        &db,
        TaskSeed {
            id: "task-blocked",
            stage: "blocked",
            stage_changed_at: Some(now - STUCK_MS),
            ..TaskSeed::default()
        },
    );
    let result = inspect(&db, now).unwrap();
    assert_eq!(findings(&result)[0].0, "stuck");
}

#[test]
fn an_unknown_stage_time_is_not_an_anomaly() {
    let (_dir, db) = database();
    steward(&db);
    let now = 10_000_000_000;
    // A row from before `stage_changed_at` existed: "stuck since forever" is a
    // guess, and the inspection does not guess.
    task(
        &db,
        TaskSeed {
            stage: "person/answer",
            stage_changed_at: None,
            ..TaskSeed::default()
        },
    );
    let result = inspect(&db, now).unwrap();
    assert!(findings(&result).is_empty());
    assert!(notices_written(&db).is_empty());
}

#[test]
fn a_long_running_turn_is_reported_but_a_short_one_is_not() {
    let (_dir, db) = database();
    steward(&db);
    let now = 10_000_000_000;
    let session_id = task(
        &db,
        TaskSeed {
            id: "task-running",
            stage: "working",
            stage_changed_at: Some(now - MINUTE),
            ..TaskSeed::default()
        },
    );
    db.conn()
        .execute(
            "INSERT INTO turns (id, session_id, status, started_at)
             VALUES ('turn-1', ?1, 'running', ?2)",
            params![session_id, now - RUNNING_TOO_LONG_MS - MINUTE],
        )
        .unwrap();
    let result = inspect(&db, now).unwrap();
    assert_eq!(findings(&result)[0].0, "running-long");

    // A fresh turn on another task is simply work in progress.
    let quiet = task(
        &db,
        TaskSeed {
            id: "task-fresh",
            stage: "working",
            stage_changed_at: Some(now - MINUTE),
            ..TaskSeed::default()
        },
    );
    db.conn()
        .execute(
            "INSERT INTO turns (id, session_id, status, started_at)
             VALUES ('turn-2', ?1, 'running', ?2)",
            params![quiet, now - MINUTE],
        )
        .unwrap();
    // An hour later the fresh turn is still young, and the stalled one has just
    // been mentioned: the inspection says nothing at all.
    let hour = inspect(&db, now + 60 * MINUTE).unwrap();
    assert!(findings(&hour).is_empty());

    // Three hours after it started, the fresh turn is a stall of its own.
    let later = inspect(&db, now + 3 * 60 * MINUTE).unwrap();
    let reported = findings(&later);
    assert_eq!(reported.len(), 1);
    assert_eq!(reported[0].0, "running-long");
}

#[test]
fn the_same_condition_is_not_repeated_inside_a_day() {
    let (_dir, db) = database();
    steward(&db);
    let now = 10_000_000_000;
    task(
        &db,
        TaskSeed {
            stage: "person/answer",
            stage_changed_at: Some(now - ANSWER_WAIT_MS),
            ..TaskSeed::default()
        },
    );
    assert_eq!(findings(&inspect(&db, now).unwrap()).len(), 1);
    assert_eq!(notices_written(&db).len(), 1);

    // The hourly timer fires again, and again says nothing.
    assert!(findings(&inspect(&db, now + 60 * MINUTE).unwrap()).is_empty());
    assert!(findings(&inspect(&db, now + 23 * 60 * MINUTE).unwrap()).is_empty());
    assert_eq!(notices_written(&db).len(), 1);

    // A day later it is worth one more mention.
    assert_eq!(
        findings(&inspect(&db, now + REMIND_AFTER_MS).unwrap()).len(),
        1
    );
    assert_eq!(notices_written(&db).len(), 2);
}

#[test]
fn one_run_writes_one_merged_notice_and_marks_direct_tasks() {
    let (_dir, db) = database();
    steward(&db);
    let now = 10_000_000_000;
    task(
        &db,
        TaskSeed {
            id: "task-answer",
            stage: "person/answer",
            stage_changed_at: Some(now - ANSWER_WAIT_MS),
            ..TaskSeed::default()
        },
    );
    task(
        &db,
        TaskSeed {
            id: "task-direct",
            stage: "blocked",
            // Started by the person in the employee's own workbench.
            origin: "direct",
            stage_changed_at: Some(now - STUCK_MS),
            ..TaskSeed::default()
        },
    );
    let result = inspect(&db, now).unwrap();
    let reported = findings(&result);
    assert_eq!(reported.len(), 2);
    assert_eq!(result["notified"], json!(2));

    // Exactly one ledger row carries both, and the direct one says so.
    let written = notices_written(&db);
    assert_eq!(written.len(), 1);
    let payload: Value = serde_json::from_str(&written[0]).unwrap();
    assert_eq!(payload["reason"], json!("inspection"));
    let entries = payload["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 2);
    let direct = entries
        .iter()
        .find(|entry| entry["taskId"] == json!("task-direct"))
        .unwrap();
    assert_eq!(direct["direct"], json!(true));
    let relayed = entries
        .iter()
        .find(|entry| entry["taskId"] == json!("task-answer"))
        .unwrap();
    assert_eq!(relayed["direct"], json!(false));

    // The notice is addressed to the steward, as a `stage` row, and asks for
    // nothing on completion — she is woken to say one sentence.
    let (kind, target, status): (String, String, String) = db
        .conn()
        .query_row(
            "SELECT kind, target_session_id, status FROM session_collaboration_messages",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(kind, "stage");
    assert_eq!(target, "steward");
    assert_eq!(status, "queued");
}

#[test]
fn progress_says_nothing() {
    let (_dir, db) = database();
    steward(&db);
    let now = 10_000_000_000;
    task(
        &db,
        TaskSeed {
            stage: "working",
            stage_changed_at: Some(now - MINUTE),
            ..TaskSeed::default()
        },
    );
    let result = inspect(&db, now).unwrap();
    assert!(findings(&result).is_empty());
    assert_eq!(result["notified"], json!(0));
    assert!(notices_written(&db).is_empty());
}

#[test]
fn without_a_steward_the_person_still_sees_the_task() {
    let (_dir, db) = database();
    // No steward row at all: nothing to address, and nothing to fail.
    let now = 10_000_000_000;
    task(
        &db,
        TaskSeed {
            stage: "person/answer",
            stage_changed_at: Some(now - ANSWER_WAIT_MS),
            ..TaskSeed::default()
        },
    );
    let result = inspect(&db, now).unwrap();
    assert_eq!(findings(&result).len(), 1);
    assert_eq!(result["notified"], json!(0));
    assert!(notices_written(&db).is_empty());
}
