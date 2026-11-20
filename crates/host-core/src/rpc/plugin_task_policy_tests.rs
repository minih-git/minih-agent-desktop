//! The runtime safety policy of a task a plugin created (`tasks.plugin_id`).
//!
//! A plugin task is an ordinary task session with a narrower trust story, so
//! every test asserts both halves: inside one, the plugin's own tools always
//! ask and a session grant buys nothing; outside one, the same rules keep their
//! old answer. `permissions.evaluate` is the preview the renderer shows and the
//! same evaluation `tools.execute` performs, so the preview assertions are gate
//! assertions, and the subagent test goes through `tools.execute` itself.

use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::{mpsc, Mutex};

use crate::db::canonical_project_path;
use crate::rpc::handle_request;
use crate::sessions::SessionCreateOptions;
use crate::state::AppState;

async fn open() -> (tempfile::TempDir, Arc<Mutex<AppState>>) {
    let dir = tempfile::tempdir().unwrap();
    let mut app_state = AppState::open(dir.path()).unwrap();
    app_state.handshook = true;
    (dir, Arc::new(Mutex::new(app_state)))
}

fn project(dir: &tempfile::TempDir, name: &str) -> String {
    let path = dir.path().join(name);
    std::fs::create_dir_all(&path).unwrap();
    canonical_project_path(path.to_str().unwrap()).unwrap()
}

