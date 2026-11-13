//! The task row's own tests, moved out of `tasks.rs` when the module reached the
//! Rust budget (employee mode 0.5 slice 4b).
//!
//! They are the rules the row owns: a task session inherits its employee's
//! configuration but not its identity, the repository a task was given is the one
//! its session runs in, archiving is one timestamp in two places, and a reported
//! delivery moves the stage of the task bound to it.

use anyhow::Result;
use rusqlite::params;
use serde_json::{json, Value};

use crate::db::Database;
use crate::session_collaboration::repository;
use crate::tasks::*;

/// The ledger write `spawn` uses, reached through the same module so the
/// test does not need a plugin round trip to create one delivery.
fn send_record_for_test(
    db: &Database,
    input: &Value,
    target: &str,
    kind: &str,
) -> Result<crate::session_collaboration::Message> {
    crate::session_collaboration::dispatch_send_for_test(db, input, target, kind)
}

fn database() -> (tempfile::TempDir, Database) {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
    (dir, db)
}

fn employee(db: &Database, name: &str) -> String {
    crate::sessions::create_session_with_options(
        db,
        crate::sessions::SessionCreateOptions {
            title: Some(name.into()),
            mode: Some("agent".into()),
            permission_mode: Some("accept-edits".into()),
            thinking_level: Some("high".into()),
            role: Some("bot".into()),
            bot_profile_json: Some(
                json!({
                    "name": name,
                    "permissionMode": "accept-edits",
                    "mustAsk": [],
                    "observe": false
                })
                .to_string(),
            ),
            ..Default::default()
        },
    )
    .unwrap()
    .id
}

