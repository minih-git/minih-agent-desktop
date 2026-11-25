//! The mail server a user types into one credential instance
//! (`contributes.credentials[].userEndpoint`).
//!
//! A mailbox slot whose manifest declares `userEndpoint` lets the user name
//! their own IMAP or POP3 server next to the address and the password. Those
//! four values belong to the credential instance, not to the plugin: the host
//! injects that instance's password into the endpoint stored with it and
//! nowhere else, so a plugin can neither choose the server nor redirect a
//! stored secret to one of its own.
//!
//! What lives here, and is therefore the same for the Settings sheet, the
//! encrypted store and the TCP dialer:
//!
//! * the four reserved field keys and the values they accept;
//! * the normalization of one endpoint (`server`, numeric `port`, `protocol`,
//!   `security`);
//! * the cloud-metadata refusal, so an instance can never point at a service
//!   whose answers are instance credentials.
//!
//! Private and LAN addresses stay valid on purpose: a company mail server is
//! exactly who this exists for.

use std::collections::BTreeMap;
use std::net::IpAddr;

use super::validation::is_hostname;

/// Field key holding the mail server's hostname or IP literal.
pub(crate) const SERVER: &str = "server";
/// Field key holding the server's port, as a decimal string.
pub(crate) const PORT: &str = "port";
/// Field key holding `imap` or `pop3`.
pub(crate) const PROTOCOL: &str = "protocol";
/// Field key holding `tls` (implicit TLS) or `starttls`.
pub(crate) const SECURITY: &str = "security";

/// The keys a `userEndpoint` slot reserves for the host. A plugin may not
/// declare a field with one of these keys, so the form it renders cannot
/// overwrite where its own secret is sent.
pub(crate) const RESERVED_KEYS: [&str; 4] = [SERVER, PORT, PROTOCOL, SECURITY];

/// Mail protocols a slot may accept, mirroring `PLUGIN_MAIL_PROTOCOLS` in the
/// plugin SDK.
pub(crate) const PROTOCOLS: [&str; 2] = ["imap", "pop3"];

/// Transport security a user may choose, mirroring the SDK. There is no
/// plaintext option: a password is never written to an unencrypted stream.
pub(crate) const SECURITIES: [&str; 2] = ["tls", "starttls"];

/// Hostnames cloud providers answer with instance credentials.
const CLOUD_METADATA_HOSTS: [&str; 6] = [
    "169.254.169.254",
    "metadata.google.internal",
    "metadata",
    "instance-data",
    "100.100.100.200",
    "fd00:ec2::254",
];

/// One user-typed mail server, normalized and ready to store.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct UserEndpoint {
    pub server: String,
    pub port: u16,
    pub protocol: String,
    pub security: String,
}

impl UserEndpoint {
    /// The four values as they are stored inside the instance's blob.
    pub(crate) fn to_fields(&self) -> BTreeMap<String, String> {
        let mut fields = BTreeMap::new();
        fields.insert(SERVER.to_string(), self.server.clone());
        fields.insert(PORT.to_string(), self.port.to_string());
        fields.insert(PROTOCOL.to_string(), self.protocol.clone());
        fields.insert(SECURITY.to_string(), self.security.clone());
        fields
    }
}

/// Whether a submitted value is a reserved key of a `userEndpoint` slot.
pub(crate) fn is_reserved(key: &str) -> bool {
    RESERVED_KEYS.contains(&key)
}

/// Read the four reserved values out of one submitted field map.
///
/// A blank `server` means "no custom server": the instance keeps following the
/// plugin's preset path exactly as before, and whatever the form prefilled for
/// the other three keys is dropped rather than stored. Once a server is named,
/// the other three have to be usable — a partial set would leave the stored
/// password pointing at a server nobody chose.
///
/// The message is safe to hand back: it names a field and a rule, never a
/// submitted value.
pub(crate) fn from_fields(
    fields: &BTreeMap<String, String>,
    protocols: &[String],
) -> Result<Option<UserEndpoint>, String> {
    if value(fields, SERVER).trim().is_empty() {
        return Ok(None);
    }
    if let Some(missing) = [PORT, PROTOCOL, SECURITY]
        .iter()
        .find(|key| value(fields, key).trim().is_empty())
    {
        return Err(format!(
            "a custom mail server needs server, port, protocol and security; {missing} is missing"
        ));
    }
    if protocols.is_empty() {
        return Err("this credential slot accepts no custom mail server".to_string());
    }
    let server = normalize_server(value(fields, SERVER))?;
    let port = normalize_endpoint_port(value(fields, PORT))?;
    let protocol = value(fields, PROTOCOL).trim().to_ascii_lowercase();
    if !protocols.iter().any(|declared| declared == &protocol) {
        return Err("the custom mail server protocol is not one this slot allows".to_string());
    }
    let security = value(fields, SECURITY).trim().to_ascii_lowercase();
    if !SECURITIES.contains(&security.as_str()) {
        return Err("the custom mail server security must be tls or starttls".to_string());
    }
    Ok(Some(UserEndpoint {
        server,
        port,
        protocol,
        security,
    }))
}

