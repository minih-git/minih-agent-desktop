//! Server-issued EasyTier network identity.
//!
//! The network name and secret are the shared key that both encrypts the tunnel
//! and scopes who may join it. Shipping a default pair in source means anyone
//! who reads the repository can join the network and read its traffic, so the
//! gateway issues a per-key pair instead and this module fetches it.
//!
//! Precedence, highest first:
//!
//! 1. the bootstrap response for the row's AccessKey,
//! 2. what the user typed in Settings,
//! 3. the built-in defaults.
//!
//! Every failure path falls back down that chain rather than surfacing an error,
//! because a gateway that does not serve the endpoint yet must keep working on
//! the public URL. The response is cached under a digest of the AccessKey — the
//! key itself is never retained — so a rotated key misses and a stolen cache
//! cannot be replayed against another account.

use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::config::{
    parse_router_lan_target, EasyTierSettings, DEFAULT_EASYTIER_NETWORK_NAME,
    DEFAULT_EASYTIER_NETWORK_SECRET, DEFAULT_EASYTIER_PEERS,
};

/// Ceiling on how long a response may ask to be trusted for. A gateway that
/// asks for longer keeps a compromised key valid longer than necessary.
const MAX_TTL: Duration = Duration::from_secs(7 * 24 * 60 * 60);
/// Floor, so a broken `ttlSeconds` cannot turn every request into a fetch.
const MIN_TTL: Duration = Duration::from_secs(60);
/// Used when the response omits `ttlSeconds`.
const DEFAULT_TTL: Duration = Duration::from_secs(6 * 60 * 60);
/// Connect plus read budget. This runs on the resolve path, so it must stay
/// well under the request timeout the caller already paid for.
const FETCH_TIMEOUT: Duration = Duration::from_secs(5);
/// Bound on each string, so a hostile or broken gateway cannot exhaust memory.
const MAX_FIELD_LEN: usize = 256;
/// Bound on the peer list, matching the local validator.
const MAX_PEERS: usize = 32;

/// What the gateway answered, after validation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapResponse {
    pub network_name: String,
    pub network_secret: String,
    /// Virtual address the gateway holds on the tunnel, e.g. `10.144.144.10`.
    pub gateway_virtual_ipv4: Option<String>,
    /// Bootstrap peers to dial; absent keeps the locally configured list.
    pub peers: Option<Vec<String>>,
    /// How long the caller may reuse this answer.
    pub ttl_seconds: Option<u64>,
}

/// A validated response plus when it stops being trustworthy.
#[derive(Debug, Clone)]
pub struct CachedBootstrap {
    pub response: BootstrapResponse,
    pub fetched_at: Instant,
    pub ttl: Duration,
}

impl CachedBootstrap {
    fn is_fresh(&self, now: Instant) -> bool {
        now.saturating_duration_since(self.fetched_at) < self.ttl
    }
}

/// One cached answer per AccessKey digest, so rotating a key naturally misses
/// and the cache never holds the key material itself.
#[derive(Debug, Default)]
pub struct BootstrapCache {
    entries: Vec<(String, CachedBootstrap)>,
}

impl BootstrapCache {
    pub fn get(&self, key_digest: &str, now: Instant) -> Option<&BootstrapResponse> {
        self.entries
            .iter()
            .find(|(digest, cached)| digest == key_digest && cached.is_fresh(now))
            .map(|(_, cached)| &cached.response)
    }

    pub fn insert(&mut self, key_digest: String, response: BootstrapResponse, now: Instant) {
        let ttl = response
            .ttl_seconds
            .map(Duration::from_secs)
            .unwrap_or(DEFAULT_TTL)
            .clamp(MIN_TTL, MAX_TTL);
        self.entries.retain(|(digest, _)| digest != &key_digest);
        self.entries.push((
            key_digest,
            CachedBootstrap {
                response,
                fetched_at: now,
                ttl,
            },
        ));
        // One entry per configured Router row is the realistic ceiling; anything
        // past that is a leak from rows the user deleted.
        const MAX_ENTRIES: usize = 8;
        if self.entries.len() > MAX_ENTRIES {
            let excess = self.entries.len() - MAX_ENTRIES;
            self.entries.drain(0..excess);
        }
    }
}

