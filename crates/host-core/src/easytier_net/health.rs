//! Background tunnel health for the No-TUN Router forward.
//!
//! A No-TUN forward keeps its loopback socket open while the overlay is gone:
//! the connection is accepted and never answered. Probing that forward on the
//! chat path was therefore both useless (one lucky answer promoted a tunnel
//! that was about to drop) and expensive (a 1.2 s round trip per request). This
//! module owns the single answer instead:
//!
//! * a prober task asks `<forward>/health` every few seconds and feeds the
//!   [`TunnelHealth`] state machine;
//! * `unavailable → probing → healthy` needs a *stable* streak, so a single
//!   successful probe never promotes a flapping tunnel;
//! * one failed probe — or a failure the agent runtime reports through
//!   `easytier.reportTunnelFailure` — demotes it immediately;
//! * a network watcher notices that the machine moved to another link and asks
//!   the runtime to rebuild the node.
//!
//! Request paths only *read* [`TunnelHealthMonitor::is_healthy`]; every probe
//! happens on a task with an owner and a cleanup path (AGENTS.md §9).

use std::net::{SocketAddr, UdpSocket};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio::task::JoinHandle;

/// How often the prober asks the forward's `/health`.
pub const PROBE_INTERVAL_MS: u64 = 4_000;

/// How long consecutive successful probes must span before the tunnel is called
/// healthy. A single answer proves a moment, not a path.
pub const HEALTHY_STABLE_WINDOW_MS: u64 = 12_000;

/// Timeout of one `/health` probe. Shorter than [`PROBE_INTERVAL_MS`] so probes
/// cannot pile up behind each other.
pub const PROBE_TIMEOUT_MS: u64 = 2_500;

/// How often the network watcher samples the local route.
pub const NETWORK_SAMPLE_INTERVAL_MS: u64 = 4_000;

/// Quiet period after a detected link change before another one is reported, so
/// a flapping interface does not restart the node on every sample.
pub const NETWORK_CHANGE_COOLDOWN_MS: u64 = 15_000;

/// Destinations used only to ask the kernel which source address the default
/// route would use. No packet is sent: a connected UDP socket only performs the
/// route lookup.
const ROUTE_SAMPLE_TARGETS: [&str; 2] = ["223.5.5.5:53", "1.1.1.1:53"];

/// The three states the request path may observe.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum TunnelHealthState {
    /// The forward is not answering, or nobody has proven it does.
    #[default]
    Unavailable,
    /// Answers arrived, but not for long enough to be trusted with a request.
    Probing,
    /// A stable streak of answers; the only state that may use the tunnel.
    Healthy,
}

/// The state machine, kept synchronous with an explicit clock so it is testable
/// without sleeping.
#[derive(Debug, Clone, Default)]
pub struct TunnelHealth {
    state: TunnelHealthState,
    /// When the current streak of successful probes began.
    streak_started: Option<Instant>,
    last_error: Option<String>,
}

impl TunnelHealth {
    pub fn state(&self) -> TunnelHealthState {
        self.state
    }

    pub fn is_healthy(&self) -> bool {
        self.state == TunnelHealthState::Healthy
    }

    pub fn last_error(&self) -> Option<&str> {
        self.last_error.as_deref()
    }

    /// Fold one background probe result in.
    ///
    /// A success extends the streak (and promotes it once the streak spans
    /// [`HEALTHY_STABLE_WINDOW_MS`]); a single failure demotes at once, because
    /// a forward that stopped answering the prober will not answer a request
    /// either.
    pub fn observe(&mut self, ok: bool, now: Instant, error: Option<&str>) {
        if !ok {
            self.degrade(error.unwrap_or("tunnel probe failed"));
            return;
        }
        self.last_error = None;
        match self.streak_started {
            None => {
                self.streak_started = Some(now);
                self.state = TunnelHealthState::Probing;
            }
            Some(started) => {
                if now.saturating_duration_since(started) >= stable_window() {
                    self.state = TunnelHealthState::Healthy;
                } else {
                    self.state = TunnelHealthState::Probing;
                }
            }
        }
    }

