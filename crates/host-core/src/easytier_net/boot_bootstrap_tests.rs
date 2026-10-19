//! Boot-time bootstrap: the desktop must learn the Gateway configuration at
//! startup, and in No-TUN mode it must ask through the forward that can
//! actually reach the Router.
//!
//! A stub Router on loopback answers `/api/easytier/bootstrap`; nothing here
//! touches a real Router, Gateway, or network.

use super::*;
use crate::easytier_net::remote_gateway::{RemoteGatewayAnnouncement, RemoteGatewayOutcome};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;

/// A Router stub that answers the bootstrap endpoint once per connection.
///
/// It records how many requests it served, so a test can tell "asked the
/// reachable address" from "never reached anything".
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
        "networkSecret": "Minih@placeholder-secret",
        "gatewayVirtualIpv4": "10.144.144.10",
        "peers": ["tcp://127.0.0.1:65530"],
    })
    .to_string()
}

fn stub_payload() -> String {
    serde_json::json!({
        "networkName": "minih-router",
        "networkSecret": "Minih@placeholder-secret",
        "gatewayVirtualIpv4": "10.144.144.10",
        "peers": ["tcp://127.0.0.1:65530"],
        "remoteGateway": {
            "hostlinkUrl": "wss://gateway.example.com:8443/hostlink",
            "publicOrigin": "https://gateway.example.com",
            "caPem": TEST_CA_PEM,
        },
    })
    .to_string()
}

const TEST_CA_PEM: &str = "-----BEGIN CERTIFICATE-----\n\
MIIBkTCB+wIJAJ8Y0V0n8m2fMA0GCSqGSIb3DQEBCwUAMB4xHDAaBgNVBAMME2dh\
dGV3YXkuZXhhbXBsZS5jb20=\n\
-----END CERTIFICATE-----\n";

/// Settings whose Router address is the stub, in the mode under test.
fn settings_against(base_url: &str, mode: EasyTierMode) -> EasyTierSettings {
    EasyTierSettings {
        enabled: true,
        mode,
        network_name: "minih-net-test".to_string(),
        network_secret: "Minih@9527".to_string(),
        peers: vec!["tcp://127.0.0.1:65530".to_string()],
        router_lan_url: base_url.to_string(),
        dhcp: true,
        ipv4: None,
    }
}

#[tokio::test]
async fn a_runtime_without_credentials_says_why_account_mode_is_off() {
    // The boot path used to hand the manager no credential source at all, and
    // the panel then reported `available: false` with an empty reason — a state
    // the user cannot act on.
    let dir = tempfile::tempdir().unwrap();
    let mut mgr = EasyTierManager::default();
    mgr.apply_settings(
        dir.path(),
        settings_against("http://127.0.0.1:1/v1", EasyTierMode::NoTun),
        true,
    )
    .await;
    let status = mgr.status(None).await;
    assert!(!status.remote_gateway.available);
    assert!(
        !status.remote_gateway.unavailable_reason.trim().is_empty(),
        "an unavailable account mode must explain itself"
    );
}

#[tokio::test]
async fn the_startup_apply_learns_the_gateway_configuration_in_no_tun_mode() {
    // Cold start, No-TUN: the Router's LAN address is not routable without the
    // tunnel, so the identity has to be fetched through the forward the tunnel
    // installs. The configured address here points at a closed port, so only a
    // request through that forward can succeed.
    let stub = RouterStub::start(stub_payload());
    let dir = tempfile::tempdir().unwrap();
    let mut mgr = EasyTierManager::default();
    let settings = settings_against(&stub.base_url, EasyTierMode::NoTun);
    // The address the Router row carries: unreachable in No-TUN mode.
    let unreachable = "http://127.0.0.1:1/v1".to_string();
    let provider = FakeProvider {
        base_url: unreachable,
        access_key: "sk_placeholder_account_key".to_string(),
    };

    mgr.apply_settings_with(dir.path(), settings, true, Some(&provider))
        .await;
    let status = mgr.status(None).await;
    assert_eq!(status.effective_mode, EasyTierEffectiveMode::NoTun);
    assert!(
        status.remote_gateway.available,
        "account mode must be usable after a plain start: {:?}",
        status.remote_gateway
    );
    assert!(
        stub.hits() > 0,
        "the bootstrap request never reached the reachable address"
    );
}

#[tokio::test]
async fn tun_mode_still_asks_the_configured_router_address() {
    // TUN routes the overlay address itself, so the configured LAN address is
    // the one to use and the forward must not be invented.
    let stub = RouterStub::start(stub_payload());
    let dir = tempfile::tempdir().unwrap();
    let mut mgr = EasyTierManager::default();
    let provider = FakeProvider {
        base_url: stub.base_url.clone(),
        access_key: "sk_placeholder_account_key".to_string(),
    };
    let settings = settings_against(&stub.base_url, EasyTierMode::Tun);
    mgr.apply_settings_with(dir.path(), settings, true, Some(&provider))
        .await;
    let status = mgr.status(None).await;
    assert!(stub.hits() > 0, "the configured address must be asked");
    assert!(
        status.remote_gateway.available || status.effective_mode == EasyTierEffectiveMode::NoTun,
        "either TUN is in effect, or it fell back to No-TUN: {:?}",
        status.effective_mode
    );
}

#[tokio::test]
async fn a_gateway_without_the_endpoint_is_asked_once() {
    // 404 is a supported configuration (the gateway has not shipped account
    // mode). The No-TUN retry must not repeat a question already answered.
    let stub = RouterStub::start_with_status(String::new(), 404);
    let dir = tempfile::tempdir().unwrap();
    let mut mgr = EasyTierManager::default();
    let provider = FakeProvider {
        base_url: "http://127.0.0.1:1/v1".to_string(),
        access_key: "sk_placeholder_account_key".to_string(),
    };
    let settings = settings_against(&stub.base_url, EasyTierMode::NoTun);
    mgr.apply_settings_with(dir.path(), settings, true, Some(&provider))
        .await;
    let status = mgr.status(None).await;
    assert!(!status.remote_gateway.available);
    assert!(
        !status.remote_gateway.unavailable_reason.trim().is_empty(),
        "even a gateway without the endpoint must leave a readable reason"
    );
    assert_eq!(stub.hits(), 1, "the retry must not repeat a 404");
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
        settings_against(&stub.base_url, EasyTierMode::NoTun),
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
}

#[tokio::test]
async fn a_tun_start_that_falls_back_still_says_it_needs_privileges() {
    // TUN without elevation runs as No-TUN. When the identity only arrives
    // through the forward, the restart must not swallow that explanation.
    if is_current_process_elevated() {
        // A privileged process really gets TUN; the notice does not apply.
        return;
    }
    let stub = RouterStub::start(stub_payload());
    let dir = tempfile::tempdir().unwrap();
    let mut mgr = EasyTierManager::default();
    let provider = FakeProvider {
        base_url: "http://127.0.0.1:1/v1".to_string(),
        access_key: "sk_placeholder_account_key".to_string(),
    };
    mgr.apply_settings_with(
        dir.path(),
        settings_against(&stub.base_url, EasyTierMode::Tun),
        true,
        Some(&provider),
    )
    .await;
    let status = mgr.status(None).await;
    assert!(
        status.remote_gateway.available,
        "the forward answered, so the identity is in effect"
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
}
