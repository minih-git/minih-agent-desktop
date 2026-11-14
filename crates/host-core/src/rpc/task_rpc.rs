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
        // The completion card (employee mode 0.5 slice 4b): what the card shows
        // and whether it may merge, then the merge itself, in the host's fixed
        // steps. `gh` is constructed here so the domain keeps its injectable
        // reader and every test drives a scripted one.
        "task.delivery.check" => {
            let task_id = param(&params, "taskId")?;
            let gh = crate::task_delivery::GhCli::default();
            crate::task_delivery::check(state, &git, &gh, task_id)
                .await
                .map_err(session_collaboration_rpc_err)
        }
        "task.delivery.merge" => {
            let task_id = param(&params, "taskId")?;
            let gh = crate::task_delivery::GhCli::default();
            crate::task_delivery::merge(state, &git, &gh, task_id)
                .await
                .map_err(session_collaboration_rpc_err)
        }
        // An employee's lessons from an archived task (employee mode 0.5 slice
        // 5). Database work only: Main drains the pending list and calls a model
        // of its own, and the host stays the one that decides what is stored.
        "task.experience.pending"
        | "task.experience.claim"
        | "task.experience.input"
        | "task.experience.complete"
        | "task.experience.fail"
        | "task.experience.skip"
        | "task.experience.list" => {
            let st = state.lock().await;
            experience(&st.db, method, &params)
        }
        // The hourly inspection (employee mode 0.5 slice 5). Deterministic, and
        // it calls no model: progress must cost nothing, and only an anomaly is
        // worth the steward's attention.
        "task.inspect" => {
            let st = state.lock().await;
            crate::task_inspection::inspect(&st.db, crate::db::now_ms()).map_err(internal)
        }
        // Relay between steps (employee mode 0.5 slice 7). The click on a
        // completion card is what hands the branch on: the host records the
        // handoff and answers with the delivery Main has to start, so the next
        // step begins exactly where this one stopped. Repeating the click is the
        // same answer, never a second dispatch.
        "task.relay.handoff" => {
            let st = state.lock().await;
            crate::task_relay::handoff(&st.db, &params).map_err(session_collaboration_rpc_err)
        }
        // 「改从 main 开工」 on an orphaned step: the edge to the abandoned step
        // goes away, the workspace is built from the project's own `main`, and
        // the delivery that was waiting is dispatched again. The person's own
        // click, never a fallback the host chooses.
        "task.relay.detach" => {
            let detached = {
                let st = state.lock().await;
                crate::task_relay::detach(&st.db, &params).map_err(session_collaboration_rpc_err)?
            };
            let task_id = detached
                .pointer("/task/id")
                .and_then(Value::as_str)
                .map(str::to_owned);
            let Some(task_id) = task_id else {
                return Ok(detached);
            };
            task_workspace::prepare(state, &git, &task_id)
                .await
                .map_err(to_rpc)?;
            let mut detached = detached;
            detached["task"] = read_task(state, &task_id).await?;
            Ok(detached)
        }
        // Which other open tasks in this repository are changing files, and
        // which of those files this one changes too. A hint the card shows,
        // never a refusal: a person who is told can still decide the two changes
        // are unrelated.
        "task.overlap" => crate::task_overlap::overlap(state, &git, &params)
            .await
            .map_err(internal),
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
/// `task.experience.*`: what an archived task taught its employee.
///
/// Main owns the model call; the host owns the rules. `pending` and `claim` make
/// the run exactly-once across restarts, `input` decides how much transcript the
/// run may read, and `complete` / `fail` / `skip` are the only three ways the
/// state can move.
fn experience(
    db: &crate::db::Database,
    method: &str,
    params: &Value,
) -> Result<Value, JsonRpcError> {
    match method {
        "task.experience.pending" => {
            let limit = params.get("limit").and_then(Value::as_i64).unwrap_or(20);
            Ok(json!({ "tasks": db.experience_pending(limit).map_err(internal)? }))
        }
        "task.experience.claim" => {
            let task_id = param(params, "taskId")?;
            let lease = params
                .get("leaseMs")
                .and_then(Value::as_i64)
                .unwrap_or(crate::memory::EXTRACTION_LEASE_MS);
            let claimed = db.experience_claim(task_id, lease).map_err(internal)?;
            Ok(json!({ "claimed": claimed.is_some(), "state": claimed }))
        }
        "task.experience.input" => {
            let task_id = param(params, "taskId")?;
            // A task the person already deleted is not an error for the drain: it
            // answers with no input and the caller moves on.
            let input = db.experience_input(task_id).map_err(internal)?;
            Ok(json!({ "input": input }))
        }
        "task.experience.complete" => {
            let task_id = param(params, "taskId")?;
            let entries = params
                .get("entries")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|item| {
                            serde_json::from_value::<crate::memory::ExperienceCandidate>(
                                item.clone(),
                            )
                            .ok()
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let result = db
                .experience_complete(task_id, &entries)
                .map_err(internal)?;
            Ok(json!({ "result": result }))
        }
        "task.experience.fail" => {
            let task_id = param(params, "taskId")?;
            let code = params
                .get("code")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or("EXPERIENCE_FAILED");
            let state = db.experience_fail(task_id, code).map_err(internal)?;
            Ok(json!({ "state": state }))
        }
        "task.experience.skip" => {
            let task_id = param(params, "taskId")?;
            let state = db.experience_skip(task_id).map_err(internal)?;
            Ok(json!({ "state": state }))
        }
        "task.experience.list" => {
            let employee = param(params, "employeeSessionId")?;
            let entries = db.experience_list(employee).map_err(internal)?;
            Ok(json!({ "entries": entries }))
        }
        _ => Err(rpc_err(1007, "unknown experience method", "NOT_FOUND")),
    }
}
