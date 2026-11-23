//! Host-side storage for plugin credential slots (`contributes.credentials`).
//!
//! Called by Electron Main only. The renderer has no IPC channel for these
//! methods and a plugin has no API at all, so the one call that returns
//! plaintext — `plugins.credentials.resolve` — never crosses into either: Main
//! resolves a slot to inject it into a host-owned egress request, then drops the
//! value. Every other method answers state and declaration metadata only.
//!
//! `status` carries the slot declaration (title, kind, fields, scope) so the
//! Settings sheet can render a plugin's credential form while the plugin is
//! disabled or unloaded — the metadata comes from the installed manifest, not
//! from the plugin process.

use super::{rpc_err, AppState, JsonRpcError};
use crate::plugins::credentials::{self, CredentialError};
use serde::Deserialize;
use serde_json::{Map, Value};
use std::sync::Arc;
use tokio::sync::Mutex;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PluginRequest {
    plugin_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SetRequest {
    plugin_id: String,
    slot_id: String,
    fields: Map<String, Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ClearRequest {
    plugin_id: String,
    slot_id: String,
    /// One instance of a multi-instance slot; absent clears the whole slot.
    #[serde(default)]
    instance_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ResolveRequest {
    plugin_id: String,
    /// `<slotId>` or `<slotId>#<instanceId>`.
    slot_id: String,
}

pub(super) async fn handle(
    state: Arc<Mutex<AppState>>,
    method: &str,
    params: Value,
) -> Result<Value, JsonRpcError> {
    match method {
        "plugins.credentials.status" => {
            let input: PluginRequest = parse(params, "invalid credentials status request")?;
            let st = state.lock().await;
            let plugin = installed(&st, &input.plugin_id)?;
            let locale = st.plugins.locale().to_string();
            credentials::status(&st.secrets, &plugin, &locale, Some(&st.db)).map_err(credential_err)
        }
        "plugins.credentials.list" => {
            let input: PluginRequest = parse(params, "invalid credentials list request")?;
            let st = state.lock().await;
            let plugin = installed(&st, &input.plugin_id)?;
            credentials::list(&st.secrets, &plugin, Some(&st.db)).map_err(credential_err)
        }
        "plugins.credentials.set" => {
            let input: SetRequest = parse(params, "invalid credentials set request")?;
            let st = state.lock().await;
            let plugin = installed(&st, &input.plugin_id)?;
            let instance = credentials::set(
                &st.secrets,
                &plugin,
                &input.slot_id,
                input.fields,
                Some(&st.db),
            )
            .map_err(credential_err)?;
            // `instanceId` is present only when the slot holds several values;
            // the renderer then refreshes the list instead of the single form.
            Ok(match instance {
                Some(instance_id) => {
                    serde_json::json!({ "configured": true, "instanceId": instance_id })
                }
                None => serde_json::json!({ "configured": true }),
            })
        }
        "plugins.credentials.clear" => {
            let input: ClearRequest = parse(params, "invalid credentials clear request")?;
            let st = state.lock().await;
            let plugin = installed(&st, &input.plugin_id)?;
            let cleared = credentials::clear(
                &st.secrets,
                &plugin,
                &input.slot_id,
                input.instance_id.as_deref(),
                Some(&st.db),
            )
            .map_err(credential_err)?;
            Ok(serde_json::json!({ "cleared": cleared }))
        }
        "plugins.credentials.resolve" => {
            let input: ResolveRequest = parse(params, "invalid credentials resolve request")?;
            let st = state.lock().await;
            let plugin = installed(&st, &input.plugin_id)?;
            let fields = credentials::resolve(&st.secrets, &plugin, &input.slot_id, Some(&st.db))
                .map_err(credential_err)?;
            Ok(serde_json::json!({ "fields": fields }))
        }
        other => Err(rpc_err(
            -32601,
            format!("method not found: {other}"),
            "NOT_FOUND",
        )),
    }
}

fn parse<T: serde::de::DeserializeOwned>(
    params: Value,
    message: &'static str,
) -> Result<T, JsonRpcError> {
    serde_json::from_value(params).map_err(|_| rpc_err(-32602, message, "INVALID_PARAMS"))
}

/// A slot belongs to a plugin this host has registered. A disabled plugin
/// still qualifies: its declaration and its stored values stay until uninstall.
fn installed(
    st: &AppState,
    plugin_id: &str,
) -> Result<crate::plugins::PluginSummary, JsonRpcError> {
    st.plugins.get(plugin_id).ok_or_else(|| {
        rpc_err(
            1007,
            format!("plugin {plugin_id} is not installed"),
            "PLUGIN_NOT_FOUND",
        )
    })
}
fn credential_err(error: CredentialError) -> JsonRpcError {
    match error {
        CredentialError::PluginInvalid(message) => rpc_err(1009, message, "PLUGIN_INVALID"),
        CredentialError::SlotNotDeclared(message) => {
            rpc_err(1002, message, "CREDENTIAL_SLOT_NOT_DECLARED")
        }
        CredentialError::Invalid(message) => rpc_err(1002, message, "CREDENTIAL_INVALID"),
        CredentialError::InstanceRequired(message) => {
            rpc_err(1002, message, "CREDENTIAL_INSTANCE_REQUIRED")
        }
        CredentialError::Limit(message) => rpc_err(1002, message, "CREDENTIAL_LIMIT"),
        CredentialError::NotConfigured(message) => {
            rpc_err(1007, message, "CREDENTIAL_NOT_CONFIGURED")
        }
        CredentialError::Storage(message) => rpc_err(1000, message, "INTERNAL"),
    }
}

#[cfg(test)]
#[path = "plugin_credentials_rpc_tests.rs"]
mod tests;
