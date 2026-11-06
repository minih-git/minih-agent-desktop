//! What the chat path is allowed to answer, and after which evidence.

use super::*;
use crate::easytier_net::config::EasyTierEffectiveMode;
use crate::easytier_net::health::{TunnelHealthMonitor, HEALTHY_STABLE_WINDOW_MS};
use std::time::{Duration, Instant};

const PUBLIC: &str = "https://router.hmini.org/v1";
const FORWARD: &str = "http://127.0.0.1:25890/v1";

/// A published forward whose health has already passed the stable window.
fn healthy_endpoint() -> TunnelEndpoint {
    let health = TunnelHealthMonitor::new();
    let mut endpoint = TunnelEndpoint::new(health.clone());
    endpoint.publish(published());
    let start = Instant::now();
    health.observe_at(true, start, None);
    health.observe_at(
        true,
        start + Duration::from_millis(HEALTHY_STABLE_WINDOW_MS),
        None,
    );
    endpoint
}

fn published() -> PublishedEndpoint {
    PublishedEndpoint {
        local_forward_url: FORWARD.to_string(),
        effective_mode: EasyTierEffectiveMode::NoTun,
        virtual_ipv4: None,
    }
}

#[test]
fn a_healthy_tunnel_carries_the_request() {
    let endpoint = healthy_endpoint();
    let resolved = endpoint.resolve(Some(PUBLIC));
    assert!(resolved.using_lan);
    assert_eq!(resolved.active_base_url, FORWARD);
    assert_eq!(resolved.fallback_base_url, PUBLIC);
    assert_eq!(resolved.local_forward_url.as_deref(), Some(FORWARD));
    assert_eq!(resolved.effective_mode, EasyTierEffectiveMode::NoTun);
}

#[test]
fn nothing_published_means_the_public_address() {
    let endpoint = TunnelEndpoint::default();
    let resolved = endpoint.resolve(Some(PUBLIC));
    assert!(!resolved.using_lan);
    assert_eq!(resolved.active_base_url, PUBLIC);
    assert_eq!(resolved.effective_mode, EasyTierEffectiveMode::Disabled);
    assert!(resolved.local_forward_url.is_none());
}

#[test]
fn one_answer_is_not_enough_to_carry_a_request() {
    // The old request-path probe promoted a tunnel on a single lucky answer.
    let health = TunnelHealthMonitor::new();
    let mut endpoint = TunnelEndpoint::new(health.clone());
    endpoint.publish(published());
    health.observe_at(true, Instant::now(), None);

    let resolved = endpoint.resolve(Some(PUBLIC));
    assert!(!resolved.using_lan);
    assert_eq!(resolved.active_base_url, PUBLIC);
    // The forward is still reported, so the panel can say what is being watched.
    assert_eq!(resolved.local_forward_url.as_deref(), Some(FORWARD));
}

#[test]
fn a_reported_failure_moves_every_later_request_to_the_public_address() {
    // C2: one session's failed request is every session's answer, because the
    // state lives in Host Core rather than in one runtime.
    let endpoint = healthy_endpoint();
    assert!(endpoint.resolve(Some(PUBLIC)).using_lan);

    endpoint
        .health()
        .report_failure("tunnel request failed: connection reset");

    let first_session = endpoint.resolve(Some(PUBLIC));
    let second_session = endpoint.resolve(Some(PUBLIC));
    assert!(!first_session.using_lan);
    assert!(!second_session.using_lan);
    assert_eq!(first_session.active_base_url, PUBLIC);
    assert_eq!(second_session.active_base_url, PUBLIC);
}

#[test]
fn clearing_the_forward_removes_the_lan_address() {
    let mut endpoint = healthy_endpoint();
    endpoint.clear();
    let resolved = endpoint.resolve(Some(PUBLIC));
    assert!(!resolved.using_lan);
    assert_eq!(resolved.active_base_url, PUBLIC);
    assert!(resolved.local_forward_url.is_none());
    assert_eq!(resolved.effective_mode, EasyTierEffectiveMode::Disabled);
}

#[test]
fn a_row_without_a_base_url_falls_back_to_the_public_default() {
    let endpoint = healthy_endpoint();
    let resolved = endpoint.resolve(None);
    assert_eq!(resolved.fallback_base_url, DEFAULT_ROUTER_PUBLIC_URL);
}

#[test]
fn a_blank_base_url_is_not_a_fallback() {
    let endpoint = TunnelEndpoint::default();
    let resolved = endpoint.resolve(Some("   "));
    assert_eq!(resolved.fallback_base_url, DEFAULT_ROUTER_PUBLIC_URL);
    assert_eq!(resolved.active_base_url, DEFAULT_ROUTER_PUBLIC_URL);
}
