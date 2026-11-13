//! The waiting channel and the one stage writer, tested where they are wired
//! (employee mode 0.5 slice 4a).
//!
//! Every test here starts from what a person or a runtime actually does — create
//! a task, begin a turn, end it, ask a question, answer it, report being stuck —
//! and asserts what the host then holds. That is the level the defects were
//! observed at:
//!
//! - a directly dispatched task stayed `queued` for ever, because only a
//!   delivery's report ever moved a stage;
//! - a question a task was waiting on was visible only inside the session it was
//!   asked in, so the sidebar showed a busy employee and the steward said
//!   nothing;
//! - a stuck task could not say where it got stuck, so the person got prose.

use serde_json::{json, Value};

use crate::db::{now_ms, Database};
use crate::session_collaboration;
use crate::sessions;
use crate::tasks;

fn database() -> (tempfile::TempDir, Database) {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
    (dir, db)
}

fn employee(db: &Database, name: &str, definition: Option<&str>) -> String {
    let mut profile = json!({
        "name": name,
        "permissionMode": "accept-edits",
        "mustAsk": [],
        "observe": false,
    });
    if let Some(definition) = definition {
        profile["definition"] = json!(definition);
    }
    sessions::create_session_with_options(
        db,
        sessions::SessionCreateOptions {
            title: Some(name.into()),
            mode: Some("agent".into()),
            permission_mode: Some("accept-edits".into()),
            role: Some("bot".into()),
            bot_profile_json: Some(profile.to_string()),
            ..Default::default()
        },
    )
    .unwrap()
    .id
}

/// One directly dispatched task: the person typed into the workbench, so there is
/// no delivery and no steward.
fn direct_task(db: &Database, owner: &str, title: &str) -> tasks::Task {
    let created = tasks::create(
        db,
        &json!({ "employeeSessionId": owner, "title": title, "origin": "direct" }),
    )
    .unwrap();
    tasks::get_task(db, created["task"]["id"].as_str().unwrap())
        .unwrap()
        .unwrap()
}

/// One task a confirmed card dispatched: it carries the delivery the steward's
/// card wrote, which is what a notice is addressed through.
fn steward_task(db: &Database, steward: &str, owner: &str, title: &str) -> tasks::Task {
    let task_session = sessions::create_session_with_options(
        db,
        sessions::SessionCreateOptions {
            title: Some(title.into()),
            mode: Some("agent".into()),
            permission_mode: Some("accept-edits".into()),
            role: Some("task".into()),
            ..Default::default()
        },
    )
    .unwrap()
    .id;
    let delivery = session_collaboration::dispatch_send_for_test(
        db,
        &json!({
            "sourceSessionId": steward,
            "pluginId": "builtin:session-messaging",
            "content": title,
            "idempotencyKey": format!("card:{title}"),
            "notifyOnCompletion": false,
        }),
        &task_session,
        "task",
    )
    .unwrap();
    let id = format!("task-{}", uuid::Uuid::new_v4());
    db.conn()
        .execute(
            "INSERT INTO tasks (id, employee_session_id, session_id, title, origin,
              stage, delivery_id, created_at)
             VALUES (?1, ?2, ?3, ?4, 'steward', 'queued', ?5, ?6)",
            rusqlite::params![id, owner, task_session, title, delivery.id, now_ms()],
        )
        .unwrap();
    tasks::get_task(db, &id).unwrap().unwrap()
}

fn stage_of(db: &Database, task: &tasks::Task) -> String {
    tasks::get_task(db, &task.id).unwrap().unwrap().stage
}

fn stage_notices(db: &Database, task_id: &str) -> Vec<Value> {
    let mut statement = db
        .conn()
        .prepare(
            "SELECT content FROM session_collaboration_messages
              WHERE kind='stage' AND content LIKE ?1 ORDER BY created_at",
        )
        .unwrap();
    let key = format!("%\"taskId\":\"{task_id}\"%");
    statement
        .query_map(rusqlite::params![key], |row| row.get::<_, String>(0))
        .unwrap()
        .map(|row| serde_json::from_str(&row.unwrap()).unwrap())
        .collect()
}

