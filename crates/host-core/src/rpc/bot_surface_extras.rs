//! The employee surface's slice-3 additions, proved on the real RPC route.
//!
//! `mod tests` in `rpc/mod.rs` is a 1 000-line block that a large edit can
//! misplace; these methods are asserted here instead, against the same
//! `handle_request` entry point the desktop's calls reach, so a missing routing
//! arm still fails.

use std::sync::Arc;

use serde_json::json;
use tokio::sync::{mpsc, Mutex};

use super::{handle_request, AppState};
use crate::sessions;

fn employee(db: &crate::db::Database, name: &str) -> String {
    let profile = json!({
        "name": name,
        "duty": format!("{name} duty"),
        "permissionMode": "ask",
        "mustAsk": [],
        "observe": false,
    });
    sessions::create_session_with_options(
        db,
        sessions::SessionCreateOptions {
            title: Some(name.into()),
            mode: Some("agent".into()),
            permission_mode: Some("ask".into()),
            role: Some("bot".into()),
            bot_profile_json: Some(profile.to_string()),
            ..Default::default()
        },
    )
    .unwrap()
    .id
}

/// `task.reassign` answers on the real route and puts the work under the
/// employee the person picked: a new task of their own, at `origin = direct`,
/// with the old one left exactly as it was.
#[tokio::test]
async fn task_reassign_creates_the_work_under_the_new_employee() {
    let dir = tempfile::tempdir().unwrap();
    let mut app = AppState::open(dir.path()).unwrap();
    app.handshook = true;
    let owner = employee(&app.db, "Router 后端");
    let other = employee(&app.db, "界面");
    let created = crate::tasks::create(
        &app.db,
        &json!({"employeeSessionId": owner, "title": "补单测", "origin": "direct"}),
    )
    .unwrap();
    let task_id = created["task"]["id"].as_str().unwrap().to_string();
    let state = Arc::new(Mutex::new(app));
    let tx = mpsc::unbounded_channel().0;

    let reassigned = handle_request(
        state.clone(),
        "task.reassign",
        json!({ "taskId": task_id, "employeeSessionId": other }),
        tx.clone(),
    )
    .await
    .unwrap_or_else(|error| panic!("task.reassign must be routed: {error:?}"));
    assert_eq!(reassigned["task"]["employeeSessionId"], json!(other));
    assert_eq!(reassigned["task"]["origin"], json!("direct"));
    assert_eq!(reassigned["task"]["title"], json!("补单测"));
    assert_eq!(reassigned["reassignedFrom"]["id"], json!(task_id));
    assert_ne!(reassigned["task"]["id"], json!(task_id));
    assert_eq!(
        reassigned["reassignedFrom"]["archivedAt"],
        serde_json::Value::Null,
        "the original task is left for the person to decide about"
    );
}
/// `task.restart` answers on the real route and refuses a task that was never
/// interrupted.
#[tokio::test]
async fn task_restart_is_routed_and_refuses_a_task_that_is_not_interrupted() {
    let dir = tempfile::tempdir().unwrap();
    let mut app = AppState::open(dir.path()).unwrap();
    app.handshook = true;
    let worker = employee(&app.db, "Router 后端");
    let created = crate::tasks::create(
        &app.db,
        &json!({"employeeSessionId": worker, "title": "补单测", "origin": "direct"}),
    )
    .unwrap();
    let task_id = created["task"]["id"].as_str().unwrap().to_string();
    let state = Arc::new(Mutex::new(app));
    let tx = mpsc::unbounded_channel().0;

    let error = handle_request(
        state.clone(),
        "task.restart",
        json!({ "taskId": task_id }),
        tx.clone(),
    )
    .await
    .expect_err("a task with no interrupted delivery cannot restart");
    assert!(
        !error.message.contains("method not found"),
        "task.restart is not routed to a handler: {}",
        error.message
    );
    assert!(
        error.message.contains("CONFLICT"),
        "the refusal names the reason: {}",
        error.message
    );

    // The method itself is routed even with no arguments.
    let error = handle_request(state, "task.restart", json!({}), tx)
        .await
        .expect_err("task.restart needs a task id");
    assert!(
        !error.message.contains("method not found"),
        "task.restart is not routed to a handler: {}",
        error.message
    );
}
