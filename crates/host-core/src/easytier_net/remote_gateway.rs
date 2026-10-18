//! The remote-control Gateway a Router advertises in its bootstrap answer.
//!
//! Account mode (ADR `remote-control-router-account-binding`, decision D666) is
//! an additive part of the same bootstrap answer that already carries the
//! network identity: an optional `remote_gateway { hostlink_url,
//! public_origin, ca_pem }` object. It is the endpoint the desktop enrolls
//! with and later dials for the Host link, and it is deliberately NOT part of
//! the mesh identity: a Router that does not ship it, or that ships something
//! this module cannot use, must leave the tunnel exactly as it is today.
//!
//! That is why a malformed object never fails the bootstrap: the network fields
//! of the same answer stay authoritative, and account mode simply reports
//! itself unavailable with a reason. The one thing this module refuses to carry
//! is anything that is not a certificate — a PEM holding a private key would be
//! cached, logged, and handed to the panel.
//!
//! Reachability rule (spec 12, "Second overlay forward for the Host link"): the
//! Gateway runs on the Router's overlay node, so the destination is either the
//! IP literal the Router already named in `hostlink_url` or, when that name is
//! a domain, the `gatewayVirtualIpv4` of the same bootstrap answer. Nothing here
//! knows a subnet: `11.12.0.1` is the minih brand's gateway address, not a
//! constant, and a hungraim deployment lives on `11.123.0.0/24`.
//!
//! TLS validation always uses the host named in `hostlink_url`, never the
//! loopback forward that carries the bytes (security §5.1: certificate
//! validation includes the service identity).

use std::net::{IpAddr, SocketAddr};

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use url::Url;

/// Bound on the `wss://` endpoint, matching the Router's own server-side cap.
pub const MAX_HOSTLINK_URL_LEN: usize = 512;
/// Bound on the HTTPS origin, matching the Router's own server-side cap.
pub const MAX_PUBLIC_ORIGIN_LEN: usize = 512;
/// Bound on the CA bundle, matching the Router's own server-side cap.
pub const MAX_CA_PEM_LEN: usize = 16 * 1024;

/// The endpoint a Router advertised, after validation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteGatewayAnnouncement {
    /// `wss://` Host-link endpoint the desktop dials with mutual TLS.
    pub hostlink_url: String,
    /// HTTPS origin the phone or browser uses for the client API.
    pub public_origin: String,
    /// The Gateway CA the desktop pins.
    pub ca_pem: String,
}

/// What the bootstrap answer said about account mode.
///
/// A malformed object is a value, not an error: the network identity in the
/// same answer stays authoritative, and account mode reports itself
/// unavailable with a reason the panel can show.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RemoteGatewayOutcome {
    /// The Router does not offer account mode.
    Absent,
    /// The Router offered a usable endpoint.
    Announced(RemoteGatewayAnnouncement),
    /// The Router offered something unusable; the string explains why.
    Malformed(String),
}

impl RemoteGatewayOutcome {
    /// The announcement, when there is one.
    pub fn announcement(&self) -> Option<&RemoteGatewayAnnouncement> {
        match self {
            Self::Announced(announcement) => Some(announcement),
            _ => None,
        }
    }

    /// Why account mode is unavailable, empty when the Router said nothing.
    pub fn reason(&self) -> &str {
        match self {
            Self::Malformed(reason) => reason.as_str(),
            _ => "",
        }
    }
}

/// Where the Host link can actually be dialled from this machine.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostlinkTarget {
    /// Overlay address of the Gateway: the IP in `hostlink_url`, or the
    /// Router's overlay address when the URL names a domain.
    pub dst: SocketAddr,
    /// Host name the TLS client must validate the certificate against.
    pub tls_server_name: String,
    /// Path of the Host-link endpoint, always starting with `/`.
    pub path: String,
}

/// Account mode as the panel and the Host-link client see it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteGatewayStatus {
    /// True only when the endpoint was advertised AND is reachable from here.
    pub available: bool,
    /// The advertised `wss://` endpoint, empty when none was advertised.
    pub hostlink_url: String,
    /// The advertised HTTPS origin, empty when none was advertised.
    pub public_origin: String,
    /// The advertised CA certificate, empty when none was advertised.
    pub ca_pem: String,
    /// Address the Host-link client should dial: the loopback forward in
    /// No-TUN mode, the overlay address in TUN mode, empty when unavailable.
    pub dial_url: String,
    /// Service identity for certificate validation, always the name in
    /// `hostlink_url`; empty when the Router advertised nothing.
    pub tls_server_name: String,
    /// Loopback port of the overlay forward, set only in No-TUN mode.
    pub local_forward_port: Option<u16>,
    /// Why account mode is unavailable; empty when it is available. Never
    /// carries key material.
    pub unavailable_reason: String,
}