/// Digest of the AccessKey. Used only as a cache key, never persisted or logged.
pub fn access_key_digest(access_key: &str) -> String {
    let digest = Sha256::digest(access_key.as_bytes());
    let mut hex = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(hex, "{byte:02x}");
    }
    hex
}

/// Why a bootstrap fetch did not produce an answer.
///
/// The message is safe to surface: it names the transport failure or the
/// gateway's own status, and never carries the key or the secret.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BootstrapError {
    /// No Minih Router row, or that row has no AccessKey.
    NoAccessKey,
    /// The gateway does not serve the endpoint yet (or the route moved).
    EndpointUnavailable,
    /// Transport failure: DNS, TLS, connect, timeout.
    Transport(String),
    /// The gateway answered, but the payload was unusable.
    InvalidPayload(String),
}

impl std::fmt::Display for BootstrapError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NoAccessKey => {
                write!(
                    f,
                    "no Minih Router access key to request a network identity"
                )
            }
            Self::EndpointUnavailable => write!(f, "gateway does not serve the bootstrap endpoint"),
            Self::Transport(detail) => write!(f, "bootstrap request failed: {detail}"),
            Self::InvalidPayload(detail) => write!(f, "bootstrap response was unusable: {detail}"),
        }
    }
}

/// Validate and normalize a decoded payload.
///
/// A missing field falls back to the local configuration rather than failing the
/// whole response, so a gateway that only rotates the secret still works. A
/// present-but-malformed field does fail, because silently ignoring it would
/// leave the node on a network the gateway does not expect.
pub fn parse_bootstrap_payload(payload: &serde_json::Value) -> Result<BootstrapResponse, String> {
    let root_obj = payload
        .as_object()
        .ok_or_else(|| "payload must be an object".to_string())?;

    // Unwrap Minih-Router's standard `{ code: 0, message: "...", data: { ... } }`
    // envelope when present, while continuing to accept bare objects.
    let obj = if let Some(code_val) = root_obj.get("code") {
        let code = code_val
            .as_i64()
            .ok_or_else(|| "envelope code must be an integer".to_string())?;
        if code != 0 {
            let msg = root_obj
                .get("message")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("non-zero gateway code");
            return Err(format!("gateway returned error code {code}: {msg}"));
        }
        root_obj
            .get("data")
            .and_then(serde_json::Value::as_object)
            .ok_or_else(|| "envelope data must be an object".to_string())?
    } else if let Some(data_obj) = root_obj.get("data").and_then(serde_json::Value::as_object) {
        data_obj
    } else {
        root_obj
    };

    if obj.get("available").and_then(serde_json::Value::as_bool) == Some(false) {
        return Err("gateway EasyTier instance is not available".to_string());
    }

    let network_name = required_string_any(obj, &["networkName", "network_name"])?;
    let raw_network_secret = required_string_any(obj, &["networkSecret", "network_secret"])?;

    let secure_mode = obj
        .get("secureMode")
        .or_else(|| obj.get("secure_mode"))
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    let shared_network_secret = obj
        .get("sharedNetworkSecret")
        .or_else(|| obj.get("shared_network_secret"))
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty() && s.len() <= MAX_FIELD_LEN)
        .map(ToString::to_string);

    // When the gateway instance is running in classic shared-secret mode
    // (`secure_mode == false`), `NetworkIdentity::new` requires the shared
    // network secret so the handshake digest matches the mesh.
    let network_secret = match (secure_mode, shared_network_secret) {
        (false, Some(shared)) => shared,
        _ => raw_network_secret,
    };

    let gateway_virtual_ipv4 = match obj
        .get("gatewayVirtualIpv4")
        .or_else(|| obj.get("gateway_virtual_ipv4"))
    {
        None | Some(serde_json::Value::Null) => None,
        Some(value) => {
            let raw = value
                .as_str()
                .ok_or_else(|| "gatewayVirtualIpv4 must be a string".to_string())?;
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                None
            } else if is_ipv4(trimmed) {
                Some(trimmed.to_string())
            } else {
                return Err(format!(
                    "gatewayVirtualIpv4 is not an IPv4 address: {trimmed}"
                ));
            }
        }
    };

    let peers = match obj.get("peers") {
        None | Some(serde_json::Value::Null) => None,
        Some(serde_json::Value::Array(items)) => {
            let mut parsed = Vec::with_capacity(items.len());
            for item in items {
                let raw = item
                    .as_str()
                    .ok_or_else(|| "peers entries must be strings".to_string())?;
                let trimmed = raw.trim();
                if trimmed.is_empty() {
                    continue;
                }
                if !is_peer_url(trimmed) {
                    return Err(format!("invalid peer URL: {trimmed}"));
                }
                parsed.push(trimmed.to_string());
            }
            if parsed.len() > MAX_PEERS {
                return Err(format!("peers must not exceed {MAX_PEERS} entries"));
            }
            // An empty list is not "no opinion" — it would dial nothing. Treat it
            // as absent so the locally configured peers survive.
            (!parsed.is_empty()).then_some(parsed)
        }
        Some(_) => return Err("peers must be an array".into()),
    };

    let ttl_seconds = match obj.get("ttlSeconds").or_else(|| obj.get("ttl_seconds")) {
        None | Some(serde_json::Value::Null) => None,
        Some(value) => {
            let raw = value
                .as_u64()
                .ok_or_else(|| "ttlSeconds must be a non-negative integer".to_string())?;
            Some(raw)
        }
    };

    Ok(BootstrapResponse {
        network_name,
        network_secret,
        gateway_virtual_ipv4,
        peers,
        ttl_seconds,
    })
}

