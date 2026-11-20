//! `pluginTasks.*` — the RPC half of a plugin's `tasks.read` / `tasks.manage`
//! capabilities (ADR plugin-host-capabilities, spec 07-plugins/03).
//!
//! The data layer is [`crate::plugin_tasks`]; this module is the trust boundary
//! in front of it. Electron Main knows which plugin is calling; the host does
//! not take that on faith, so every method that names a plugin resolves it
//! against the registry *and* the manifest on disk before a row is read or
//! written:
//!
//! | method | params | permission | result |
//! | --- | --- | --- | --- |
//! | `pluginTasks.create` | `{ pluginId, employeeId, title, prompt, projectId?, maxPermission? }` | `tasks.manage` | `{ taskId, sessionId, employeeId, permissionMode, notificationId, notification, task, workspaceReady, workspaceStatus, workspaceError }` |
//! | `pluginTasks.roster` | `{ pluginId, limit? }` | `tasks.read` | `{ employees: [ … ] }` |
//! | `pluginTasks.list` | `{ pluginId, limit?, cursor? }` | `tasks.read` | `{ tasks: [ … ], nextCursor }` |
//! | `pluginTasks.get` | `{ pluginId, taskId }` | `tasks.manage` | one `pluginTasks.list` row |
//! | `pluginTasks.send` | `{ pluginId, taskId, prompt }` | `tasks.manage` | `{ taskId, sessionId, employeeId }` |
//! | `pluginTasks.stop` | `{ pluginId, taskId }` | `tasks.manage` | `{ taskId, sessionId, employeeId }` |
//! | `pluginTasks.owner` | `{ taskId }` | none (host-internal) | `{ pluginId }` |
//!
//! `get` needs `tasks.manage`, not `tasks.read`, even though it only reads: it
//! addresses one task by id, and an id that is not the caller's is answered
//! `NOT_FOUND`. `roster` and `list` are the `tasks.read` surface, and they are
//! both redacted projections rather than the ledger rows a person sees.
//!
//! Registration, for the host's router:
//!
//! ```ignore
//! // crates/host-core/src/main.rs
//! mod plugin_tasks;
//! // crates/host-core/src/rpc/mod.rs
//! mod plugin_tasks_rpc;
//! if method.starts_with("pluginTasks.") {
//!     return plugin_tasks_rpc::handle(state, method, params).await;
//! }
//! ```
//!
//! `pluginTasks.owner` exists only for the host's own event wiring: it answers
//! which plugin created a task so an event about that task can reach its owner.
//! It takes no `pluginId` and is not something the plugin broker exposes.
//!
//! `create` is the one method that touches git. It writes the task, its
//! `plugin_id`, the audit record and the inbox row in one transaction, then
//! builds the task's workspace with [`crate::task_workspace::prepare`] and only
//! then answers — the same order `task.create` uses, because a prompt delivered
//! into a folder that is still being built opens a turn in the wrong place.
//!
//! Its answer carries the person's inbox row as `notification` (the same
//! `Notification` shape `pluginNotification.create` answers with), so Electron
//! Main can push `notificationChanged` without a second read, the task row
//! itself for `taskChanges.announce(task, "created")`, and a `workspaceReady`
//! flag with the row's `workspaceStatus` / `workspaceError`. A workspace that
//! failed to prepare is reported there rather than as an RPC failure: the task
//! and its announcement are already committed, so the caller has to learn
//! "created, workspace failed" instead of "nothing happened".
//!
//! `send` and `stop` do **not** deliver anything or stop anything. They
//! authorize, check that the task is the caller's and still open, and answer
//! with the session the caller has to drive: the input queue, the runtime turn
//! and the stop acknowledgement belong to Electron Main. A host that answered
//! "sent" without a delivery would be claiming an outcome it never produced.

use std::path::Path;
use std::sync::Arc;

use tokio::sync::Mutex;

use super::{json, rpc_err, AppState, JsonRpcError, Value};
use crate::plugin_tasks::{self, Grant};
use crate::plugins::PluginSummary;
use crate::session_worktrees::git::GitRunner;
use crate::task_workspace;

#[cfg(test)]
#[path = "plugin_tasks_rpc_tests.rs"]
mod tests;

