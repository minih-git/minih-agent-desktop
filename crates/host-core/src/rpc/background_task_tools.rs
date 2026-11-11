//! Host-side execution of the model-facing background task tools.
//!
//! `Bash` with `runInBackground: true` registers a process in
//! [`crate::background_tasks`] and returns only its id. Without these tools the
//! model that started a dev server could not read its output or stop it — the
//! `backgroundTasks.*` RPCs belong to the renderer's task dock and are global.
//!
//! `BackgroundTaskList` and `BackgroundTaskOutput` are read-only;
//! `BackgroundTaskStop` signals the same stop path the renderer uses. Every
//! boundary stays in the host:
//!
//! - **Session isolation.** The registry is process-wide and has no per-session
//!   authorization, so every lookup here filters by `p.session_id` — the
//!   calling session's own identity. No tool takes a session id, and an id
//!   owned by another session answers exactly like an unknown id, so the tools
//!   cannot be used to probe what another conversation runs.
//! - **Bounded reads.** stdout and stderr keep their tail under
//!   [`crate::tools::BUDGET_SHELL_ERR`]; a task that logged for minutes must not
//!   fill the model's context. The over-budget copy spills to the session
//!   scratch directory, so the truncation marker can name a file to Grep.
//! - **Bounded waiting.** `waitSeconds` waits for a terminal state, capped far
//!   below the `tools.execute` request budget and interrupted by the turn's own
//!   Stop through the typed cancellation registry. A timeout returns the
//!   current state; it is not a failure.

use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tokio::sync::watch;

use super::{rpc_err, AppState, JsonRpcError};
use crate::background_tasks::{self, BackgroundTaskRegistry, BackgroundTaskState};
use crate::permissions::Risk;
use crate::tool_cancellation::wait_for_tool_cancellation;
use crate::tools::{ToolsExecuteParams, ToolsExecuteResult};

#[cfg(test)]
#[path = "background_task_tools_tests.rs"]
mod tests;

pub(crate) const LIST: &str = "BackgroundTaskList";
pub(crate) const OUTPUT: &str = "BackgroundTaskOutput";
pub(crate) const STOP: &str = "BackgroundTaskStop";

/// Longest `waitSeconds` may block. `tools.execute` is admitted for
/// `timeout + RPC_PERMISSION_WAIT_CAP_MS + RPC_TOOL_BUDGET_GRACE_MS` — at least
/// three minutes even for a tool that declares no timeout — and the transport
/// gives `tools.execute` no separate deadline. 60s keeps one wait well inside
/// that budget while staying long enough for a build or a server's first log
/// lines, and the model can call again to keep waiting.
const MAX_WAIT_SECONDS: u64 = 60;
/// Poll interval of a bounded wait. A finished task should answer promptly; the
/// poll costs one short lock and never blocks a supervisor.
const WAIT_POLL: Duration = Duration::from_millis(50);
/// Tasks one list result may carry. The registry keeps at most 10 running and
/// 16 finished per session, so this bounds a result that a future history
/// change cannot grow.
const MAX_LISTED_TASKS: usize = 40;

pub fn recognizes(name: &str) -> bool {
    matches!(name, LIST | OUTPUT | STOP)
}

/// The registered risk of one call. Reading this session's own tasks is as
/// cheap as a `Read`, so it registers low. Stopping a process the model started
/// is a state change and keeps the default medium risk, so `ask` and
/// `accept-edits` show a card while `auto` follows the selected policy.
pub(crate) fn risk_for(tool_name: &str) -> Option<Risk> {
    (tool_name == STOP).then_some(Risk::Medium)
}

