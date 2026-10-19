pub mod bootstrap;
pub mod config;
pub mod credentials;
pub mod remote_gateway;
pub mod runtime;
pub mod tun_runner;

use std::path::Path;
use std::sync::Arc;

use serde_json::Value;

pub use config::{settings_from_app_value, validate_easytier_settings, EasyTierEffectiveMode};
pub use credentials::AppStateCredentialProvider;
pub use runtime::{
    manager, BootstrapCredentialProvider, EasyTierPeerSummary, EasyTierStatus,
    MinihRouterResolvedEndpoint,
};
pub use tun_runner::{run_internal_tun_runner, INTERNAL_EASYTIER_TUN_RUNNER_FLAG};

/// Start the channel at boot with the database as the credential source.
///
/// Every start asks the Router for the network identity, so the boot path needs
/// a source just as the settings path does: without one the desktop never learns
/// which Gateway serves this account, and account mode stays unavailable until
/// the user happens to reconfigure or reconnect. `AppState::open` has already
/// finished by the time this runs, so the provider can read the saved row.
pub fn spawn_at_boot(
    data_dir: &Path,
    app_settings: Option<&Value>,
    credentials: Arc<dyn BootstrapCredentialProvider>,
) {
    spawn_from_settings_with(data_dir, app_settings, credentials);
}

/// `spawn_from_settings` with a credential source, for the settings-update path
/// where the database is already available.
pub fn spawn_from_settings_with(
    data_dir: &Path,
    app_settings: Option<&Value>,
    credentials: Arc<dyn BootstrapCredentialProvider>,
) {
    let settings = settings_from_app_value(app_settings);
    let dir = data_dir.to_path_buf();
    if let Ok(handle) = tokio::runtime::Handle::try_current() {
        handle.spawn(async move {
            let mut mgr = manager().lock().await;
            mgr.apply_settings_with(&dir, settings, false, Some(credentials.as_ref()))
                .await;
        });
    }
}

pub async fn apply_from_settings(
    data_dir: &Path,
    app_settings: Option<&Value>,
    credentials: Option<&dyn BootstrapCredentialProvider>,
) -> EasyTierStatus {
    let settings = settings_from_app_value(app_settings);
    let mut mgr = manager().lock().await;
    mgr.apply_settings_with(data_dir, settings, false, credentials)
        .await;
    mgr.status(None).await
}

pub async fn reconnect(
    data_dir: &Path,
    app_settings: Option<&Value>,
    credentials: Option<&dyn BootstrapCredentialProvider>,
) -> EasyTierStatus {
    let settings = settings_from_app_value(app_settings);
    let mut mgr = manager().lock().await;
    mgr.apply_settings_with(data_dir, settings, true, credentials)
        .await;
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