    /// Demote to unavailable right now.
    ///
    /// Used by a failed probe, by the runtime's own failure report, and by a
    /// detected link change: all three are evidence that the tunnel is not
    /// usable, and none of them is undone by a stale streak.
    pub fn degrade(&mut self, reason: &str) {
        self.state = TunnelHealthState::Unavailable;
        self.streak_started = None;
        let trimmed = reason.trim();
        if !trimmed.is_empty() {
            self.last_error = Some(trimmed.to_string());
        }
    }
}

fn stable_window() -> Duration {
    Duration::from_millis(HEALTHY_STABLE_WINDOW_MS)
}

/// What a status read needs to know about the health probe.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelHealthSnapshot {
    pub state: TunnelHealthState,
    /// The forward base URL being probed, empty when nothing is watched.
    pub target: String,
    pub last_error: String,
    pub healthy: bool,
}

#[derive(Debug, Default)]
struct MonitorInner {
    health: TunnelHealth,
    target: Option<String>,
}

/// Shared health state, read by request paths and written by the prober.
///
/// A plain `std::sync::Mutex` is enough: every critical section is a few field
/// moves with no `.await` inside, so a request path never queues behind a
/// network round trip.
#[derive(Debug, Default)]
pub struct TunnelHealthMonitor {
    inner: Mutex<MonitorInner>,
}

fn lock_ignoring_poison(inner: &Mutex<MonitorInner>) -> MutexGuard<'_, MonitorInner> {
    match inner.lock() {
        Ok(guard) => guard,
        // A panic elsewhere must not turn the tunnel permanently unreadable.
        Err(poisoned) => poisoned.into_inner(),
    }
}

impl TunnelHealthMonitor {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Point the prober at another forward, or at nothing.
    ///
    /// A different target starts over in `unavailable`: the previous streak
    /// described another node, possibly on another network.
    pub fn set_target(&self, target: Option<String>) {
        let mut inner = lock_ignoring_poison(&self.inner);
        let next = target.map(|url| url.trim().trim_end_matches('/').to_string());
        let next = next.filter(|url| !url.is_empty());
        if inner.target == next {
            return;
        }
        inner.target = next;
        inner.health = TunnelHealth::default();
    }

    pub fn target(&self) -> Option<String> {
        lock_ignoring_poison(&self.inner).target.clone()
    }

    pub fn is_healthy(&self) -> bool {
        lock_ignoring_poison(&self.inner).health.is_healthy()
    }

    pub fn observe(&self, ok: bool, error: Option<&str>) {
        self.observe_at(ok, Instant::now(), error);
    }

    /// Same, on a caller-supplied clock: the stable window is a property of the
    /// state machine, not of `Instant::now()`, so tests drive it directly.
    pub fn observe_at(&self, ok: bool, now: Instant, error: Option<&str>) {
        lock_ignoring_poison(&self.inner)
            .health
            .observe(ok, now, error);
    }

    /// A failure the agent runtime saw on a real request (C2).
    pub fn report_failure(&self, reason: &str) {
        lock_ignoring_poison(&self.inner).health.degrade(reason);
    }

    pub fn snapshot(&self) -> TunnelHealthSnapshot {
        let inner = lock_ignoring_poison(&self.inner);
        TunnelHealthSnapshot {
            state: inner.health.state(),
            target: inner.target.clone().unwrap_or_default(),
            last_error: inner.health.last_error().unwrap_or_default().to_string(),
            healthy: inner.health.is_healthy(),
        }
    }
}

/// Ask one forward whether anything behind it still answers.
///
/// Any HTTP answer proves the overlay carried the request; only a rejected or
/// timed-out probe means the tunnel is gone. The `/health` path is asked of the
/// forward's origin because a No-TUN forward relays the gateway's own service.
pub async fn probe_tunnel_health(base_url: &str, timeout: Duration) -> Result<(), String> {
    let root = control_root_from_base_url(base_url);
    if root.is_empty() {
        return Err("no forward address to probe".to_string());
    }
    let url = format!("{root}/health");
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(timeout)
        .connect_timeout(timeout)
        .build()
        .map_err(|e| format!("failed to build the tunnel probe client: {e}"))?;
    match client.get(&url).send().await {
        Ok(response) => {
            if response.status().is_success() || response.status().is_client_error() {
                Ok(())
            } else {
                Err(format!(
                    "tunnel probe answered HTTP {}",
                    response.status().as_u16()
                ))
            }
        }
        Err(error) => Err(format!("tunnel probe failed: {error}")),
    }
}