fn required_string_any(
    obj: &serde_json::Map<String, serde_json::Value>,
    fields: &[&str],
) -> Result<String, String> {
    let primary = fields.first().copied().unwrap_or("field");
    let value = fields.iter().find_map(|field| obj.get(*field));
    let raw = value
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| format!("{primary} must be a string"))?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(format!("{primary} must not be empty"));
    }
    if trimmed.len() > MAX_FIELD_LEN {
        return Err(format!(
            "{primary} must not exceed {MAX_FIELD_LEN} characters"
        ));
    }
    Ok(trimmed.to_string())
}

fn is_ipv4(raw: &str) -> bool {
    let without_mask = raw.strip_suffix("/32").unwrap_or(raw);
    let octets: Vec<&str> = without_mask.split('.').collect();
    if octets.len() != 4 {
        return false;
    }
    octets.iter().all(|octet| octet.parse::<u8>().is_ok())
}

fn is_peer_url(raw: &str) -> bool {
    let Ok(parsed) = url::Url::parse(raw) else {
        return false;
    };
    if !matches!(parsed.scheme(), "tcp" | "udp" | "ws" | "wss") {
        return false;
    }
    parsed.host_str().is_some_and(|host| !host.is_empty()) && parsed.port().is_some()
}

/// Overlay a bootstrap answer onto the local settings.
///
/// Only fields the gateway actually answered are replaced, so a partial
/// response upgrades the secret while leaving the user's peers and gateway
/// address alone. The overlay never re-enables a channel the user switched off.
pub fn apply_bootstrap(settings: &mut EasyTierSettings, response: &BootstrapResponse) {
    settings.network_name = response.network_name.clone();
    settings.network_secret = response.network_secret.clone();
    if let Some(gateway) = &response.gateway_virtual_ipv4 {
        if let Ok(target) = parse_router_lan_target(&settings.router_lan_url) {
            // Keep the user's scheme, port and API path; only the host moves,
            // because that is the one thing the gateway is authoritative about.
            let port_suffix = match (target.scheme.as_str(), target.port) {
                ("http", 80) | ("https", 443) => String::new(),
                _ => format!(":{}", target.port),
            };
            settings.router_lan_url = format!(
                "{}://{}{}{}",
                target.scheme, gateway, port_suffix, target.api_path
            );
        }
    }
    if let Some(peers) = &response.peers {
        settings.peers = peers.clone();
    }
}

