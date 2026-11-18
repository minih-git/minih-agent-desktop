//! Version-aware acknowledgement of durable notifications.
use std::sync::Arc;

use serde_json::{json, Value};
use tokio::sync::Mutex;

use super::{rpc_err, AppState, JsonRpcError};
use crate::{db::NOTIFICATION_KEEP, notifications};

fn timestamp(value: &Value, field: &str) -> Result<i64, JsonRpcError> {
    value
        .as_str()
        .and_then(|raw| chrono::DateTime::parse_from_rfc3339(raw).ok())
        .map(|stamp| stamp.timestamp_millis())
        .ok_or_else(|| {
            rpc_err(
                1002,
                format!("{field} must be an RFC3339 timestamp"),
                "INVALID_PARAMS",
            )
        })
}

pub(super) async fn mark_read(
    state: Arc<Mutex<AppState>>,
    params: Value,
) -> Result<Value, JsonRpcError> {
    let id = params
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.trim().is_empty())
        .ok_or_else(|| rpc_err(1002, "id required", "INVALID_PARAMS"))?;
    let expected = match params.get("expectedCreatedAt") {
        None | Some(Value::Null) => None,
        Some(value) => Some(timestamp(value, "expectedCreatedAt")?),
    };
    let st = state.lock().await;
    let ok = notifications::mark_read_versioned(&st.db, id, expected)
        .map_err(|error| rpc_err(1000, error.to_string(), "INTERNAL"))?;
    Ok(json!({ "ok": ok }))
}

pub(super) async fn mark_all_read(
    state: Arc<Mutex<AppState>>,
    params: Value,
) -> Result<Value, JsonRpcError> {
    let versions = match params.get("pluginRows") {
        None | Some(Value::Null) => None,
        Some(value) => {
            let rows = value
                .as_array()
                .ok_or_else(|| rpc_err(1002, "pluginRows must be an array", "INVALID_PARAMS"))?;
            if rows.len() > NOTIFICATION_KEEP as usize {
                return Err(rpc_err(
                    1002,
                    "pluginRows exceeds the inbox limit",
                    "INVALID_PARAMS",
                ));
            }
            let mut versions = Vec::with_capacity(rows.len());
            for row in rows {
                let id = row
                    .get("id")
                    .and_then(Value::as_str)
                    .filter(|id| !id.trim().is_empty())
                    .ok_or_else(|| {
                        rpc_err(1002, "pluginRows entries need an id", "INVALID_PARAMS")
                    })?;
                let created_at = timestamp(
                    row.get("createdAt").unwrap_or(&Value::Null),
                    "pluginRows createdAt",
                )?;
                versions.push((id.to_string(), created_at));
            }
            Some(versions)
        }
    };
    let st = state.lock().await;
    notifications::mark_all_read_versioned(&st.db, versions.as_deref())
        .map_err(|error| rpc_err(1000, error.to_string(), "INTERNAL"))?;
    Ok(json!({ "ok": true }))
}
