use std::net::{SocketAddr, ToSocketAddrs};

use easytier::common::config::{
    ConfigLoader as _, NetworkIdentity, PeerConfig, PortForwardConfig, TomlConfigLoader,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use url::Url;

pub const DEFAULT_EASYTIER_NETWORK_NAME: &str = "minih-net";
pub const DEFAULT_EASYTIER_NETWORK_SECRET: &str = "Minih@9527";
pub const DEFAULT_EASYTIER_PEERS: &[&str] =
    &["udp://tier.hmini.org:11010", "tcp://tier.hmini.org:11010"];
pub const DEFAULT_ROUTER_LAN_URL: &str = "http://10.144.144.10:3001/v1";
pub const DEFAULT_ROUTER_PUBLIC_URL: &str = "https://router.hmini.org/v1";

const MAX_NETWORK_NAME_LEN: usize = 128;
const MAX_NETWORK_SECRET_LEN: usize = 256;
const MAX_PEER_URL_LEN: usize = 512;
const MAX_PEERS_COUNT: usize = 32;
const MAX_ROUTER_URL_LEN: usize = 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum EasyTierMode {
    #[serde(rename = "auto")]
    #[default]
    Auto,
    #[serde(rename = "no_tun", alias = "no-tun")]
    NoTun,
    #[serde(rename = "tun")]
    Tun,
}

impl EasyTierMode {
    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim() {
            "auto" => Some(Self::Auto),
            "no_tun" | "no-tun" => Some(Self::NoTun),
            "tun" => Some(Self::Tun),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum EasyTierEffectiveMode {
    #[serde(rename = "disabled")]
    #[default]
    Disabled,
    #[serde(rename = "no_tun", alias = "no-tun")]
    NoTun,
    #[serde(rename = "tun")]
    Tun,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum EasyTierConnectionState {
    #[default]
    Disabled,
    Connecting,
    Connected,
    Degraded,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EasyTierSettings {
    pub enabled: bool,
    pub mode: EasyTierMode,
    pub network_name: String,
    pub network_secret: String,
    pub peers: Vec<String>,
    pub router_lan_url: String,
    pub dhcp: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ipv4: Option<String>,
}

impl Default for EasyTierSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            mode: EasyTierMode::Auto,
            network_name: DEFAULT_EASYTIER_NETWORK_NAME.to_string(),
            network_secret: DEFAULT_EASYTIER_NETWORK_SECRET.to_string(),
            peers: DEFAULT_EASYTIER_PEERS
                .iter()
                .map(|peer| (*peer).to_string())
                .collect(),
            router_lan_url: DEFAULT_ROUTER_LAN_URL.to_string(),
            dhcp: true,
            ipv4: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RouterLanTarget {
    pub scheme: String,
    pub host: String,
    pub port: u16,
    pub api_path: String,
    pub normalized_base_url: String,
}

impl RouterLanTarget {
    pub fn forward_base_url(&self, local_port: u16) -> String {
        format!("http://127.0.0.1:{local_port}{}", self.api_path)
    }

    pub fn dst_socket_addr(&self) -> Result<SocketAddr, String> {
        if let Ok(ip) = self.host.parse::<std::net::IpAddr>() {
            return Ok(SocketAddr::new(ip, self.port));
        }
        let host_port = format!("{}:{}", self.host, self.port);
        host_port
            .to_socket_addrs()
            .map_err(|error| format!("failed to resolve router LAN host '{}': {error}", self.host))?
            .next()
            .ok_or_else(|| format!("router LAN host '{}' resolved to no addresses", self.host))
    }
}

pub fn parse_router_lan_target(raw: &str) -> Result<RouterLanTarget, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("routerLanUrl is required".into());
    }
    if trimmed.len() > MAX_ROUTER_URL_LEN {
        return Err("routerLanUrl is too long".into());
    }
    let parsed = Url::parse(trimmed).map_err(|_| "routerLanUrl must be a valid URL".to_string())?;
    let scheme = parsed.scheme().to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        return Err("routerLanUrl scheme must be http or https".into());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("routerLanUrl must not contain credentials".into());
    }
    let host = parsed
        .host_str()
        .map(str::trim)
        .filter(|h| !h.is_empty())
        .ok_or_else(|| "routerLanUrl must include a host".to_string())?
        .to_string();
    let port = parsed
        .port_or_known_default()
        .ok_or_else(|| "routerLanUrl must include a valid port".to_string())?;
    let clean_path = parsed.path().trim_end_matches('/');
    let api_path = if clean_path.to_ascii_lowercase().ends_with("/v1") {
        clean_path.to_string()
    } else if clean_path.is_empty() {
        "/v1".to_string()
    } else {
        format!("{clean_path}/v1")
    };
    let host_bracketed = if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]")
    } else {
        host.clone()
    };
    let port_suffix = match (scheme.as_str(), port) {
        ("http", 80) | ("https", 443) => String::new(),
        _ => format!(":{port}"),
    };
    let normalized_base_url = format!("{scheme}://{host_bracketed}{port_suffix}{api_path}");
    Ok(RouterLanTarget {
        scheme,
        host,
        port,
        api_path,
        normalized_base_url,
    })
}