fn value<'a>(fields: &'a BTreeMap<String, String>, key: &str) -> &'a str {
    fields.get(key).map(String::as_str).unwrap_or_default()
}

/// A bare hostname or IP literal: no scheme, port, path, whitespace or
/// wildcard. Lowercased, with one trailing root dot removed, so the stored
/// value and a plugin's spelling of the same server compare equal.
///
/// `what` names the thing being validated in the refusal ("custom mail server",
/// "proxy"): the rule is shared, the message stays about the field the user
/// just filled in.
pub(crate) fn normalize_host(raw: &str, what: &str) -> Result<String, String> {
    let trimmed = raw.trim().to_ascii_lowercase();
    let value = trimmed.strip_suffix('.').unwrap_or(&trimmed).to_string();
    if value.is_empty() {
        return Err(format!("the {what} needs a hostname or IP address"));
    }
    if value.len() > 253 {
        return Err(format!("the {what} is not a valid hostname or IP address"));
    }
    let is_ip = value.parse::<IpAddr>().is_ok();
    if !is_ip && !is_hostname(&value) {
        return Err(format!("the {what} is not a valid hostname or IP address"));
    }
    if is_metadata_host(&value) {
        return Err(format!("the {what} must not be a cloud metadata endpoint"));
    }
    Ok(value)
}

fn normalize_server(raw: &str) -> Result<String, String> {
    normalize_host(raw, "custom mail server")
}

/// Whether `server` is a cloud metadata endpoint, by the same list the plugin
/// egress policy refuses. An address is compared as an address, so another
/// spelling of the same IPv6 endpoint is caught too.
fn is_metadata_host(server: &str) -> bool {
    let value = server.trim().to_ascii_lowercase();
    if CLOUD_METADATA_HOSTS.contains(&value.as_str()) {
        return true;
    }
    match value.parse::<IpAddr>() {
        Ok(address) => CLOUD_METADATA_HOSTS
            .iter()
            .filter_map(|known| known.parse::<IpAddr>().ok())
            .any(|known| known == address),
        Err(_) => false,
    }
}

/// A port is a decimal number from 1 to 65535, and nothing else: a sign, a
/// space or a fraction would make the stored value something other than what
/// the user read back.
pub(crate) fn normalize_port(raw: &str, what: &str) -> Result<u16, String> {
    let value = raw.trim();
    let digits = value.strip_prefix('+').unwrap_or(value);
    if digits.is_empty() || digits.len() > 5 || !digits.chars().all(|c| c.is_ascii_digit()) {
        return Err(format!("the {what} port must be a number from 1 to 65535"));
    }
    match digits.parse::<u16>() {
        Ok(port) if port >= 1 => Ok(port),
        _ => Err(format!("the {what} port must be a number from 1 to 65535")),
    }
}

fn normalize_endpoint_port(raw: &str) -> Result<u16, String> {
    normalize_port(raw, "custom mail server")
}

