use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::Instant;

use easytier::instance::factory::{create_native_instance, NativeCoreInstance};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use super::bootstrap::{
    bootstrap_cache_key, bootstrap_client, bootstrap_request_root, fetch_bootstrap, BootstrapCache,
    BootstrapError, BootstrapResponse, BootstrapSource, SharedClient,
};
use super::config::{
    build_toml_config, parse_router_lan_target, EasyTierConnectionState, EasyTierEffectiveMode,
    EasyTierIdentity, EasyTierMode, EasyTierSettings, OverlayForward, DEFAULT_ROUTER_PUBLIC_URL,
};
use super::endpoint::{PublishedEndpoint, TunnelEndpoint};
use super::health::{NetworkWatcher, ProbeTask, TunnelHealthMonitor, TunnelHealthSnapshot};
use super::identity::{decide, Decision};
use super::loopback::{
    allocate_loopback_port, allocate_loopback_port_excluding, loopback_port_is_free,
};
use super::remote_gateway::{
    derive_hostlink_target, status_for, RemoteGatewayReach, RemoteGatewayStatus,
};
use super::tun_runner::{
    collect_instance_snapshot, is_current_process_elevated, now_ms, spawn_elevated_tun_runner,
    TunRunnerSpec, TunRunnerStatusSnapshot,
};

/// Why account mode is off when the host never had a credential source.
///
/// A start without one cannot ask the Router anything, and an empty reason left
/// the panel showing "unavailable" with nothing behind it.
const NO_CREDENTIAL_SOURCE: &str = "no Router credential source is available to this start";

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
    /// Account-mode endpoint for remote control (ADR D666), or why it is
    /// unavailable. Additive: a Router that advertises nothing leaves this
    /// unavailable and every other field untouched.
    pub remote_gateway: RemoteGatewayStatus,
    /// Which identity mode the saved settings ask for.
    pub identity: EasyTierIdentity,
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
        /// Loopback port of the Host-link forward, None when it is not needed
        /// (TUN mode) or could not be installed.
        hostlink_forward_port: Option<u16>,
    },
    ElevatedTun {
        spec: TunRunnerSpec,
    },
}
/// Ports a restart must keep so a running remote link is not re-registered
/// under a new loopback address.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct ReusedPorts {
    pub router_forward_port: Option<u16>,
    pub hostlink_forward_port: Option<u16>,
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
    /// Which loopback forward the running node published, and whether the
    /// background prober currently trusts it.
    endpoint: TunnelEndpoint,
    /// The `/health` prober for the running node; `None` when nothing runs.
    prober: Option<ProbeTask>,
    /// Watches the local route for as long as the channel is enabled. Separate
    /// from `prober` on purpose: a restart it triggers must not abort the task
    /// that is waiting for that restart.
    watcher: Option<NetworkWatcher>,
    /// Server-issued network identities, keyed by control-plane root + AccessKey
    /// digest.
    bootstrap_cache: BootstrapCache,
    /// Why the last bootstrap attempt did not apply, or why the identity is
    /// absent. The panel shows it verbatim.
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
            endpoint: TunnelEndpoint::new(TunnelHealthMonitor::new()),
            prober: None,
            watcher: None,
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

