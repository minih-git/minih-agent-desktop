//! `TaskReport`: a task session's structured "I am stuck" (employee mode 0.5
//! slice 4a).
//!
//! Employee mode splits the employee from its work, and the work is a task with
//! its own session. What that session could not do is say *how* it failed: a
//! model that ends its turn with a paragraph about a missing credential leaves
//! the person reading prose, and leaves the task looking finished. This tool is
//! the one structured exit: three bounded fields the blocked card renders as
//! they are, plus the stage the host derives from them.
//!
//! Two rules are enforced here rather than trusted to the model:
//!
//! - **The session comes from the transport.** `sessionId` is filled from the
//!   call's own session, so a task cannot report on another task's row; any
//!   `sessionId` in the arguments is overwritten.
//! - **Only a task session may report.** A conversation or an employee session
//!   is refused with a concrete tool error the model can read, which is also the
//!   guard that keeps the tool's declaration honest.

use std::sync::Arc;
use std::time::Instant;

use serde_json::{json, Value};
use tokio::sync::Mutex;

use super::{rpc_err, JsonRpcError};
use crate::state::AppState;
use crate::tasks;
use crate::tools::{ToolsExecuteParams, ToolsExecuteResult};

/// A refused call, as a tool result the model can act on rather than a transport
/// failure.
fn refused(
    p: &ToolsExecuteParams,
    code: &str,
    message: &str,
    started: Instant,
) -> ToolsExecuteResult {
    ToolsExecuteResult {
        tool_call_id: p.tool_call_id.clone(),
        ok: false,
        is_error: Some(true),
        content: json!({ "error": message, "code": code }),
        duration_ms: started.elapsed().as_millis() as u64,
        denied: None,
        error_code: Some(code.to_string()),
        command_shell_id: None,
    }
}

/// The wire code one host refusal becomes.
///
/// The host's errors are `CODE: message` strings, and every one of them is
/// something the model can fix (a missing field, an over-long one) or something
/// it must not retry (not a task session).
fn wire_code(message: &str) -> &'static str {
    if message.starts_with("INVALID_ARGUMENT") {
        "INVALID_ARGUMENT"
    } else if message.starts_with("LIMIT_EXCEEDED") {
        "LIMIT_EXCEEDED"
    } else if message.starts_with("NOT_FOUND") {
        "NOT_FOUND"
    } else {
        "INTERNAL"
    }
}

/// Execute one `TaskReport` call.
pub async fn execute_report(
    state: &Arc<Mutex<AppState>>,
    p: &ToolsExecuteParams,
    started: Instant,
) -> Result<ToolsExecuteResult, JsonRpcError> {
    // A task reports its own turn. A delegate's call carries the definition's
    // permission scope and belongs to a subagent's context, not to the task's
    // row, so it is refused rather than attributed upwards.
    if p.permission_scope.is_some() {
        return Ok(refused(
            p,
            "TOOL_DENIED",
            "TaskReport belongs to the task session's own turn, not to a delegate",
            started,
        ));
    }

    let mut params = p.args.clone();
    let Some(map) = params.as_object_mut() else {
        return Ok(refused(
            p,
            "INVALID_ARGUMENT",
            "TaskReport arguments must be an object",
            started,
        ));
    };
    // The trusted session, never the model's own claim about it.
    map.insert("sessionId".into(), json!(p.session_id));

    let reported = {
        let st = state.lock().await;
        if st.shutting_down {
            return Err(rpc_err(1001, "host is shutting down", "HOST_SHUTTING_DOWN"));
        }
        tasks::report_blocked(&st.db, &params)
    };

    let value: Value = match reported {
        Ok(value) => value,
        Err(error) => {
            let message = error.to_string();
            return Ok(refused(p, wire_code(&message), &message, started));
        }
    };
    let stage = value
        .pointer("/task/stage")
        .and_then(Value::as_str)
        .unwrap_or("blocked");
    // Two reports share this tool: the work stopped, or the work is done. What
    // the model is told to do next differs, so the status is read back from
    // what the host actually stored rather than from the argument.
    let ready = value.pointer("/result/status").and_then(Value::as_str) == Some("ready");
    tracing::info!(
        session_id = %p.session_id,
        turn_id = p.turn_id.as_deref().unwrap_or(""),
        stage,
        ready,
        "task reported its outcome"
    );
    Ok(ToolsExecuteResult {
        tool_call_id: p.tool_call_id.clone(),
        ok: true,
        is_error: None,
        content: if ready {
            json!({
                // Same rule for the other outcome: the report is the end of the
                // turn, and carrying on would turn a finished task into work
                // nobody asked for.
                "text": format!(
                    "Reported ready; the person now sees the completion card and decides whether to accept. Stage is {stage}. End this turn now."
                ),
                "stage": stage,
                "result": value.get("result").cloned().unwrap_or(Value::Null),
            })
        } else {
            json!({
                // The instruction the model has to follow is in the result, not
                // only in the tool description: a report is the end of the turn,
                // and carrying on would turn "stuck" into work nobody asked for.
                "text": format!(
                    "Reported blocked; the person now sees where this task stopped. Stage is {stage}. End this turn now."
                ),
                "stage": stage,
                "blocker": value.get("blocker").cloned().unwrap_or(Value::Null),
            })
        },
        duration_ms: started.elapsed().as_millis() as u64,
        denied: None,
        error_code: None,
        command_shell_id: None,
    })
}
