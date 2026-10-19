//! Background task reads and explicit stops; process ownership stays in
//! `background_tasks` rather than in the RPC transport.
use serde_json::{json, Value};
use tokio::sync::Mutex;

use super::{rpc_err, JsonRpcError};
use crate::{background_tasks, state::AppState};

pub(super) async fn handle(
    state: &Mutex<AppState>,
    method: &str,
    params: Value,
) -> Result<Value, JsonRpcError> {
    match method {
        "backgroundTasks.list" => {
            let st = state.lock().await;
            Ok(json!({
                "tasks": st.background_tasks.summaries(),
                // The change counter is the single version source: supervisors
                // bump it on every transition and the renderer re-lists on the
                // matching notification.
                "version": background_tasks::change_counter(),
            }))
        }
        "backgroundTasks.output" => {
            let id = params
                .get("id")
                .and_then(|v| v.as_str())
                .filter(|id| !id.trim().is_empty())
                .ok_or_else(|| rpc_err(1002, "id required", "INVALID_PARAMS"))?;
            let st = state.lock().await;
            match background_tasks::task_output(&st.background_tasks, id).await {
                Ok(Some(output)) => Ok(output),
                // `NOT_FOUND` is the registered, documented code for an unknown
                // entity id; a dedicated TASK_NOT_FOUND would be a new contract
                // (ErrorCodes + 08-error-codes) for no behavioural gain.
                Ok(None) => Err(rpc_err(1007, "task not found", "NOT_FOUND")),
                Err(message) => Err(rpc_err(1000, message, "INTERNAL")),
            }
        }
        "backgroundTasks.stop" => {
            let id = params
                .get("id")
                .and_then(|v| v.as_str())
                .filter(|id| !id.trim().is_empty())
                .ok_or_else(|| rpc_err(1002, "id required", "INVALID_PARAMS"))?;
            let st = state.lock().await;
            // Signalling is enough: the supervisor kills the tree, records the
            // terminal state, and bumps the change counter, which fans out the
            // `backgroundTasks.changed` notification for this same task.
            let found = background_tasks::stop_task(&st.background_tasks, id)
                .await
                .map_err(|message| rpc_err(1000, message, "INTERNAL"))?;
            Ok(json!({ "ok": true, "found": found }))
        }
        _ => Err(rpc_err(
            -32601,
            "unknown background task method",
            "METHOD_NOT_FOUND",
        )),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    #[test]
    fn background_start_preserves_the_permission_admission_budget() {
        let foreground = json!({ "toolName": "Bash", "timeoutMs": 60_000 });
        let background = json!({
            "toolName": "Bash", "timeoutMs": 60_000, "runInBackground": true
        });
        assert_eq!(
            super::super::request_budget_ms("tools.execute", &background),
            super::super::request_budget_ms("tools.execute", &foreground),
        );
    }
}
