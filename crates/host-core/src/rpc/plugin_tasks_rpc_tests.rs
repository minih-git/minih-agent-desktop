//! Host trust-boundary tests for `pluginTasks.*`.
//!
//! Everything starts at the RPCs Electron Main calls, so the checks cover the
//! real boundary: the registry and manifest lookup behind every method, the
//! capability each method needs, the ownership rule, the answer shapes, and the
//! workspace step that decides whether a created task can actually start.
use std::path::Path;
use std::sync::Arc;

use serde_json::{json, Value};
use tokio::sync::Mutex;

use crate::rpc::JsonRpcError;
use crate::state::AppState;

use super::handle;

const PROMPT: &str = "Read the flaky test and say why it fails";

fn open_at(path: &Path) -> Arc<Mutex<AppState>> {
    let mut app = AppState::open(path).expect("open the host state");
    app.handshook = true;
    Arc::new(Mutex::new(app))
}

async fn call(
    state: &Arc<Mutex<AppState>>,
    method: &str,
    params: Value,
) -> Result<Value, JsonRpcError> {
    handle(state.clone(), method, params).await
}

async fn ok(state: &Arc<Mutex<AppState>>, method: &str, params: Value) -> Value {
    match call(state, method, params).await {
        Ok(result) => result,
        Err(error) => panic!("{method} failed: {error:?}"),
    }
}