impl EasyTierManager {
    async fn stop_current(&mut self) {
        // Ownership of both background tasks ends here: nothing is left probing
        // a forward that no longer exists.
        self.prober = None;
        self.endpoint.clear();
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

    /// Start an in-process node.
    ///
    /// `reuse` carries the loopback ports of the node this start replaces (a
    /// link change restart): keeping them means the remote Host link is not
    /// re-registered under a new local address.
    async fn start_in_process(
        &mut self,
        settings: &EasyTierSettings,
        no_tun: bool,
        effective_mode: EasyTierEffectiveMode,
        reuse: ReusedPorts,
    ) -> Result<(), String> {
        // The forward target is parsed before anything starts, so a bad
        // `routerLanUrl` fails the start instead of the published address.
        let target = parse_router_lan_target(&settings.router_lan_url)?;
        let local_port = reuse
            .router_forward_port
            .filter(|port| loopback_port_is_free(*port))
            .unwrap_or(allocate_loopback_port()?);
        // Only No-TUN mode needs the extra forward: TUN mode routes the overlay
        // address itself, so it reaches the Gateway without help.
        let hostlink_forward =
            self.hostlink_forward_for_start(no_tun, local_port, reuse.hostlink_forward_port);
        let toml_config = build_toml_config(settings, no_tun, Some(local_port), hostlink_forward)?;
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
            hostlink_forward_port: hostlink_forward.map(|forward| forward.local_port),
        };
        self.last_error = None;
        self.publish_running_forward(
            target.forward_base_url(local_port),
            effective_mode,
            settings,
        );
        Ok(())
    }

    /// Record the forward this node installed and start watching it.
    ///
    /// Nothing is published until the node is up: an address that no node
    /// forwards to is exactly the "accepted, never answered" shape this whole
    /// module exists to keep off the request path.
    fn publish_running_forward(
        &mut self,
        local_forward_url: String,
        effective_mode: EasyTierEffectiveMode,
        settings: &EasyTierSettings,
    ) {
        let virtual_ipv4 = if settings.dhcp {
            None
        } else {
            settings.ipv4.clone()
        };
        self.endpoint.publish(PublishedEndpoint {
            local_forward_url,
            effective_mode,
            virtual_ipv4,
        });
        // A fresh start begins in `unavailable`; the prober promotes it once
        // the forward has answered for a stable window.
        self.prober = Some(ProbeTask::spawn(self.endpoint.health().clone()));
        self.ensure_network_watcher();
    }

    /// Start the link-change watcher once per enabled channel.
    fn ensure_network_watcher(&mut self) {
        if self.watcher.is_some() {
            return;
        }
        let handle = tokio::runtime::Handle::try_current();
        if handle.is_err() {
            return;
        }
        self.watcher = Some(NetworkWatcher::spawn(std::sync::Arc::new(|| {
            Box::pin(async {
                restart_after_network_change().await;
            })
        })));
    }

    /// The Host-link forward to install for a start in `no_tun` mode.
    ///
    /// TUN mode never installs one: it routes the overlay address itself.
    fn hostlink_forward_for_start(
        &self,
        no_tun: bool,
        router_forward_port: u16,
        reuse_port: Option<u16>,
    ) -> Option<OverlayForward> {
        if !no_tun {
            return None;
        }
        let mut forward = self.hostlink_forward(router_forward_port)?;
        // Keep the port the replaced node held, so a restart does not hand the
        // remote side a new local address to dial.
        if let Some(port) =
            reuse_port.filter(|port| *port != router_forward_port && loopback_port_is_free(*port))
        {
            forward.local_port = port;
        }
        Some(forward)
    }

    /// The settings a start would use right now.
    ///
    /// The saved ones, with the gateway answer applied when gateway mode has one.
    /// Pure: the saved settings are never rewritten by an answer, so a later start
    /// re-decides from the user's own values instead of layering answer on answer.
    fn resolved_settings(&self) -> EasyTierSettings {
        match decide(&self.settings, self.active_bootstrap.as_ref(), None) {
            Decision::Start(effective) => effective,
            Decision::Hold(_) => self.settings.clone(),
        }
    }

