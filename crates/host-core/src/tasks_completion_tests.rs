//! The completion card's host half (employee mode 0.5 slice 4b): the employee's
//! own `ready` report, the person's acceptance, and what a new turn does to
//! both.
//!
//! These are the rules the card is rendered from, so they are proven at the row:
//! a report that cannot be read back, an acceptance that archives the task, or
//! an acceptance that survives a rejection are all bugs a screenshot cannot see.

use rusqlite::params;
use serde_json::json;

use crate::db::Database;
use crate::tasks;

fn database() -> (tempfile::TempDir, Database) {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
    (dir, db)
}

fn employee(db: &Database) -> String {
    crate::sessions::create_session_with_options(
        db,
        crate::sessions::SessionCreateOptions {
            title: Some("后端".into()),
            mode: Some("agent".into()),
            permission_mode: Some("accept-edits".into()),
            role: Some("bot".into()),
            bot_profile_json: Some(
                json!({"name": "后端", "permissionMode": "accept-edits", "observe": false})
                    .to_string(),
            ),
            ..Default::default()
        },
    )
    .unwrap()
    .id
}

/// One task under one employee, at `person/accept` — where a turn that ended
/// normally leaves it.
fn finished_task(db: &Database) -> (String, String) {
    let owner = employee(db);
    let created = tasks::create(
        db,
        &json!({"employeeSessionId": owner, "title": "Fix the login timeout", "origin": "direct"}),
    )
    .unwrap();
    let id = created["task"]["id"].as_str().unwrap().to_string();
    let session_id = created["task"]["sessionId"].as_str().unwrap().to_string();
    db.conn()
        .execute(
            "UPDATE tasks SET stage='person/accept', stage_seq=1 WHERE id=?1",
            params![id],
        )
        .unwrap();
    (id, session_id)
}

fn read(db: &Database, id: &str) -> tasks::Task {
    tasks::get_task(db, id).unwrap().unwrap()
}

/// The employee's own report of what it delivered, read back as the card shows
/// it: a summary, one line per criterion, and the leftovers.
#[test]
fn a_ready_report_is_stored_and_read_back_with_its_criteria() {
    let (_dir, db) = database();
    let (id, session_id) = finished_task(&db);
    let reported = tasks::report(
        &db,
        &json!({
            "sessionId": session_id,
            "status": "ready",
            "summary": "The timeout is 30s now and a retry reuses the token.",
            "acceptance": [
                {"criterion": "A failing repro exists", "met": true},
                {"criterion": "The timeout is configurable", "met": false, "note": "next slice"},
            ],
            "leftovers": ["The docs page still says 10s"],
        }),
    )
    .unwrap();
    assert_eq!(reported["result"]["status"], json!("ready"));

    let task = read(&db, &id);
    let result = task.result.expect("the report is on the row");
    assert_eq!(result.status, "ready");
    assert_eq!(
        result.summary,
        "The timeout is 30s now and a retry reuses the token."
    );
    assert_eq!(result.acceptance.len(), 2);
    assert!(result.acceptance[0].met);
    assert!(!result.acceptance[1].met);
    assert_eq!(result.acceptance[1].note.as_deref(), Some("next slice"));
    assert_eq!(result.leftovers, vec!["The docs page still says 10s"]);
    // A ready report is not a stage change: the stage still says what the turn
    // wrote when it ended, so a report cannot claim `person/accept` mid-turn.
    assert_eq!(task.stage, "person/accept");
    assert_eq!(task.accepted_at, None);
}

/// Two statuses, one tool. Anything else is refused rather than stored.
#[test]
fn the_report_tool_refuses_a_status_it_does_not_know() {
    let (_dir, db) = database();
    let (_id, session_id) = finished_task(&db);
    let error = tasks::report(
        &db,
        &json!({"sessionId": session_id, "status": "maybe", "summary": "x"}),
    )
    .unwrap_err();
    assert!(error.to_string().contains("INVALID_ARGUMENT"), "{error}");
    // A ready report without a summary is refused too: a card with no words is
    // not a completion card.
    let error =
        tasks::report(&db, &json!({"sessionId": session_id, "status": "ready"})).unwrap_err();
    assert!(error.to_string().contains("INVALID_ARGUMENT"), "{error}");
}

/// Accepting is not archiving: the row stays open with its timestamp, and a
/// second click keeps the first one.
#[test]
fn accepting_keeps_the_task_open_and_is_idempotent() {
    let (_dir, db) = database();
    let (id, _session) = finished_task(&db);
    let first = tasks::accept(&db, &json!({"taskId": id})).unwrap();
    let accepted_at = first["task"]["acceptedAt"].clone();
    assert!(accepted_at.is_string(), "{first}");
    let task = read(&db, &id);
    assert_eq!(task.archived_at, None, "accepting must not archive");
    assert_eq!(task.stage, "person/accept");

    let second = tasks::accept(&db, &json!({"taskId": id})).unwrap();
    assert_eq!(
        second["task"]["acceptedAt"], accepted_at,
        "a second click keeps the first timestamp"
    );
    assert!(tasks::accept(&db, &json!({"taskId": "missing"})).is_err());
}

/// 打回 and 追加要求 are both a user message, and a message starts a turn: the
/// acceptance and the previous result do not describe the new attempt.
#[test]
fn a_new_turn_clears_the_acceptance_and_the_previous_result() {
    let (_dir, db) = database();
    let (id, session_id) = finished_task(&db);
    tasks::report(
        &db,
        &json!({
            "sessionId": session_id,
            "status": "ready",
            "summary": "Done.",
        }),
    )
    .unwrap();
    tasks::accept(&db, &json!({"taskId": id})).unwrap();
    assert!(read(&db, &id).accepted_at.is_some());

    tasks::turn_began(&db, db.conn(), &session_id).unwrap();
    let task = read(&db, &id);
    assert_eq!(task.accepted_at, None, "a rejected task is not accepted");
    assert!(task.result.is_none(), "the previous result is gone");
    assert_eq!(task.stage, "working");
}

/// The batch a task belonged to is read from the card it came from, never
/// copied onto the task: one sentence split into three cards is one batch by
/// construction, and a task whose card had no batch is never grouped.
///
/// A new task is created by the person (`task.create`), so a card row only
/// exists for work that predates that. It is seeded here exactly as a
/// confirmation left it, because the subject of this test is the read.
#[test]
fn the_batch_of_a_task_is_read_from_its_card() {
    let (_dir, db) = database();
    let owner = employee(&db);
    let created = tasks::create(
        &db,
        &json!({
            "employeeSessionId": owner,
            "title": "把三个仓库的依赖对齐",
            "origin": "steward",
            "deliveryId": "delivery-1",
        }),
    )
    .unwrap();
    let task_id = created["task"]["id"].as_str().unwrap().to_string();
    assert!(read(&db, &task_id).batch_id.is_none(), "no card, no batch");

    db.conn()
        .execute(
            "INSERT INTO task_card_drafts
               (id, session_id, status, card_json, card_hash, source_utterance,
                target_session_id, confirmed_by, confirmed_at, delivery_id, batch_id,
                created_at, updated_at)
             VALUES ('draft-1', ?1, 'confirmed', '{}', 'hash-1', '三个仓库的依赖对齐',
                     ?1, 'user', 1, 'delivery-1', 'turn-42', 1, 1)",
            params![owner],
        )
        .unwrap();
    assert_eq!(read(&db, &task_id).batch_id.as_deref(), Some("turn-42"));
}