impl RemoteGatewayStatus {
    /// Account mode is off, or the Router advertised something unusable.
    pub fn unavailable(reason: impl Into<String>) -> Self {
        Self {
            available: false,
            hostlink_url: String::new(),
            public_origin: String::new(),
            ca_pem: String::new(),
            dial_url: String::new(),
            tls_server_name: String::new(),
            local_forward_port: None,
            unavailable_reason: reason.into(),
        }
    }

    /// The endpoint was advertised but this build cannot reach it (yet).
    pub fn advertised_but_unreachable(
        announcement: &RemoteGatewayAnnouncement,
        tls_server_name: impl Into<String>,
        reason: impl Into<String>,
    ) -> Self {
        Self {
            available: false,
            hostlink_url: announcement.hostlink_url.clone(),
            public_origin: announcement.public_origin.clone(),
            ca_pem: announcement.ca_pem.clone(),
            dial_url: String::new(),
            tls_server_name: tls_server_name.into(),
            local_forward_port: None,
            unavailable_reason: reason.into(),
        }
    }

    /// TUN mode dials the overlay address directly.
    pub fn available_direct(
        announcement: &RemoteGatewayAnnouncement,
        target: &HostlinkTarget,
    ) -> Self {
        Self {
            available: true,
            hostlink_url: announcement.hostlink_url.clone(),
            public_origin: announcement.public_origin.clone(),
            ca_pem: announcement.ca_pem.clone(),
            dial_url: dial_url(target.dst.ip(), target.dst.port(), &target.path),
            tls_server_name: target.tls_server_name.clone(),
            local_forward_port: None,
            unavailable_reason: String::new(),
        }
    }

    /// No-TUN mode dials the loopback forward the overlay stack installed.
    pub fn available_forwarded(
        announcement: &RemoteGatewayAnnouncement,
        target: &HostlinkTarget,
        local_forward_port: u16,
    ) -> Self {
        Self {
            available: true,
            hostlink_url: announcement.hostlink_url.clone(),
            public_origin: announcement.public_origin.clone(),
            ca_pem: announcement.ca_pem.clone(),
            dial_url: dial_url(
                IpAddr::V4(std::net::Ipv4Addr::LOCALHOST),
                local_forward_port,
                &target.path,
            ),
            tls_server_name: target.tls_server_name.clone(),
            local_forward_port: Some(local_forward_port),
            unavailable_reason: String::new(),
        }
    }
}

/// Read the optional object out of a bootstrap payload.
///
/// Both wire spellings are accepted: the Router writes snake_case, and the
/// panel-facing spelling in the spec is camelCase.
pub fn parse_remote_gateway(obj: &Map<String, Value>) -> RemoteGatewayOutcome {
    let Some(value) = obj
        .get("remoteGateway")
        .or_else(|| obj.get("remote_gateway"))
    else {
        return RemoteGatewayOutcome::Absent;
    };
    if value.is_null() {
        return RemoteGatewayOutcome::Absent;
    }
    let Some(gateway) = value.as_object() else {
        return RemoteGatewayOutcome::Malformed("remoteGateway must be an object".to_string());
    };

    let parsed = (|| -> Result<RemoteGatewayAnnouncement, String> {
        let hostlink_url =
            required_field(gateway, &["hostlink_url", "hostlinkUrl"], "hostlinkUrl")?;
        let public_origin =
            required_field(gateway, &["public_origin", "publicOrigin"], "publicOrigin")?;
        let ca_pem = required_field(gateway, &["ca_pem", "caPem"], "caPem")?;
        validate_hostlink_url(&hostlink_url)?;
        validate_public_origin(&public_origin)?;
        validate_ca_pem(&ca_pem)?;
        Ok(RemoteGatewayAnnouncement {
            hostlink_url,
            public_origin,
            ca_pem,
        })
    })();

    match parsed {
        Ok(announcement) => RemoteGatewayOutcome::Announced(announcement),
        Err(reason) => RemoteGatewayOutcome::Malformed(reason),
    }
}

fn required_field(obj: &Map<String, Value>, names: &[&str], label: &str) -> Result<String, String> {
    let value = names.iter().find_map(|name| obj.get(*name));
    let raw = value
        .and_then(Value::as_str)
        .ok_or_else(|| format!("remoteGateway.{label} must be a string"))?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(format!("remoteGateway.{label} must not be empty"));
    }
    Ok(trimmed.to_string())
}