    /// Ask the gateway for the network identity this AccessKey should use.
    ///
    /// Nothing is started when this fails: the reason is kept so the caller can
    /// hold with an explanation, and the public endpoint keeps serving requests
    /// meanwhile. A cached answer is reused until its TTL expires.
    async fn refresh_bootstrap(&mut self, credentials: Option<&dyn BootstrapCredentialProvider>) {
        self.bootstrap_error = None;
        let Some(provider) = credentials else {
            // No credential source: an answer already in effect stays, so a start
            // handed resolved settings (the elevated runner, tests) does not drop
            // the network. With nothing in hand the start holds, and the reason
            // says why instead of leaving an empty state in the panel.
            if self.active_bootstrap.is_none() {
                self.bootstrap_error = Some(NO_CREDENTIAL_SOURCE.to_string());
            }
            return;
        };
        let Some((base_url, access_key)) = provider.minih_router_credential().await else {
            self.active_bootstrap = None;
            self.bootstrap_error = Some(BootstrapError::NoAccessKey.to_string());
            return;
        };
        // The request goes to the Router row's own address, which must be
        // reachable without the tunnel: an identity only the tunnel could fetch
        // would be a deadlock.
        let Some(root) = bootstrap_request_root(&base_url) else {
            self.active_bootstrap = None;
            self.bootstrap_error = Some(BootstrapError::NoAccessKey.to_string());
            return;
        };
        let cache_key = bootstrap_cache_key(&root, &access_key);
        let now = Instant::now();
        if let Some(cached) = self.bootstrap_cache.get(&cache_key, now) {
            self.active_bootstrap = Some(cached.clone());
            return;
        }

        match fetch_bootstrap(&self.http_client, &base_url, &access_key).await {
            Ok(response) => {
                self.bootstrap_cache
                    .insert(cache_key, response.clone(), Instant::now());
                self.active_bootstrap = Some(response);
            }
            Err(error) => {
                // A 404 means the gateway has not shipped the endpoint, which a
                // self-hosted gateway may never do; developer mode covers that
                // with a manual identity. A normal install holds with the reason
                // instead of joining a network the gateway never issued.
                self.active_bootstrap = None;
                self.bootstrap_error = Some(error.to_string());
            }
        }
    }

    /// Where the identity in effect came from, for the panel and for logs.
    ///
    /// `Local` now means a manual identity, i.e. values the user typed. A
    /// gateway-mode start that is holding has no identity in effect at all, and
    /// reports `Gateway` with `bootstrapError` explaining the gap.
    fn bootstrap_source(&self) -> BootstrapSource {
        if !self.settings.enabled {
            BootstrapSource::Disabled
        } else if self.active_bootstrap.is_some() {
            BootstrapSource::Gateway
        } else if self.settings.identity == EasyTierIdentity::Manual {
            BootstrapSource::Local
        } else {
            BootstrapSource::Gateway
        }
    }

    /// The loopback forward the Host link needs in No-TUN mode.
    ///
    /// `None` whenever account mode is off, the answer was unusable, or the
    /// target cannot be derived; `remote_gateway_status` derives the same way,
    /// so the panel gets the precise reason instead of a silent no-op.
    fn hostlink_forward(&self, router_forward_port: u16) -> Option<OverlayForward> {
        let response = self.active_bootstrap.as_ref()?;
        let announcement = response.remote_gateway.announcement()?;
        let target =
            match derive_hostlink_target(announcement, response.gateway_virtual_ipv4.as_deref()) {
                Ok(target) => target,
                Err(reason) => {
                    tracing::warn!(
                        %reason,
                        "account-mode Host link is not reachable; continuing without it"
                    );
                    return None;
                }
            };
        match allocate_loopback_port_excluding(&[router_forward_port]) {
            Ok(local_port) => Some(OverlayForward {
                local_port,
                dst: target.dst,
            }),
            Err(error) => {
                tracing::warn!(%error, "failed to allocate the Host-link forward port");
                None
            }
        }
    }

