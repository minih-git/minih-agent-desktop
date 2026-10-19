//! Gateway-issued identity: the desktop must learn it before the tunnel starts,
//! hold when the gateway will not issue one, and re-read it when the Router row's
//! endpoint or key changes.
//!
//! A stub Router on loopback answers `/api/easytier/bootstrap`; nothing here
//! touches a real Router, Gateway, or network.

use super::*;
use crate::easytier_net::config::EasyTierIdentity;
use crate::easytier_net::remote_gateway::{RemoteGatewayAnnouncement, RemoteGatewayOutcome};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;

/// A Router stub that answers the bootstrap endpoint once per connection.
///
/// It records how many requests it served, so a test can tell "asked the
/// reachable address" from "never reached anything", and can count the refetches
/// an endpoint change causes.
struct RouterStub {
    base_url: String,
    port: u16,
    hits: Arc<AtomicUsize>,
    shutdown: Arc<AtomicBool>,
}

impl Drop for RouterStub {
    fn drop(&mut self) {
        self.shutdown.store(true, Ordering::Relaxed);
        // Unblock the accept loop so the thread can exit.
        let _ = std::net::TcpStream::connect(("127.0.0.1", self.port));
    }
}

impl RouterStub {
    fn start(payload: String) -> Self {
        Self::start_with_status(payload, 200)
    }

    fn start_with_status(payload: String, status: u16) -> Self {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind stub");
        let port = listener.local_addr().expect("stub addr").port();
        let hits = Arc::new(AtomicUsize::new(0));
        let shutdown = Arc::new(AtomicBool::new(false));
        let hits_for_thread = hits.clone();
        let shutdown_for_thread = shutdown.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                if shutdown_for_thread.load(Ordering::Relaxed) {
                    return;
                }
                let Ok(mut stream) = stream else { continue };
                let mut buffer = [0u8; 4096];
                let read = stream.read(&mut buffer).unwrap_or(0);
                let request = String::from_utf8_lossy(&buffer[..read]).to_string();
                if !request.contains("/api/easytier/bootstrap") {
                    let _ = stream.write_all(
                        b"HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: close\r\n\r\n",
                    );
                    continue;
                }
                hits_for_thread.fetch_add(1, Ordering::Relaxed);
                let response = if status == 200 {
                    format!(
                        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                        payload.len(),
                        payload
                    )
                } else {
                    format!(
                        "HTTP/1.1 {status} Error\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"
                    )
                };
                let _ = stream.write_all(response.as_bytes());
            }
        });
        Self {
            port,
            base_url: format!("http://127.0.0.1:{port}/v1"),
            hits,
            shutdown,
        }
    }

    fn hits(&self) -> usize {
        self.hits.load(Ordering::Relaxed)
    }
}

struct FakeProvider {
    base_url: String,
    access_key: String,
}

#[async_trait::async_trait]
impl BootstrapCredentialProvider for FakeProvider {
    async fn minih_router_credential(&self) -> Option<(String, String)> {
        Some((self.base_url.clone(), self.access_key.clone()))
    }
}

/// The same answer without a `remote_gateway` object: the Router simply does
/// not offer account mode (e.g. a self-hosted Router without a Gateway).
fn stub_payload_without_remote_gateway() -> String {
    serde_json::json!({
        "networkName": "minih-router",
        "networkSecret": "placeholder-secret",
        "gatewayVirtualIpv4": "10.144.144.10",
        "peers": ["tcp://127.0.0.1:65530"],
    })
    .to_string()
}

fn stub_payload_named(network_name: &str) -> String {
    serde_json::json!({
        "networkName": network_name,
        "networkSecret": "gateway-issued-secret",
        "gatewayVirtualIpv4": "10.144.144.10",
        "peers": ["tcp://127.0.0.1:65530"],
        // The gateway spells out its own control-plane URL; it wins over the
        // local `routerLanUrl` host, which is what R3 was about.
        "routerLanAccess": "http://11.11.11.10:3001",
        "remoteGateway": {
            "hostlinkUrl": "wss://gateway.example.com:8443/hostlink",
            "publicOrigin": "https://gateway.example.com",
            "caPem": TEST_CA_PEM,
        },
    })
    .to_string()
}

