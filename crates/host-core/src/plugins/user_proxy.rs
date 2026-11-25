//! The proxy a user configures for one mail account
//! (`contributes.credentials[].userProxy`).
//!
//! A mailbox that is only reachable through a local or LAN proxy — a Clash on
//! `127.0.0.1:7897` is the case this exists for — needs the proxy to belong to
//! the account, exactly like a user-typed server: the host dials it only for a
//! connection that carries that account's `credentialRef`, and never falls back
//! to a direct dial. The plugin can neither choose the proxy nor read its
//! password.
//!
//! What lives here, shared by the Settings sheet, the encrypted store and the
//! TCP dialer:
//!
//! * the five reserved field keys, of which `proxyType`, `proxyHost` and
//!   `proxyPort` are published back and the two credential keys never are;
//! * the normalization of one proxy (`type`, `host`, numeric `port`, optional
//!   username and password);
//! * the all-or-nothing rule: no type means no proxy, and a type means a host,
//!   a port and either both credential fields or neither.
//!
//! Loopback and private addresses stay valid on purpose: the proxy this feature
//! is for runs on the user's own machine. Cloud metadata hosts are refused by
//! the same list the mail server validation uses, so a proxy can never become a
//! way to reach an instance-credential service.

use std::collections::BTreeMap;

use serde_json::Value;

use super::user_endpoint::{normalize_host, normalize_port};

/// Field key holding `""` (no proxy), `http` or `socks5`.
pub(crate) const TYPE: &str = "proxyType";
/// Field key holding the proxy's hostname or IP literal.
pub(crate) const HOST: &str = "proxyHost";
/// Field key holding the proxy's port, as a decimal string.
pub(crate) const PORT: &str = "proxyPort";
/// Field key holding the optional proxy user name.
pub(crate) const USERNAME: &str = "proxyUsername";
/// Field key holding the optional proxy password.
pub(crate) const PASSWORD: &str = "proxyPassword";

/// The keys a `userProxy` slot reserves for the host. A plugin may not declare a
/// field with one of these, so its own form cannot redirect the dialer.
pub(crate) const RESERVED_KEYS: [&str; 5] = [TYPE, HOST, PORT, USERNAME, PASSWORD];

/// What an account's proxy publishes back to the plugin: where it points, never
/// who it logs in as.
pub(crate) const PUBLIC_KEYS: [&str; 3] = [TYPE, HOST, PORT];

/// Proxy protocols a slot may accept, mirroring `PLUGIN_PROXY_TYPES` in the
/// plugin SDK.
pub(crate) const TYPES: [&str; 2] = ["http", "socks5"];

/// Longest proxy user name or password this host stores.
///
/// RFC 1929 caps each SOCKS5 sub-negotiation field at 255 bytes, and a proxy
/// login has no legitimate reason to be longer than that, so one bound covers
/// both protocols.
const MAX_AUTH_BYTES: usize = 255;

/// One user-configured proxy, normalized and ready to store.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct UserProxy {
    pub kind: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
}

impl UserProxy {
    /// The five values as they are stored inside the instance's blob.
    pub(crate) fn to_fields(&self) -> BTreeMap<String, String> {
        let mut fields = BTreeMap::new();
        fields.insert(TYPE.to_string(), self.kind.clone());
        fields.insert(HOST.to_string(), self.host.clone());
        fields.insert(PORT.to_string(), self.port.to_string());
        fields.insert(USERNAME.to_string(), self.username.clone());
        fields.insert(PASSWORD.to_string(), self.password.clone());
        fields
    }

    /// Whether the proxy expects a login, which decides the handshake shape.
    pub(crate) fn has_credentials(&self) -> bool {
        !self.username.is_empty()
    }
}

/// Whether a submitted value is a reserved key of a `userProxy` slot.
pub(crate) fn is_reserved(key: &str) -> bool {
    RESERVED_KEYS.contains(&key)
}

/// The keys the plugin may read back for a proxied account.
pub(crate) fn is_public(key: &str) -> bool {
    PUBLIC_KEYS.contains(&key)
}

fn value<'a>(fields: &'a BTreeMap<String, String>, key: &str) -> &'a str {
    fields.get(key).map(String::as_str).unwrap_or_default()
}

/// Read the five reserved values out of one submitted field map.
///
/// An empty type means "no proxy": the account dials the mail server directly,
/// and whatever the form prefilled or the user typed for the other four keys is
/// dropped rather than stored. A chosen type has to come with a usable host and
/// port, and with either both credential fields or neither — a half-configured
/// login would fail at the proxy instead of in the form.
///
/// The message is safe to hand back: it names a rule, never a submitted value.
pub(crate) fn from_fields(
    fields: &BTreeMap<String, String>,
    types: &[String],
) -> Result<Option<UserProxy>, String> {
    let kind = value(fields, TYPE).trim().to_ascii_lowercase();
    let host = value(fields, HOST).trim();
    let port = value(fields, PORT).trim();
    let username = value(fields, USERNAME).trim();
    let password = value(fields, PASSWORD);
    if kind.is_empty() {
        if [host, port, username].iter().any(|value| !value.is_empty()) || !password.is_empty() {
            return Err(
                "a proxy needs a type: choose HTTP or SOCKS5, or clear the proxy fields"
                    .to_string(),
            );
        }
        return Ok(None);
    }
    if types.is_empty() {
        return Err("this credential slot accepts no proxy".to_string());
    }
    if !types.iter().any(|declared| declared == &kind) {
        return Err("the proxy type is not one this slot allows".to_string());
    }
    if host.is_empty() || port.is_empty() {
        return Err("a proxy needs a hostname or IP address and a port".to_string());
    }
    let host = normalize_host(host, "proxy")?;
    let port = normalize_port(port, "proxy")?;
    if username.is_empty() != password.is_empty() {
        return Err("a proxy login needs both a user name and a password, or neither".to_string());
    }
    if [username, password]
        .iter()
        .any(|value| value.chars().any(|c| matches!(c, '\r' | '\n' | '\0')))
    {
        return Err("the proxy credential cannot carry a line break or a NUL".to_string());
    }
    if username.len() > MAX_AUTH_BYTES || password.len() > MAX_AUTH_BYTES {
        return Err(format!(
            "the proxy user name and password must each be at most {MAX_AUTH_BYTES} bytes"
        ));
    }
    Ok(Some(UserProxy {
        kind,
        host,
        port,
        username: username.to_string(),
        password: password.to_string(),
    }))
}