    /// Account mode as the panel and the Host-link client see it.
    ///
    /// Recomputed per status call: it depends on the answer in effect and on
    /// which backend is running, and both change without a new fetch. The
    /// mapping itself lives with the account-mode domain.
    fn remote_gateway_status(&self) -> RemoteGatewayStatus {
        let response = self.active_bootstrap.as_ref();
        let reach = match &self.backend {
            ActiveBackend::InProcess {
                effective_mode: EasyTierEffectiveMode::Tun,
                ..
            }
            | ActiveBackend::ElevatedTun { .. } => RemoteGatewayReach::Direct,
            ActiveBackend::InProcess {
                hostlink_forward_port,
                ..
            } => RemoteGatewayReach::Forwarded {
                local_port: *hostlink_forward_port,
            },
            ActiveBackend::Disabled => RemoteGatewayReach::Unavailable,
        };
        status_for(
            self.settings.enabled,
            response.map(|answer| &answer.remote_gateway),
            response.and_then(|answer| answer.gateway_virtual_ipv4.as_deref()),
            reach,
            self.bootstrap_error.as_deref().unwrap_or_default(),
        )
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
    /// Every caller that owns the database passes one; a manual identity does not
    /// need it, and neither does the elevated TUN runner, which receives the
    /// identity already resolved inside its spec.
    pub async fn apply_settings_with(
        &mut self,
        data_dir: &Path,
        next_settings: EasyTierSettings,
        force_restart: bool,
        credentials: Option<&dyn BootstrapCredentialProvider>,
    ) {
        self.start_from_settings(data_dir, next_settings, force_restart, credentials)
            .await;
    }

    /// Re-read the gateway identity, bypassing the cached answer.
    ///
    /// The Router row's endpoint or key changed, so the answer in hand belongs to
    /// a gateway this account may no longer be bound to. One fetch, one restart:
    /// a retry loop would only walk into the gateway's per-IP lockout.
    pub async fn refresh_identity_with(
        &mut self,
        data_dir: &Path,
        next_settings: EasyTierSettings,
        credentials: Option<&dyn BootstrapCredentialProvider>,
    ) {
        self.bootstrap_cache.clear();
        self.apply_settings_with(data_dir, next_settings, true, credentials)
            .await;
    }

    async fn start_from_settings(
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
            // Nothing left to rebuild: the channel is off, so the watcher's
            // ownership ends here too.
            self.watcher = None;
            return;
        }

        // The gateway identity is fetched once per settings change, not per
        // request: `resolve_minih_router_endpoint` runs on the chat path and
        // must never pay a network round trip there. It has to be in hand before
        // the tunnel comes up, because it decides whether the tunnel comes up.
        if self.settings.identity == EasyTierIdentity::Gateway {
            self.refresh_bootstrap(credentials).await;
        } else {
            // A manual identity is what the user typed; asking the gateway would
            // only offer an answer this mode deliberately ignores.
            self.active_bootstrap = None;
            self.bootstrap_error = None;
        }

        let effective = match decide(
            &self.settings,
            self.active_bootstrap.as_ref(),
            self.bootstrap_error.as_deref(),
        ) {
            Decision::Start(effective) => effective,
            // Hold: no identity, so no tunnel. The backend stays Disabled and the
            // reason travels to the panel through `bootstrap_error`, where the
            // user can act on it instead of seeing an unexplained failure.
            Decision::Hold(reason) => {
                self.last_error = None;
                self.bootstrap_error = Some(reason);
                return;
            }
        };

        let elevated = is_current_process_elevated();
        let try_tun_in_process = match effective.mode {
            EasyTierMode::Tun | EasyTierMode::Auto => elevated,
            EasyTierMode::NoTun => false,
        };

        if try_tun_in_process {
            match self
                .start_in_process(
                    &effective,
                    false,
                    EasyTierEffectiveMode::Tun,
                    ReusedPorts::default(),
                )
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
            .start_in_process(
                &effective,
                true,
                EasyTierEffectiveMode::NoTun,
                ReusedPorts::default(),
            )
            .await
        {
            tracing::warn!(%error, "EasyTier no-tun start failed");
            self.last_error = Some(error);
            return;
        }

        // A user who configured TUN without the privileges it needs is running
        // No-TUN, and has to be told.
        if effective.mode == EasyTierMode::Tun && !elevated {
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

        // Only an already-issued identity may run with privileges: the elevated
        // runner receives the resolved settings in its spec and never fetches.
        let resolved = match decide(
            &self.settings,
            self.active_bootstrap.as_ref(),
            self.bootstrap_error.as_deref(),
        ) {
            Decision::Start(resolved) => resolved,
            Decision::Hold(reason) => {
                self.bootstrap_error = Some(reason);
                return Ok(self.status(None).await);
            }
        };

        if is_current_process_elevated() {
            self.stop_current().await;
            self.settings.mode = EasyTierMode::Tun;
            self.start_in_process(
                &resolved,
                false,
                EasyTierEffectiveMode::Tun,
                ReusedPorts::default(),
            )
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

        let mut tun_settings = self.resolved_settings();
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
                self.backend = ActiveBackend::ElevatedTun { spec };
                self.last_error = None;
                // The runner is another process, but its forward is a loopback
                // port this process can still probe and publish.
                if let Ok(target) = parse_router_lan_target(&tun_settings.router_lan_url) {
                    self.publish_running_forward(
                        target.forward_base_url(local_port),
                        EasyTierEffectiveMode::Tun,
                        &tun_settings,
                    );
                }
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
                        .start_in_process(
                            &resolved,
                            true,
                            EasyTierEffectiveMode::NoTun,
                            ReusedPorts::default(),
                        )
                        .await;
                }
                Ok(self.status(None).await)
            }
        }
    }