fn stub_payload() -> String {
    stub_payload_named("minih-router")
}

const TEST_CA_PEM: &str = "-----BEGIN CERTIFICATE-----\n\
MIIBkTCB+wIJAJ8Y0V0n8m2fMA0GCSqGSIb3DQEBCwUAMB4xHDAaBgNVBAMME2dh\
dGV3YXkuZXhhbXBsZS5jb20=\n\
-----END CERTIFICATE-----\n";

/// Settings whose Router row address is the stub, in the mode under test.
///
/// The LAN address points at a closed port: in No-TUN mode that address is only
/// reachable through the tunnel, which is exactly why the identity has to arrive
/// from the row's own (public) address instead.
fn settings_against(base_url: &str, mode: EasyTierMode) -> EasyTierSettings {
    EasyTierSettings {
        enabled: true,
        mode,
        identity: EasyTierIdentity::Gateway,
        network_name: "minih-net-test".to_string(),
        network_secret: String::new(),
        peers: vec!["tcp://127.0.0.1:65530".to_string()],
        router_lan_url: base_url.to_string(),
        dhcp: true,
        ipv4: None,
    }
}

const UNREACHABLE: &str = "http://127.0.0.1:1/v1";

#[tokio::test]
async fn a_runtime_without_credentials_says_why_the_channel_is_off() {
    // The boot path used to hand the manager no credential source at all, and
    // the panel then reported an empty state the user could not act on.
    let dir = tempfile::tempdir().unwrap();
    let mut mgr = EasyTierManager::default();
    mgr.apply_settings(
        dir.path(),
        settings_against(UNREACHABLE, EasyTierMode::NoTun),
        true,
    )
    .await;
    let status = mgr.status(None).await;
    assert!(!status.remote_gateway.available);
    assert!(
        !status.remote_gateway.unavailable_reason.trim().is_empty(),
        "an unavailable account mode must explain itself"
    );
    assert!(
        !status.bootstrap_error.trim().is_empty(),
        "a held channel must explain itself"
    );
    assert_eq!(status.effective_mode, EasyTierEffectiveMode::Disabled);
}

#[tokio::test]
async fn the_startup_apply_learns_the_gateway_identity_from_the_rows_own_address() {
    // Cold start, No-TUN: the Router row's address must be reachable on its own.
    // The tunnel is not up yet, so the LAN address cannot be the source of truth.
    let stub = RouterStub::start(stub_payload());
    let dir = tempfile::tempdir().unwrap();
    let mut mgr = EasyTierManager::default();
    let provider = FakeProvider {
        base_url: stub.base_url.clone(),
        access_key: "sk_placeholder_account_key".to_string(),
    };
    // The LAN address the row derives from: unreachable until the tunnel is up.
    let settings = settings_against(UNREACHABLE, EasyTierMode::NoTun);

    mgr.apply_settings_with(dir.path(), settings, true, Some(&provider))
        .await;
    let status = mgr.status(None).await;
    assert_eq!(status.effective_mode, EasyTierEffectiveMode::NoTun);
    assert_eq!(status.bootstrap_source, BootstrapSource::Gateway);
    assert_eq!(status.bootstrap_network_name, "minih-router");
    assert!(status.bootstrap_error.is_empty());
    assert!(
        stub.hits() > 0,
        "the bootstrap request never reached the Router row's address"
    );
    // The gateway's own control-plane spelling replaced the local host.
    assert_eq!(status.router_lan_url, "http://11.11.11.10:3001/v1");
    // Without a reachable LAN gateway the chat path stays on the public URL.
    let resolved = mgr
        .resolve_minih_router_endpoint(Some("https://router.hmini.org/v1"))
        .await;
    assert!(!resolved.using_lan);
    assert_eq!(resolved.active_base_url, "https://router.hmini.org/v1");
}