/// The defect that started this slice: a task the person started directly never
/// left `queued`, because only a delivery's report moved a stage.
#[test]
fn a_directly_dispatched_task_follows_its_own_turns() {
    let (_dir, db) = database();
    let owner = employee(&db, "Router 后端", None);
    let task = direct_task(&db, &owner, "Fix the login timeout");
    assert_eq!(stage_of(&db, &task), "queued");

    let turn = sessions::begin_turn(&db, &task.session_id, None, None).unwrap();
    assert_eq!(
        stage_of(&db, &task),
        "working",
        "a running turn is work in progress, not \"queued\""
    );

    sessions::end_turn(&db, &turn, "completed", None, None, false).unwrap();
    assert_eq!(
        stage_of(&db, &task),
        "person/accept",
        "finished work waits for the person"
    );

    // A follow-up turn moves it again: the stage follows the session, not the
    // first dispatch.
    let again = sessions::begin_turn(&db, &task.session_id, None, None).unwrap();
    assert_eq!(stage_of(&db, &task), "working");
    sessions::end_turn(&db, &again, "error", Some("PROVIDER_AUTH"), None, false).unwrap();
    assert_eq!(stage_of(&db, &task), "failed");
}

/// A steward's task is `working` while its turn runs, not `queued`: the delivery
/// was claimed, so nothing is waiting to be picked up.
#[test]
fn a_steward_task_is_working_while_its_turn_runs() {
    let (_dir, db) = database();
    let steward = employee(&db, "Super Agent", Some("steward"));
    let owner = employee(&db, "Router 后端", None);
    let task = steward_task(&db, &steward, &owner, "Fix the login timeout");

    sessions::begin_turn(&db, &task.session_id, None, None).unwrap();
    assert_eq!(stage_of(&db, &task), "working");
}

/// One stage change is one notice, however many times a settlement reaches the
/// same task.
#[test]
fn a_repeated_stage_write_is_not_a_second_wake() {
    let (_dir, db) = database();
    let steward = employee(&db, "Super Agent", Some("steward"));
    let owner = employee(&db, "Router 后端", None);
    let task = steward_task(&db, &steward, &owner, "Fix the login timeout");
    let delivery = task.delivery_id.clone().unwrap();

    let turn =
        session_collaboration::begin_turn(&db, &task.session_id, &delivery, None, None).unwrap();
    db.conn()
        .execute(
            "UPDATE turns SET status='error' WHERE id=?1",
            rusqlite::params![turn],
        )
        .unwrap();
    session_collaboration::settle_turn(&db, &turn).unwrap();
    assert_eq!(stage_of(&db, &task), "failed");
    let first = stage_notices(&db, &task.id);
    assert_eq!(first.len(), 1, "a failure is one notice");
    assert_eq!(first[0]["stage"], json!("failed"));

    // The same settlement again (a restarted Main, a replayed notification).
    session_collaboration::settle_turn(&db, &turn).unwrap();
    assert_eq!(
        stage_notices(&db, &task.id).len(),
        1,
        "the same stage is not announced twice"
    );
}

/// A task the person started directly never wakes the steward: she knows about it
/// from the briefing and must not interfere.
#[test]
fn a_direct_task_that_fails_does_not_wake_the_steward() {
    let (_dir, db) = database();
    let steward = employee(&db, "Super Agent", Some("steward"));
    let owner = employee(&db, "Router 后端", None);
    let task = direct_task(&db, &owner, "Fix the login timeout");
    let turn = sessions::begin_turn(&db, &task.session_id, None, None).unwrap();
    sessions::end_turn(&db, &turn, "error", Some("PROVIDER_AUTH"), None, false).unwrap();

    assert_eq!(stage_of(&db, &task), "failed");
    assert!(stage_notices(&db, &task.id).is_empty());
    let sent: i64 = db
        .conn()
        .query_row(
            "SELECT COUNT(*) FROM session_collaboration_messages WHERE target_session_id=?1",
            rusqlite::params![steward],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        sent, 0,
        "the steward was told about work she did not dispatch"
    );
}