/// The write capability: creating and driving the plugin's own tasks.
const MANAGE: &str = "tasks.manage";
/// The read capability: the roster and the redacted ledger.
const READ: &str = "tasks.read";

/// Longest plugin id this boundary accepts, matching `pluginNotification.create`.
const MAX_PLUGIN_ID_CHARS: usize = 200;
/// Longest task or employee id this boundary accepts.
const MAX_ID_CHARS: usize = 256;

pub(super) async fn handle(
    state: Arc<Mutex<AppState>>,
    method: &str,
    params: Value,
) -> Result<Value, JsonRpcError> {
    match method {
        "pluginTasks.create" => create(state, params).await,
        "pluginTasks.roster" => {
            let plugin_id = plugin_id(&params)?;
            let limit = optional_i64(&params, "limit")?;
            let st = state.lock().await;
            grant(&st, &plugin_id, &[READ])?;
            plugin_tasks::roster(&st.db, limit).map_err(map)
        }
        "pluginTasks.list" => {
            let plugin_id = plugin_id(&params)?;
            let limit = optional_i64(&params, "limit")?;
            let st = state.lock().await;
            grant(&st, &plugin_id, &[READ])?;
            let cursor = optional_str(&params, "cursor")?;
            plugin_tasks::list(&st.db, plugin_tasks::LedgerQuery { limit, cursor }).map_err(map)
        }
        // `tasks.manage`, not `tasks.read`: one task by id is manage-scoped
        // work, and anything the caller did not create is `NOT_FOUND`.
        "pluginTasks.get" => {
            let plugin_id = plugin_id(&params)?;
            let task_id = required_str(&params, "taskId")?;
            let st = state.lock().await;
            let grant = grant(&st, &plugin_id, &[MANAGE])?;
            plugin_tasks::get(&st.db, &grant.plugin_id, task_id).map_err(map)
        }
        "pluginTasks.send" => {
            let plugin_id = plugin_id(&params)?;
            let task_id = required_str(&params, "taskId")?;
            let prompt = required_str(&params, "prompt")?;
            let st = state.lock().await;
            let grant = grant(&st, &plugin_id, &[MANAGE])?;
            // Checked here and never stored: the delivery is the caller's, and
            // a work request is not something the ledger keeps.
            plugin_tasks::validate_prompt(prompt).map_err(map)?;
            plugin_tasks::owned_open_task(&st.db, &grant.plugin_id, task_id)
                .map(target_json)
                .map_err(map)
        }
        "pluginTasks.stop" => {
            let plugin_id = plugin_id(&params)?;
            let task_id = required_str(&params, "taskId")?;
            let st = state.lock().await;
            let grant = grant(&st, &plugin_id, &[MANAGE])?;
            plugin_tasks::owned_open_task(&st.db, &grant.plugin_id, task_id)
                .map(target_json)
                .map_err(map)
        }
        // Host-internal: which plugin owns this task. No plugin id in the
        // params and no plugin permission to check — the caller is the host.
        "pluginTasks.owner" => {
            let task_id = required_str(&params, "taskId")?;
            let st = state.lock().await;
            plugin_tasks::owner(&st.db, task_id).map_err(map)
        }
        _ => Err(rpc_err(
            -32601,
            "unknown plugin task method",
            "METHOD_NOT_FOUND",
        )),
    }
}

/// What `send` and `stop` answer: the session the caller has to drive.
fn target_json(target: plugin_tasks::TaskTarget) -> Value {
    json!({
        "taskId": target.task_id,
        "sessionId": target.session_id,
        "employeeId": target.employee_id,
    })
}