#[tokio::test]
async fn a_gateway_that_rejects_the_key_holds_with_a_reason() {
    let stub = RouterStub::start_with_status(String::new(), 401);
    let dir = tempfile::tempdir().unwrap();
    let mut mgr = EasyTierManager::default();
    let provider = FakeProvider {
        base_url: stub.base_url.clone(),
        access_key: "sk_rejected".to_string(),
    };
    mgr.apply_settings_with(
        dir.path(),
        settings_against(UNREACHABLE, EasyTierMode::NoTun),
        true,
        Some(&provider),
    )
    .await;

    let status = mgr.status(Some("https://router.hmini.org/v1")).await;
    assert!(stub.hits() > 0, "the key was never presented");
    assert_eq!(status.state, EasyTierConnectionState::Error);
    assert_eq!(status.effective_mode, EasyTierEffectiveMode::Disabled);
    assert!(status.local_forward_port.is_none(), "no tunnel may start");
    assert!(!status.using_lan);
    assert_eq!(status.active_router_base_url, "https://router.hmini.org/v1");
    assert!(
        status.bootstrap_error.contains("access key"),
        "the reason must name the rejected credential: {:?}",
        status.bootstrap_error
    );
}

#[tokio::test]
async fn a_gateway_without_the_endpoint_holds_and_is_asked_once() {
    // 404 is a supported configuration: a self-hosted gateway may never ship the
    // endpoint. Developer mode covers it with a manual identity; a normal install
    // holds instead of joining a brand mesh, and the question is not repeated.
    let stub = RouterStub::start_with_status(String::new(), 404);
    let dir = tempfile::tempdir().unwrap();
    let mut mgr = EasyTierManager::default();
    let provider = FakeProvider {
        base_url: stub.base_url.clone(),
        access_key: "sk_placeholder_account_key".to_string(),
    };
    mgr.apply_settings_with(
        dir.path(),
        settings_against(UNREACHABLE, EasyTierMode::NoTun),
        true,
        Some(&provider),
    )
    .await;

    let status = mgr.status(Some("https://router.hmini.org/v1")).await;
    assert_eq!(status.effective_mode, EasyTierEffectiveMode::Disabled);
    assert!(status.local_forward_port.is_none());
    assert_eq!(status.active_router_base_url, "https://router.hmini.org/v1");
    assert!(
        status.bootstrap_error.contains("does not serve"),
        "even a gateway without the endpoint must leave a readable reason: {:?}",
        status.bootstrap_error
    );
    assert_eq!(stub.hits(), 1, "the retry must not repeat a 404");
}

#[tokio::test]
async fn an_unreachable_gateway_holds_without_a_tunnel() {
    let dir = tempfile::tempdir().unwrap();
    let mut mgr = EasyTierManager::default();
    let provider = FakeProvider {
        base_url: UNREACHABLE.to_string(),
        access_key: "sk_placeholder_account_key".to_string(),
    };
    mgr.apply_settings_with(
        dir.path(),
        settings_against(UNREACHABLE, EasyTierMode::NoTun),
        true,
        Some(&provider),
    )
    .await;

    let status = mgr.status(Some("https://router.hmini.org/v1")).await;
    assert_eq!(status.state, EasyTierConnectionState::Error);
    assert!(status.local_forward_port.is_none());
    assert!(!status.using_lan);
    assert!(
        status.bootstrap_error.contains("bootstrap request failed"),
        "a transport failure must say so: {:?}",
        status.bootstrap_error
    );
}