/// Run one background task tool call. Mirrors `memory_tools::execute`: the
/// caller (`tools.execute`) has already resolved the session, the mode, and the
/// permission decision, and passes the turn's cancellation signal.
pub async fn execute(
    state: &tokio::sync::Mutex<AppState>,
    p: &ToolsExecuteParams,
    cancellation: Option<watch::Receiver<bool>>,
) -> ToolsExecuteResult {
    let started = Instant::now();
    let result = execute_inner(state, p, cancellation).await;
    let (ok, content, error_code) = match result {
        Ok(content) => (true, content, None),
        Err(error) => {
            let code = error
                .data
                .as_ref()
                .and_then(|data| data["errorCode"].as_str())
                .unwrap_or("INTERNAL")
                .to_string();
            (
                false,
                json!({ "error": error.message, "code": code }),
                Some(code),
            )
        }
    };
    ToolsExecuteResult {
        tool_call_id: p.tool_call_id.clone(),
        ok,
        is_error: (!ok).then_some(true),
        content,
        duration_ms: started.elapsed().as_millis() as u64,
        denied: None,
        error_code,
        command_shell_id: None,
    }
}

async fn execute_inner(
    state: &tokio::sync::Mutex<AppState>,
    p: &ToolsExecuteParams,
    cancellation: Option<watch::Receiver<bool>>,
) -> Result<Value, JsonRpcError> {
    match p.tool_name.as_str() {
        LIST => list(state, &p.session_id).await,
        OUTPUT => output(state, p, cancellation).await,
        STOP => stop(state, p).await,
        _ => Err(rpc_err(-32601, "unknown tool", "METHOD_NOT_FOUND")),
    }
}

/// This session's tasks only. The registry is global, so the session filter is
/// the authorization boundary, not presentation.
async fn list(
    state: &tokio::sync::Mutex<AppState>,
    session_id: &str,
) -> Result<Value, JsonRpcError> {
    let st = state.lock().await;
    let tasks: Vec<Value> = st
        .background_tasks
        .summaries()
        .into_iter()
        .filter(|summary| summary.session_id == session_id)
        .take(MAX_LISTED_TASKS)
        .map(|summary| {
            json!({
                "id": summary.id,
                "command": summary.command,
                "state": summary.state,
                "elapsedMs": summary.elapsed_ms,
                "exitCode": summary.exit_code,
            })
        })
        .collect();
    let running = st.background_tasks.running_count_for(session_id);
    Ok(json!({
        "count": tasks.len(),
        "runningCount": running,
        "tasks": tasks,
    }))
}

async fn output(
    state: &tokio::sync::Mutex<AppState>,
    p: &ToolsExecuteParams,
    cancellation: Option<watch::Receiver<bool>>,
) -> Result<Value, JsonRpcError> {
    let id = id_arg(&p.args)?;
    let wait_seconds = wait_seconds_arg(&p.args)?;
    wait_for_terminal(state, p, &id, wait_seconds, cancellation).await?;

    let (data_dir, snapshot) = {
        let st = state.lock().await;
        let data_dir = st.data_dir.clone();
        // One acquired read: state, exit code, and both streams agree, and a
        // busy supervisor delays the answer instead of turning it into
        // NOT_FOUND.
        let snapshot = st
            .background_tasks
            .session_task_snapshot(&p.session_id, &id)
            .await;
        (data_dir, snapshot)
    };
    let Some(task) = snapshot else {
        return Err(task_not_found());
    };
    let scratch = crate::scratch::session_dir(&data_dir, &p.session_id);
    let (stdout, stdout_cut) = bounded(&task.stdout, scratch.as_deref(), &task.id, "stdout");
    let (stderr, stderr_cut) = bounded(&task.stderr, scratch.as_deref(), &task.id, "stderr");
    Ok(json!({
        "id": task.id,
        "command": task.command,
        "state": task.state,
        "elapsedMs": task.elapsed_ms,
        "exitCode": task.exit_code,
        "stdout": stdout,
        "stderr": stderr,
        // The ring reports drops from its own head; the budget below trims the
        // copy handed to the model. Either makes the streams incomplete.
        "truncated": task.truncated || stdout_cut || stderr_cut,
    }))
}

