use std::sync::Arc;

use serde_json::{json, Value};
use tokio::sync::Mutex;

use super::{
    merge_settings_value, normalize_settings_value, rpc_err, validate_settings_value, JsonRpcError,
};
use crate::easytier_net::{self, AppStateCredentialProvider, EasyTierEffectiveMode};
use crate::state::AppState;

pub(super) async fn handle(
    state: Arc<Mutex<AppState>>,
    method: &str,
    params: Value,
) -> Result<Value, JsonRpcError> {
    match method {
        "easytier.status" => {
            let fallback = params.get("fallbackBaseUrl").and_then(Value::as_str);
            let status = easytier_net::status(fallback).await;
            serde_json::to_value(status).map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))
        }
        "easytier.configure" => {
            let easytier_payload = params
                .get("easytier")
                .cloned()
                .unwrap_or_else(|| params.clone());
            let patch = json!({ "easytier": easytier_payload });
            validate_settings_value(&patch)?;

            let (data_dir, settings) = {
                let st = state.lock().await;
                let stored = st
                    .db
                    .get_setting("app")
                    .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
                let settings = normalize_settings_value(merge_settings_value(stored, patch));
                st.db
                    .set_setting("app", &settings)
                    .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
                (st.data_dir.clone(), settings)
            };

            // The credential provider borrows the same state lock this arm is
            // about to release, so it is built after the write and asked for the
            // key inside `apply_from_settings`, not here.
            let status = easytier_net::apply_from_settings(
                &data_dir,
                Some(&settings),
                Some(&AppStateCredentialProvider::new(state.clone())),
            )
            .await;
            serde_json::to_value(status).map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))
        }
        "easytier.reconnect" => {
            let (data_dir, stored) = {
                let st = state.lock().await;
                let stored = st
                    .db
                    .get_setting("app")
                    .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
                (st.data_dir.clone(), stored)
            };
            let status = easytier_net::reconnect(
                &data_dir,
                stored.as_ref(),
                Some(&AppStateCredentialProvider::new(state.clone())),
            )
            .await;
            serde_json::to_value(status).map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))
        }
        "easytier.requestElevation" => {
            let status = easytier_net::request_elevation()
                .await
                .map_err(|e| rpc_err(1000, e, "INTERNAL"))?;
            let persisted_mode = if status.effective_mode == EasyTierEffectiveMode::Tun {
                "tun"
            } else {
                "no_tun"
            };
            {
                let st = state.lock().await;
                if let Ok(stored) = st.db.get_setting("app") {
                    let mut current_easytier = stored
                        .as_ref()
                        .and_then(|v| v.get("easytier"))
                        .and_then(Value::as_object)
                        .cloned()
                        .unwrap_or_default();
                    current_easytier.insert("mode".into(), Value::String(persisted_mode.into()));
                    let merged = normalize_settings_value(merge_settings_value(
                        stored,
                        json!({ "easytier": Value::Object(current_easytier) }),
                    ));
                    let _ = st.db.set_setting("app", &merged);
                }
            }
            serde_json::to_value(status).map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))
        }
        "easytier.resolveMinihRouterEndpoint" => {
            let base_url = params.get("baseUrl").and_then(Value::as_str);
            let resolved = easytier_net::resolve_minih_router_endpoint(base_url).await;
            serde_json::to_value(resolved).map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))
        }
        _ => Err(rpc_err(
            -32601,
            format!("method not found: {method}"),
            "NOT_FOUND",
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn easytier_rpc_validates_and_persists_disabled_configuration() {
        let data_dir = tempfile::tempdir().unwrap();
        let mut app_state = AppState::open(data_dir.path()).unwrap();
        app_state.handshook = true;
        let state = Arc::new(Mutex::new(app_state));

        let invalid = handle(
            state.clone(),
            "easytier.configure",
            json!({
                "enabled": false,
                "mode": "invalid_mode"
            }),
        )
        .await
        .unwrap_err();
        assert_eq!(invalid.data.unwrap()["errorCode"], "INVALID_PARAMS");

        let status = handle(
            state.clone(),
            "easytier.configure",
            json!({
                "enabled": false,
                "mode": "no_tun",
                "networkName": "minih-net",
                "networkSecret": "typed-by-user",
                "peers": ["udp://tier.hmini.org:11010", "tcp://tier.hmini.org:11010"],
                "routerLanUrl": "http://11.11.11.10:3001/v1"
            }),
        )
        .await
        .unwrap();
        assert_eq!(status["state"], "disabled");

        let resolved = handle(
            state.clone(),
            "easytier.resolveMinihRouterEndpoint",
            json!({
                "baseUrl": "https://router.hmini.org/v1"
            }),
        )
        .await
        .unwrap();
        assert_eq!(resolved["usingLan"], false);
        assert_eq!(resolved["activeBaseUrl"], "https://router.hmini.org/v1");
        assert_eq!(resolved["fallbackBaseUrl"], "https://router.hmini.org/v1");
    }
}