#[tokio::test]
async fn tun_mode_asks_the_rows_own_address_before_starting() {
    // TUN routes the overlay address itself, but the identity still arrives from
    // the row's address first: the tunnel never comes up to fetch its own identity.
    let stub = RouterStub::start(stub_payload());
    let dir = tempfile::tempdir().unwrap();
    let mut mgr = EasyTierManager::default();
    let provider = FakeProvider {
        base_url: stub.base_url.clone(),
        access_key: "sk_placeholder_account_key".to_string(),
    };
    let settings = settings_against(stub.base_url.as_str(), EasyTierMode::Tun);
    mgr.apply_settings_with(dir.path(), settings, true, Some(&provider))
        .await;
    let status = mgr.status(None).await;
    assert!(stub.hits() > 0, "the row's address must be asked");
    assert!(
        status.remote_gateway.available || status.effective_mode == EasyTierEffectiveMode::NoTun,
        "either TUN is in effect, or it fell back to No-TUN: {:?}",
        status.effective_mode
    );
    assert_eq!(status.bootstrap_source, BootstrapSource::Gateway);
}

#[tokio::test]
async fn a_router_that_offers_no_account_mode_says_so() {
    // 200 with a network identity but no `remote_gateway`: account mode is off
    // because the Router does not provide it. The panel must say that instead of
    // showing an unavailable badge with nothing behind it.
    let stub = RouterStub::start(stub_payload_without_remote_gateway());
    let dir = tempfile::tempdir().unwrap();
    let mut mgr = EasyTierManager::default();
    let provider = FakeProvider {
        base_url: stub.base_url.clone(),
        access_key: "sk_placeholder_account_key".to_string(),
    };
    mgr.apply_settings_with(
        dir.path(),
        settings_against(stub.base_url.as_str(), EasyTierMode::NoTun),
        true,
        Some(&provider),
    )
    .await;
    let status = mgr.status(None).await;
    assert!(!status.remote_gateway.available);
    let reason = status.remote_gateway.unavailable_reason.trim();
    assert!(
        !reason.is_empty(),
        "a Router without account mode must explain it"
    );
    assert!(
        reason.to_lowercase().contains("does not offer"),
        "the reason must name the Router's answer: {reason}"
    );
    // The issued identity is still in effect: only account mode is missing.
    assert_eq!(status.bootstrap_source, BootstrapSource::Gateway);
    assert_eq!(status.effective_mode, EasyTierEffectiveMode::NoTun);
}

#[tokio::test]
async fn a_tun_start_that_falls_back_still_says_it_needs_privileges() {
    // TUN without elevation runs as No-TUN, and the notice must survive the
    // identity arriving first.
    if is_current_process_elevated() {
        // A privileged process really gets TUN; the notice does not apply.
        return;
    }
    let stub = RouterStub::start(stub_payload());
    let dir = tempfile::tempdir().unwrap();
    let mut mgr = EasyTierManager::default();
    let provider = FakeProvider {
        base_url: stub.base_url.clone(),
        access_key: "sk_placeholder_account_key".to_string(),
    };
    mgr.apply_settings_with(
        dir.path(),
        settings_against(stub.base_url.as_str(), EasyTierMode::Tun),
        true,
        Some(&provider),
    )
    .await;
    let status = mgr.status(None).await;
    assert!(
        status.remote_gateway.available,
        "the gateway answered, so the identity is in effect"
    );
    assert!(
        status.effective_mode == EasyTierEffectiveMode::NoTun,
        "without elevation the channel runs No-TUN"
    );
    let last_error = status.last_error.unwrap_or_default();
    assert!(
        last_error.contains("administrator privileges"),
        "a TUN fallback must still say why it is running No-TUN: {last_error:?}"
    );
}