/// Block until the task leaves `running` or the bounded budget runs out. A
/// timeout reports the state that is current now; it is not an error. A Stop
/// ends the wait the same way — the task itself keeps running, because a
/// background process survives the turn that started it.
async fn wait_for_terminal(
    state: &tokio::sync::Mutex<AppState>,
    p: &ToolsExecuteParams,
    id: &str,
    wait_seconds: u64,
    cancellation: Option<watch::Receiver<bool>>,
) -> Result<(), JsonRpcError> {
    let deadline = Instant::now() + Duration::from_secs(wait_seconds.min(MAX_WAIT_SECONDS));
    let mut cancellation = cancellation;
    loop {
        {
            let st = state.lock().await;
            match owned_state(&st.background_tasks, &p.session_id, id) {
                // An unknown id, or one owned by another session, never reads
                // as "a task with no output".
                None => return Err(task_not_found()),
                Some(BackgroundTaskState::Running) => {}
                Some(_) => return Ok(()),
            }
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Ok(());
        }
        let slice = remaining.min(WAIT_POLL);
        // The stop path must end the wait without waiting out the budget: the
        // process is untouched either way, and the model reads the state it
        // finds.
        tokio::select! {
            _ = tokio::time::sleep(slice) => {}
            // A stop ends the wait immediately; the task keeps running.
            _ = wait_for_tool_cancellation(&mut cancellation) => return Ok(()),
        }
    }
}

async fn stop(
    state: &tokio::sync::Mutex<AppState>,
    p: &ToolsExecuteParams,
) -> Result<Value, JsonRpcError> {
    let id = id_arg(&p.args)?;
    let st = state.lock().await;
    // Ownership first: `stop_task` answers by registry id alone, so it must
    // never see an id this session does not own. Reading under the task's own
    // lock keeps `wasRunning` honest instead of guessing at a contended cell.
    let before = st
        .background_tasks
        .session_task_snapshot(&p.session_id, &id)
        .await
        .ok_or_else(task_not_found)?;
    let signalled = background_tasks::stop_task(&st.background_tasks, &id)
        .await
        .map_err(|message| rpc_err(1000, message, "INTERNAL"))?;
    // Idempotent: a finished task, or one that is already stopping, reports
    // `stopped: false` and the state it is in. The request itself succeeded.
    Ok(json!({
        "id": id,
        "stopped": signalled,
        "wasRunning": before.state == BackgroundTaskState::Running,
        "state": if signalled { BackgroundTaskState::Stopped } else { before.state },
    }))
}

/// One id answers for another session exactly as an unknown id does. Anything
/// else would let the model enumerate what other conversations are running.
fn task_not_found() -> JsonRpcError {
    rpc_err(
        1007,
        "task not found in this session; list your own tasks with BackgroundTaskList",
        "NOT_FOUND",
    )
}

fn id_arg(args: &Value) -> Result<String, JsonRpcError> {
    args.get("id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_string)
        .ok_or_else(|| rpc_err(1002, "id required", "INVALID_ARGUMENT"))
}

/// Absent means "do not wait". A negative or non-numeric value is refused
/// rather than silently read as zero, so a malformed wait stays visible.
fn wait_seconds_arg(args: &Value) -> Result<u64, JsonRpcError> {
    match args.get("waitSeconds") {
        None | Some(Value::Null) => Ok(0),
        Some(value) => value.as_u64().ok_or_else(|| {
            rpc_err(
                1002,
                "waitSeconds must be a non-negative integer",
                "INVALID_ARGUMENT",
            )
        }),
    }
}

fn owned_state(
    registry: &BackgroundTaskRegistry,
    session_id: &str,
    id: &str,
) -> Option<BackgroundTaskState> {
    registry
        .summaries()
        .into_iter()
        .find(|summary| summary.session_id == session_id && summary.id == id)
        .map(|summary| summary.state)
}

/// Trim one stream to the model's budget. The over-budget copy lands at a path
/// fixed per task and stream, so polling a large log overwrites one file
/// instead of leaving a dated copy per read.
fn bounded(
    text: &str,
    scratch: Option<&std::path::Path>,
    task_id: &str,
    stream: &str,
) -> (String, bool) {
    crate::tools::truncate_with_stable_spill(
        text,
        crate::tools::BUDGET_SHELL_ERR,
        scratch,
        &format!("background-{task_id}-{stream}"),
    )
}
