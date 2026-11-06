//! The address a running EasyTier node publishes, and the one answer the chat
//! path reads.
//!
//! `resolve_minih_router_endpoint` runs on every provider request, so it must
//! never do I/O. What it may read is here: which loopback forward the node
//! installed when it started, and the health state the background prober keeps
//! up to date ([`super::health`]). Only a `healthy` tunnel hands back its LAN
//! address; everything else — disabled, held, probing, degraded — answers with
//! the public base URL, so a request never pays the No-TUN "accepted, never
//! answered" wait.

use std::sync::Arc;

use super::config::{EasyTierEffectiveMode, DEFAULT_ROUTER_PUBLIC_URL};
use super::health::TunnelHealthMonitor;
use super::runtime::MinihRouterResolvedEndpoint;

/// What one successful start put in place.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PublishedEndpoint {
    /// Loopback base URL of the Router forward, e.g. `http://127.0.0.1:25890/v1`.
    pub local_forward_url: String,
    pub effective_mode: EasyTierEffectiveMode,
    pub virtual_ipv4: Option<String>,
}

impl PublishedEndpoint {
    /// The URL the health prober asks: the forward's origin, not its API path.
    pub fn probe_target(&self) -> String {
        self.local_forward_url.clone()
    }
}

/// The published address plus the health gate in front of it.
#[derive(Debug, Default)]
pub struct TunnelEndpoint {
    published: Option<PublishedEndpoint>,
    health: Arc<TunnelHealthMonitor>,
}

impl TunnelEndpoint {
    pub fn new(health: Arc<TunnelHealthMonitor>) -> Self {
        Self {
            published: None,
            health,
        }
    }

    pub fn health(&self) -> &Arc<TunnelHealthMonitor> {
        &self.health
    }

    /// Record the forward a start just installed and start watching it.
    pub fn publish(&mut self, published: PublishedEndpoint) {
        self.health.set_target(Some(published.probe_target()));
        self.published = Some(published);
    }

    /// The node is gone: nothing is published and nothing is probed.
    pub fn clear(&mut self) {
        self.published = None;
        self.health.set_target(None);
    }

    /// Whether the LAN address may carry a request right now.
    pub fn using_lan(&self) -> bool {
        self.published.is_some() && self.health.is_healthy()
    }

    /// The endpoint a Minih Router request should use.
    pub fn resolve(&self, configured_base_url: Option<&str>) -> MinihRouterResolvedEndpoint {
        let fallback_base_url = configured_base_url
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(DEFAULT_ROUTER_PUBLIC_URL)
            .to_string();
        let using_lan = self.using_lan();
        let published = self.published.as_ref();
        MinihRouterResolvedEndpoint {
            active_base_url: match published {
                Some(endpoint) if using_lan => endpoint.local_forward_url.clone(),
                _ => fallback_base_url.clone(),
            },
            fallback_base_url,
            using_lan,
            mode: published
                .map(|endpoint| endpoint.effective_mode)
                .unwrap_or(EasyTierEffectiveMode::Disabled),
            effective_mode: published
                .map(|endpoint| endpoint.effective_mode)
                .unwrap_or(EasyTierEffectiveMode::Disabled),
            virtual_ipv4: published.and_then(|endpoint| endpoint.virtual_ipv4.clone()),
            local_forward_url: published.map(|endpoint| endpoint.local_forward_url.clone()),
        }
    }
}

#[cfg(test)]
#[path = "endpoint_tests.rs"]
mod tests;