#[tokio::test]
async fn switching_the_endpoint_refetches_the_identity_once() {
    // R1 + R2: the same AccessKey against a different gateway must not reuse the
    // previous answer, and one credential change must cost one request.
    let first = RouterStub::start(stub_payload_named("gateway-a-net"));
    let second = RouterStub::start(stub_payload_named("gateway-b-net"));
    let dir = tempfile::tempdir().unwrap();
    let mut mgr = EasyTierManager::default();
    let settings = settings_against(UNREACHABLE, EasyTierMode::NoTun);

    let provider_a = FakeProvider {
        base_url: first.base_url.clone(),
        access_key: "sk_same_key".to_string(),
    };
    mgr.apply_settings_with(dir.path(), settings.clone(), true, Some(&provider_a))
        .await;
    assert_eq!(
        mgr.status(None).await.bootstrap_network_name,
        "gateway-a-net"
    );
    assert_eq!(first.hits(), 1);

    // The endpoint changed: force a fresh answer from the new gateway.
    let provider_b = FakeProvider {
        base_url: second.base_url.clone(),
        access_key: "sk_same_key".to_string(),
    };
    mgr.refresh_identity_with(dir.path(), settings, Some(&provider_b))
        .await;
    assert_eq!(
        mgr.status(None).await.bootstrap_network_name,
        "gateway-b-net"
    );
    assert_eq!(second.hits(), 1, "the new gateway is asked exactly once");
    assert_eq!(first.hits(), 1, "the old gateway must not be asked again");
}

#[tokio::test]
async fn a_cached_answer_is_reused_until_the_identity_is_refreshed() {
    let stub = RouterStub::start(stub_payload_named("gateway-a-net"));
    let dir = tempfile::tempdir().unwrap();
    let mut mgr = EasyTierManager::default();
    let settings = settings_against(UNREACHABLE, EasyTierMode::NoTun);
    let provider = FakeProvider {
        base_url: stub.base_url.clone(),
        access_key: "sk_same_key".to_string(),
    };

    mgr.apply_settings_with(dir.path(), settings.clone(), true, Some(&provider))
        .await;
    // A forced restart at the same endpoint and key reuses the cached answer.
    mgr.apply_settings_with(dir.path(), settings.clone(), true, Some(&provider))
        .await;
    assert_eq!(stub.hits(), 1, "the cached answer must not be refetched");

    // A credential change does refetch — exactly once.
    mgr.refresh_identity_with(dir.path(), settings, Some(&provider))
        .await;
    assert_eq!(stub.hits(), 2);
}

#[tokio::test]
async fn a_manual_identity_refuses_to_start_without_a_secret() {
    let dir = tempfile::tempdir().unwrap();
    let mut mgr = EasyTierManager::default();
    let mut settings = settings_against(UNREACHABLE, EasyTierMode::NoTun);
    settings.identity = EasyTierIdentity::Manual;
    settings.network_secret = "   ".to_string();
    let provider = FakeProvider {
        base_url: UNREACHABLE.to_string(),
        access_key: "sk_placeholder_account_key".to_string(),
    };
    mgr.apply_settings_with(dir.path(), settings, true, Some(&provider))
        .await;

    let status = mgr.status(None).await;
    assert_eq!(status.identity, EasyTierIdentity::Manual);
    assert!(status.local_forward_port.is_none());
    assert!(status.bootstrap_error.contains("network secret"));
    // A manual identity does not ask the gateway at all.
    assert_eq!(status.bootstrap_source, BootstrapSource::Local);
}

#[test]
fn an_announcement_is_still_parsed_from_the_stub_payload() {
    // Guard against the stub drifting away from the real payload shape.
    let payload: serde_json::Value = serde_json::from_str(&stub_payload()).unwrap();
    let parsed = crate::easytier_net::bootstrap::parse_bootstrap_payload(&payload).unwrap();
    assert!(matches!(
        parsed.remote_gateway,
        RemoteGatewayOutcome::Announced(_)
    ));
    let RemoteGatewayOutcome::Announced(RemoteGatewayAnnouncement { hostlink_url, .. }) =
        parsed.remote_gateway
    else {
        unreachable!()
    };
    assert_eq!(hostlink_url, "wss://gateway.example.com:8443/hostlink");
    assert_eq!(
        parsed.router_lan_url.as_deref(),
        Some("http://11.11.11.10:3001/v1")
    );
}
