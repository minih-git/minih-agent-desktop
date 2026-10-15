pub mod config;
pub mod runtime;
pub mod tun_runner;

use std::path::Path;

use serde_json::Value;

pub use config::{settings_from_app_value, validate_easytier_settings, EasyTierEffectiveMode};
pub use runtime::{manager, EasyTierPeerSummary, EasyTierStatus, MinihRouterResolvedEndpoint};
pub use tun_runner::{run_internal_tun_runner, INTERNAL_EASYTIER_TUN_RUNNER_FLAG};

pub fn spawn_from_settings(data_dir: &Path, app_settings: Option<&Value>) {
    let settings = settings_from_app_value(app_settings);
    let dir = data_dir.to_path_buf();
    if let Ok(handle) = tokio::runtime::Handle::try_current() {
        handle.spawn(async move {
            let mut mgr = manager().lock().await;
            mgr.apply_settings(&dir, settings, false).await;
        });
    }
}

pub async fn apply_from_settings(data_dir: &Path, app_settings: Option<&Value>) -> EasyTierStatus {
    let settings = settings_from_app_value(app_settings);
    let mut mgr = manager().lock().await;
    mgr.apply_settings(data_dir, settings, false).await;
    mgr.status(None).await
}

pub async fn reconnect(data_dir: &Path, app_settings: Option<&Value>) -> EasyTierStatus {
    let settings = settings_from_app_value(app_settings);
    let mut mgr = manager().lock().await;
    mgr.apply_settings(data_dir, settings, true).await;
    mgr.status(None).await
}

pub async fn status(fallback_public_url: Option<&str>) -> EasyTierStatus {
    let mut mgr = manager().lock().await;
    mgr.status(fallback_public_url).await
}

pub async fn request_elevation() -> Result<EasyTierStatus, String> {
    let mut mgr = manager().lock().await;
    mgr.request_tun_elevation().await
}

pub async fn resolve_minih_router_endpoint(
    configured_base_url: Option<&str>,
) -> MinihRouterResolvedEndpoint {
    let mut mgr = manager().lock().await;
    mgr.resolve_minih_router_endpoint(configured_base_url).await
}