fn validate_hostlink_url(raw: &str) -> Result<(), String> {
    if raw.len() > MAX_HOSTLINK_URL_LEN {
        return Err(format!(
            "remoteGateway.hostlinkUrl must not exceed {MAX_HOSTLINK_URL_LEN} characters"
        ));
    }
    let parsed =
        Url::parse(raw).map_err(|_| "remoteGateway.hostlinkUrl must be a valid URL".to_string())?;
    if parsed.scheme() != "wss" {
        return Err("remoteGateway.hostlinkUrl must use the wss scheme".to_string());
    }
    if parsed.host_str().map(str::trim).unwrap_or("").is_empty() {
        return Err("remoteGateway.hostlinkUrl must include a host".to_string());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("remoteGateway.hostlinkUrl must not contain credentials".to_string());
    }
    if parsed.query().is_some() || parsed.fragment().is_some() {
        return Err("remoteGateway.hostlinkUrl must not contain a query or fragment".to_string());
    }
    Ok(())
}

fn validate_public_origin(raw: &str) -> Result<(), String> {
    if raw.len() > MAX_PUBLIC_ORIGIN_LEN {
        return Err(format!(
            "remoteGateway.publicOrigin must not exceed {MAX_PUBLIC_ORIGIN_LEN} characters"
        ));
    }
    let parsed = Url::parse(raw)
        .map_err(|_| "remoteGateway.publicOrigin must be a valid URL".to_string())?;
    if parsed.scheme() != "https" {
        return Err("remoteGateway.publicOrigin must use the https scheme".to_string());
    }
    if parsed.host_str().map(str::trim).unwrap_or("").is_empty() {
        return Err("remoteGateway.publicOrigin must include a host".to_string());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("remoteGateway.publicOrigin must not contain credentials".to_string());
    }
    if !parsed.path().is_empty() && parsed.path() != "/" {
        return Err("remoteGateway.publicOrigin must be an origin without a path".to_string());
    }
    if parsed.query().is_some() || parsed.fragment().is_some() {
        return Err("remoteGateway.publicOrigin must not contain a query or fragment".to_string());
    }
    Ok(())
}

/// Structural PEM validation.
///
/// The desktop carries this certificate to its own TLS client, so it must be a
/// certificate and nothing else: a private key pasted into the same field would
/// otherwise be cached and shown. Whether the certificate is actually a CA is
/// enforced by the Router before it ever reaches this side.
fn validate_ca_pem(raw: &str) -> Result<(), String> {
    if raw.len() > MAX_CA_PEM_LEN {
        return Err(format!(
            "remoteGateway.caPem must not exceed {MAX_CA_PEM_LEN} bytes"
        ));
    }
    let blocks = pem_blocks(raw)?;
    if blocks.is_empty() {
        return Err("remoteGateway.caPem must contain a PEM certificate".to_string());
    }
    for block in &blocks {
        if block.label != "CERTIFICATE" {
            return Err(format!(
                "remoteGateway.caPem must only contain CERTIFICATE blocks, found '{}'",
                block.label
            ));
        }
        let der = B64
            .decode(block.body.as_bytes())
            .map_err(|_| "remoteGateway.caPem contains an invalid base64 body".to_string())?;
        // Every X.509 certificate is a DER SEQUENCE; anything else is not one.
        if der.first() != Some(&0x30) {
            return Err("remoteGateway.caPem is not a DER certificate".to_string());
        }
    }
    Ok(())
}

struct PemBlock {
    label: String,
    body: String,
}

/// Split a PEM bundle into its blocks. Text outside a block is rejected so a
/// truncated or hand-edited bundle is not silently accepted.
fn pem_blocks(raw: &str) -> Result<Vec<PemBlock>, String> {
    let mut blocks = Vec::new();
    let mut open: Option<(String, String)> = None;
    for line in raw.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("-----BEGIN ") {
            let Some(label) = rest.strip_suffix("-----") else {
                return Err("remoteGateway.caPem has a malformed BEGIN line".to_string());
            };
            if open.is_some() {
                return Err("remoteGateway.caPem nests PEM blocks".to_string());
            }
            open = Some((label.trim().to_string(), String::new()));
        } else if let Some(rest) = trimmed.strip_prefix("-----END ") {
            let Some(label) = rest.strip_suffix("-----") else {
                return Err("remoteGateway.caPem has a malformed END line".to_string());
            };
            let Some((opened, body)) = open.take() else {
                return Err("remoteGateway.caPem has an END without a BEGIN".to_string());
            };
            if opened != label.trim() {
                return Err("remoteGateway.caPem has mismatched PEM labels".to_string());
            }
            blocks.push(PemBlock {
                label: opened,
                body,
            });
        } else if let Some((_, body)) = open.as_mut() {
            body.push_str(trimmed);
        } else if !trimmed.is_empty() {
            return Err("remoteGateway.caPem has text outside a PEM block".to_string());
        }
    }
    if open.is_some() {
        return Err("remoteGateway.caPem has an unterminated PEM block".to_string());
    }
    Ok(blocks)
}