/// The inheritance rule, checked on the row a task session actually gets.
#[test]
fn a_task_session_inherits_the_employees_configuration_but_not_its_identity() {
    let (dir, db) = database();
    let repo = dir.path().join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    let repo_path = repo.to_string_lossy().to_string();
    let owner = crate::sessions::create_session_with_options(
        &db,
        crate::sessions::SessionCreateOptions {
            title: Some("Router 后端".into()),
            mode: Some("agent".into()),
            permission_mode: Some("accept-edits".into()),
            thinking_level: Some("high".into()),
            project_path: Some(repo_path.clone()),
            role: Some("bot".into()),
            bot_profile_json: Some(
                json!({"name": "Router 后端", "permissionMode": "accept-edits", "observe": false})
                    .to_string(),
            ),
            ..Default::default()
        },
    )
    .unwrap()
    .id;
    let created = create(
        &db,
        &json!({
            "employeeSessionId": owner,
            "title": "Fix the login timeout",
            "origin": "direct",
        }),
    )
    .unwrap();
    let session = &created["session"];
    assert_eq!(session["role"], json!("task"));
    assert_eq!(session["permissionMode"], json!("accept-edits"));
    assert_eq!(session["thinkingLevel"], json!("high"));
    // A project path is stored canonical, so a temporary directory on macOS
    // comes back as `/private/var/...`.
    assert_eq!(
        session["projectPath"].as_str().unwrap(),
        std::fs::canonicalize(&repo_path).unwrap().to_string_lossy()
    );
    assert!(session["botProfile"].is_null(), "a task is not an employee");
    let task = &created["task"];
    assert_eq!(task["employeeSessionId"], json!(owner));
    assert_eq!(task["origin"], json!("direct"));
    assert_eq!(task["stage"], json!("queued"));
    assert_eq!(task["projectPath"], session["projectPath"]);
    // The session points back at its employee, which is what an archive
    // and a later "show me this employee's work" read.
    let session_owner: Option<String> = db
        .conn()
        .query_row(
            "SELECT owner_session_id FROM sessions WHERE id=?1",
            params![task["sessionId"].as_str().unwrap()],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(session_owner.as_deref(), Some(owner.as_str()));
}

/// The repository a task was given is the one its session runs in.
///
/// The runtime launches a turn in the *session's* workspace, so a project
/// recorded only on the task row made the person's choice display-only: the
/// employee kept working in its own repository (#B2).
#[test]
fn a_task_session_runs_in_the_project_the_task_was_given() {
    let (dir, db) = database();
    let own = dir.path().join("desktop");
    let other = dir.path().join("router");
    std::fs::create_dir_all(&own).unwrap();
    std::fs::create_dir_all(&other).unwrap();
    let own_path = std::fs::canonicalize(&own)
        .unwrap()
        .to_string_lossy()
        .to_string();
    let other_path = std::fs::canonicalize(&other)
        .unwrap()
        .to_string_lossy()
        .to_string();
    let owner = crate::sessions::create_session_with_options(
        &db,
        crate::sessions::SessionCreateOptions {
            title: Some("后端".into()),
            mode: Some("agent".into()),
            project_path: Some(own_path.clone()),
            role: Some("bot".into()),
            bot_profile_json: Some(
                json!({"name": "后端", "permissionMode": "ask", "observe": false}).to_string(),
            ),
            ..Default::default()
        },
    )
    .unwrap()
    .id;
    let created = create(
        &db,
        &json!({
            "employeeSessionId": owner,
            "title": "补 remote_gateway 单测",
            "origin": "direct",
            "projectPath": other_path,
        }),
    )
    .unwrap();

    // The session is what the runtime reads, and it is what the person sees.
    assert_eq!(created["session"]["projectPath"], json!(other_path));
    assert_eq!(created["task"]["projectPath"], json!(other_path));
    // The employee keeps its own repository: a task's project is the task's,
    // not a change to the employee's profile.
    let employee_project: Option<String> = db
        .conn()
        .query_row(
            "SELECT p.path FROM sessions s LEFT JOIN projects p ON p.id = s.project_id
                 WHERE s.id = ?1",
            params![owner],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(employee_project.as_deref(), Some(own_path.as_str()));
    // One source of truth: the two rows cannot disagree.
    let (task_project, session_project): (Option<i64>, Option<i64>) = db
        .conn()
        .query_row(
            "SELECT t.project_id, s.project_id FROM tasks t
                 JOIN sessions s ON s.id = t.session_id WHERE t.id = ?1",
            params![created["task"]["id"].as_str().unwrap()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert!(task_project.is_some());
    assert_eq!(task_project, session_project);
}

#[test]
fn a_task_needs_an_employee_and_a_known_origin() {
    let (_dir, db) = database();
    let chat = crate::sessions::create_session_with_options(
        &db,
        crate::sessions::SessionCreateOptions {
            title: Some("Chat".into()),
            mode: Some("agent".into()),
            ..Default::default()
        },
    )
    .unwrap()
    .id;
    let error = create(
        &db,
        &json!({"employeeSessionId": chat, "title": "X", "origin": "direct"}),
    )
    .unwrap_err();
    assert!(error.to_string().contains("INVALID_ARGUMENT"), "{error}");
    let owner = employee(&db, "小爪");
    let error = create(
        &db,
        &json!({"employeeSessionId": owner, "title": "X", "origin": "somebody"}),
    )
    .unwrap_err();
    assert!(error.to_string().contains("INVALID_ARGUMENT"), "{error}");
    // Neither refusal left a task or a stray session behind.
    let tasks = list(&db, &json!({})).unwrap();
    assert_eq!(tasks["tasks"], json!([]));
    let sessions = crate::sessions::list_sessions(&db).unwrap();
    assert_eq!(sessions.len(), 2);
}

#[test]
fn archiving_moves_the_task_and_its_session_and_is_idempotent() {
    let (_dir, db) = database();
    let owner = employee(&db, "小爪");
    let created = create(
        &db,
        &json!({"employeeSessionId": owner, "title": "Fix it", "origin": "direct"}),
    )
    .unwrap();
    let id = created["task"]["id"].as_str().unwrap().to_string();
    let session_id = created["task"]["sessionId"].as_str().unwrap().to_string();
    assert_eq!(
        list(&db, &json!({})).unwrap()["tasks"]
            .as_array()
            .unwrap()
            .len(),
        1
    );

    let first = archive(&db, &json!({"taskId": id})).unwrap();
    assert!(first["task"]["archivedAt"].is_string());
    assert_eq!(list(&db, &json!({})).unwrap()["tasks"], json!([]));
    let with_history = list(&db, &json!({"includeArchived": true})).unwrap();
    assert_eq!(with_history["tasks"].as_array().unwrap().len(), 1);
    let archived_session: Option<i64> = db
        .conn()
        .query_row(
            "SELECT archived_at FROM sessions WHERE id=?1",
            params![session_id],
            |row| row.get(0),
        )
        .unwrap();
    assert!(
        archived_session.is_some(),
        "the session leaves with its task"
    );

    // A second click is the same answer, not an error.
    let second = archive(&db, &json!({"taskId": id})).unwrap();
    assert_eq!(second["archivedAt"], first["archivedAt"]);
    assert!(archive(&db, &json!({"taskId": "missing"})).is_err());
}

/// A ledger report moves the task bound to that delivery and nothing else.
#[test]
fn a_report_on_the_bound_delivery_moves_the_task_stage() {
    let (_dir, db) = database();
    let owner = employee(&db, "小爪");
    let sender = crate::sessions::create_session_with_options(
        &db,
        crate::sessions::SessionCreateOptions {
            title: Some("Steward".into()),
            mode: Some("agent".into()),
            permission_mode: Some("auto".into()),
            ..Default::default()
        },
    )
    .unwrap()
    .id;
    // The task session is the delivery's target, which is what a confirmed
    // card does: the work runs where the task is, not in the employee.
    let task_session = crate::sessions::create_session_with_options(
        &db,
        crate::sessions::SessionCreateOptions {
            title: Some("Fix the login timeout".into()),
            mode: Some("agent".into()),
            permission_mode: Some("accept-edits".into()),
            role: Some("task".into()),
            ..Default::default()
        },
    )
    .unwrap()
    .id;
    let delivery = send_record_for_test(
        &db,
        &json!({
            "sourceSessionId": sender,
            "pluginId": "builtin:session-messaging",
            "content": "Fix the login timeout",
            "idempotencyKey": "one",
            "notifyOnCompletion": false,
        }),
        &task_session,
        "task",
    )
    .unwrap();
    // A task row for that session, written directly so the test controls
    // which session the delivery targets.
    db.conn()
        .execute(
            "INSERT INTO tasks (id, employee_session_id, session_id, title, origin,
                  stage, delivery_id, created_at)
                 VALUES ('task-1', ?1, ?2, 'Fix the login timeout', 'steward', 'queued', ?3, 1)",
            params![owner, task_session, delivery.id],
        )
        .unwrap();
    let created = json!({"task": {"sessionId": task_session}});
    let id = "task-1".to_string();

    crate::session_collaboration::progress::report(&db, &delivery.id, 1, "progress", "working")
        .unwrap();
    assert_eq!(get_task(&db, &id).unwrap().unwrap().stage, "working");
    crate::session_collaboration::progress::report(
        &db,
        &delivery.id,
        2,
        "waiting",
        "person/answer",
    )
    .unwrap();
    assert_eq!(get_task(&db, &id).unwrap().unwrap().stage, "person/answer");

    // Settlement records the machine's own outcome.
    let task_session = created["task"]["sessionId"].as_str().unwrap().to_string();
    let turn =
        crate::session_collaboration::begin_turn(&db, &task_session, &delivery.id, None, None)
            .unwrap();
    db.conn()
        .execute(
            "UPDATE turns SET status='completed' WHERE id=?1",
            params![turn],
        )
        .unwrap();
    crate::session_collaboration::settle_turn(&db, &turn).unwrap();
    assert_eq!(get_task(&db, &id).unwrap().unwrap().stage, "person/accept");
}

/// A delivery that belongs to no task writes nothing, and payment of the
/// stage vocabulary is refused rather than stored.
#[test]
fn a_report_without_a_task_is_harmless_and_an_unknown_stage_is_refused() {
    let (_dir, db) = database();
    let owner = employee(&db, "小爪");
    create(
        &db,
        &json!({"employeeSessionId": owner, "title": "Fix it", "origin": "direct"}),
    )
    .unwrap();
    sync_stage(&db, db.conn(), "no-such-delivery", "working").unwrap();
    assert!(sync_stage(&db, db.conn(), "no-such-delivery", "person/waiting").is_err());
    let tasks = list(&db, &json!({})).unwrap();
    assert_eq!(tasks["tasks"][0]["stage"], json!("queued"));
}

/// The task a confirmed card creates is the delivery's target, so the work
/// reaches the task and not the employee's own transcript — and the card's
/// `repo.origin`, which is a git remote, never becomes a project row.
#[test]
fn a_confirmed_card_dispatches_into_a_new_task_of_that_employee() {
    let (dir, db) = database();
    let repo = dir.path().join("desktop");
    std::fs::create_dir_all(&repo).unwrap();
    let repo_path = std::fs::canonicalize(&repo)
        .unwrap()
        .to_string_lossy()
        .to_string();
    let projects_before: i64 = db
        .conn()
        .query_row("SELECT COUNT(*) FROM projects", [], |row| row.get(0))
        .unwrap();
    let steward = crate::sessions::create_session_with_options(
        &db,
        crate::sessions::SessionCreateOptions {
            title: Some("Steward".into()),
            mode: Some("agent".into()),
            permission_mode: Some("auto".into()),
            ..Default::default()
        },
    )
    .unwrap()
    .id;
    // The employee is bound to one repository, which is the project its work
    // runs in: a card names a remote, not a folder.
    let owner = crate::sessions::create_session_with_options(
        &db,
        crate::sessions::SessionCreateOptions {
            title: Some("小爪".into()),
            mode: Some("agent".into()),
            permission_mode: Some("accept-edits".into()),
            project_path: Some(repo_path.clone()),
            role: Some("bot".into()),
            bot_profile_json: Some(
                json!({"name": "小爪", "permissionMode": "accept-edits", "observe": false})
                    .to_string(),
            ),
            ..Default::default()
        },
    )
    .unwrap()
    .id;
    let card = json!({
        "goal": "Fix the login timeout",
        "criteria": [{"id": "c1", "text": "A failing repro exists"}],
        "boundaries": [],
        "permissionMode": "accept-edits",
        "mustAsk": [],
        "risk": "low",
        "repo": {"origin": "github.com/minih-git/minih-agent-desktop", "ref": "fix/login"},
    });
    let proposed = crate::session_collaboration::drafts::propose(
        &db,
        &json!({
            "sessionId": steward,
            "targetSessionId": owner,
            "sourceUtterance": "登录超时今天修掉",
            "card": card,
        }),
    )
    .unwrap();
    let draft_id = proposed["draft"]["id"].as_str().unwrap().to_string();
    let hash = proposed["draft"]["cardHash"].as_str().unwrap().to_string();
    let confirmed = crate::session_collaboration::drafts::confirm(
        &db,
        crate::session_collaboration::drafts::ConfirmRequest {
            draft_id: &draft_id,
            card_hash: &hash,
            confirmed_by: crate::session_collaboration::drafts::CONFIRMED_BY_USER,
            host_id: Some("mac-mini"),
            device_id: None,
            policy_version: "steward-1",
            notify_on_completion: true,
            idempotency_key: "confirm-1",
            project_path: None,
        },
    )
    .unwrap();
    let task = &confirmed["task"];
    assert_eq!(task["origin"], json!("steward"));
    assert_eq!(task["employeeSessionId"], json!(owner));
    // The card's `repo.ref` is the branch the person confirmed.
    assert_eq!(task["branch"], json!("fix/login"));
    assert_eq!(task["sourceUtterance"], json!("登录超时今天修掉"));
    // `repo.origin` is `host/owner/name`, so it must not create a project:
    // before this was fixed it produced a phantom row in the person's list.
    let projects_after: i64 = db
        .conn()
        .query_row("SELECT COUNT(*) FROM projects", [], |row| row.get(0))
        .unwrap();
    assert_eq!(
        projects_after,
        projects_before + 1,
        "only the employee's own repository is a project"
    );
    let phantom: i64 = db
        .conn()
        .query_row(
            "SELECT COUNT(*) FROM projects WHERE path LIKE 'github.com%'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(phantom, 0, "a git remote was stored as a project path");
    // The task works in the employee's project, and its session says so —
    // the session's project is what the runtime launches the turn in.
    assert_eq!(task["projectPath"], json!(repo_path));
    let session_project: Option<String> = db
        .conn()
        .query_row(
            "SELECT p.path FROM sessions s LEFT JOIN projects p ON p.id = s.project_id
                 WHERE s.id = ?1",
            params![task["sessionId"].as_str().unwrap()],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(session_project.as_deref(), Some(repo_path.as_str()));
    let delivery = repository::get(&db, confirmed["delivery"]["id"].as_str().unwrap())
        .unwrap()
        .unwrap();
    assert_eq!(delivery.target_session_id, task["sessionId"]);
    assert!(
        delivery
            .mandate_json
            .as_deref()
            .is_some_and(|raw| raw.contains("Fix the login timeout")),
        "the confirmed card travels with the delivery"
    );
}