/// Create a task, build its workspace, and answer with the ids the caller
/// needs to drive it.
///
/// The answer is flat (`taskId` at the top) because the plugin-facing
/// `pi.tasks.create` result is `{ taskId, sessionId }`: Electron Main hands it
/// straight to the plugin and remembers the creator by that id.
async fn create(state: Arc<Mutex<AppState>>, params: Value) -> Result<Value, JsonRpcError> {
    let plugin_id = plugin_id(&params)?;
    let employee_id = required_str(&params, "employeeId")?;
    let title = required_text(&params, "title", plugin_tasks::MAX_TITLE_CHARS)?;
    let prompt = required_text(&params, "prompt", plugin_tasks::MAX_PROMPT_CHARS)?;
    let project_id = optional_i64(&params, "projectId")?;
    let max_permission = optional_str(&params, "maxPermission")?;

    // Everything the transaction owns — quotas, the row, its provenance, the
    // audit record, the inbox row — happens under the host state lock, so two
    // calls cannot each see room for the last one.
    let created = {
        let st = state.lock().await;
        let grant = grant(&st, &plugin_id, &[MANAGE])?;
        plugin_tasks::create(
            &st.db,
            &grant,
            plugin_tasks::CreateRequest {
                employee_id,
                title,
                prompt,
                project_id,
                max_permission,
            },
        )
        .map_err(map)?
    };

    // Git work, after the transaction and before any delivery. The lock is not
    // held here; `prepare` takes it itself. A prompt delivered into a folder
    // that is still being built would open a turn in the wrong place, so the
    // workspace is settled before this answers.
    //
    // A prepare failure is *not* turned into an RPC error: the task row, its
    // provenance and the person's inbox row are already committed, so answering
    // "create failed" would be a lie the plugin could retry against its own
    // quota. The row records the outcome, and `workspaceReady` reports it —
    // Electron Main delivers the prompt only when the workspace can take one.
    let git = GitRunner::default();
    let prepare_error = task_workspace::prepare(&state, &git, &created.task.id)
        .await
        .err();

    let st = state.lock().await;
    let task = crate::tasks::get_task(&st.db, &created.task.id)
        .map_err(map)?
        .ok_or_else(|| rpc_err(1007, "the task vanished after it was created", "NOT_FOUND"))?;
    // `none` (no project to prepare) and `ready` are the two states that can
    // take a prompt; `preparing` and `failed` cannot. This is what the
    // workspace step produced, not a claim that a turn is running: the task is
    // `queued` until Electron Main delivers the prompt.
    let workspace_ready = task.workspace_status == "none" || task.workspace_status == "ready";
    let workspace_error = task
        .workspace_error
        .clone()
        .or_else(|| prepare_error.map(|error| error.message));
    Ok(json!({
        "taskId": created.task.id,
        "sessionId": created.task.session_id,
        "employeeId": created.task.employee_session_id,
        "permissionMode": created.permission_mode,
        "notificationId": created.notification.id,
        // The person's own inbox row, so Main can push `notificationChanged`
        // with the row it did not have to re-read — the same shape
        // `pluginNotification.create` answers with.
        "notification": created.notification,
        // The host's own task projection, so Main can call
        // `taskChanges.announce(task, "created")` and seed the stage baseline
        // before a single stage event exists. The plugin never sees this
        // object: `pi.tasks.create` answers `{ taskId, sessionId }`, and the
        // broker keeps the rest of this result to itself.
        "task": task,
        "workspaceReady": workspace_ready,
        "workspaceStatus": task.workspace_status,
        "workspaceError": workspace_error,
    }))
}

/// Resolve one of `wanted` permissions, plus the ceiling the installed manifest
/// declares.
///
/// The registry decides whether the plugin is installed and enabled; the
/// manifest on disk decides the permission ceiling. Both are read here rather
/// than trusted from the call, so a plugin disabled or updated between the
/// broker's decision and this write cannot act on the older state.
fn grant(st: &AppState, plugin_id: &str, wanted: &[&str]) -> Result<Grant, JsonRpcError> {
    let plugin = st
        .plugins
        .get(plugin_id)
        .ok_or_else(|| rpc_err(1007, "plugin is not installed", "NOT_FOUND"))?;
    if !plugin.enabled {
        return Err(rpc_err(1003, "plugin is disabled", "PERMISSION_DENIED"));
    }
    // `tasks.read` and `tasks.manage` are independent grants, so a method that
    // accepts either is satisfied by either one.
    let held = wanted.iter().any(|permission| {
        plugin
            .permissions
            .iter()
            .any(|granted| granted == permission)
    });
    if !held {
        return Err(rpc_err(
            1003,
            format!("plugin lacks {}", wanted.join(" or ")),
            "PERMISSION_DENIED",
        ));
    }
    Grant::new(plugin_id, declared_ceiling(&plugin)?.as_deref()).map_err(map)
}