/// Where the Host link lives on the overlay.
///
/// A `hostlink_url` host that is already an IP is taken as the overlay address.
/// A domain cannot be resolved to the overlay by DNS, so the Gateway is assumed
/// to sit on the Router's own overlay node and the bootstrap's
/// `gatewayVirtualIpv4` supplies the address; the domain stays the service
/// identity for TLS.
pub fn derive_hostlink_target(
    announcement: &RemoteGatewayAnnouncement,
    gateway_virtual_ipv4: Option<&str>,
) -> Result<HostlinkTarget, String> {
    let parsed = Url::parse(&announcement.hostlink_url)
        .map_err(|_| "remoteGateway.hostlinkUrl must be a valid URL".to_string())?;
    let host = parsed
        .host_str()
        .map(str::trim)
        .filter(|host| !host.is_empty())
        .ok_or_else(|| "remoteGateway.hostlinkUrl must include a host".to_string())?;
    let port = parsed
        .port_or_known_default()
        .ok_or_else(|| "remoteGateway.hostlinkUrl must include a valid port".to_string())?;
    let path = match parsed.path() {
        "" => "/".to_string(),
        path => path.to_string(),
    };

    let address = match host.parse::<IpAddr>() {
        Ok(ip) => ip,
        Err(_) => {
            let gateway = gateway_virtual_ipv4
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| {
                    "the gateway named a Host-link domain but no overlay address".to_string()
                })?;
            gateway
                .parse::<IpAddr>()
                .map_err(|_| "the gateway's overlay address is not an IP address".to_string())?
        }
    };

    Ok(HostlinkTarget {
        dst: SocketAddr::new(address, port),
        tls_server_name: host.to_string(),
        path,
    })
}

fn dial_url(address: IpAddr, port: u16, path: &str) -> String {
    let host = match address {
        IpAddr::V4(ip) => ip.to_string(),
        IpAddr::V6(ip) => format!("[{ip}]"),
    };
    match port {
        443 => format!("wss://{host}{path}"),
        port => format!("wss://{host}:{port}{path}"),
    }
}

/// How the overlay currently reaches the Gateway, as far as account mode cares.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RemoteGatewayReach {
    /// Nothing is carrying the overlay.
    Unavailable,
    /// No-TUN mode: the Host link is reached through a loopback forward.
    Forwarded { local_port: Option<u16> },
    /// TUN mode: the overlay address is routed directly.
    Direct,
}

/// Account mode as the panel and the Host-link client see it.
///
/// `outcome` is what the bootstrap answer said about account mode,
/// `gateway_virtual_ipv4` is the Router's overlay address from the same answer,
/// and `reach` says how the running backend would carry the connection.
pub fn status_for(
    enabled: bool,
    outcome: Option<&RemoteGatewayOutcome>,
    gateway_virtual_ipv4: Option<&str>,
    reach: RemoteGatewayReach,
    bootstrap_error: &str,
) -> RemoteGatewayStatus {
    if !enabled {
        return RemoteGatewayStatus::unavailable("the virtual LAN channel is disabled");
    }
    let Some(outcome) = outcome else {
        return RemoteGatewayStatus::unavailable(bootstrap_error.to_string());
    };
    let RemoteGatewayOutcome::Announced(announcement) = outcome else {
        return RemoteGatewayStatus::unavailable(outcome.reason().to_string());
    };
    let target = match derive_hostlink_target(announcement, gateway_virtual_ipv4) {
        Ok(target) => target,
        Err(reason) => return RemoteGatewayStatus::unavailable(reason),
    };
    match reach {
        RemoteGatewayReach::Direct => RemoteGatewayStatus::available_direct(announcement, &target),
        RemoteGatewayReach::Forwarded {
            local_port: Some(port),
        } => RemoteGatewayStatus::available_forwarded(announcement, &target, port),
        _ => RemoteGatewayStatus::advertised_but_unreachable(
            announcement,
            target.tls_server_name.clone(),
            "the overlay forward for the Host link is not installed",
        ),
    }
}

#[cfg(test)]
#[path = "remote_gateway_tests.rs"]
mod tests;