/// A question asked in the task puts the task in `person/answer`, with the
/// question itself stored — and answering it puts the task back to work.
#[test]
fn a_question_waits_on_the_person_and_answering_resumes_the_work() {
    let (_dir, db) = database();
    let steward = employee(&db, "Super Agent", Some("steward"));
    let owner = employee(&db, "Router 后端", None);
    let task = steward_task(&db, &steward, &owner, "Fix the login timeout");
    let turn = sessions::begin_turn(&db, &task.session_id, None, None).unwrap();

    tasks::waiting_open(
        &db,
        &json!({
            "sessionId": task.session_id,
            "requestId": "ask-1",
            "kind": "ask",
            "question": "要保留旧的登录接口吗？",
            "options": ["保留", "直接删掉"],
        }),
    )
    .unwrap();

    let waiting = tasks::get_task(&db, &task.id).unwrap().unwrap();
    assert_eq!(waiting.stage, "person/answer");
    assert_eq!(waiting.waiting.len(), 1);
    assert_eq!(
        waiting.waiting[0].question.as_deref(),
        Some("要保留旧的登录接口吗？")
    );
    // The steward hears the question itself, not a summary of the transcript.
    let notices = stage_notices(&db, &task.id);
    assert_eq!(notices.len(), 1);
    assert_eq!(notices[0]["question"], json!("要保留旧的登录接口吗？"));

    tasks::waiting_close(&db, &json!({ "requestId": "ask-1" })).unwrap();
    let answered = tasks::get_task(&db, &task.id).unwrap().unwrap();
    assert!(answered.waiting.is_empty());
    assert_eq!(
        answered.stage, "working",
        "the turn is still running, so answering resumes the work"
    );
    // Closing is not a second announcement.
    assert_eq!(stage_notices(&db, &task.id).len(), 1);

    sessions::end_turn(&db, &turn, "completed", None, None, false).unwrap();
    assert_eq!(stage_of(&db, &task), "person/accept");
}

/// Answering does not have to come from the task session: the phone and an MCP
/// client know the request id, not the session.
#[test]
fn a_request_can_be_closed_by_its_own_id_alone() {
    let (_dir, db) = database();
    let owner = employee(&db, "Router 后端", None);
    let task = direct_task(&db, &owner, "Fix the login timeout");
    sessions::begin_turn(&db, &task.session_id, None, None).unwrap();
    tasks::waiting_open(
        &db,
        &json!({
            "sessionId": task.session_id,
            "requestId": "perm-9",
            "kind": "permission",
            "toolName": "Bash",
            "reason": "needs to run the test suite",
        }),
    )
    .unwrap();
    assert_eq!(stage_of(&db, &task), "person/answer");

    let closed = tasks::waiting_close(&db, &json!({ "requestId": "perm-9" })).unwrap();
    assert_eq!(closed["closed"], json!(true));
    assert_eq!(stage_of(&db, &task), "working");
}

/// A restart removes every open request: the sidecar that was holding them is
/// gone, so a card nobody can answer must not survive.
#[test]
fn a_restart_clears_every_open_request() {
    let (_dir, db) = database();
    let owner = employee(&db, "Router 后端", None);
    let task = direct_task(&db, &owner, "Fix the login timeout");
    sessions::begin_turn(&db, &task.session_id, None, None).unwrap();
    tasks::waiting_open(
        &db,
        &json!({
            "sessionId": task.session_id,
            "requestId": "ask-1",
            "kind": "ask",
            "question": "Which branch?",
        }),
    )
    .unwrap();

    session_collaboration::recover(&db).unwrap();
    let after = tasks::get_task(&db, &task.id).unwrap().unwrap();
    assert!(
        after.waiting.is_empty(),
        "a restarted app holds no requests"
    );
}

/// A directly dispatched task in `person/answer` counts as waiting on the person
/// and still does not wake the steward.
#[test]
fn a_direct_task_waiting_on_the_person_does_not_wake_the_steward() {
    let (_dir, db) = database();
    let steward = employee(&db, "Super Agent", Some("steward"));
    let owner = employee(&db, "Router 后端", None);
    let task = direct_task(&db, &owner, "Fix the login timeout");
    sessions::begin_turn(&db, &task.session_id, None, None).unwrap();
    tasks::waiting_open(
        &db,
        &json!({
            "sessionId": task.session_id,
            "requestId": "ask-1",
            "kind": "ask",
            "question": "Which branch?",
        }),
    )
    .unwrap();

    assert_eq!(stage_of(&db, &task), "person/answer");
    let point = tasks::task_status_point(&[tasks::get_task(&db, &task.id).unwrap().unwrap()]);
    assert_eq!(point["kind"], json!("stage"));
    assert_eq!(point["stage"], json!("person/answer"));
    assert!(stage_notices(&db, &task.id).is_empty());
    assert!(!steward.is_empty());
}

