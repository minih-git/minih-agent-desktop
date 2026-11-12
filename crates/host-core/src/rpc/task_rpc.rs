//! `task.*` over RPC, including the workspace work that needs state and git
//! (employee mode 0.5 slice 2).
//!
//! `task.create` still writes the task and its session in one database
//! transaction. Preparing the worktree is a git operation, so it runs *after*
//! that transaction commits and *before* the caller sends the first message: a
//! task never opens a turn in a folder that is still being built, and a failure
//! is reported on the row instead of being guessed from a log.
//!
//! `task.archive` cleans the workspace first, because its refusal is the whole
//! point: archiving work that has not left the machine has to be the person's
//! second decision, not a side effect of the first one.

use std::sync::Arc;

use serde_json::{json, Value};
use tokio::sync::Mutex;

use super::worktree_rpc::to_rpc;
use super::{rpc_err, session_collaboration_rpc_err, JsonRpcError};
use crate::session_worktrees::git::GitRunner;
use crate::state::AppState;
use crate::task_workspace;

fn internal(error: impl ToString) -> JsonRpcError {
    rpc_err(1000, error.to_string(), "INTERNAL")
}

fn param<'a>(params: &'a Value, name: &str) -> Result<&'a str, JsonRpcError> {
    params
        .get(name)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| rpc_err(1002, format!("{name} required"), "INVALID_PARAMS"))
}

/// Read one task back after the workspace work changed it.
async fn read_task(state: &Arc<Mutex<AppState>>, task_id: &str) -> Result<Value, JsonRpcError> {
    let st = state.lock().await;
    let task = crate::tasks::get_task(&st.db, task_id).map_err(internal)?;
    Ok(json!(task))
}

/// The task's own session summary, so a caller can open it without a second
/// read.
async fn read_session_for(
    state: &Arc<Mutex<AppState>>,
    task_id: &str,
) -> Result<Option<Value>, JsonRpcError> {
    let st = state.lock().await;
    let task = crate::tasks::get_task(&st.db, task_id).map_err(internal)?;
    let Some(task) = task else {
        return Ok(None);
    };
    let summary = crate::sessions::session_summary(&st.db, &task.session_id).map_err(internal)?;
    Ok(summary.map(|summary| json!(summary)))
}

pub(super) async fn handle(
    state: &Arc<Mutex<AppState>>,
    method: &str,
    params: Value,
) -> Result<Value, JsonRpcError> {
    let git = GitRunner::default();
    match method {
        "task.create" => {
            let created = {
                let st = state.lock().await;
                crate::session_collaboration::handle_task(&st.db, method, &params)
                    .map_err(session_collaboration_rpc_err)?
            };
            let Some(task_id) = created
                .pointer("/task/id")
                .and_then(Value::as_str)
                .map(str::to_owned)
            else {
                return Ok(created);
            };
            task_workspace::prepare(state, &git, &task_id)
                .await
                .map_err(to_rpc)?;
            Ok(json!({
                "task": read_task(state, &task_id).await?,
                "session": read_session_for(state, &task_id).await?,
            }))
        }
        "task.workspace.retry" => {
            let task_id = param(&params, "taskId")?;
            task_workspace::prepare(state, &git, task_id)
                .await
                .map_err(to_rpc)?;
            Ok(json!({ "task": read_task(state, task_id).await? }))
        }
        "task.archive" => {
            let task_id = param(&params, "taskId")?;
            // The person's second click on a refusal; absent means "not yet".
            let discard = params
                .get("discard")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            task_workspace::cleanup_for_archive(state, &git, task_id, discard)
                .await
                .map_err(to_rpc)?;
            let st = state.lock().await;
            crate::tasks::archive(&st.db, &params).map_err(session_collaboration_rpc_err)
        }
        _ => {
            let st = state.lock().await;
            crate::session_collaboration::handle_task(&st.db, method, &params)
                .map_err(session_collaboration_rpc_err)
        }
    }
}

/// `taskCard.confirm`: resolve the card's repository to a checkout on this
/// machine, confirm, then prepare the task's workspace before the caller
/// dispatches the delivery.
///
/// The resolution has to happen here because it runs git, and the confirmation
/// itself is a database transaction that must not hold the state lock across a
/// subprocess.
pub(super) async fn confirm_card(
    state: &Arc<Mutex<AppState>>,
    params: Value,
) -> Result<Value, JsonRpcError> {
    let git = GitRunner::default();
    let draft_id = param(&params, "draftId")?;
    let (origin, paths) = {
        let st = state.lock().await;
        let draft =
            crate::session_collaboration::drafts::get(&st.db, draft_id).map_err(internal)?;
        let origin = draft
            .as_ref()
            .and_then(|draft| draft.card.pointer("/repo/origin"))
            .and_then(Value::as_str)
            .map(str::to_owned);
        let paths = crate::task_workspace::project_paths(&st.db).map_err(internal)?;
        (origin, paths)
    };
    let project = match origin.as_deref() {
        Some(origin) => crate::task_workspace::project_for_origin(&git, &paths, origin).await,
        None => None,
    };
    let mut enriched = params.clone();
    if let Some(project) = project.as_deref() {
        enriched["projectPath"] = json!(project);
    }
    let result = {
        let st = state.lock().await;
        crate::session_collaboration::handle(&st.db, "taskCard.confirm", &enriched)
            .map_err(session_collaboration_rpc_err)?
    };
    let Some(task_id) = result
        .pointer("/task/id")
        .and_then(Value::as_str)
        .map(str::to_owned)
    else {
        return Ok(result);
    };
    task_workspace::prepare(state, &git, &task_id)
        .await
        .map_err(to_rpc)?;
    let mut result = result;
    result["task"] = read_task(state, &task_id).await?;
    Ok(result)
}