pub fn validate_peer_url(raw: &str) -> Result<Url, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("peer URL must not be empty".into());
    }
    if trimmed.len() > MAX_PEER_URL_LEN {
        return Err("peer URL is too long".into());
    }
    let parsed = Url::parse(trimmed).map_err(|_| format!("invalid peer URL '{trimmed}'"))?;
    let scheme = parsed.scheme().to_ascii_lowercase();
    if !matches!(scheme.as_str(), "tcp" | "udp" | "ws" | "wss") {
        return Err(format!(
            "unsupported peer URL scheme '{scheme}'; expected tcp, udp, ws, or wss"
        ));
    }
    if parsed.host_str().map(str::trim).unwrap_or("").is_empty() {
        return Err(format!("peer URL '{trimmed}' must include a host"));
    }
    if parsed.port().is_none() {
        return Err(format!("peer URL '{trimmed}' must include a port"));
    }
    Ok(parsed)
}

pub fn settings_from_app_value(value: Option<&Value>) -> EasyTierSettings {
    let Some(section) = value
        .and_then(Value::as_object)
        .and_then(|obj| obj.get("easytier"))
    else {
        return EasyTierSettings::default();
    };
    settings_from_section(Some(section))
}

pub fn settings_from_section(section: Option<&Value>) -> EasyTierSettings {
    let defaults = EasyTierSettings::default();
    let Some(obj) = section.and_then(Value::as_object) else {
        return defaults;
    };
    let enabled = obj
        .get("enabled")
        .and_then(Value::as_bool)
        .unwrap_or(defaults.enabled);
    let mode = obj
        .get("mode")
        .and_then(Value::as_str)
        .and_then(EasyTierMode::parse)
        .unwrap_or(defaults.mode);
    let network_name = obj
        .get("networkName")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty() && s.len() <= MAX_NETWORK_NAME_LEN)
        .map(ToString::to_string)
        .unwrap_or(defaults.network_name);
    let network_secret = obj
        .get("networkSecret")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| s.len() <= MAX_NETWORK_SECRET_LEN)
        .map(ToString::to_string)
        .unwrap_or(defaults.network_secret);
    let peers = obj
        .get("peers")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .filter(|s| validate_peer_url(s).is_ok())
                .take(MAX_PEERS_COUNT)
                .map(ToString::to_string)
                .collect::<Vec<_>>()
        })
        .filter(|list| !list.is_empty())
        .unwrap_or(defaults.peers);
    let router_lan_url = obj
        .get("routerLanUrl")
        .and_then(Value::as_str)
        .and_then(|s| parse_router_lan_target(s).ok())
        .map(|target| target.normalized_base_url)
        .unwrap_or(defaults.router_lan_url);
    let dhcp = obj
        .get("dhcp")
        .and_then(Value::as_bool)
        .unwrap_or(defaults.dhcp);
    let ipv4 = obj
        .get("ipv4")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToString::to_string);

    EasyTierSettings {
        enabled,
        mode,
        network_name,
        network_secret,
        peers,
        router_lan_url,
        dhcp,
        ipv4,
    }
}