/// The employee a task belongs to. A task needs one, and it is never the
/// session under test.
fn employee(state: &AppState, dir: &tempfile::TempDir) -> String {
    crate::sessions::create_session_with_options(
        &state.db,
        SessionCreateOptions {
            title: Some("employee".into()),
            mode: Some("agent".into()),
            permission_mode: Some("accept-edits".into()),
            project_path: Some(project(dir, "employee")),
            role: Some("bot".into()),
            bot_profile_json: Some(
                json!({
                    "name": "employee",
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

/// A real task session. `plugin_id` is what the v43 column records and the only
/// thing that makes the task a plugin's.
fn task_session(
    state: &AppState,
    employee: &str,
    title: &str,
    project_path: String,
    permission_mode: &str,
    plugin_id: Option<&str>,
) -> String {
    let task = crate::tasks::create_in(
        &state.db,
        state.db.conn(),
        crate::tasks::CreateRequest {
            employee_session_id: employee,
            title,
            origin: "direct",
            project_path: Some(project_path),
            branch: None,
            source_utterance: None,
            delivery_id: None,
            permission_mode: Some(permission_mode),
            relay_parent_task_id: None,
            relay_state: None,
        },
    )
    .unwrap();
    if let Some(plugin_id) = plugin_id {
        state
            .db
            .conn()
            .execute(
                "UPDATE tasks SET plugin_id=?2 WHERE id=?1",
                rusqlite::params![task.id, plugin_id],
            )
            .unwrap();
    }
    task.session_id
}

async fn evaluate(
    state: &Arc<Mutex<AppState>>,
    session_id: &str,
    tool_name: &str,
    declared_risk: Option<&str>,
    args: Value,
) -> Value {
    let mut request = json!({ "sessionId": session_id, "toolName": tool_name, "args": args });
    if let Some(risk) = declared_risk {
        request["declaredRisk"] = json!(risk);
    }
    handle_request(
        state.clone(),
        "permissions.evaluate",
        request,
        mpsc::unbounded_channel().0,
    )
    .await
    .unwrap()
}

fn grant(state: &mut AppState, session_id: &str, tool_name: &str) {
    state
        .session_grants
        .entry(session_id.to_string())
        .or_default()
        .push(tool_name.to_string());
}

#[tokio::test]
async fn a_plugin_tool_always_asks_inside_a_plugin_task() {
    let (dir, state) = open().await;
    let (plain, plugin_task) = {
        let st = state.lock().await;
        let employee = employee(&st, &dir);
        (
            task_session(
                &st,
                &employee,
                "plain task",
                project(&dir, "plain"),
                "auto",
                None,
            ),
            task_session(
                &st,
                &employee,
                "plugin task",
                project(&dir, "plugin"),
                "auto",
                Some("acme"),
            ),
        )
    };

    // Outside a plugin task the low-risk auto-allow is untouched, in every
    // permission mode the task session can carry.
    for declared in [None, Some("low")] {
        let ordinary = evaluate(&state, &plain, "plugin_acme_run", declared, json!({})).await;
        assert_eq!(ordinary["decision"], json!("allow-once"), "{ordinary}");
        assert_eq!(
            ordinary["risk"],
            json!(declared.unwrap_or("medium")),
            "{ordinary}"
        );
    }

    // Inside one the same call always needs the person, even under auto and
    // even when the plugin declared it low risk.
    for declared in [None, Some("low")] {
        let guarded = evaluate(&state, &plugin_task, "plugin_acme_run", declared, json!({})).await;
        assert_eq!(guarded["decision"], Value::Null, "{guarded}");
        // The host raises a plugin's self-declared low risk to medium.
        assert_eq!(guarded["risk"], json!("medium"), "{guarded}");
    }

    // The host's own read-only tools keep their free path in both.
    for session_id in [&plain, &plugin_task] {
        let read = evaluate(
            &state,
            session_id,
            "Read",
            None,
            json!({ "path": "note.txt" }),
        )
        .await;
        assert_eq!(read["decision"], json!("allow-once"), "{read}");
    }
}

#[tokio::test]
async fn a_session_grant_does_not_skip_the_plugin_task_gate() {
    let (dir, state) = open().await;
    let (plain, plugin_task) = {
        let mut st = state.lock().await;
        let employee = employee(&st, &dir);
        let plain = task_session(
            &st,
            &employee,
            "plain task",
            project(&dir, "plain"),
            "ask",
            None,
        );
        let plugin_task = task_session(
            &st,
            &employee,
            "plugin task",
            project(&dir, "plugin"),
            "ask",
            Some("acme"),
        );
        for session_id in [&plain, &plugin_task] {
            grant(&mut st, session_id, "Bash");
            grant(&mut st, session_id, "Read");
        }
        (plain, plugin_task)
    };

    // A standing grant still answers for an ordinary task.
    let plain_bash = evaluate(&state, &plain, "Bash", None, json!({ "command": "ls" })).await;
    assert_eq!(
        plain_bash["decision"],
        json!("allow-session"),
        "{plain_bash}"
    );

    // In a plugin task every call is asked again, plugin tool or not.
    for tool in ["Bash", "plugin_acme_run", "TodoWrite", "TaskReport"] {
        let guarded = evaluate(&state, &plugin_task, tool, Some("low"), json!({})).await;
        assert_eq!(guarded["decision"], Value::Null, "{tool}: {guarded}");
    }

    // An outside-path grant is ignored the same way.
    let outside = dir.path().join("outside");
    std::fs::create_dir_all(&outside).unwrap();
    let outside_note = outside.join("note.txt");
    std::fs::write(&outside_note, "outside").unwrap();
    let args = json!({ "path": outside_note.to_string_lossy() });
    let plain_read = evaluate(&state, &plain, "Read", None, args.clone()).await;
    assert_eq!(
        plain_read["decision"],
        json!("allow-session"),
        "{plain_read}"
    );
    let guarded_read = evaluate(&state, &plugin_task, "Read", None, args).await;
    assert_eq!(guarded_read["decision"], Value::Null, "{guarded_read}");
    assert_eq!(guarded_read["externalPathPermission"], json!(true));
}

#[tokio::test]
async fn an_outside_path_still_asks_inside_a_plugin_task() {
    let (dir, state) = open().await;
    let outside = dir.path().join("outside");
    std::fs::create_dir_all(&outside).unwrap();
    let outside_note = outside.join("note.txt");
    std::fs::write(&outside_note, "outside").unwrap();
    let outside_args = json!({ "path": outside_note.to_string_lossy() });
    let (plain, plugin_task) = {
        let st = state.lock().await;
        let employee = employee(&st, &dir);
        (
            task_session(
                &st,
                &employee,
                "plain auto",
                project(&dir, "plain"),
                "auto",
                None,
            ),
            task_session(
                &st,
                &employee,
                "plugin auto",
                project(&dir, "plugin"),
                "auto",
                Some("acme"),
            ),
        )
    };

    // Auto still opens an outside path for an ordinary task...
    let ordinary = evaluate(&state, &plain, "Read", None, outside_args.clone()).await;
    assert_eq!(ordinary["decision"], json!("allow-once"), "{ordinary}");
    // ...and never does inside a plugin task.
    let guarded = evaluate(&state, &plugin_task, "Read", None, outside_args).await;
    assert_eq!(guarded["decision"], Value::Null, "{guarded}");
    assert_eq!(guarded["externalPathPermission"], json!(true));

    // Accept-edits keeps its own answer: the workspace write is free, the
    // outside write is not.
    let (plain_edits, plugin_edits) = {
        let st = state.lock().await;
        let employee = employee(&st, &dir);
        (
            task_session(
                &st,
                &employee,
                "plain edits",
                project(&dir, "plain-edits"),
                "accept-edits",
                None,
            ),
            task_session(
                &st,
                &employee,
                "plugin edits",
                project(&dir, "plugin-edits"),
                "accept-edits",
                Some("acme"),
            ),
        )
    };
    for session_id in [&plain_edits, &plugin_edits] {
        let inside = evaluate(
            &state,
            session_id,
            "Write",
            None,
            json!({ "path": "file.txt", "content": "x" }),
        )
        .await;
        assert_eq!(
            inside["decision"],
            json!("allow-once"),
            "{session_id}: {inside}"
        );
        let outside_write = evaluate(
            &state,
            session_id,
            "Write",
            None,
            json!({ "path": dir.path().join("outside").join("w.txt").to_string_lossy(), "content": "x" }),
        )
        .await;
        assert_eq!(
            outside_write["decision"],
            Value::Null,
            "{session_id}: {outside_write}"
        );
    }
}

/// A subagent carries its own permission scope (ADR 0089). In a plugin task
/// that scope may narrow the task's mode and never widen it, so `auto` cannot
/// turn an `ask` task into one that writes without a card.
#[tokio::test]
async fn a_subagent_scope_cannot_widen_a_plugin_task() {
    let (dir, state) = open().await;
    let (plain, plugin_task) = {
        let st = state.lock().await;
        let employee = employee(&st, &dir);
        (
            task_session(
                &st,
                &employee,
                "plain ask",
                project(&dir, "plain"),
                "ask",
                None,
            ),
            task_session(
                &st,
                &employee,
                "plugin ask",
                project(&dir, "plugin"),
                "ask",
                Some("acme"),
            ),
        )
    };

    // The ordinary task honours the delegate's scope: `auto` writes freely.
    let scoped = handle_request(
        state.clone(),
        "tools.execute",
        json!({
            "sessionId": plain,
            "toolCallId": "delegate-write-scoped",
            "toolName": "Write",
            "args": { "path": "delegate.txt", "content": "scoped" },
            "mode": "agent",
            "permissionScope": "auto"
        }),
        mpsc::unbounded_channel().0,
    )
    .await
    .unwrap();
    assert_eq!(scoped["ok"], true, "{scoped}");
    assert_eq!(scoped["content"]["root"], "workspace", "{scoped}");

    // The plugin task caps the same scope at its own mode, so the write needs
    // a card and a denial keeps the file off disk.
    let (notify_tx, mut notify_rx) = mpsc::unbounded_channel();
    let pending_state = state.clone();
    let pending_session = plugin_task.clone();
    let pending = tokio::spawn(async move {
        handle_request(
            pending_state,
            "tools.execute",
            json!({
                "sessionId": pending_session,
                "toolCallId": "delegate-write-plugin-task",
                "toolName": "Write",
                "args": { "path": "delegate.txt", "content": "scoped" },
                "mode": "agent",
                "permissionScope": "auto"
            }),
            notify_tx,
        )
        .await
    });
    let notification = tokio::time::timeout(Duration::from_secs(5), notify_rx.recv())
        .await
        .expect("the widened scope must still raise a permission card")
        .expect("the permission channel stays open");
    let notification: Value = serde_json::from_str(&notification).unwrap();
    assert_eq!(notification["method"], "permissions.request");
    assert_eq!(notification["params"]["perCallOnly"], true);
    let snapshot = handle_request(
        state.clone(),
        "permissions.pending",
        json!({ "sessionId": plugin_task }),
        mpsc::unbounded_channel().0,
    )
    .await
    .unwrap();
    assert_eq!(snapshot["requests"][0]["perCallOnly"], true);
    assert_eq!(
        notification["params"]["reason"],
        "Modifies files in your workspace"
    );
    let request_id = notification["params"]["requestId"].as_str().unwrap();
    handle_request(
        state.clone(),
        "permissions.resolve",
        json!({ "requestId": request_id, "decision": "deny" }),
        mpsc::unbounded_channel().0,
    )
    .await
    .unwrap();
    let denied = pending.await.unwrap().unwrap();
    assert_eq!(denied["ok"], false, "{denied}");
    assert_eq!(denied["denied"], true, "{denied}");
    assert_eq!(denied["errorCode"], "TOOL_DENIED", "{denied}");
}