fn error_code(error: &JsonRpcError) -> String {
    error
        .data
        .as_ref()
        .and_then(|data| data.get("errorCode"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

/// Install a throwaway plugin whose manifest declares these permissions, so
/// the registry lookup every method does finds a real row.
async fn install(
    state: &Arc<Mutex<AppState>>,
    root: &Path,
    id: &str,
    permissions: &[&str],
    max_permission: Option<&str>,
) {
    let source = root.join(format!("{id}-source"));
    std::fs::create_dir_all(&source).unwrap();
    let mut manifest = json!({
        "schemaVersion": 1,
        "id": id,
        "name": id,
        "version": "0.1.0",
        "main": "main.js",
        "permissions": permissions,
    });
    if let Some(max_permission) = max_permission {
        manifest["tasks"] = json!({ "manage": { "maxPermission": max_permission } });
    }
    std::fs::write(
        source.join("manifest.json"),
        serde_json::to_string_pretty(&manifest).unwrap(),
    )
    .unwrap();
    std::fs::write(source.join("main.js"), "export function onLoad() {}\n").unwrap();
    let mut st = state.lock().await;
    st.plugins
        .install_from_path(
            source.to_str().unwrap(),
            crate::plugins::InstallOptions::default(),
        )
        .unwrap_or_else(|error| panic!("installing {id} failed: {error}"));
}

async fn employee(state: &Arc<Mutex<AppState>>, name: &str, mode: &str) -> String {
    let st = state.lock().await;
    crate::sessions::create_session_with_options(
        &st.db,
        crate::sessions::SessionCreateOptions {
            title: Some(name.into()),
            mode: Some("agent".into()),
            permission_mode: Some(mode.into()),
            role: Some("bot".into()),
            bot_profile_json: Some(
                json!({ "name": name, "permissionMode": mode, "mustAsk": [], "observe": false })
                    .to_string(),
            ),
            ..Default::default()
        },
    )
    .unwrap()
    .id
}

/// A task the data layer created for a plugin, for the tests that need a row
/// without going through `create`.
async fn seed_task(state: &Arc<Mutex<AppState>>, plugin: &str, employee_id: &str) -> String {
    let st = state.lock().await;
    let grant = crate::plugin_tasks::Grant::new(plugin, None).unwrap();
    crate::plugin_tasks::create(
        &st.db,
        &grant,
        crate::plugin_tasks::CreateRequest {
            employee_id,
            title: "Seeded work",
            prompt: PROMPT,
            project_id: None,
            max_permission: None,
        },
    )
    .unwrap()
    .task
    .id
}

/// The task rows in the database, read under the host lock.
async fn task_count(state: &Arc<Mutex<AppState>>) -> i64 {
    let st = state.lock().await;
    st.db
        .conn()
        .query_row("SELECT COUNT(*) FROM tasks", [], |row| row.get(0))
        .unwrap()
}

fn create_params(plugin: &str, employee_id: &str) -> Value {
    json!({
        "pluginId": plugin,
        "employeeId": employee_id,
        "title": "Fix the login timeout",
        "prompt": PROMPT,
    })
}

// ---- create -----------------------------------------------------------------

/// A create answers with the ids, the person's own inbox row, the task row and
/// whether its workspace is ready — everything Electron Main needs to push
/// `notificationChanged` and to announce `taskChanges.announce(task, "created")`
/// without a second read.
#[tokio::test]
async fn create_answers_with_the_announcement_the_task_and_a_workspace_flag() {
    let dir = tempfile::tempdir().unwrap();
    let state = open_at(dir.path());
    install(
        &state,
        dir.path(),
        "acme.ci",
        &["tasks.read", "tasks.manage"],
        None,
    )
    .await;
    let owner = employee(&state, "Router 后端", "accept-edits").await;

    let created = ok(
        &state,
        "pluginTasks.create",
        create_params("acme.ci", &owner),
    )
    .await;
    let task_id = created["taskId"].as_str().unwrap().to_string();
    let session_id = created["sessionId"].as_str().unwrap().to_string();
    assert_eq!(created["employeeId"], json!(owner));
    assert_eq!(created["permissionMode"], json!("accept-edits"));
    // No project, so there was nothing to prepare and nothing to fail.
    assert_eq!(created["workspaceReady"], json!(true));
    assert_eq!(created["workspaceStatus"], json!("none"));
    assert_eq!(created["workspaceError"], json!(null));
    // The host's own task projection, for the stage baseline. "Ready" is about
    // the workspace, not about a turn: the task itself is still queued.
    assert_eq!(created["task"]["id"], json!(task_id));
    assert_eq!(created["task"]["sessionId"], json!(session_id));
    assert_eq!(created["task"]["stage"], json!("queued"));
    assert_eq!(created["task"]["workspaceStatus"], json!("none"));
    assert_eq!(created["task"]["employeeSessionId"], json!(owner));

    // The notification is the inbox row itself, not a summary of it.
    let notification = &created["notification"];
    assert_eq!(created["notificationId"], notification["id"]);
    assert!(notification["id"].is_string());
    assert_eq!(notification["kind"], json!("plugin.alert"));
    assert_eq!(notification["pluginId"], json!("acme.ci"));
    assert_eq!(notification["sessionId"], json!(null));
    assert_eq!(notification["title"], json!("Fix the login timeout"));
    assert_eq!(notification["readAt"], json!(null));
    let link: Value = serde_json::from_str(notification["linkJson"].as_str().unwrap()).unwrap();
    assert_eq!(link, json!({ "session": session_id }));
    let body: Value = serde_json::from_str(notification["body"].as_str().unwrap()).unwrap();
    assert_eq!(
        body["schema"],
        json!(crate::plugin_tasks::NOTIFICATION_BODY_SCHEMA)
    );
    assert_eq!(
        body["i18n"]["key"],
        json!(crate::plugin_tasks::NOTIFICATION_I18N_KEY)
    );

    // The answer matches the rows that were written.
    let st = state.lock().await;
    let (plugin_id, stored_session): (Option<String>, String) = st
        .db
        .conn()
        .query_row(
            "SELECT plugin_id, session_id FROM tasks WHERE id = ?1",
            rusqlite::params![task_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(plugin_id.as_deref(), Some("acme.ci"));
    assert_eq!(stored_session, session_id);
    let kind: String = st
        .db
        .conn()
        .query_row(
            "SELECT kind FROM notifications WHERE id = ?1",
            rusqlite::params![created["notificationId"].as_str().unwrap()],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(kind, "plugin.alert");
}

/// A workspace that could not be prepared is reported as created-but-not-ready,
/// not as a failed create: the task row and the person's inbox row are already
/// committed, and Main must not deliver a prompt into a folder that is not
/// there.
#[tokio::test]
async fn a_failed_workspace_is_created_but_not_ready() {
    let dir = tempfile::tempdir().unwrap();
    let state = open_at(dir.path());
    install(&state, dir.path(), "acme.ci", &["tasks.manage"], None).await;
    let owner = employee(&state, "Router 后端", "accept-edits").await;
    // A directory that is not a git repository: preparing a worktree cannot
    // succeed, and the failure is recorded on the task.
    let plain = dir.path().join("not-a-repo");
    std::fs::create_dir_all(&plain).unwrap();
    let project_id = {
        let st = state.lock().await;
        st.db
            .ensure_project(plain.to_str().unwrap(), false)
            .unwrap()
    };

    let created = ok(
        &state,
        "pluginTasks.create",
        json!({
            "pluginId": "acme.ci",
            "employeeId": owner,
            "title": "Fix the login timeout",
            "prompt": PROMPT,
            "projectId": project_id,
        }),
    )
    .await;
    assert_eq!(created["workspaceReady"], json!(false));
    assert_eq!(created["workspaceStatus"], json!("failed"));
    assert_eq!(created["task"]["workspaceStatus"], json!("failed"));
    assert!(
        created["workspaceError"]
            .as_str()
            .is_some_and(|text| !text.is_empty()),
        "a failed prepare says why: {created:?}"
    );
    // The rows exist: this is "created, workspace failed", not "nothing happened".
    assert!(created["taskId"].is_string());
    assert!(created["notification"].is_object());
    assert_eq!(task_count(&state).await, 1);
}

#[tokio::test]
async fn a_long_prompt_is_refused_before_any_row_exists() {
    let dir = tempfile::tempdir().unwrap();
    let state = open_at(dir.path());
    install(&state, dir.path(), "acme.ci", &["tasks.manage"], None).await;
    let owner = employee(&state, "Router 后端", "accept-edits").await;
    let long = "x".repeat(crate::plugin_tasks::MAX_PROMPT_CHARS + 1);
    let error = call(
        &state,
        "pluginTasks.create",
        json!({
            "pluginId": "acme.ci",
            "employeeId": owner,
            "title": "Fix the login timeout",
            "prompt": long,
        }),
    )
    .await
    .expect_err("an oversized prompt is refused");
    assert_eq!(error.code, 1002);
    assert_eq!(error_code(&error), "INVALID_PARAMS");
    assert_eq!(task_count(&state).await, 0);
}

// ---- capabilities -----------------------------------------------------------

/// `get` is manage-scoped: one task by id is not part of the read-only roster
/// and ledger surface, even though it only reads.
#[tokio::test]
async fn get_needs_tasks_manage_while_roster_and_list_need_tasks_read() {
    let dir = tempfile::tempdir().unwrap();
    let state = open_at(dir.path());
    install(&state, dir.path(), "acme.read", &["tasks.read"], None).await;
    let owner = employee(&state, "Router 后端", "accept-edits").await;
    let task_id = seed_task(&state, "acme.read", &owner).await;

    let refused = call(
        &state,
        "pluginTasks.get",
        json!({ "pluginId": "acme.read", "taskId": task_id }),
    )
    .await
    .expect_err("tasks.read does not reach get");
    assert_eq!(refused.code, 1003);
    assert_eq!(error_code(&refused), "PERMISSION_DENIED");

    // The read surface itself is open to the same plugin.
    let roster = ok(
        &state,
        "pluginTasks.roster",
        json!({ "pluginId": "acme.read" }),
    )
    .await;
    assert_eq!(roster["employees"].as_array().unwrap().len(), 1);
    let ledger = ok(
        &state,
        "pluginTasks.list",
        json!({ "pluginId": "acme.read", "limit": 10 }),
    )
    .await;
    assert_eq!(ledger["tasks"].as_array().unwrap().len(), 1);
    assert_eq!(ledger["tasks"][0]["taskId"], json!(task_id));
}

/// A plugin without `tasks.manage` cannot create, and a disabled plugin loses
/// the whole surface.
#[tokio::test]
async fn the_capability_and_the_registry_both_decide() {
    let dir = tempfile::tempdir().unwrap();
    let state = open_at(dir.path());
    install(&state, dir.path(), "acme.read", &["tasks.read"], None).await;
    let owner = employee(&state, "Router 后端", "accept-edits").await;

    let refused = call(
        &state,
        "pluginTasks.create",
        create_params("acme.read", &owner),
    )
    .await
    .expect_err("tasks.read cannot create");
    assert_eq!(error_code(&refused), "PERMISSION_DENIED");
    assert_eq!(task_count(&state).await, 0);

    // Not installed at all.
    let unknown = call(
        &state,
        "pluginTasks.roster",
        json!({ "pluginId": "acme.nobody" }),
    )
    .await
    .expect_err("an unknown plugin has no surface");
    assert_eq!(error_code(&unknown), "NOT_FOUND");

    // Installed, then disabled.
    {
        let mut st = state.lock().await;
        st.plugins.set_enabled("acme.read", false).unwrap();
    }
    let disabled = call(
        &state,
        "pluginTasks.roster",
        json!({ "pluginId": "acme.read" }),
    )
    .await
    .expect_err("a disabled plugin has no surface");
    assert_eq!(error_code(&disabled), "PERMISSION_DENIED");
}

/// The manifest's `tasks.manage.maxPermission` narrows the task, and an
/// explicit `auto` is refused rather than quietly clamped.
#[tokio::test]
async fn the_manifest_ceiling_narrows_and_auto_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let state = open_at(dir.path());
    install(
        &state,
        dir.path(),
        "acme.ci",
        &["tasks.manage"],
        Some("ask"),
    )
    .await;
    let owner = employee(&state, "Router 后端", "accept-edits").await;

    let created = ok(
        &state,
        "pluginTasks.create",
        create_params("acme.ci", &owner),
    )
    .await;
    assert_eq!(created["permissionMode"], json!("ask"));

    let refused = call(
        &state,
        "pluginTasks.create",
        json!({
            "pluginId": "acme.ci",
            "employeeId": owner,
            "title": "Fix the login timeout",
            "prompt": PROMPT,
            "maxPermission": "auto",
        }),
    )
    .await
    .expect_err("auto is not grantable");
    assert_eq!(error_code(&refused), "PERMISSION_DENIED");
    assert_eq!(
        task_count(&state).await,
        1,
        "only the first create wrote a row"
    );
}

// ---- ownership --------------------------------------------------------------

/// One plugin's task is `NOT_FOUND` to another, on every method that names it.
#[tokio::test]
async fn another_plugins_task_is_not_found() {
    let dir = tempfile::tempdir().unwrap();
    let state = open_at(dir.path());
    install(&state, dir.path(), "acme.ci", &["tasks.manage"], None).await;
    install(&state, dir.path(), "acme.deploy", &["tasks.manage"], None).await;
    let owner = employee(&state, "Router 后端", "accept-edits").await;

    let created = ok(
        &state,
        "pluginTasks.create",
        create_params("acme.ci", &owner),
    )
    .await;
    let task_id = created["taskId"].as_str().unwrap();

    for method in ["pluginTasks.get", "pluginTasks.send", "pluginTasks.stop"] {
        let mut params = json!({ "pluginId": "acme.deploy", "taskId": task_id });
        if method == "pluginTasks.send" {
            params["prompt"] = json!("Do it");
        }
        let error = expect_error(call(&state, method, params).await, method);
        assert_eq!(
            error_code(&error),
            "NOT_FOUND",
            "{method} must not confirm that another plugin's task exists"
        );
    }

    // The owner can drive it, and gets the session to hand the prompt to.
    let target = ok(
        &state,
        "pluginTasks.send",
        json!({
            "pluginId": "acme.ci",
            "taskId": task_id,
            "prompt": "Try the other branch",
        }),
    )
    .await;
    assert_eq!(target["taskId"], json!(task_id));
    assert_eq!(target["sessionId"], created["sessionId"]);
    assert_eq!(target["employeeId"], json!(owner));
    let stopped = ok(
        &state,
        "pluginTasks.stop",
        json!({ "pluginId": "acme.ci", "taskId": task_id }),
    )
    .await;
    assert_eq!(stopped["sessionId"], created["sessionId"]);
}

/// `pluginTasks.owner` is the host's own reading: it answers for any task,
/// including one no plugin created.
#[tokio::test]
async fn owner_answers_for_any_task() {
    let dir = tempfile::tempdir().unwrap();
    let state = open_at(dir.path());
    install(&state, dir.path(), "acme.ci", &["tasks.manage"], None).await;
    let owner = employee(&state, "Router 后端", "accept-edits").await;
    let task_id = seed_task(&state, "acme.ci", &owner).await;

    assert_eq!(
        ok(&state, "pluginTasks.owner", json!({ "taskId": task_id })).await,
        json!({ "pluginId": "acme.ci" })
    );

    let person_task = {
        let st = state.lock().await;
        crate::tasks::create(
            &st.db,
            &json!({
                "employeeSessionId": owner,
                "title": "Typed by hand",
                "origin": "direct",
            }),
        )
        .unwrap()["task"]["id"]
            .as_str()
            .unwrap()
            .to_string()
    };
    assert_eq!(
        ok(
            &state,
            "pluginTasks.owner",
            json!({ "taskId": person_task })
        )
        .await,
        json!({ "pluginId": null })
    );

    let unknown = call(
        &state,
        "pluginTasks.owner",
        json!({ "taskId": "no-such-task" }),
    )
    .await
    .expect_err("an id nobody has is not found");
    assert_eq!(error_code(&unknown), "NOT_FOUND");
}

// ---- reads ------------------------------------------------------------------

/// The read surface is redacted: no prompt, no question, no transcript.
#[tokio::test]
async fn roster_and_ledger_carry_no_prompt() {
    let dir = tempfile::tempdir().unwrap();
    let state = open_at(dir.path());
    install(
        &state,
        dir.path(),
        "acme.ci",
        &["tasks.read", "tasks.manage"],
        None,
    )
    .await;
    let owner = employee(&state, "Router 后端", "accept-edits").await;
    ok(
        &state,
        "pluginTasks.create",
        create_params("acme.ci", &owner),
    )
    .await;

    let roster = ok(
        &state,
        "pluginTasks.roster",
        json!({ "pluginId": "acme.ci", "limit": 10 }),
    )
    .await;
    assert!(!roster.to_string().contains(PROMPT));
    assert_eq!(roster["employees"][0]["employeeId"], json!(owner));
    assert_eq!(roster["employees"][0]["openTasks"], json!(1));

    let ledger = ok(&state, "pluginTasks.list", json!({ "pluginId": "acme.ci" })).await;
    assert!(!ledger.to_string().contains(PROMPT));
    let row = &ledger["tasks"][0];
    assert_eq!(row["origin"], json!("direct"));
    assert_eq!(row["pluginId"], json!("acme.ci"));
    assert!(row["title"].is_string());
    assert_eq!(ledger["nextCursor"], json!(null));
    // A cursor the host never wrote is refused.
    let bad = call(
        &state,
        "pluginTasks.list",
        json!({ "pluginId": "acme.ci", "cursor": "nonsense" }),
    )
    .await
    .expect_err("a cursor must be one the host wrote");
    assert_eq!(error_code(&bad), "INVALID_ARGUMENT");
}

#[tokio::test]
async fn an_unknown_method_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let state = open_at(dir.path());
    let error = call(&state, "pluginTasks.archive", json!({}))
        .await
        .err()
        .unwrap();
    assert_eq!(error.code, -32601);
    assert_eq!(error_code(&error), "METHOD_NOT_FOUND");
}

/// A refusal, with the method named when the call unexpectedly succeeded.
fn expect_error(result: Result<Value, JsonRpcError>, method: &str) -> JsonRpcError {
    match result {
        Err(error) => error,
        Ok(value) => panic!("{method} was expected to fail, got {value}"),
    }
}
