//! The employee surface's slice-3 additions, proved on the real RPC route.
//!
//! `mod tests` in `rpc/mod.rs` is a 1 000-line block that a large edit can
//! misplace; these two methods are asserted here instead, against the same
//! `handle_request` entry point the desktop's calls reach, so a missing routing
//! arm still fails.

use std::sync::Arc;

use serde_json::json;
use tokio::sync::{mpsc, Mutex};

use super::{handle_request, AppState};
use crate::sessions;

fn employee(db: &crate::db::Database, name: &str, definition: Option<&str>) -> String {
    let mut profile = json!({
        "name": name,
        "duty": format!("{name} duty"),
        "permissionMode": "ask",
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
            permission_mode: Some("ask".into()),
            role: Some("bot".into()),
            bot_profile_json: Some(profile.to_string()),
            ..Default::default()
        },
    )
    .unwrap()
    .id
}

/// `bot.roster` answers on the real route, and the secretary is not in the list
/// she chooses from.
#[tokio::test]
async fn bot_roster_is_routed_and_leaves_out_the_secretary() {
    let dir = tempfile::tempdir().unwrap();
    let mut app = AppState::open(dir.path()).unwrap();
    app.handshook = true;
    let steward = employee(&app.db, "秘书", Some("steward"));
    let backend = employee(&app.db, "Router 后端", None);
    let state = Arc::new(Mutex::new(app));
    let tx = mpsc::unbounded_channel().0;

    let roster = handle_request(
        state.clone(),
        "bot.roster",
        json!({ "sessionId": steward }),
        tx.clone(),
    )
    .await
    .unwrap_or_else(|error| panic!("bot.roster must be routed: {error:?}"));
    let employees = roster["employees"]
        .as_array()
        .expect("bot.roster returns employees");
    assert_eq!(employees.len(), 1, "{roster}");
    assert_eq!(employees[0]["sessionId"], json!(backend));
    assert_eq!(employees[0]["name"], json!("Router 后端"));
    assert_eq!(employees[0]["duty"], json!("Router 后端 duty"));
    assert_eq!(employees[0]["openTaskCount"], json!(0));
    assert_eq!(employees[0]["idle"], json!(true));
    assert!(employees[0]["repos"].is_array());
    assert_eq!(employees[0]["status"], json!({"kind": "idle"}));
}

/// `task.restart` answers on the real route and refuses a task that was never
/// interrupted.
#[tokio::test]
async fn task_restart_is_routed_and_refuses_a_task_that_is_not_interrupted() {
    let dir = tempfile::tempdir().unwrap();
    let mut app = AppState::open(dir.path()).unwrap();
    app.handshook = true;
    let worker = employee(&app.db, "Router 后端", None);
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