pub fn validate_easytier_settings(app_settings: &Value) -> Result<(), String> {
    let Some(object) = app_settings.as_object() else {
        return Ok(());
    };
    let Some(section) = object.get("easytier") else {
        return Ok(());
    };
    if section.is_null() {
        return Ok(());
    }
    validate_easytier_section(section)
}

pub fn validate_easytier_section(section: &Value) -> Result<(), String> {
    let Some(obj) = section.as_object() else {
        return Err("easytier settings must be an object".into());
    };
    if let Some(enabled) = obj.get("enabled") {
        if !enabled.is_boolean() {
            return Err("easytier.enabled must be a boolean".into());
        }
    }
    if let Some(mode) = obj.get("mode") {
        let Some(mode_str) = mode.as_str() else {
            return Err("easytier.mode must be a string".into());
        };
        if EasyTierMode::parse(mode_str).is_none() {
            return Err("easytier.mode must be auto, no-tun, or tun".into());
        }
    }
    if let Some(name) = obj.get("networkName") {
        let Some(name_str) = name.as_str() else {
            return Err("easytier.networkName must be a string".into());
        };
        let trimmed = name_str.trim();
        if trimmed.is_empty() || trimmed.len() > MAX_NETWORK_NAME_LEN {
            return Err("easytier.networkName must be 1 to 128 characters".into());
        }
    }
    if let Some(secret) = obj.get("networkSecret") {
        let Some(secret_str) = secret.as_str() else {
            return Err("easytier.networkSecret must be a string".into());
        };
        if secret_str.trim().len() > MAX_NETWORK_SECRET_LEN {
            return Err("easytier.networkSecret is too long".into());
        }
    }
    if let Some(peers) = obj.get("peers") {
        let Some(arr) = peers.as_array() else {
            return Err("easytier.peers must be an array of peer URLs".into());
        };
        if arr.is_empty() || arr.len() > MAX_PEERS_COUNT {
            return Err("easytier.peers must contain 1 to 32 peer URLs".into());
        }
        for item in arr {
            let Some(peer_str) = item.as_str() else {
                return Err("easytier.peers entries must be strings".into());
            };
            validate_peer_url(peer_str)?;
        }
    }
    if let Some(router_url) = obj.get("routerLanUrl") {
        let Some(router_str) = router_url.as_str() else {
            return Err("easytier.routerLanUrl must be a string".into());
        };
        parse_router_lan_target(router_str)?;
    }
    if let Some(dhcp) = obj.get("dhcp") {
        if !dhcp.is_boolean() {
            return Err("easytier.dhcp must be a boolean".into());
        }
    }
    if let Some(ipv4) = obj.get("ipv4").filter(|v| !v.is_null()) {
        let Some(ipv4_str) = ipv4.as_str() else {
            return Err("easytier.ipv4 must be a string".into());
        };
        let trimmed = ipv4_str.trim();
        if !trimmed.is_empty() {
            let probe_toml = format!("ipv4 = {trimmed:?}\n");
            TomlConfigLoader::new_from_str(&probe_toml)
                .map_err(|_| "easytier.ipv4 must be a valid IPv4 address or CIDR".to_string())?;
        }
    }
    Ok(())
}

