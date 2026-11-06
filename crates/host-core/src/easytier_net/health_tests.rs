//! Tunnel health is a timing machine, so every test drives it with an explicit
//! clock: no test here sleeps.

use super::*;
use std::time::Duration;

fn at(base: Instant, ms: u64) -> Instant {
    base + Duration::from_millis(ms)
}

#[test]
fn one_answer_is_not_a_path() {
    let mut health = TunnelHealth::default();
    let now = Instant::now();
    health.observe(true, now, None);
    assert_eq!(health.state(), TunnelHealthState::Probing);
    assert!(!health.is_healthy());
}

#[test]
fn promotion_waits_for_the_stable_window() {
    let mut health = TunnelHealth::default();
    let start = Instant::now();
    health.observe(true, start, None);
    // Answers keep arriving, but the streak is younger than the window.
    health.observe(true, at(start, PROBE_INTERVAL_MS), None);
    health.observe(true, at(start, HEALTHY_STABLE_WINDOW_MS - 1), None);
    assert_eq!(health.state(), TunnelHealthState::Probing);

    health.observe(true, at(start, HEALTHY_STABLE_WINDOW_MS), None);
    assert_eq!(health.state(), TunnelHealthState::Healthy);
    assert!(health.is_healthy());
}

#[test]
fn one_failed_probe_demotes_a_healthy_tunnel() {
    let mut health = TunnelHealth::default();
    let start = Instant::now();
    health.observe(true, start, None);
    health.observe(true, at(start, HEALTHY_STABLE_WINDOW_MS), None);
    assert!(health.is_healthy());

    health.observe(
        false,
        at(start, HEALTHY_STABLE_WINDOW_MS + PROBE_INTERVAL_MS),
        Some("tunnel probe failed: connect refused"),
    );
    assert_eq!(health.state(), TunnelHealthState::Unavailable);
    assert_eq!(
        health.last_error(),
        Some("tunnel probe failed: connect refused")
    );

    // Recovery goes through the whole window again, not straight back in.
    health.observe(true, at(start, HEALTHY_STABLE_WINDOW_MS + 1_000), None);
    assert_eq!(health.state(), TunnelHealthState::Probing);
}

#[test]
fn a_quiet_period_inside_the_window_restarts_the_streak() {
    let mut health = TunnelHealth::default();
    let start = Instant::now();
    health.observe(true, start, None);
    health.observe(false, at(start, 8_000), None);
    // The streak began again here, so the original start no longer counts.
    health.observe(true, at(start, 9_000), None);
    health.observe(true, at(start, 9_000 + HEALTHY_STABLE_WINDOW_MS - 1), None);
    assert_eq!(health.state(), TunnelHealthState::Probing);
    health.observe(true, at(start, 9_000 + HEALTHY_STABLE_WINDOW_MS), None);
    assert!(health.is_healthy());
}

#[test]
fn a_reported_failure_demotes_and_names_its_reason() {
    let mut health = TunnelHealth::default();
    let start = Instant::now();
    health.observe(true, start, None);
    health.observe(true, at(start, HEALTHY_STABLE_WINDOW_MS), None);
    assert!(health.is_healthy());

    health.degrade("tunnel request failed: connection reset");
    assert_eq!(health.state(), TunnelHealthState::Unavailable);
    assert_eq!(
        health.last_error(),
        Some("tunnel request failed: connection reset")
    );
}

#[test]
fn a_failure_report_reaches_every_reader_of_the_monitor() {
    let monitor = TunnelHealthMonitor::new();
    monitor.set_target(Some("http://127.0.0.1:25890/v1".to_string()));
    assert!(!monitor.is_healthy());

    monitor.report_failure("provider request failed on the tunnel");
    assert_eq!(monitor.snapshot().state, TunnelHealthState::Unavailable);
    let snapshot = monitor.snapshot();
    assert!(!snapshot.healthy);
    assert_eq!(snapshot.target, "http://127.0.0.1:25890/v1");
    assert!(snapshot.last_error.contains("tunnel"));
}

#[test]
fn a_new_target_forgets_the_previous_streak() {
    let monitor = TunnelHealthMonitor::new();
    monitor.set_target(Some("http://127.0.0.1:25890/v1".to_string()));
    monitor.report_failure("old forward is gone");
    monitor.observe(true, None);
    assert_eq!(monitor.snapshot().state, TunnelHealthState::Probing);

    monitor.set_target(Some("http://127.0.0.1:25991/v1".to_string()));
    assert_eq!(monitor.snapshot().state, TunnelHealthState::Unavailable);
    assert_eq!(
        monitor.target().as_deref(),
        Some("http://127.0.0.1:25991/v1")
    );

    monitor.set_target(None);
    assert_eq!(monitor.target(), None);
}

#[test]
fn the_probe_reads_the_gateway_origin_not_the_api_path() {
    assert_eq!(
        control_root_from_base_url("http://127.0.0.1:25890/v1"),
        "http://127.0.0.1:25890"
    );
    assert_eq!(
        control_root_from_base_url("https://router.hmini.org/v1/"),
        "https://router.hmini.org"
    );
    assert_eq!(
        control_root_from_base_url("http://11.12.0.1:3001"),
        "http://11.12.0.1:3001"
    );
}

#[test]
fn the_network_fingerprint_is_a_stable_string() {
    // Two samples in a row describe the same machine; a test host without a
    // default route still produces a stable value instead of failing.
    let first = sample_network_fingerprint();
    let second = sample_network_fingerprint();
    assert_eq!(first, second);
    assert_eq!(first.split('/').count(), 2);
    assert!(!first.is_empty());
}