/// A report of being stuck holds the stage through the end of its own turn, and
/// its three fields are what the card shows.
#[test]
fn a_stuck_report_keeps_the_blocked_stage_after_its_turn_ends() {
    let (_dir, db) = database();
    let steward = employee(&db, "Super Agent", Some("steward"));
    let owner = employee(&db, "Router 后端", None);
    let task = steward_task(&db, &steward, &owner, "Fix the login timeout");
    let turn = sessions::begin_turn(&db, &task.session_id, None, None).unwrap();

    tasks::report_blocked(
        &db,
        &json!({
            "sessionId": task.session_id,
            "status": "blocked",
            "where": "迁移脚本要先在测试库上跑一遍",
            "tried": "本地跑过一次，缺 staging 的数据库权限",
            "suggestion": "给我一份 staging 的只读账号",
        }),
    )
    .unwrap();
    let blocked = tasks::get_task(&db, &task.id).unwrap().unwrap();
    assert_eq!(blocked.stage, "blocked");
    let blocker = blocked.blocker.unwrap();
    assert_eq!(blocker["where"], json!("迁移脚本要先在测试库上跑一遍"));
    assert_eq!(
        blocker["tried"],
        json!("本地跑过一次，缺 staging 的数据库权限")
    );
    assert_eq!(blocker["suggestion"], json!("给我一份 staging 的只读账号"));
    let notices = stage_notices(&db, &task.id);
    assert_eq!(notices.len(), 1);
    assert_eq!(notices[0]["blocker"]["where"], blocker["where"]);

    // The turn ending must not turn "stuck" into "finished, waiting for
    // acceptance".
    sessions::end_turn(&db, &turn, "completed", None, None, false).unwrap();
    let after = tasks::get_task(&db, &task.id).unwrap().unwrap();
    assert_eq!(after.stage, "blocked");
    assert!(after.blocker.is_some());
}

/// A stop by the person leaves the task stuck with `reason: "stopped"`, and
/// wakes nobody: it is not the machine's failure and not news.
#[test]
fn a_stopped_turn_is_stuck_and_silent() {
    let (_dir, db) = database();
    let steward = employee(&db, "Super Agent", Some("steward"));
    let owner = employee(&db, "Router 后端", None);
    let task = steward_task(&db, &steward, &owner, "Fix the login timeout");
    let turn = sessions::begin_turn(&db, &task.session_id, None, None).unwrap();
    sessions::end_turn(&db, &turn, "aborted", None, None, false).unwrap();

    let after = tasks::get_task(&db, &task.id).unwrap().unwrap();
    assert_eq!(after.stage, "blocked");
    assert_eq!(after.blocker.unwrap()["reason"], json!("stopped"));
    assert!(stage_notices(&db, &task.id).is_empty());
}

/// Handing a stuck task's work to somebody else proposes a card on the steward's
/// conversation with nobody assigned, and leaves the original task alone.
#[test]
fn reassigning_proposes_a_new_card_and_keeps_the_old_task() {
    let (_dir, db) = database();
    let steward = employee(&db, "Super Agent", Some("steward"));
    let owner = employee(&db, "Router 后端", None);
    let task = steward_task(&db, &steward, &owner, "Fix the login timeout");
    tasks::report_blocked(
        &db,
        &json!({
            "sessionId": task.session_id,
            "status": "blocked",
            "where": "缺 staging 凭据",
            "tried": "问了两次",
            "suggestion": "换个能拿到凭据的人",
        }),
    )
    .unwrap();

    let reassigned = tasks::reassign(
        &db,
        &json!({ "taskId": task.id, "reason": "从任务 #abc123 改派" }),
    )
    .unwrap();
    let draft = &reassigned["draft"];
    assert_eq!(draft["sessionId"], json!(steward));
    assert_eq!(
        draft["targetSessionId"],
        json!(""),
        "nobody is assigned yet"
    );
    assert_eq!(draft["card"]["reason"], json!("从任务 #abc123 改派"));
    assert_eq!(draft["card"]["goal"], json!("Fix the login timeout"));
    assert_eq!(draft["status"], json!("proposed"));

    // The old task is untouched: the person still decides what happens to it.
    let after = tasks::get_task(&db, &task.id).unwrap().unwrap();
    assert_eq!(after.stage, "blocked");
    assert!(after.archived_at.is_none());
}

/// Only an employee's work is a task: a conversation has no stage to move, and a
/// request in one is not the person's problem.
#[test]
fn a_conversation_is_not_a_task() {
    let (_dir, db) = database();
    let chat = sessions::create_session_with_options(
        &db,
        sessions::SessionCreateOptions {
            title: Some("Chat".into()),
            mode: Some("agent".into()),
            ..Default::default()
        },
    )
    .unwrap()
    .id;
    let turn = sessions::begin_turn(&db, &chat, None, None).unwrap();
    let opened = tasks::waiting_open(
        &db,
        &json!({
            "sessionId": chat,
            "requestId": "ask-1",
            "kind": "ask",
            "question": "Which branch?",
        }),
    )
    .unwrap();
    assert_eq!(opened["opened"], json!(false));
    sessions::end_turn(&db, &turn, "completed", None, None, false).unwrap();
    assert!(tasks::get_task(&db, &chat).unwrap().is_none());
}