pub fn build_toml_config(
    settings: &EasyTierSettings,
    no_tun: bool,
    local_forward_port: Option<u16>,
) -> Result<TomlConfigLoader, String> {
    let config = if let Some(ipv4) = settings
        .ipv4
        .as_deref()
        .filter(|s| !s.is_empty() && !settings.dhcp)
    {
        let raw = format!("ipv4 = {ipv4:?}\n");
        TomlConfigLoader::new_from_str(&raw)
            .map_err(|e| format!("invalid easytier ipv4 '{ipv4}': {e}"))?
    } else {
        TomlConfigLoader::default()
    };

    config.set_inst_name("minih-agent-easytier".to_string());
    config.set_network_identity(NetworkIdentity::new(
        settings.network_name.clone(),
        settings.network_secret.clone(),
    ));
    config.set_dhcp(settings.dhcp);
    config.set_listeners(Vec::new());

    let mut peer_configs = Vec::with_capacity(settings.peers.len());
    for peer_raw in &settings.peers {
        let uri = validate_peer_url(peer_raw)?;
        peer_configs.push(PeerConfig {
            uri,
            peer_public_key: None,
        });
    }
    config.set_peers(peer_configs);

    if let Some(port) = local_forward_port {
        let target = parse_router_lan_target(&settings.router_lan_url)?;
        let dst_addr = target.dst_socket_addr()?;
        let bind_addr = SocketAddr::from(([127, 0, 0, 1], port));
        config.set_port_forwards(vec![PortForwardConfig {
            bind_addr,
            dst_addr,
            proto: "tcp".to_string(),
        }]);
    }

    let mut flags = config.get_flags();
    flags.no_tun = no_tun;
    flags.enable_kcp_proxy = false;
    flags.enable_quic_proxy = false;
    flags.bind_device = false;
    config.set_flags(flags);

    Ok(config)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn default_settings_match_minih_router_lan_parameters() {
        let defaults = EasyTierSettings::default();
        assert!(defaults.enabled);
        assert_eq!(defaults.mode, EasyTierMode::Auto);
        assert_eq!(defaults.network_name, "minih-net");
        assert_eq!(defaults.network_secret, "Minih@9527");
        assert_eq!(
            defaults.peers,
            vec![
                "udp://tier.hmini.org:11010".to_string(),
                "tcp://tier.hmini.org:11010".to_string()
            ]
        );
        assert_eq!(defaults.router_lan_url, "http://10.144.144.10:3001/v1");
        assert!(defaults.dhcp);
    }

    #[test]
    fn router_lan_target_normalizes_root_and_v1_paths() {
        let target = parse_router_lan_target("http://10.144.144.10:3001").unwrap();
        assert_eq!(target.host, "10.144.144.10");
        assert_eq!(target.port, 3001);
        assert_eq!(target.api_path, "/v1");
        assert_eq!(target.normalized_base_url, "http://10.144.144.10:3001/v1");
        assert_eq!(target.forward_base_url(25890), "http://127.0.0.1:25890/v1");
    }

    #[test]
    fn validates_and_builds_toml_config_with_port_forward() {
        let raw = json!({
            "easytier": {
                "enabled": true,
                "mode": "no-tun",
                "networkName": "minih-net",
                "networkSecret": "Minih@9527",
                "peers": ["udp://tier.hmini.org:11010"],
                 "routerLanUrl": "http://10.144.144.10:3001/v1",
                "dhcp": true
            }
        });
        assert!(validate_easytier_settings(&raw).is_ok());
        let settings = settings_from_app_value(Some(&raw));
        let toml = build_toml_config(&settings, true, Some(25890)).unwrap();
        assert!(toml.get_flags().no_tun);
        assert_eq!(toml.get_port_forwards().len(), 1);
        assert_eq!(
            toml.get_port_forwards()[0].bind_addr.to_string(),
            "127.0.0.1:25890"
        );
        assert_eq!(
            toml.get_port_forwards()[0].dst_addr.to_string(),
            "10.144.144.10:3001"
        );
    }
}
