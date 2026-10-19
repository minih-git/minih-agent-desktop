use super::*;
use crate::easytier_net::remote_gateway::{RemoteGatewayAnnouncement, RemoteGatewayOutcome};

const TEST_CA_PEM: &str = "-----BEGIN CERTIFICATE-----\n\
MIIBkTCB+wIJAJ8Y0V0n8m2fMA0GCSqGSIb3DQEBCwUAMB4xHDAaBgNVBAMME2dh\
dGV3YXkuZXhhbXBsZS5jb20=\n\
-----END CERTIFICATE-----\n";

/// A settings row that starts on its own: developer mode's manual identity.
///
/// Gateway mode is covered by `boot_bootstrap_tests`, where a stub Router issues
/// the identity; without one it holds, which is the point of the mode.
fn manual_settings() -> EasyTierSettings {
    EasyTierSettings {
        enabled: true,
        mode: EasyTierMode::NoTun,
        identity: EasyTierIdentity::Manual,
        network_name: "minih-net-test".to_string(),
        network_secret: "typed-by-user".to_string(),
        peers: vec!["tcp://127.0.0.1:65530".to_string()],
        router_lan_url: "http://10.144.144.10:3001/v1".to_string(),
        dhcp: true,
        ipv4: None,
    }
}

fn gateway_settings() -> EasyTierSettings {
    EasyTierSettings {
        identity: EasyTierIdentity::Gateway,
        network_secret: String::new(),
        ..manual_settings()
    }
}