/// `manifest.tasks.manage.maxPermission`, or `None` when the manifest declares
/// no ceiling (the data layer then uses `accept-edits`).
fn declared_ceiling(plugin: &PluginSummary) -> Result<Option<String>, JsonRpcError> {
    let Some(path) = plugin
        .path
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty())
    else {
        return Ok(None);
    };
    let raw = std::fs::read_to_string(Path::new(path).join("manifest.json")).map_err(|error| {
        rpc_err(
            1000,
            format!("plugin manifest is unavailable: {error}"),
            "INTERNAL",
        )
    })?;
    let manifest: Value = serde_json::from_str(&raw).map_err(|error| {
        rpc_err(
            1000,
            format!("plugin manifest is unreadable: {error}"),
            "INTERNAL",
        )
    })?;
    // A manifest that does not describe the row it is installed as is not
    // evidence for anything.
    if manifest.get("id").and_then(Value::as_str) != Some(plugin.id.as_str()) {
        return Err(rpc_err(
            1000,
            "plugin manifest does not match its registry row",
            "INTERNAL",
        ));
    }
    Ok(manifest
        .get("tasks")
        .and_then(|tasks| tasks.get("manage"))
        .and_then(|manage| manage.get("maxPermission"))
        .and_then(Value::as_str)
        .map(str::to_owned))
}

/// One `CODE: message` failure from the data layer, in the host's error shape.
fn map(error: anyhow::Error) -> JsonRpcError {
    let message = error.to_string();
    let code = message
        .split(':')
        .next()
        .unwrap_or("INTERNAL")
        .trim()
        .to_string();
    let rpc_code = match code.as_str() {
        "INVALID_ARGUMENT" | "INVALID_PARAMS" | "LIMIT_EXCEEDED" => 1002,
        "PERMISSION_DENIED" => 1003,
        "RATE_LIMITED" => 1006,
        "NOT_FOUND" => 1007,
        "CONFLICT" | "IDEMPOTENCY_CONFLICT" => 1008,
        _ => return rpc_err(1000, message, "INTERNAL"),
    };
    rpc_err(rpc_code, message, &code)
}

fn invalid(key: &str, rule: &str) -> JsonRpcError {
    rpc_err(1002, format!("{key} {rule}"), "INVALID_PARAMS")
}

/// The plugin identity is a budget and permission key, so it is normalized: a
/// manifest id with stray whitespace must not become a second identity.
fn plugin_id(params: &Value) -> Result<String, JsonRpcError> {
    let value = required_str(params, "pluginId")?.trim();
    if value.is_empty() {
        return Err(invalid("pluginId", "is required"));
    }
    if value.chars().count() > MAX_PLUGIN_ID_CHARS {
        return Err(invalid(
            "pluginId",
            &format!("exceeds {MAX_PLUGIN_ID_CHARS} characters"),
        ));
    }
    if value
        .chars()
        .any(|character| character.is_control() || character.is_whitespace())
    {
        return Err(invalid(
            "pluginId",
            "must not contain spaces or control characters",
        ));
    }
    Ok(value.to_string())
}

/// A required string bounded by `limit` characters, with the bound named in
/// the error. `limit` is the data layer's own constant, so the boundary refuses
/// exactly what the row would have refused one hop later.
fn required_text<'a>(params: &'a Value, key: &str, limit: usize) -> Result<&'a str, JsonRpcError> {
    params
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty() && value.chars().count() <= limit)
        .ok_or_else(|| invalid(key, &format!("must be 1 to {limit} characters")))
}

/// A required id: the same bound every id on this surface shares.
fn required_str<'a>(params: &'a Value, key: &str) -> Result<&'a str, JsonRpcError> {
    required_text(params, key, MAX_ID_CHARS)
}

fn optional_str<'a>(params: &'a Value, key: &str) -> Result<Option<&'a str>, JsonRpcError> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => {
            let value = value.trim();
            if value.is_empty() {
                return Err(invalid(key, "must not be empty"));
            }
            if value.chars().count() > MAX_ID_CHARS {
                return Err(invalid(key, &format!("exceeds {MAX_ID_CHARS} characters")));
            }
            Ok(Some(value))
        }
        Some(_) => Err(invalid(key, "must be a string")),
    }
}

fn optional_i64(params: &Value, key: &str) -> Result<Option<i64>, JsonRpcError> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value
            .as_i64()
            .map(Some)
            .ok_or_else(|| invalid(key, "must be an integer")),
    }
}