/// Strip a trailing `/v1` so the probe asks the gateway origin, not its API.
pub fn control_root_from_base_url(base_url: &str) -> String {
    let trimmed = base_url.trim().trim_end_matches('/');
    if let Some(root) = trimmed.strip_suffix("/v1") {
        root.to_string()
    } else if let Some(root) = trimmed.strip_suffix("/V1") {
        root.to_string()
    } else {
        trimmed.to_string()
    }
}

/// The background `/health` prober.
///
/// One task per running node; dropping it stops the probes. It never touches
/// the manager lock, so a restart can drop it without deadlocking.
pub struct ProbeTask {
    handle: JoinHandle<()>,
}

impl ProbeTask {
    pub fn spawn(monitor: Arc<TunnelHealthMonitor>) -> Self {
        let handle = tokio::spawn(async move {
            let interval = Duration::from_millis(PROBE_INTERVAL_MS);
            let timeout = Duration::from_millis(PROBE_TIMEOUT_MS);
            loop {
                tokio::time::sleep(interval).await;
                let Some(target) = monitor.target() else {
                    continue;
                };
                let result = probe_tunnel_health(&target, timeout).await;
                // The target may have changed while the probe was in flight;
                // its answer describes a forward that is no longer watched.
                if monitor.target().as_deref() != Some(target.as_str()) {
                    continue;
                }
                match result {
                    Ok(()) => monitor.observe(true, None),
                    Err(error) => monitor.observe(false, Some(&error)),
                }
            }
        });
        Self { handle }
    }
}

impl Drop for ProbeTask {
    fn drop(&mut self) {
        self.handle.abort();
    }
}

/// The local route fingerprint the watcher compares between samples.
///
/// Two sample targets are used so that a default-route change between two links
/// that happen to share a prefix still shows up as a different source address.
pub fn sample_network_fingerprint() -> String {
    ROUTE_SAMPLE_TARGETS
        .iter()
        .map(|target| match target.parse::<SocketAddr>() {
            Ok(addr) => source_address_for(addr),
            Err(_) => "invalid".to_string(),
        })
        .collect::<Vec<_>>()
        .join("/")
}

fn source_address_for(destination: SocketAddr) -> String {
    let Ok(socket) = UdpSocket::bind("0.0.0.0:0") else {
        return "unbound".to_string();
    };
    // `connect` on a UDP socket only selects a route; nothing is transmitted.
    match socket.connect(destination) {
        Ok(()) => socket
            .local_addr()
            .map(|addr| addr.ip().to_string())
            .unwrap_or_else(|_| "unknown".to_string()),
        Err(_) => "unreachable".to_string(),
    }
}

/// Work the watcher must do when the machine changes links.
pub type NetworkChangeHandler =
    Arc<dyn Fn() -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> + Send + Sync>;

/// Watches the local route and reports link changes.
///
/// Long-lived for the channel, not per node: the restart it triggers must not
/// abort the task that is waiting for it (that would cancel the restart
/// mid-way), so this task only *reports*, and the report re-enters the manager
/// from a separate task.
pub struct NetworkWatcher {
    handle: JoinHandle<()>,
}

impl NetworkWatcher {
    pub fn spawn(handler: NetworkChangeHandler) -> Self {
        let handle = tokio::spawn(async move {
            let interval = Duration::from_millis(NETWORK_SAMPLE_INTERVAL_MS);
            let cooldown = Duration::from_millis(NETWORK_CHANGE_COOLDOWN_MS);
            let mut previous = sample_network_fingerprint();
            let mut last_report: Option<Instant> = None;
            loop {
                tokio::time::sleep(interval).await;
                let current = sample_network_fingerprint();
                if current == previous {
                    continue;
                }
                let from = std::mem::replace(&mut previous, current.clone());
                if last_report.is_some_and(|at| at.elapsed() < cooldown) {
                    continue;
                }
                last_report = Some(Instant::now());
                tracing::info!(
                    from = %from,
                    to = %current,
                    "local network changed; rebuilding the EasyTier node"
                );
                handler().await;
            }
        });
        Self { handle }
    }
}

impl Drop for NetworkWatcher {
    fn drop(&mut self) {
        self.handle.abort();
    }
}

#[cfg(test)]
#[path = "health_tests.rs"]
mod tests;