fn bootstrap_answer(remote_gateway: RemoteGatewayOutcome) -> BootstrapResponse {
    BootstrapResponse {
        network_name: "minih-net-test".to_string(),
        network_secret: "issued-by-gateway".to_string(),
        gateway_virtual_ipv4: Some("10.144.144.10".to_string()),
        router_lan_url: None,
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
async fn in_process_no_tun_allocates_forward_port_and_falls_back_until_reachable() {
    let dir = tempfile::tempdir().unwrap();
    let mut mgr = EasyTierManager::default();
    mgr.apply_settings(dir.path(), manual_settings(), true)
        .await;

    let status = mgr.status(Some("https://router.hmini.org/v1")).await;
    assert!(status.enabled);
    assert_eq!(status.identity, EasyTierIdentity::Manual);
    assert_eq!(status.effective_mode, EasyTierEffectiveMode::NoTun);
    assert!(status.local_forward_port.unwrap_or(0) > 0);
    assert!(status
        .local_forward_url
        .as_deref()
        .unwrap_or("")
        .starts_with("http://127.0.0.1:"));
    assert!(!status.using_lan);
    assert_eq!(status.active_router_base_url, "https://router.hmini.org/v1");
    // A manual identity is the local one, and says so.
    assert_eq!(status.bootstrap_source, BootstrapSource::Local);

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

#[tokio::test]
async fn gateway_mode_without_an_answer_holds_and_stays_on_the_public_endpoint() {
    // R3: a gateway that cannot issue an identity must leave the tunnel down.
    // Starting anyway put the machine on a brand mesh the gateway never
    // authorised, and "LAN first" then sent requests to the wrong gateway.
    let dir = tempfile::tempdir().unwrap();
    let mut mgr = EasyTierManager::default();
    mgr.apply_settings(dir.path(), gateway_settings(), true)
        .await;

    let status = mgr.status(Some("https://router.hmini.org/v1")).await;
    assert!(status.enabled, "the user's switch is still on");
    assert_eq!(status.state, EasyTierConnectionState::Error);
    assert_eq!(status.effective_mode, EasyTierEffectiveMode::Disabled);
    assert!(status.local_forward_port.is_none());
    assert!(!status.using_lan);
    assert!(!status.router_lan_reachable);
    assert_eq!(status.active_router_base_url, "https://router.hmini.org/v1");
    assert_eq!(
        status.fallback_router_base_url,
        "https://router.hmini.org/v1"
    );
    assert_eq!(status.bootstrap_source, BootstrapSource::Gateway);
    assert!(
        !status.bootstrap_error.trim().is_empty(),
        "a held channel must explain itself: {:?}",
        status.bootstrap_error
    );
    // Nothing the gateway never issued is in effect.
    assert!(status.bootstrap_network_name.is_empty());

    // The chat path asks the same question and gets the public answer.
    let resolved = mgr
        .resolve_minih_router_endpoint(Some("https://router.hmini.org/v1"))
        .await;
    assert!(!resolved.using_lan);
    assert_eq!(resolved.active_base_url, "https://router.hmini.org/v1");
    assert_eq!(resolved.effective_mode, EasyTierEffectiveMode::Disabled);
}

#[tokio::test]
async fn manual_mode_without_a_secret_holds() {
    let dir = tempfile::tempdir().unwrap();
    let mut mgr = EasyTierManager::default();
    let mut settings = manual_settings();
    settings.network_secret = String::new();
    mgr.apply_settings(dir.path(), settings, true).await;

    let status = mgr.status(None).await;
    assert_eq!(status.state, EasyTierConnectionState::Error);
    assert!(status.local_forward_port.is_none());
    assert!(
        status.bootstrap_error.contains("network secret"),
        "the reason must name the missing secret: {:?}",
        status.bootstrap_error
    );
}

#[tokio::test]
async fn a_manual_identity_starts_without_any_gateway() {
    // The one supported start a bootstrap cannot authorise: a developer typed the
    // identity for a gateway that does not serve the endpoint.
    let dir = tempfile::tempdir().unwrap();
    let mut mgr = EasyTierManager::default();
    mgr.apply_settings(dir.path(), manual_settings(), true)
        .await;

    let status = mgr.status(None).await;
    assert_eq!(status.effective_mode, EasyTierEffectiveMode::NoTun);
    assert!(status.local_forward_port.unwrap_or(0) > 0);
    assert!(status.bootstrap_error.is_empty());
    assert_eq!(status.network_name, "minih-net-test");
}

#[tokio::test]
async fn no_tun_installs_the_host_link_forward_and_reports_it() {
    let dir = tempfile::tempdir().unwrap();
    let mut mgr = manager_with(announced());
    // A manual identity keeps the seeded answer in place: the forward is derived
    // from the answer, and this test is about the forward.
    let mut settings = manual_settings();
    settings.identity = EasyTierIdentity::Gateway;
    mgr.apply_settings(dir.path(), settings, true).await;

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
    // The identity in effect is the issued one, not the empty local secret.
    assert_eq!(status.network_name, "minih-net-test");
    assert_eq!(status.bootstrap_source, BootstrapSource::Gateway);
}

#[tokio::test]
async fn a_gateway_answer_meant_for_another_network_is_used_verbatim() {
    // The issued name and secret win over whatever the local row carries: the
    // gateway is authoritative about its own mesh.
    let dir = tempfile::tempdir().unwrap();
    let mut answer = bootstrap_answer(RemoteGatewayOutcome::Absent);
    answer.network_name = "issued-net".to_string();
    answer.network_secret = "issued-secret".to_string();
    let mut mgr = EasyTierManager {
        active_bootstrap: Some(answer),
        ..EasyTierManager::default()
    };
    mgr.apply_settings(dir.path(), gateway_settings(), true)
        .await;

    let resolved = mgr.resolved_settings();
    assert_eq!(resolved.network_name, "issued-net");
    assert_eq!(resolved.network_secret, "issued-secret");
    let status = mgr.status(None).await;
    assert_eq!(status.network_name, "issued-net");
}

#[tokio::test]
async fn without_an_announcement_the_mesh_is_unchanged() {
    let dir = tempfile::tempdir().unwrap();
    let mut mgr = manager_with(RemoteGatewayOutcome::Absent);
    mgr.apply_settings(dir.path(), gateway_settings(), true)
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
    mgr.apply_settings(dir.path(), gateway_settings(), true)
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
