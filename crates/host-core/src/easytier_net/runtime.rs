use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use easytier::instance::factory::{create_native_instance, NativeCoreInstance};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use super::bootstrap::{
    access_key_digest, apply_bootstrap, bootstrap_client, defaults_overlay, fetch_bootstrap,
    BootstrapCache, BootstrapError, BootstrapResponse, BootstrapSource, SharedClient,
};
use super::config::{
    build_toml_config, parse_router_lan_target, EasyTierConnectionState, EasyTierEffectiveMode,
    EasyTierMode, EasyTierSettings, DEFAULT_ROUTER_PUBLIC_URL,
};
use super::tun_runner::{
    collect_instance_snapshot, is_current_process_elevated, now_ms, spawn_elevated_tun_runner,
    TunRunnerSpec, TunRunnerStatusSnapshot,
};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EasyTierPeerSummary {
    pub peer_id: u32,
    pub ipv4: Option<String>,
    pub hostname: String,
    pub cost: String,
    pub tunnel_proto: String,
    pub loss_rate: Option<f32>,
    pub rx_bytes: u64,
    pub tx_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EasyTierStatus {
    pub enabled: bool,
    pub configured_mode: EasyTierMode,
    pub effective_mode: EasyTierEffectiveMode,
    pub state: EasyTierConnectionState,
    pub tun_privileged: bool,
    pub virtual_ipv4: Option<String>,
    pub hostname: Option<String>,
    pub network_name: String,
    pub peers: Vec<String>,
    pub bootstrap_peers: Vec<String>,
    pub peer_count: usize,
    pub connected_peers: Vec<EasyTierPeerSummary>,
    pub router_lan_url: String,
    pub local_forward_port: Option<u16>,
    pub local_forward_url: Option<String>,
    pub using_lan: bool,
    pub active_router_base_url: String,
    pub fallback_router_base_url: String,
    pub router_lan_reachable: bool,
    pub last_error: Option<String>,
    pub updated_at_ms: u64,
    /// True when EasyTier hands out the virtual IPv4; false pins `static_ipv4`.
    pub dhcp: bool,
    /// The configured static virtual IPv4, empty when DHCP is on.
    pub static_ipv4: String,
    /// Where the network identity in effect came from.
    pub bootstrap_source: BootstrapSource,
    /// The network name the gateway issued, empty when it did not answer.
    pub bootstrap_network_name: String,
    /// Why the bootstrap did not apply, empty when it did.
    pub bootstrap_error: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MinihRouterResolvedEndpoint {
    pub active_base_url: String,
    pub fallback_base_url: String,
    pub using_lan: bool,
    pub mode: EasyTierEffectiveMode,
    pub effective_mode: EasyTierEffectiveMode,
    pub virtual_ipv4: Option<String>,
    pub local_forward_url: Option<String>,
}

enum ActiveBackend {
    Disabled,
    InProcess {
        instance: Arc<NativeCoreInstance>,
        effective_mode: EasyTierEffectiveMode,
        local_forward_port: u16,
    },
    ElevatedTun {
        spec: TunRunnerSpec,
    },
}

struct ProbeCache {
    checked_at: Instant,
    url: String,
    reachable: bool,
}

/// Reads the AccessKey of the Minih Router row the tunnel is built for.
///
/// Kept as a trait so `easytier_net` never imports the provider layer: the
/// secret store stays owned by `providers`, and a test can answer without a
/// database. Implementations must return the key already folded for HTTP
/// headers, and must never log it.
#[async_trait::async_trait]
pub trait BootstrapCredentialProvider: Send + Sync {
    /// The Router base URL and AccessKey to identify with, or `None` when the
    /// user has no Minih Router row or that row carries no key.
    async fn minih_router_credential(&self) -> Option<(String, String)>;
}

pub struct EasyTierManager {
    data_dir: Option<PathBuf>,
    settings: EasyTierSettings,
    backend: ActiveBackend,
    last_error: Option<String>,
    probe_cache: Option<ProbeCache>,
    /// Server-issued network identities, keyed by AccessKey digest.
    bootstrap_cache: BootstrapCache,
    /// Why the last bootstrap attempt did not apply.
    bootstrap_error: Option<String>,
    /// The answer currently in effect, so the panel can show the source.
    active_bootstrap: Option<BootstrapResponse>,
    /// Shared HTTP client, so the TLS session pool survives across calls.
    http_client: SharedClient,
}

impl Default for EasyTierManager {
    fn default() -> Self {
        Self {
            data_dir: None,
            settings: EasyTierSettings::default(),
            backend: ActiveBackend::Disabled,
            last_error: None,
            probe_cache: None,
            bootstrap_cache: BootstrapCache::default(),
            bootstrap_error: None,
            active_bootstrap: None,
            http_client: std::sync::Arc::new(bootstrap_client()),
        }
    }
}

static MANAGER: OnceLock<Mutex<EasyTierManager>> = OnceLock::new();

pub fn manager() -> &'static Mutex<EasyTierManager> {
    MANAGER.get_or_init(|| Mutex::new(EasyTierManager::default()))
}

fn allocate_loopback_port() -> Result<u16, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|e| format!("failed to allocate local port forward socket: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("failed to inspect local port forward socket: {e}"))?
        .port();
    Ok(port)
}

fn control_root_from_base_url(base_url: &str) -> String {
    let trimmed = base_url.trim().trim_end_matches('/');
    if let Some(root) = trimmed.strip_suffix("/v1") {
        root.to_string()
    } else if let Some(root) = trimmed.strip_suffix("/V1") {
        root.to_string()
    } else {
        trimmed.to_string()
    }
}

async fn probe_http_reachability(base_url: &str, timeout: Duration) -> bool {
    let root = control_root_from_base_url(base_url);
    let health_url = format!("{root}/health");
    let Ok(client) = reqwest::Client::builder()
        .no_proxy()
        .timeout(timeout)
        .connect_timeout(timeout)
        .build()
    else {
        return false;
    };
    match client.get(&health_url).send().await {
        Ok(resp) => resp.status().is_success() || resp.status().is_client_error(),
        Err(_) => false,
    }
}

impl EasyTierManager {
    async fn stop_current(&mut self) {
        self.probe_cache = None;
        let prev = std::mem::replace(&mut self.backend, ActiveBackend::Disabled);
        match prev {
            ActiveBackend::Disabled => {}
            ActiveBackend::InProcess { instance, .. } => {
                instance.stop().await;
            }
            ActiveBackend::ElevatedTun { spec } => {
                let _ = std::fs::remove_file(&spec.control_path);
                let _ = std::fs::remove_file(&spec.status_path);
                let _ = std::fs::remove_file(
                    spec.control_path.with_file_name("easytier-tun-spec.json"),
                );
            }
        }
    }

    async fn start_in_process(
        &mut self,
        no_tun: bool,
        effective_mode: EasyTierEffectiveMode,
    ) -> Result<(), String> {
        let local_port = allocate_loopback_port()?;
        let toml_config = build_toml_config(&self.settings, no_tun, Some(local_port))?;
        let instance = create_native_instance(toml_config)
            .map_err(|e| format!("failed to create EasyTier instance: {e}"))?;
        instance
            .start()
            .await
            .map_err(|e| format!("failed to start EasyTier instance: {e}"))?;
        self.backend = ActiveBackend::InProcess {
            instance,
            effective_mode,
            local_forward_port: local_port,
        };
        self.last_error = None;
        Ok(())
    }

    /// Ask the gateway for the network identity this AccessKey should use.
    ///
    /// A cached answer is reused until its TTL expires. Every failure falls back
    /// to the local configuration instead of propagating, because a gateway that
    /// does not serve the endpoint yet must keep working on the public URL. The
    /// reason is retained only so the panel can explain the source.
    async fn refresh_bootstrap(&mut self, credentials: Option<&dyn BootstrapCredentialProvider>) {
        self.bootstrap_error = None;
        let Some(provider) = credentials else {
            // No credential source: keep whatever answer is already in effect so
            // a restart inside the elevated runner does not drop the network.
            if self.active_bootstrap.is_none() {
                self.bootstrap_error = None;
            }
            return;
        };
        let Some((base_url, access_key)) = provider.minih_router_credential().await else {
            self.active_bootstrap = None;
            self.bootstrap_error = Some(BootstrapError::NoAccessKey.to_string());
            return;
        };

        let digest = access_key_digest(&access_key);
        let now = Instant::now();
        if let Some(cached) = self.bootstrap_cache.get(&digest, now) {
            self.active_bootstrap = Some(cached.clone());
            return;
        }

        match fetch_bootstrap(&self.http_client, &base_url, &access_key).await {
            Ok(response) => {
                self.bootstrap_cache
                    .insert(digest, response.clone(), Instant::now());
                self.active_bootstrap = Some(response);
            }
            Err(error) => {
                // A 404 means the gateway has not shipped the endpoint; that is a
                // supported configuration and is not worth surfacing as an error.
                self.active_bootstrap = None;
                self.bootstrap_error = match error {
                    BootstrapError::EndpointUnavailable => None,
                    other => Some(other.to_string()),
                };
            }
        }
    }

    /// Where the identity in effect came from, for the panel and for logs.
    fn bootstrap_source(&self) -> BootstrapSource {
        if !self.settings.enabled {
            BootstrapSource::Disabled
        } else if self.active_bootstrap.is_some() {
            BootstrapSource::Gateway
        } else {
            BootstrapSource::Local
        }
    }

    /// The local settings with the bootstrap chain resolved.
    fn effective_settings(&self, mut settings: EasyTierSettings) -> EasyTierSettings {
        match &self.active_bootstrap {
            Some(response) => apply_bootstrap(&mut settings, response),
            None => defaults_overlay(&mut settings),
        }
        settings
    }

    pub async fn apply_settings(
        &mut self,
        data_dir: &Path,
        next_settings: EasyTierSettings,
        force_restart: bool,
    ) {
        self.apply_settings_with(data_dir, next_settings, force_restart, None)
            .await;
    }

    /// `apply_settings` with a credential source for the gateway identity.
    ///
    /// Every caller that owns the database passes one; the elevated TUN runner
    /// and tests do not, and fall back to the local configuration.
    pub async fn apply_settings_with(
        &mut self,
        data_dir: &Path,
        next_settings: EasyTierSettings,
        force_restart: bool,
        credentials: Option<&dyn BootstrapCredentialProvider>,
    ) {
        let data_dir_buf = data_dir.to_path_buf();
        let unchanged = !force_restart
            && self.data_dir.as_ref() == Some(&data_dir_buf)
            && self.settings == next_settings
            && !matches!(self.backend, ActiveBackend::Disabled);
        self.data_dir = Some(data_dir_buf);
        if unchanged && next_settings.enabled {
            return;
        }

        let keep_elevated_tun = !force_restart
            && next_settings.enabled
            && matches!(next_settings.mode, EasyTierMode::Auto | EasyTierMode::Tun)
            && matches!(&self.backend, ActiveBackend::ElevatedTun { spec } if spec.settings == next_settings && spec.status_path.exists());
        if keep_elevated_tun {
            self.settings = next_settings;
            return;
        }

        self.stop_current().await;
        self.settings = next_settings;

        if !self.settings.enabled {
            self.last_error = None;
            self.active_bootstrap = None;
            self.bootstrap_error = None;
            return;
        }

        // The gateway identity is fetched once per settings change, not per
        // request: `resolve_minih_router_endpoint` runs on the chat path and
        // must never pay a network round trip there.
        self.refresh_bootstrap(credentials).await;
        self.settings = self.effective_settings(self.settings.clone());

        let elevated = is_current_process_elevated();
        let try_tun_in_process = match self.settings.mode {
            EasyTierMode::Tun | EasyTierMode::Auto => elevated,
            EasyTierMode::NoTun => false,
        };

        if try_tun_in_process {
            match self
                .start_in_process(false, EasyTierEffectiveMode::Tun)
                .await
            {
                Ok(()) => return,
                Err(error) => {
                    tracing::warn!(%error, "EasyTier TUN mode failed; falling back to no-tun mode");
                    self.last_error = Some(error);
                }
            }
        }

        if let Err(error) = self
            .start_in_process(true, EasyTierEffectiveMode::NoTun)
            .await
        {
            tracing::warn!(%error, "EasyTier no-tun start failed");
            self.last_error = Some(error);
        } else if self.settings.mode == EasyTierMode::Tun && !elevated {
            self.last_error = Some(
                "TUN mode requires administrator privileges; running in No-TUN mode until elevated"
                    .to_string(),
            );
        }
    }

    pub async fn request_tun_elevation(&mut self) -> Result<EasyTierStatus, String> {
        let Some(data_dir) = self.data_dir.clone() else {
            return Err("EasyTier data directory is not initialized".into());
        };
        if !self.settings.enabled {
            self.settings.enabled = true;
        }

        if is_current_process_elevated() {
            self.stop_current().await;
            self.settings.mode = EasyTierMode::Tun;
            self.start_in_process(false, EasyTierEffectiveMode::Tun)
                .await?;
            return Ok(self.status(None).await);
        }

        let runtime_dir = data_dir.join("cache").join("easytier");
        std::fs::create_dir_all(&runtime_dir)
            .map_err(|e| format!("failed to create easytier runtime dir: {e}"))?;
        let local_port = allocate_loopback_port()?;
        let status_path = runtime_dir.join("easytier-tun-status.json");
        let control_path = runtime_dir.join("easytier-tun-active.lock");
        let spec_path = runtime_dir.join("easytier-tun-spec.json");

        std::fs::write(&control_path, b"active")
            .map_err(|e| format!("failed to write easytier control file: {e}"))?;

        let mut tun_settings = self.settings.clone();
        tun_settings.mode = EasyTierMode::Tun;
        let spec = TunRunnerSpec {
            settings: tun_settings.clone(),
            local_forward_port: local_port,
            status_path: status_path.clone(),
            control_path: control_path.clone(),
            parent_pid: std::process::id(),
        };
        let spec_json = serde_json::to_vec_pretty(&spec)
            .map_err(|e| format!("failed to serialize TunRunnerSpec: {e}"))?;
        std::fs::write(&spec_path, spec_json)
            .map_err(|e| format!("failed to write TunRunnerSpec: {e}"))?;

        match spawn_elevated_tun_runner(&spec_path, &status_path).await {
            Ok(_snapshot) => {
                self.stop_current().await;
                let _ = std::fs::write(&control_path, b"active");
                self.settings = tun_settings;
                self.backend = ActiveBackend::ElevatedTun { spec };
                self.last_error = None;
                Ok(self.status(None).await)
            }
            Err(error) => {
                let _ = std::fs::remove_file(&control_path);
                let _ = std::fs::remove_file(&status_path);
                self.last_error = Some(format!(
                    "TUN privilege elevation declined or failed ({error}); continuing in No-TUN mode"
                ));
                if matches!(self.backend, ActiveBackend::Disabled) {
                    let _ = self
                        .start_in_process(true, EasyTierEffectiveMode::NoTun)
                        .await;
                }
                Ok(self.status(None).await)
            }
        }
    }

    async fn check_lan_reachable(&mut self, candidate_base_url: &str, has_peers: bool) -> bool {
        if !has_peers {
            return false;
        }
        if let Some(cache) = &self.probe_cache {
            let ttl = if cache.reachable {
                Duration::from_secs(6)
            } else {
                Duration::from_millis(1500)
            };
            if cache.url == candidate_base_url && cache.checked_at.elapsed() < ttl {
                return cache.reachable;
            }
        }
        let reachable =
            probe_http_reachability(candidate_base_url, Duration::from_millis(1200)).await;
        self.probe_cache = Some(ProbeCache {
            checked_at: Instant::now(),
            url: candidate_base_url.to_string(),
            reachable,
        });
        reachable
    }

    pub async fn status(&mut self, fallback_public_url: Option<&str>) -> EasyTierStatus {
        let fallback_url = fallback_public_url
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(DEFAULT_ROUTER_PUBLIC_URL)
            .to_string();
        let target = parse_router_lan_target(&self.settings.router_lan_url).ok();
        let router_lan_url = target
            .as_ref()
            .map(|t| t.normalized_base_url.clone())
            .unwrap_or_else(|| self.settings.router_lan_url.clone());

        if !self.settings.enabled {
            return EasyTierStatus {
                enabled: false,
                configured_mode: self.settings.mode,
                effective_mode: EasyTierEffectiveMode::Disabled,
                state: EasyTierConnectionState::Disabled,
                tun_privileged: is_current_process_elevated(),
                virtual_ipv4: None,
                hostname: None,
                network_name: self.settings.network_name.clone(),
                peers: self.settings.peers.clone(),
                bootstrap_peers: self.settings.peers.clone(),
                peer_count: 0,
                connected_peers: Vec::new(),
                router_lan_url,
                local_forward_port: None,
                local_forward_url: None,
                using_lan: false,
                active_router_base_url: fallback_url.clone(),
                fallback_router_base_url: fallback_url,
                router_lan_reachable: false,
                last_error: self.last_error.clone(),
                updated_at_ms: now_ms(),
                dhcp: self.settings.dhcp,
                static_ipv4: self.settings.ipv4.clone().unwrap_or_default(),
                bootstrap_source: self.bootstrap_source(),
                bootstrap_network_name: self
                    .active_bootstrap
                    .as_ref()
                    .map(|b| b.network_name.clone())
                    .unwrap_or_default(),
                bootstrap_error: self.bootstrap_error.clone().unwrap_or_default(),
            };
        }

        match &self.backend {
            ActiveBackend::Disabled => EasyTierStatus {
                enabled: true,
                configured_mode: self.settings.mode,
                effective_mode: EasyTierEffectiveMode::Disabled,
                state: EasyTierConnectionState::Error,
                tun_privileged: is_current_process_elevated(),
                virtual_ipv4: None,
                hostname: None,
                network_name: self.settings.network_name.clone(),
                peers: self.settings.peers.clone(),
                bootstrap_peers: self.settings.peers.clone(),
                peer_count: 0,
                connected_peers: Vec::new(),
                router_lan_url,
                local_forward_port: None,
                local_forward_url: None,
                using_lan: false,
                active_router_base_url: fallback_url.clone(),
                fallback_router_base_url: fallback_url,
                router_lan_reachable: false,
                last_error: self.last_error.clone(),
                updated_at_ms: now_ms(),
                dhcp: self.settings.dhcp,
                static_ipv4: self.settings.ipv4.clone().unwrap_or_default(),
                bootstrap_source: self.bootstrap_source(),
                bootstrap_network_name: self
                    .active_bootstrap
                    .as_ref()
                    .map(|b| b.network_name.clone())
                    .unwrap_or_default(),
                bootstrap_error: self.bootstrap_error.clone().unwrap_or_default(),
            },
            ActiveBackend::InProcess {
                instance,
                effective_mode,
                local_forward_port,
            } => {
                let effective_mode = *effective_mode;
                let local_port = *local_forward_port;
                let instance = instance.clone();
                let (virtual_ipv4, hostname, connected_peers, inst_err) =
                    collect_instance_snapshot(&instance).await;
                let local_forward_url = target.as_ref().map(|t| t.forward_base_url(local_port));
                let candidate_url = local_forward_url
                    .clone()
                    .unwrap_or_else(|| router_lan_url.clone());
                let has_peers = !connected_peers.is_empty() || virtual_ipv4.is_some();
                let reachable = self.check_lan_reachable(&candidate_url, has_peers).await;
                let state = if reachable {
                    EasyTierConnectionState::Connected
                } else if has_peers {
                    EasyTierConnectionState::Degraded
                } else if inst_err.is_some() && !instance.is_ready() {
                    EasyTierConnectionState::Error
                } else {
                    EasyTierConnectionState::Connecting
                };
                let active_router_base_url = if reachable {
                    if effective_mode == EasyTierEffectiveMode::Tun {
                        local_forward_url
                            .clone()
                            .unwrap_or_else(|| router_lan_url.clone())
                    } else {
                        candidate_url
                    }
                } else {
                    fallback_url.clone()
                };
                EasyTierStatus {
                    enabled: true,
                    configured_mode: self.settings.mode,
                    effective_mode,
                    state,
                    tun_privileged: is_current_process_elevated()
                        || effective_mode == EasyTierEffectiveMode::Tun,
                    virtual_ipv4,
                    hostname,
                    network_name: self.settings.network_name.clone(),
                    peers: self.settings.peers.clone(),
                    bootstrap_peers: self.settings.peers.clone(),
                    peer_count: connected_peers.len(),
                    connected_peers,
                    router_lan_url,
                    local_forward_port: Some(local_port),
                    local_forward_url,
                    using_lan: reachable,
                    active_router_base_url,
                    fallback_router_base_url: fallback_url,
                    router_lan_reachable: reachable,
                    last_error: inst_err.or_else(|| self.last_error.clone()),
                    updated_at_ms: now_ms(),
                    dhcp: self.settings.dhcp,
                    static_ipv4: self.settings.ipv4.clone().unwrap_or_default(),
                    bootstrap_source: self.bootstrap_source(),
                    bootstrap_network_name: self
                        .active_bootstrap
                        .as_ref()
                        .map(|b| b.network_name.clone())
                        .unwrap_or_default(),
                    bootstrap_error: self.bootstrap_error.clone().unwrap_or_default(),
                }
            }
            ActiveBackend::ElevatedTun { spec } => {
                let snapshot = std::fs::read_to_string(&spec.status_path)
                    .ok()
                    .and_then(|raw| serde_json::from_str::<TunRunnerStatusSnapshot>(&raw).ok());
                if let Some(snap) = snapshot {
                    let local_forward_url = target
                        .as_ref()
                        .map(|t| t.forward_base_url(snap.local_forward_port));
                    let candidate_url = local_forward_url
                        .clone()
                        .unwrap_or_else(|| router_lan_url.clone());
                    let has_peers = !snap.peers.is_empty() || snap.virtual_ipv4.is_some();
                    let reachable = self.check_lan_reachable(&candidate_url, has_peers).await;
                    let state = if reachable {
                        EasyTierConnectionState::Connected
                    } else if has_peers {
                        EasyTierConnectionState::Degraded
                    } else {
                        snap.state
                    };
                    let active_router_base_url = if reachable {
                        candidate_url
                    } else {
                        fallback_url.clone()
                    };
                    EasyTierStatus {
                        enabled: true,
                        configured_mode: self.settings.mode,
                        effective_mode: EasyTierEffectiveMode::Tun,
                        state,
                        tun_privileged: true,
                        virtual_ipv4: snap.virtual_ipv4,
                        hostname: snap.hostname,
                        network_name: self.settings.network_name.clone(),
                        peers: self.settings.peers.clone(),
                        bootstrap_peers: self.settings.peers.clone(),
                        peer_count: snap.peers.len(),
                        connected_peers: snap.peers,
                        router_lan_url,
                        local_forward_port: Some(snap.local_forward_port),
                        local_forward_url,
                        using_lan: reachable,
                        active_router_base_url,
                        fallback_router_base_url: fallback_url,
                        router_lan_reachable: reachable,
                        last_error: snap.last_error.or_else(|| self.last_error.clone()),
                        updated_at_ms: snap.updated_at_ms,
                        dhcp: self.settings.dhcp,
                        static_ipv4: self.settings.ipv4.clone().unwrap_or_default(),
                        bootstrap_source: self.bootstrap_source(),
                        bootstrap_network_name: self
                            .active_bootstrap
                            .as_ref()
                            .map(|b| b.network_name.clone())
                            .unwrap_or_default(),
                        bootstrap_error: self.bootstrap_error.clone().unwrap_or_default(),
                    }
                } else {
                    // Elevated runner exited unexpectedly; fall back seamlessly to No-TUN mode.
                    let data_dir = self.data_dir.clone();
                    let settings = self.settings.clone();
                    self.last_error =
                        Some("Elevated TUN runner stopped; switched back to No-TUN mode".into());
                    if let Some(dir) = data_dir {
                        self.apply_settings(&dir, settings, true).await;
                    }
                    Box::pin(self.status(Some(&fallback_url))).await
                }
            }
        }
    }

    pub async fn resolve_minih_router_endpoint(
        &mut self,
        configured_base_url: Option<&str>,
    ) -> MinihRouterResolvedEndpoint {
        let fallback_base_url = configured_base_url
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(DEFAULT_ROUTER_PUBLIC_URL)
            .to_string();
        let status = self.status(Some(&fallback_base_url)).await;
        let using_lan = status.enabled && status.router_lan_reachable;
        MinihRouterResolvedEndpoint {
            active_base_url: if using_lan {
                status.active_router_base_url
            } else {
                fallback_base_url.clone()
            },
            fallback_base_url,
            using_lan,
            mode: status.effective_mode,
            effective_mode: status.effective_mode,
            virtual_ipv4: status.virtual_ipv4,
            local_forward_url: status.local_forward_url,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn in_process_no_tun_allocates_forward_port_and_falls_back_until_reachable() {
        let dir = tempfile::tempdir().unwrap();
        let mut mgr = EasyTierManager::default();
        let settings = EasyTierSettings {
            enabled: true,
            mode: EasyTierMode::NoTun,
            network_name: "minih-net-test".to_string(),
            network_secret: "Minih@9527".to_string(),
            peers: vec!["tcp://127.0.0.1:65530".to_string()],
            router_lan_url: "http://10.144.144.10:3001/v1".to_string(),
            dhcp: true,
            ipv4: None,
        };
        mgr.apply_settings(dir.path(), settings, true).await;

        let status = mgr.status(Some("https://router.hmini.org/v1")).await;
        assert!(status.enabled);
        assert_eq!(status.effective_mode, EasyTierEffectiveMode::NoTun);
        assert!(status.local_forward_port.unwrap_or(0) > 0);
        assert!(status
            .local_forward_url
            .as_deref()
            .unwrap_or("")
            .starts_with("http://127.0.0.1:"));
        assert!(!status.using_lan);
        assert_eq!(status.active_router_base_url, "https://router.hmini.org/v1");

        let resolved = mgr
            .resolve_minih_router_endpoint(Some("https://router.hmini.org/v1"))
            .await;
        assert!(!resolved.using_lan);
        assert_eq!(resolved.active_base_url, "https://router.hmini.org/v1");
        assert_eq!(resolved.fallback_base_url, "https://router.hmini.org/v1");

        let mut disabled = mgr.settings.clone();
        disabled.enabled = false;
        mgr.apply_settings(dir.path(), disabled, false).await;
        let disabled_status = mgr.status(None).await;
        assert!(!disabled_status.enabled);
        assert_eq!(disabled_status.state, EasyTierConnectionState::Disabled);
    }
}