/// Parse the manifest's `userEndpoint.protocols` for one slot.
///
/// Install already refused anything else, so a malformed declaration here is
/// read as "no custom server" rather than as a slot nothing can fill: the
/// alternative would be a Settings sheet nobody can complete.
pub(crate) fn declared_protocols(raw: Option<&serde_json::Value>) -> Vec<String> {
    let Some(protocols) = raw
        .and_then(|value| value.get("protocols"))
        .and_then(serde_json::Value::as_array)
    else {
        return Vec::new();
    };
    let mut declared: Vec<String> = Vec::new();
    for protocol in protocols {
        let Some(protocol) = protocol.as_str() else {
            continue;
        };
        let protocol = protocol.trim().to_ascii_lowercase();
        if !PROTOCOLS.contains(&protocol.as_str()) || declared.contains(&protocol) {
            continue;
        }
        declared.push(protocol);
    }
    declared
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn submitted(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(key, value)| (key.to_string(), value.to_string()))
            .collect()
    }

    fn imap_only() -> Vec<String> {
        vec!["imap".to_string()]
    }

    fn with(server: &str, port: &str, protocol: &str, security: &str) -> BTreeMap<String, String> {
        submitted(&[
            (SERVER, server),
            (PORT, port),
            (PROTOCOL, protocol),
            (SECURITY, security),
        ])
    }

    #[test]
    fn a_blank_server_means_no_custom_endpoint() {
        assert_eq!(from_fields(&BTreeMap::new(), &imap_only()), Ok(None));
        assert_eq!(from_fields(&with("  ", "", "", ""), &imap_only()), Ok(None));
        // A form that prefilled the other three but never named a server stores
        // nothing rather than a half-chosen endpoint.
        assert_eq!(
            from_fields(&with("", "993", "imap", "tls"), &imap_only()),
            Ok(None)
        );
    }

    #[test]
    fn a_complete_endpoint_is_normalized() {
        let fields = with(" Mail.Example.COM. ", "993", "IMAP", "TLS");
        let endpoint = from_fields(&fields, &["imap".to_string(), "pop3".to_string()])
            .unwrap()
            .unwrap();
        assert_eq!(endpoint.server, "mail.example.com");
        assert_eq!(endpoint.port, 993);
        assert_eq!(endpoint.protocol, "imap");
        assert_eq!(endpoint.security, "tls");
        assert_eq!(
            endpoint.to_fields().get(SERVER).map(String::as_str),
            Some("mail.example.com")
        );
    }

    #[test]
    fn a_named_server_without_the_rest_is_refused() {
        for missing in [PORT, PROTOCOL, SECURITY] {
            let fields = with("mail.example.com", "143", "imap", "starttls")
                .into_iter()
                .filter(|(key, _)| key != missing)
                .collect::<BTreeMap<_, _>>();
            let error = from_fields(&fields, &imap_only()).unwrap_err();
            assert!(error.contains(missing), "{error}");
        }
    }

    #[test]
    fn a_server_is_a_bare_hostname_or_ip() {
        for (server, acceptable) in [
            ("mail.example.com", true),
            ("127.0.0.1", true),
            ("10.0.0.5", true),
            ("[2001:db8::1]", false),
            ("2001:db8::1", true),
            ("::1", true),
            ("https://mail.example.com", false),
            ("mail.example.com:993", false),
            ("mail.example.com/imap", false),
            ("*.example.com", false),
            ("mail server", false),
        ] {
            let fields = with(server, "993", "imap", "tls");
            assert_eq!(
                from_fields(&fields, &imap_only()).is_ok(),
                acceptable,
                "{server} should be {}",
                if acceptable { "accepted" } else { "refused" }
            );
        }
    }

    #[test]
    fn cloud_metadata_hosts_are_refused() {
        for server in [
            "169.254.169.254",
            "100.100.100.200",
            "metadata.google.internal",
        ] {
            let error = from_fields(&with(server, "993", "imap", "tls"), &imap_only()).unwrap_err();
            assert!(error.contains("cloud metadata"), "{error}");
        }
        assert!(from_fields(&with("fd00:ec2::254", "993", "imap", "tls"), &imap_only()).is_err());
    }

    #[test]
    fn a_port_is_a_plain_number_in_range() {
        for (port, acceptable) in [
            ("993", true),
            ("+993", true),
            ("1", true),
            ("65535", true),
            ("0", false),
            ("65536", false),
            ("0993", true),
            ("993.0", false),
            (" 993 ", true),
            ("", false),
        ] {
            let fields = with("mail.example.com", port, "imap", "tls");
            assert_eq!(
                from_fields(&fields, &imap_only()).is_ok(),
                acceptable,
                "port {port} should be {}",
                if acceptable { "accepted" } else { "refused" }
            );
        }
    }

    #[test]
    fn only_declared_protocols_and_secure_transports_are_accepted() {
        let pop3 = with("mail.example.com", "995", "pop3", "tls");
        assert!(from_fields(&pop3, &imap_only()).is_err());
        assert!(from_fields(&pop3, &["pop3".to_string()]).is_ok());
        assert!(from_fields(
            &with("mail.example.com", "143", "imap", "none"),
            &imap_only()
        )
        .is_err());
    }

    #[test]
    fn a_slot_without_user_endpoint_accepts_no_endpoint() {
        assert!(from_fields(&with("mail.example.com", "143", "imap", "starttls"), &[]).is_err());
    }

    #[test]
    fn declared_protocols_are_deduplicated_and_bounded() {
        assert_eq!(
            declared_protocols(Some(&json!({ "protocols": ["imap", "pop3", "imap"] }))),
            vec!["imap".to_string(), "pop3".to_string()]
        );
        assert_eq!(
            declared_protocols(Some(&json!({ "protocols": ["smtp"] }))),
            Vec::<String>::new()
        );
        assert_eq!(declared_protocols(Some(&json!({}))), Vec::<String>::new());
    }
}