    pub async fn status(&mut self, fallback_public_url: Option<&str>) -> EasyTierStatus {
        let fallback_url = fallback_public_url
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(DEFAULT_ROUTER_PUBLIC_URL)
            .to_string();
        // Report the identity a start would use, not the raw saved row: that is
        // what the panel shows and what the running tunnel was built from.
        let resolved = self.resolved_settings();
        let target = parse_router_lan_target(&resolved.router_lan_url).ok();
        let router_lan_url = target
            .as_ref()
            .map(|t| t.normalized_base_url.clone())
            .unwrap_or_else(|| resolved.router_lan_url.clone());
        let remote_gateway = self.remote_gateway_status();
        let enabled = self.settings.enabled;
        // The shared skeleton: a channel that is on but has no backend has been
        // held for want of an identity, which is an error the panel can explain.
        let mut status = EasyTierStatus {
            enabled,
            configured_mode: self.settings.mode,
            effective_mode: EasyTierEffectiveMode::Disabled,
            state: if enabled {
                EasyTierConnectionState::Error
            } else {
                EasyTierConnectionState::Disabled
            },
            tun_privileged: is_current_process_elevated(),
            virtual_ipv4: None,
            hostname: None,
            network_name: resolved.network_name.clone(),
            peers: resolved.peers.clone(),
            bootstrap_peers: resolved.peers.clone(),
            peer_count: 0,
            connected_peers: Vec::new(),
            router_lan_url,
            local_forward_port: None,
            local_forward_url: None,
            // No tunnel means no LAN route: requests go to the public endpoint.
            using_lan: false,
            active_router_base_url: fallback_url.clone(),
            fallback_router_base_url: fallback_url.clone(),
            router_lan_reachable: false,
            last_error: self.last_error.clone(),
            updated_at_ms: now_ms(),
            dhcp: resolved.dhcp,
            static_ipv4: resolved.ipv4.clone().unwrap_or_default(),
            bootstrap_source: self.bootstrap_source(),
            bootstrap_network_name: self
                .active_bootstrap
                .as_ref()
                .map(|b| b.network_name.clone())
                .unwrap_or_default(),
            bootstrap_error: self.bootstrap_error.clone().unwrap_or_default(),
            remote_gateway: remote_gateway.clone(),
            identity: self.settings.identity,
        };
        if !enabled {
            return status;
        }

        match &self.backend {
            // Held, or a start that never got a node up. Everything above already
            // describes that state; nothing is reachable and nothing is using the
            // LAN, so the caller keeps dialling the public endpoint.
            ActiveBackend::Disabled => status,
            ActiveBackend::InProcess {
                instance,
                effective_mode,
                local_forward_port,
                ..
            } => {
                let effective_mode = *effective_mode;
                let local_port = *local_forward_port;
                let instance = instance.clone();
                let (virtual_ipv4, hostname, connected_peers, inst_err) =
                    collect_instance_snapshot(&instance).await;
                let local_forward_url = target.as_ref().map(|t| t.forward_base_url(local_port));
                let candidate_url = local_forward_url
                    .clone()
                    .unwrap_or_else(|| status.router_lan_url.clone());
                let has_peers = !connected_peers.is_empty() || virtual_ipv4.is_some();
                // The prober owns the network round trip; status only reports.
                let reachable = self.endpoint.using_lan();
                let active_router_base_url = if !reachable {
                    fallback_url.clone()
                } else if effective_mode == EasyTierEffectiveMode::Tun {
                    local_forward_url
                        .clone()
                        .unwrap_or_else(|| status.router_lan_url.clone())
                } else {
                    candidate_url
                };
                status.effective_mode = effective_mode;
                status.state = if reachable {
                    EasyTierConnectionState::Connected
                } else if has_peers {
                    EasyTierConnectionState::Degraded
                } else if inst_err.is_some() && !instance.is_ready() {
                    EasyTierConnectionState::Error
                } else {
                    EasyTierConnectionState::Connecting
                };
                status.tun_privileged =
                    status.tun_privileged || effective_mode == EasyTierEffectiveMode::Tun;
                status.virtual_ipv4 = virtual_ipv4;
                status.hostname = hostname;
                status.peer_count = connected_peers.len();
                status.connected_peers = connected_peers;
                status.local_forward_port = Some(local_port);
                status.local_forward_url = local_forward_url;
                status.using_lan = reachable;
                status.active_router_base_url = active_router_base_url;
                status.router_lan_reachable = reachable;
                status.last_error = inst_err.or_else(|| self.last_error.clone());
                status
            }
            ActiveBackend::ElevatedTun { spec } => {
                let snapshot = std::fs::read_to_string(&spec.status_path)
                    .ok()
                    .and_then(|raw| serde_json::from_str::<TunRunnerStatusSnapshot>(&raw).ok());
                let Some(snap) = snapshot else {
                    // Elevated runner exited unexpectedly; fall back seamlessly to No-TUN mode.
                    let data_dir = self.data_dir.clone();
                    let settings = self.settings.clone();
                    self.last_error =
                        Some("Elevated TUN runner stopped; switched back to No-TUN mode".into());
                    if let Some(dir) = data_dir {
                        self.apply_settings(&dir, settings, true).await;
                    }
                    return Box::pin(self.status(Some(&fallback_url))).await;
                };
                let local_forward_url = target
                    .as_ref()
                    .map(|t| t.forward_base_url(snap.local_forward_port));
                let candidate_url = local_forward_url
                    .clone()
                    .unwrap_or_else(|| status.router_lan_url.clone());
                let has_peers = !snap.peers.is_empty() || snap.virtual_ipv4.is_some();
                // The prober owns the network round trip; status only reports.
                let reachable = self.endpoint.using_lan();
                status.effective_mode = EasyTierEffectiveMode::Tun;
                status.state = if reachable {
                    EasyTierConnectionState::Connected
                } else if has_peers {
                    EasyTierConnectionState::Degraded
                } else {
                    snap.state
                };
                status.tun_privileged = true;
                status.virtual_ipv4 = snap.virtual_ipv4;
                status.hostname = snap.hostname;
                status.peer_count = snap.peers.len();
                status.connected_peers = snap.peers;
                status.local_forward_port = Some(snap.local_forward_port);
                status.local_forward_url = local_forward_url;
                status.using_lan = reachable;
                status.active_router_base_url = if reachable {
                    candidate_url
                } else {
                    fallback_url
                };
                status.router_lan_reachable = reachable;
                status.last_error = snap.last_error.or_else(|| self.last_error.clone());
                status.updated_at_ms = snap.updated_at_ms;
                status
            }
        }
    }