/// The local settings with the bootstrap chain resolved.
///
/// Used when no bootstrap is available, so the built-in defaults still apply.
pub fn defaults_overlay(settings: &mut EasyTierSettings) {
    if settings.network_name.trim().is_empty() {
        settings.network_name = DEFAULT_EASYTIER_NETWORK_NAME.to_string();
    }
    if settings.network_secret.trim().is_empty() {
        settings.network_secret = DEFAULT_EASYTIER_NETWORK_SECRET.to_string();
    }
    if settings.peers.is_empty() {
        settings.peers = DEFAULT_EASYTIER_PEERS
            .iter()
            .map(|p| (*p).to_string())
            .collect();
    }
}

/// Where the network identity in effect came from, for display and diagnosis.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BootstrapSource {
    /// The gateway answered and its values are in effect.
    Gateway,
    /// The gateway was not reachable or served nothing usable.
    Local,
    /// The channel is off, so nothing was requested.
    Disabled,
}

/// Fetch the bootstrap answer for one AccessKey.
///
/// `client` is shared so the TLS session pool survives across calls; building a
/// client per request would pay a handshake on every resolve.
pub async fn fetch_bootstrap(
    client: &reqwest::Client,
    base_url: &str,
    access_key: &str,
) -> Result<BootstrapResponse, BootstrapError> {
    let target = parse_router_lan_target(base_url).map_err(|_| BootstrapError::NoAccessKey)?;
    let root = format!(
        "{}://{}{}",
        target.scheme,
        host_for_url(&target.host),
        port_suffix(target.scheme.as_str(), target.port)
    );
    let url = format!("{root}/api/easytier/bootstrap");

    let response = client
        .get(&url)
        .bearer_auth(access_key)
        .timeout(FETCH_TIMEOUT)
        .send()
        .await
        .map_err(|error| BootstrapError::Transport(redact(error)))?;

    // 404 is the expected answer from a gateway that has not shipped the
    // endpoint yet; it is a supported configuration, not a failure.
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Err(BootstrapError::EndpointUnavailable);
    }
    if response.status() == reqwest::StatusCode::UNAUTHORIZED
        || response.status() == reqwest::StatusCode::FORBIDDEN
    {
        return Err(BootstrapError::NoAccessKey);
    }
    if !response.status().is_success() {
        return Err(BootstrapError::Transport(format!(
            "gateway returned HTTP {}",
            response.status().as_u16()
        )));
    }

    let payload: serde_json::Value = response
        .json()
        .await
        .map_err(|error| BootstrapError::InvalidPayload(redact(error)))?;
    parse_bootstrap_payload(&payload)
        .map_err(BootstrapError::InvalidPayload)
        .and_then(validate_brand_expectation)
}

/// A hungraim build must never join a foreign (e.g. minih) mesh: the gateway
/// answer must name the hungraim network, otherwise the response is unusable
/// and the caller falls back to local settings rather than the wrong network.
fn validate_brand_expectation(
    response: BootstrapResponse,
) -> Result<BootstrapResponse, BootstrapError> {
    if option_env!("DESKTOP_BRAND") == Some("hungraim")
        && response.network_name != "hungraim-router"
    {
        return Err(BootstrapError::InvalidPayload(
            "gateway network identity does not match the hungraim brand".to_string(),
        ));
    }
    Ok(response)
}

/// A host that needs brackets in a URL gets them; one that does not is untouched.
fn host_for_url(host: &str) -> String {
    if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]")
    } else {
        host.to_string()
    }
}

fn port_suffix(scheme: &str, port: u16) -> String {
    match (scheme, port) {
        ("http", 80) | ("https", 443) => String::new(),
        _ => format!(":{port}"),
    }
}

/// Strip anything that could carry the key out of a transport error.
///
/// `reqwest` echoes the request URL, which holds no key, but a proxy or DNS
/// error can surface the host and a redirect chain can carry a query string.
/// Keeping only the error's own text is the cheapest defense that still
/// diagnoses the failure.
fn redact(error: reqwest::Error) -> String {
    let text = error.to_string();
    // reqwest's Display never includes the Authorization header, so the text is
    // already safe. Bound it anyway so a verbose chain cannot flood a log line.
    text.chars().take(200).collect()
}