/// A restart leaves no task claiming that work is happening.
///
/// The startup fence aborts every `running` turn with plain SQL and marks the
/// delivery `interrupted`; neither goes through `end_turn_settling`, so before
/// this fix a task that was `person/answer` (or `working`) kept that stage after
/// the restart: the sidebar counted a question nobody could answer, and the
/// steward's dock showed both a waiting row and a blocked card for one task.
#[test]
fn a_restart_leaves_every_open_task_stuck_rather_than_running() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("pi.sqlite");
    let (waiting_task, steward_task_id, steward_task_session) = {
        let db = Database::open(&path).unwrap();
        let steward = employee(&db, "Super Agent", Some("steward"));
        let owner = employee(&db, "Router 后端", None);
        // A directly dispatched task waiting on an answer.
        let waiting_task = direct_task(&db, &owner, "修一下登录超时");
        sessions::begin_turn(&db, &waiting_task.session_id, None, None).unwrap();
        tasks::waiting_open(
            &db,
            &json!({
                "sessionId": waiting_task.session_id,
                "requestId": "ask-1",
                "kind": "ask",
                "question": "要保留旧的登录接口吗？",
            }),
        )
        .unwrap();
        // A steward's task in the middle of a turn.
        let steward_task = steward_task(&db, &steward, &owner, "补 remote_gateway 单测");
        sessions::begin_turn(&db, &steward_task.session_id, None, None).unwrap();
        assert_eq!(stage_of(&db, &steward_task), "working");
        (
            waiting_task,
            steward_task.id.clone(),
            steward_task.session_id.clone(),
        )
    };
    // Reopen the same file: the boot fence aborts the running turns, and the
    // recovery that follows must stop the tasks that were mid-flight.
    let db = Database::open(&path).unwrap();

    let waiting = tasks::get_task(&db, &waiting_task.id).unwrap().unwrap();
    assert_eq!(waiting.stage, "blocked");
    assert_eq!(waiting.blocker.unwrap()["reason"], json!("interrupted"));
    assert!(waiting.waiting.is_empty(), "a restart holds no requests");

    let steward_row = tasks::get_task(&db, &steward_task_id).unwrap().unwrap();
    assert_eq!(steward_row.stage, "blocked");
    assert_eq!(steward_row.blocker.unwrap()["reason"], json!("interrupted"));
    // One interruption, one announcement: the delivery's own notice already went
    // out, and the stage recovery is silent.
    assert_eq!(stage_notices(&db, &steward_task_id).len(), 1);
    assert!(stage_notices(&db, &waiting_task.id).is_empty());
    assert!(!steward_task_session.is_empty());
}

/// A task whose turn is genuinely running is left alone by the recovery.
#[test]
fn the_recovery_leaves_a_running_task_alone() {
    let (_dir, db) = database();
    let owner = employee(&db, "Router 后端", None);
    let task = direct_task(&db, &owner, "修一下登录超时");
    sessions::begin_turn(&db, &task.session_id, None, None).unwrap();
    // The recovery is what `Database::open` runs; called by hand it must not
    // touch a task that still owns a running turn.
    let moved = tasks::recover_interrupted(&db, db.conn()).unwrap();
    assert_eq!(moved, 0);
    assert_eq!(stage_of(&db, &task), "working");
}

/// A stage that cannot be written costs the stage, not the turn (B8).
///
/// The write sits in the turn's own path, so an unguarded error meant a settled
/// turn could report a failed RPC — the conversation says it failed while the
/// transcript has the reply. Renaming the table is the crudest possible failure
/// and the one a corrupted file would produce.
#[test]
fn a_stage_that_cannot_be_written_does_not_fail_the_turn() {
    let (_dir, db) = database();
    let owner = employee(&db, "Router 后端", None);
    let task = direct_task(&db, &owner, "修一下登录超时");
    db.conn()
        .execute_batch("ALTER TABLE tasks RENAME TO tasks_hidden")
        .unwrap();

    let turn = sessions::begin_turn(&db, &task.session_id, None, None)
        .expect("a starting turn must not depend on the task list being writable");
    sessions::end_turn(&db, &turn, "completed", None, None, false)
        .expect("a settled turn must not depend on the task list being writable");
    db.conn()
        .execute_batch("ALTER TABLE tasks_hidden RENAME TO tasks")
        .unwrap();
    assert_eq!(stage_of(&db, &task), "queued");
}