    /// The endpoint a Minih Router request should use.
    ///
    /// Read-only by construction: this runs on the chat path, so it never
    /// probes. Only a tunnel the background prober has certified as healthy
    /// hands back its LAN address (C1).
    pub fn resolve_minih_router_endpoint(
        &self,
        configured_base_url: Option<&str>,
    ) -> MinihRouterResolvedEndpoint {
        self.endpoint.resolve(configured_base_url)
    }

    /// A provider request failed on the tunnel address (C2).
    ///
    /// The runtime reports through `easytier.reportTunnelFailure` because the
    /// No-TUN forward accepts a connection and never answers, so a real request
    /// is often the first thing to notice the overlay is gone. One report
    /// degrades the state every session reads, so the next request in any
    /// session goes straight to the public endpoint.
    pub fn report_tunnel_failure(&self, reason: &str) {
        self.endpoint.health().report_failure(reason);
        tracing::info!(%reason, "agent runtime reported a tunnel failure");
    }

    /// Where the tunnel health stands, for the RPC answer and the panel.
    pub fn tunnel_health(&self) -> TunnelHealthSnapshot {
        self.endpoint.health().snapshot()
    }

    /// Rebuild the node after the machine changed links (A3).
    ///
    /// The identity in hand is reused as-is: re-fetching bootstrap on every
    /// link change would walk into the gateway's per-IP lockout, and the answer
    /// already issued is still the one this AccessKey belongs to.
    async fn rebuild_after_network_change(&mut self) {
        if !self.settings.enabled {
            return;
        }
        // Whatever ran before was bound to the old route: the shared state says
        // so before anything else happens, so no session picks the dead
        // forward while the restart is in flight.
        self.endpoint
            .health()
            .report_failure("local network changed");
        let (reuse, effective_mode) = match &self.backend {
            ActiveBackend::InProcess {
                local_forward_port,
                hostlink_forward_port,
                effective_mode,
                ..
            } => (
                ReusedPorts {
                    router_forward_port: Some(*local_forward_port),
                    hostlink_forward_port: *hostlink_forward_port,
                },
                *effective_mode,
            ),
            // An elevated TUN runner is another process with its own lifecycle
            // and no loopback forward to re-key; it is left to reconnect.
            ActiveBackend::ElevatedTun { .. } | ActiveBackend::Disabled => return,
        };
        let settings = self.resolved_settings();
        self.stop_current().await;
        let no_tun = effective_mode == EasyTierEffectiveMode::NoTun;
        match self
            .start_in_process(&settings, no_tun, effective_mode, reuse)
            .await
        {
            Ok(()) => {
                self.last_error = None;
                tracing::info!("EasyTier node rebuilt after a local network change");
            }
            Err(error) => {
                tracing::warn!(%error, "EasyTier restart after a local network change failed");
                self.last_error = Some(format!(
                    "EasyTier restart after a network change failed: {error}"
                ));
            }
        }
    }
}

/// Rebuild the node after the local route changed.
///
/// Runs in its own task so the watcher that noticed the change is never the
/// task the restart aborts.
async fn restart_after_network_change() {
    let mut mgr = manager().lock().await;
    mgr.rebuild_after_network_change().await;
}
#[cfg(test)]
#[path = "runtime_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "boot_bootstrap_tests.rs"]
mod boot_bootstrap_tests;