/// Parse the manifest's `userProxy.types` for one slot.
///
/// Install already refused anything else, so a malformed declaration here is
/// read as "no proxy" rather than as a slot nothing can fill.
pub(crate) fn declared_types(raw: Option<&Value>) -> Vec<String> {
    let Some(types) = raw
        .and_then(|value| value.get("types"))
        .and_then(Value::as_array)
    else {
        return Vec::new();
    };
    let mut declared: Vec<String> = Vec::new();
    for kind in types {
        let Some(kind) = kind.as_str() else {
            continue;
        };
        let kind = kind.trim().to_ascii_lowercase();
        if !TYPES.contains(&kind.as_str()) || declared.contains(&kind) {
            continue;
        }
        declared.push(kind);
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

    fn types() -> Vec<String> {
        declared_types(Some(&json!({ "types": ["http", "socks5"] })))
    }

    #[test]
    fn no_type_means_no_proxy() {
        assert_eq!(from_fields(&submitted(&[]), &types()).unwrap(), None);
        assert_eq!(
            from_fields(&submitted(&[(TYPE, "")]), &types()).unwrap(),
            None
        );
    }

    #[test]
    fn a_cleared_type_drops_every_other_proxy_value() {
        let error = from_fields(
            &submitted(&[(TYPE, ""), (HOST, "127.0.0.1"), (PORT, "7897")]),
            &types(),
        )
        .unwrap_err();
        assert!(error.contains("needs a type"), "{error}");
    }

    #[test]
    fn a_local_proxy_is_stored_normalized() {
        let proxy = from_fields(
            &submitted(&[
                (TYPE, "SOCKS5"),
                (HOST, "127.0.0.1."),
                (PORT, "7897"),
                (USERNAME, "u"),
                (PASSWORD, "p"),
            ]),
            &types(),
        )
        .unwrap()
        .unwrap();
        assert_eq!(proxy.kind, "socks5");
        assert_eq!(proxy.host, "127.0.0.1");
        assert_eq!(proxy.port, 7897);
        assert!(proxy.has_credentials());
    }

    #[test]
    fn a_proxy_is_refused_without_host_port_or_a_complete_login() {
        for (pairs, expected) in [
            (
                vec![(TYPE, "http"), (PORT, "8080")],
                "needs a hostname or IP address and a port",
            ),
            (
                vec![(TYPE, "http"), (HOST, "proxy.local")],
                "needs a hostname or IP address and a port",
            ),
            (
                vec![
                    (TYPE, "http"),
                    (HOST, "proxy.local"),
                    (PORT, "8080"),
                    (USERNAME, "u"),
                ],
                "both a user name and a password",
            ),
            (
                vec![(TYPE, "smtp"), (HOST, "proxy.local"), (PORT, "8080")],
                "not one this slot allows",
            ),
            (
                vec![(TYPE, "http"), (HOST, "http://proxy.local"), (PORT, "8080")],
                "not a valid hostname or IP address",
            ),
            (
                vec![(TYPE, "http"), (HOST, "169.254.169.254"), (PORT, "8080")],
                "must not be a cloud metadata endpoint",
            ),
            (
                vec![(TYPE, "http"), (HOST, "proxy.local"), (PORT, "0")],
                "must be a number from 1 to 65535",
            ),
            (
                vec![
                    (TYPE, "http"),
                    (HOST, "proxy.local"),
                    (PORT, "8080"),
                    (USERNAME, "u\r\nX"),
                    (PASSWORD, "p"),
                ],
                "cannot carry a line break or a NUL",
            ),
        ] {
            let error = from_fields(&submitted(&pairs), &types()).unwrap_err();
            assert!(error.contains(expected), "{pairs:?}: {error}");
        }
    }

    #[test]
    fn a_slot_that_accepts_no_proxy_type_refuses_one() {
        let error = from_fields(
            &submitted(&[(TYPE, "http"), (HOST, "127.0.0.1"), (PORT, "7897")]),
            &[],
        )
        .unwrap_err();
        assert!(error.contains("accepts no proxy"), "{error}");
    }

    #[test]
    fn a_declaration_is_read_back_without_duplicates_or_unknown_types() {
        assert_eq!(
            declared_types(Some(
                &json!({ "types": ["http", "http", "smtp", "SOCKS5"] })
            )),
            vec!["http".to_string(), "socks5".to_string()]
        );
        assert!(declared_types(Some(&json!({}))).is_empty());
        assert!(declared_types(None).is_empty());
    }

    #[test]
    fn the_public_keys_never_include_the_credentials() {
        assert!(!is_public(USERNAME));
        assert!(!is_public(PASSWORD));
        for key in RESERVED_KEYS {
            assert!(is_reserved(key));
        }
    }
}