/// Shared HTTP client for bootstrap and LAN reachability probes.
pub fn bootstrap_client() -> reqwest::Client {
    reqwest::Client::builder()
        .no_proxy()
        .timeout(FETCH_TIMEOUT)
        .connect_timeout(FETCH_TIMEOUT)
        .build()
        .unwrap_or_default()
}

/// Keeps a client alive without cloning it on every call.
pub type SharedClient = Arc<reqwest::Client>;

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn base_settings() -> EasyTierSettings {
        EasyTierSettings {
            enabled: true,
            mode: super::super::config::EasyTierMode::NoTun,
            network_name: "local-net".into(),
            network_secret: "local-secret".into(),
            peers: vec!["udp://local:11010".into()],
            router_lan_url: "http://10.144.144.99:3001/v1".into(),
            dhcp: true,
            ipv4: None,
        }
    }

    #[test]
    fn digest_is_stable_and_key_free() {
        let a = access_key_digest("sk-test");
        let b = access_key_digest("sk-test");
        assert_eq!(a, b);
        assert_ne!(a, access_key_digest("sk-other"));
        // The digest must not contain the key, or a stolen cache is a stolen key.
        assert!(!a.contains("sk-test"));
    }

    #[test]
    fn ttl_is_clamped_to_a_sane_window() {
        let now = Instant::now();
        let mut cache = BootstrapCache::default();
        let response = BootstrapResponse {
            network_name: "n".into(),
            network_secret: "s".into(),
            gateway_virtual_ipv4: None,
            peers: None,
            ttl_seconds: Some(0),
        };
        cache.insert(access_key_digest("k"), response.clone(), now);
        // Zero must not disable caching entirely.
        assert!(cache.get(&access_key_digest("k"), now).is_some());

        let absurd = BootstrapResponse {
            network_name: response.network_name,
            network_secret: response.network_secret,
            gateway_virtual_ipv4: None,
            peers: None,
            ttl_seconds: Some(u64::MAX),
        };
        cache.insert(access_key_digest("k2"), absurd, now);
        // A year-long trust window is refused; the entry is still usable now.
        assert!(cache.get(&access_key_digest("k2"), now).is_some());
    }

    #[test]
    fn expired_entries_are_not_served() {
        let past = Instant::now() - Duration::from_secs(3600);
        let mut cache = BootstrapCache::default();
        cache.insert(
            access_key_digest("k"),
            BootstrapResponse {
                network_name: "n".into(),
                network_secret: "s".into(),
                gateway_virtual_ipv4: None,
                peers: None,
                ttl_seconds: Some(60),
            },
            past,
        );
        assert!(cache.get(&access_key_digest("k"), Instant::now()).is_none());
    }

    #[test]
    fn a_rotated_key_misses_the_cache() {
        let now = Instant::now();
        let mut cache = BootstrapCache::default();
        cache.insert(
            access_key_digest("old"),
            BootstrapResponse {
                network_name: "n".into(),
                network_secret: "s".into(),
                gateway_virtual_ipv4: None,
                peers: None,
                ttl_seconds: None,
            },
            now,
        );
        assert!(cache.get(&access_key_digest("new"), now).is_none());
    }

    #[test]
    fn payload_requires_name_and_secret() {
        assert!(parse_bootstrap_payload(&json!({})).is_err());
        assert!(parse_bootstrap_payload(&json!({"networkName": "n"})).is_err());
        assert!(
            parse_bootstrap_payload(&json!({"networkName": "", "networkSecret": "s"})).is_err()
        );
    }

    #[test]
    fn payload_rejects_malformed_optional_fields() {
        assert!(parse_bootstrap_payload(&json!({
            "networkName": "n",
            "networkSecret": "s",
            "gatewayVirtualIpv4": "not-an-ip"
        }))
        .is_err());
        assert!(parse_bootstrap_payload(&json!({
            "networkName": "n",
            "networkSecret": "s",
            "peers": ["ftp://bad:1"]
        }))
        .is_err());
        assert!(parse_bootstrap_payload(&json!({
            "networkName": "n",
            "networkSecret": "s",
            "ttlSeconds": -1
        }))
        .is_err());
    }

    #[test]
    fn payload_accepts_a_minimal_answer() {
        let parsed = parse_bootstrap_payload(&json!({
            "networkName": "minih-net-abc",
            "networkSecret": "rotated-secret"
        }))
        .expect("a name and a secret are enough");
        assert_eq!(parsed.network_name, "minih-net-abc");
        assert_eq!(parsed.network_secret, "rotated-secret");
        assert_eq!(parsed.gateway_virtual_ipv4, None);
        assert_eq!(parsed.peers, None);
        assert_eq!(parsed.ttl_seconds, None);
    }

    #[test]
    fn overlay_replaces_identity_and_keeps_the_users_transport() {
        let mut settings = base_settings();
        apply_bootstrap(
            &mut settings,
            &BootstrapResponse {
                network_name: "minih-net-abc".into(),
                network_secret: "rotated".into(),
                gateway_virtual_ipv4: Some("10.144.144.10".into()),
                peers: Some(vec!["udp://tier.hmini.org:11010".into()]),
                ttl_seconds: None,
            },
        );
        assert_eq!(settings.network_name, "minih-net-abc");
        assert_eq!(settings.network_secret, "rotated");
        assert_eq!(
            settings.peers,
            vec!["udp://tier.hmini.org:11010".to_string()]
        );
        // Only the host moved: the port and API path the user configured survive.
        assert_eq!(settings.router_lan_url, "http://10.144.144.10:3001/v1");
    }

    #[test]
    fn overlay_leaves_local_values_when_the_gateway_is_silent() {
        let mut settings = base_settings();
        apply_bootstrap(
            &mut settings,
            &BootstrapResponse {
                network_name: "minih-net-abc".into(),
                network_secret: "rotated".into(),
                gateway_virtual_ipv4: None,
                peers: None,
                ttl_seconds: None,
            },
        );
        assert_eq!(settings.router_lan_url, "http://10.144.144.99:3001/v1");
        assert_eq!(settings.peers, vec!["udp://local:11010".to_string()]);
    }

    #[test]
    fn defaults_fill_only_what_is_missing() {
        let mut settings = base_settings();
        settings.network_name = String::new();
        settings.peers = Vec::new();
        defaults_overlay(&mut settings);
        assert_eq!(settings.network_name, DEFAULT_EASYTIER_NETWORK_NAME);
        assert_eq!(settings.peers, DEFAULT_EASYTIER_PEERS);
        // A secret the user set is never replaced by the built-in one.
        assert_eq!(settings.network_secret, "local-secret");
    }

    #[test]
    fn gateway_host_with_a_port_keeps_it() {
        assert_eq!(host_for_url("tier.hmini.org"), "tier.hmini.org");
        assert_eq!(host_for_url("2001:db8::1"), "[2001:db8::1]");
        assert_eq!(port_suffix("https", 443), "");
        assert_eq!(port_suffix("https", 8443), ":8443");
    }

    #[test]
    fn payload_accepts_minih_router_snake_case_envelope() {
        let parsed = parse_bootstrap_payload(&json!({
            "code": 0,
            "message": "操作成功",
            "data": {
                "available": true,
                "network_name": "minih-net",
                "network_secret": "per-caller-credential",
                "shared_network_secret": "Minih@9527",
                "secure_mode": false,
                "gateway_virtual_ipv4": "11.11.11.10",
                "peers": [
                    "tcp://router.hmini.org:11010",
                    "udp://router.hmini.org:11010"
                ],
                "ttl_seconds": 86400,
                "router_lan_access": "http://11.11.11.10:3001"
            }
        }))
        .expect("Minih-Router envelope should parse cleanly");
        assert_eq!(parsed.network_name, "minih-net");
        assert_eq!(parsed.network_secret, "Minih@9527");
        assert_eq!(parsed.gateway_virtual_ipv4.as_deref(), Some("11.11.11.10"));
        assert_eq!(
            parsed.peers,
            Some(vec![
                "tcp://router.hmini.org:11010".to_string(),
                "udp://router.hmini.org:11010".to_string()
            ])
        );
        assert_eq!(parsed.ttl_seconds, Some(86400));

        assert!(parse_bootstrap_payload(&json!({
            "code": 0,
            "data": {
                "available": false,
                "network_name": "minih-net",
                "network_secret": "s"
            }
        }))
        .is_err());
    }
}
