use super::*;
use crate::easytier_net::remote_gateway::{RemoteGatewayAnnouncement, RemoteGatewayOutcome};

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

const TEST_CA_PEM: &str = "-----BEGIN CERTIFICATE-----\n\
MIIBkTCB+wIJAJ8Y0V0n8m2fMA0GCSqGSIb3DQEBCwUAMB4xHDAaBgNVBAMME2dh\ndGV3YXkuZXhhbXBsZS5jb20=\n\
-----END CERTIFICATE-----\n";

fn settings_for_test() -> EasyTierSettings {
    EasyTierSettings {
        enabled: true,
        mode: EasyTierMode::NoTun,
        network_name: "minih-net-test".to_string(),
        network_secret: "Minih@9527".to_string(),
        peers: vec!["tcp://127.0.0.1:65530".to_string()],
        router_lan_url: "http://10.144.144.10:3001/v1".to_string(),
        dhcp: true,
        ipv4: None,
    }
}

fn bootstrap_answer(remote_gateway: RemoteGatewayOutcome) -> BootstrapResponse {
    BootstrapResponse {
        network_name: "minih-net-test".to_string(),
        network_secret: "Minih@9527".to_string(),
        gateway_virtual_ipv4: Some("10.144.144.10".to_string()),
        peers: Some(vec!["tcp://127.0.0.1:65530".to_string()]),
        ttl_seconds: None,
        remote_gateway,
    }
}

fn announced() -> RemoteGatewayOutcome {
    RemoteGatewayOutcome::Announced(RemoteGatewayAnnouncement {
        hostlink_url: "wss://gateway.example.com:8443/hostlink".to_string(),
        public_origin: "https://gateway.example.com".to_string(),
        ca_pem: TEST_CA_PEM.to_string(),
    })
}

fn manager_with(remote_gateway: RemoteGatewayOutcome) -> EasyTierManager {
    EasyTierManager {
        active_bootstrap: Some(bootstrap_answer(remote_gateway)),
        ..EasyTierManager::default()
    }
}

#[tokio::test]
async fn no_tun_installs_the_host_link_forward_and_reports_it() {
    let dir = tempfile::tempdir().unwrap();
    let mut mgr = manager_with(announced());
    mgr.apply_settings(dir.path(), settings_for_test(), true)
        .await;

    let status = mgr.status(None).await;
    let gateway = &status.remote_gateway;
    assert!(
        gateway.available,
        "unavailable: {}",
        gateway.unavailable_reason
    );
    assert_eq!(
        gateway.hostlink_url,
        "wss://gateway.example.com:8443/hostlink"
    );
    assert_eq!(gateway.public_origin, "https://gateway.example.com");
    assert_eq!(gateway.ca_pem, TEST_CA_PEM);
    // Certificate validation uses the advertised name, never loopback.
    assert_eq!(gateway.tls_server_name, "gateway.example.com");
    let forward_port = gateway
        .local_forward_port
        .expect("the Host-link forward should be installed");
    assert_eq!(
        gateway.dial_url,
        format!("wss://127.0.0.1:{forward_port}/hostlink")
    );
    // Two forwards, two ports: the Router forward keeps its own.
    assert!(status.local_forward_port.unwrap_or(0) > 0);
    assert_ne!(Some(forward_port), status.local_forward_port);
}

#[tokio::test]
async fn without_an_announcement_the_mesh_is_unchanged() {
    let dir = tempfile::tempdir().unwrap();
    let mut mgr = manager_with(RemoteGatewayOutcome::Absent);
    mgr.apply_settings(dir.path(), settings_for_test(), true)
        .await;

    assert!(mgr.hostlink_forward(4000).is_none());
    assert!(mgr.hostlink_forward_for_start(false, 4000).is_none());

    let status = mgr.status(None).await;
    assert!(!status.remote_gateway.available);
    assert!(status.remote_gateway.local_forward_port.is_none());
    assert!(status.remote_gateway.dial_url.is_empty());
    // A Router that answered without offering account mode says so: an empty
    // reason left the panel with an unexplained "unavailable".
    assert!(status
        .remote_gateway
        .unavailable_reason
        .contains("does not offer"));
    // Today's behaviour: the Router forward is still the only one.
    assert!(status.local_forward_port.unwrap_or(0) > 0);
    assert!(!status.using_lan);
}

#[tokio::test]
async fn a_malformed_announcement_never_breaks_the_mesh() {
    let dir = tempfile::tempdir().unwrap();
    let mut mgr = manager_with(RemoteGatewayOutcome::Malformed(
        "remoteGateway.hostlinkUrl must use the wss scheme".to_string(),
    ));
    mgr.apply_settings(dir.path(), settings_for_test(), true)
        .await;

    let status = mgr.status(None).await;
    assert!(!status.remote_gateway.available);
    assert!(status
        .remote_gateway
        .unavailable_reason
        .contains("wss scheme"));
    // The identity from the same answer is in effect regardless.
    assert_eq!(status.network_name, "minih-net-test");
    assert_eq!(status.bootstrap_source, BootstrapSource::Gateway);
    assert_eq!(status.effective_mode, EasyTierEffectiveMode::NoTun);
    assert!(status.local_forward_port.unwrap_or(0) > 0);
}

#[test]
fn the_host_link_forward_is_only_installed_in_no_tun_mode() {
    let mgr = manager_with(announced());
    assert!(mgr.hostlink_forward_for_start(true, 4000).is_some());
    // TUN mode routes the overlay address itself.
    assert!(mgr.hostlink_forward_for_start(false, 4000).is_none());
}

#[test]
fn an_announced_endpoint_without_a_forward_is_reported_as_unavailable() {
    let mgr = manager_with(announced());
    // The backend is Disabled, so nothing installed the forward yet.
    let status = mgr.remote_gateway_status();
    assert!(!status.available);
    assert!(status.unavailable_reason.contains("forward"));
    // The endpoint still shows, so the panel can explain what arrived.
    assert_eq!(
        status.hostlink_url,
        "wss://gateway.example.com:8443/hostlink"
    );
    assert_eq!(status.tls_server_name, "gateway.example.com");
    assert!(status.dial_url.is_empty());
}

#[test]
fn a_domain_announcement_without_an_overlay_address_is_unavailable() {
    let mut answer = bootstrap_answer(announced());
    answer.gateway_virtual_ipv4 = None;
    let mgr = EasyTierManager {
        active_bootstrap: Some(answer),
        ..EasyTierManager::default()
    };
    let status = mgr.remote_gateway_status();
    assert!(!status.available);
    assert!(status.unavailable_reason.contains("overlay address"));
}
