//! Internal Electron-to-Host settings persistence. Plugins cannot choose an RPC
//! method or another identity: the runtime binds pluginId to the loaded plugin.
use super::{rpc_err, AppState, JsonRpcError};
use serde::Deserialize;
use serde_json::{Map, Value};
use std::sync::Arc;
use tokio::sync::Mutex;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    plugin_id: String,
    patch: Map<String, Value>,
}

pub(super) async fn update(
    state: Arc<Mutex<AppState>>,
    params: Value,
) -> Result<Value, JsonRpcError> {
    let input: Request = serde_json::from_value(params)
        .map_err(|_| rpc_err(-32602, "invalid plugin settings update", "PLUGIN_INVALID"))?;
    let st = state.lock().await;
    let plugin = st
        .plugins
        .get(&input.plugin_id)
        .ok_or_else(|| rpc_err(-32602, "plugin is not installed", "PLUGIN_NOT_FOUND"))?;
    let defaults = plugin
        .settings
        .iter()
        .filter_map(|setting| {
            setting
                .default
                .as_ref()
                .map(|value| (setting.key.clone(), value.clone()))
        })
        .collect();
    crate::plugins::settings::update(&st.data_dir, &input.plugin_id, defaults, input.patch)
        .map(|_| serde_json::json!({"updated": true}))
        .map_err(|error| rpc_err(-32000, error.to_string(), "PLUGIN_INVALID"))
}
