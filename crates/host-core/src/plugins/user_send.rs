//! The outgoing mail server a user configures for one mail account
//! (`contributes.credentials[].userSend`).
//!
//! Sending is host-performed, exactly like receiving: the host logs in with the
//! account's own credentials and hands the plugin only the outcome. Where a
//! message leaves from therefore belongs to the account for the same reason the
//! incoming server does — a plugin that could name the server could send a
//! stored password somewhere it was never configured for.
//!
//! What lives here, shared by the Settings sheet, the encrypted store and the
//! SMTP session:
//!
//! * the three reserved field keys;
//! * the normalization of one outgoing endpoint (`sendServer`, numeric
//!   `sendPort`, `sendSecurity`);
//! * the rule that a blank server means "no outgoing server", so an untouched
//!   form stores nothing.
//!
//! The user name and the password are the incoming ones: an account that can
//! read a mailbox and cannot authenticate to its own provider's submission
//! server is the exception, not the rule, and a second credential field would
//! ask the user for the same password twice.

use std::collections::BTreeMap;

use serde_json::Value;

use super::user_endpoint::{normalize_host, normalize_port, SECURITIES};

/// Field key holding the outgoing server's hostname or IP literal.
pub(crate) const SERVER: &str = "sendServer";
/// Field key holding the outgoing server's port, as a decimal string.
pub(crate) const PORT: &str = "sendPort";
/// Field key holding `tls` (implicit TLS) or `starttls`.
pub(crate) const SECURITY: &str = "sendSecurity";

/// The keys a `userSend` slot reserves for the host. A plugin may not declare a
/// field with one of these, so the form it renders cannot decide where its own
/// message leaves from.
pub(crate) const RESERVED_KEYS: [&str; 3] = [SERVER, PORT, SECURITY];

/// What an account publishes back to the plugin: where it sends from. All three
/// are non-secret, so the whole set is readable; the password never is.
pub(crate) const PUBLIC_KEYS: [&str; 3] = [SERVER, PORT, SECURITY];

/// One user-configured outgoing server, normalized and ready to store.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct UserSend {
    pub server: String,
    pub port: u16,
    pub security: String,
}

impl UserSend {
    /// The three values as they are stored inside the instance's blob.
    pub(crate) fn to_fields(&self) -> BTreeMap<String, String> {
        let mut fields = BTreeMap::new();
        fields.insert(SERVER.to_string(), self.server.clone());
        fields.insert(PORT.to_string(), self.port.to_string());
        fields.insert(SECURITY.to_string(), self.security.clone());
        fields
    }
}

/// Whether a submitted value is a reserved key of a `userSend` slot.
pub(crate) fn is_reserved(key: &str) -> bool {
    RESERVED_KEYS.contains(&key)
}

fn value<'a>(fields: &'a BTreeMap<String, String>, key: &str) -> &'a str {
    fields.get(key).map(String::as_str).unwrap_or_default()
}

/// Read the three reserved values out of one submitted field map.
///
/// A blank `sendServer` means "this account sends through the plugin's preset
/// path, or not at all": whatever the form prefilled for the other two keys is
/// dropped rather than stored. Once a server is named, the other two have to be
/// usable — a half-configured endpoint would fail at send time instead of in
/// the form.
///
/// The message is safe to hand back: it names a field and a rule, never a
/// submitted value.
pub(crate) fn from_fields(
    fields: &BTreeMap<String, String>,
    securities: &[String],
) -> Result<Option<UserSend>, String> {
    if value(fields, SERVER).trim().is_empty() {
        return Ok(None);
    }
    if securities.is_empty() {
        return Err("this credential slot accepts no outgoing mail server".to_string());
    }
    if let Some(missing) = [PORT, SECURITY]
        .iter()
        .find(|key| value(fields, key).trim().is_empty())
    {
        return Err(format!(
            "a custom outgoing mail server needs sendServer, sendPort and sendSecurity; {missing} is missing"
        ));
    }
    let server = normalize_host(value(fields, SERVER), "outgoing mail server")?;
    let port = normalize_port(value(fields, PORT), "outgoing mail server")?;
    let security = value(fields, SECURITY).trim().to_ascii_lowercase();
    if !securities.iter().any(|declared| declared == &security) {
        return Err("the outgoing mail server security is not one this slot allows".to_string());
    }
    Ok(Some(UserSend {
        server,
        port,
        security,
    }))
}

/// Parse the manifest's `userSend.security` for one slot.
///
/// Install already refused anything else, so a malformed declaration here is
/// read as "no outgoing server" rather than as a slot nothing can fill: the
/// alternative would be a Settings sheet nobody can complete.
pub(crate) fn declared_securities(raw: Option<&Value>) -> Vec<String> {
    let Some(securities) = raw
        .and_then(|value| value.get("security"))
        .and_then(Value::as_array)
    else {
        return Vec::new();
    };
    let mut declared: Vec<String> = Vec::new();
    for security in securities {
        let Some(security) = security.as_str() else {
            continue;
        };
        let security = security.trim().to_ascii_lowercase();
        if !SECURITIES.contains(&security.as_str()) || declared.contains(&security) {
            continue;
        }
        declared.push(security);
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

    fn both() -> Vec<String> {
        declared_securities(Some(&json!({ "security": ["tls", "starttls"] })))
    }

    #[test]
    fn a_blank_server_means_no_outgoing_server() {
        assert_eq!(from_fields(&BTreeMap::new(), &both()).unwrap(), None);
        assert_eq!(
            from_fields(&submitted(&[(SERVER, "  ")]), &both()).unwrap(),
            None
        );
        // A form that prefilled the other two but never named a server stores
        // nothing rather than a half-chosen endpoint.
        assert_eq!(
            from_fields(
                &submitted(&[(SERVER, ""), (PORT, "465"), (SECURITY, "tls")]),
                &both()
            )
            .unwrap(),
            None
        );
    }

    #[test]
    fn a_complete_endpoint_is_normalized() {
        let fields = submitted(&[
            (SERVER, " SMTP.Example.COM. "),
            (PORT, "465"),
            (SECURITY, "TLS"),
        ]);
        let send = from_fields(&fields, &both()).unwrap().unwrap();
        assert_eq!(send.server, "smtp.example.com");
        assert_eq!(send.port, 465);
        assert_eq!(send.security, "tls");
        assert_eq!(
            send.to_fields().get(SERVER).map(String::as_str),
            Some("smtp.example.com")
        );
    }

    #[test]
    fn a_named_server_without_the_rest_is_refused() {
        for missing in [PORT, SECURITY] {
            let fields = submitted(&[(SERVER, "smtp.example.com"), (PORT, "587"), (SECURITY, "starttls")])
                .into_iter()
                .filter(|(key, _)| key != missing)
                .collect::<BTreeMap<_, _>>();
            let error = from_fields(&fields, &both()).unwrap_err();
            assert!(error.contains(missing), "{error}");
        }
    }

    #[test]
    fn only_declared_transports_are_accepted() {
        let starttls_only = declared_securities(Some(&json!({ "security": ["starttls"] })));
        assert!(
            from_fields(&submitted(&[(SERVER, "smtp.example.com"), (PORT, "465"), (SECURITY, "tls")]), &starttls_only)
                .is_err()
        );
        assert!(
            from_fields(&submitted(&[(SERVER, "smtp.example.com"), (PORT, "587"), (SECURITY, "none")]), &both())
                .is_err()
        );
    }

    #[test]
    fn a_slot_without_user_send_accepts_no_endpoint() {
        let error = from_fields(
            &submitted(&[(SERVER, "smtp.example.com"), (PORT, "587"), (SECURITY, "starttls")]),
            &[],
        )
        .unwrap_err();
        assert!(error.contains("accepts no outgoing mail server"), "{error}");
    }

    #[test]
    fn a_declaration_is_read_back_without_duplicates_or_unknown_values() {
        assert_eq!(
            declared_securities(Some(&json!({ "security": ["tls", "TLS", "none", "starttls"] }))),
            vec!["tls".to_string(), "starttls".to_string()]
        );
        assert!(declared_securities(Some(&json!({}))).is_empty());
        assert!(declared_securities(None).is_empty());
    }

    #[test]
    fn every_reserved_key_is_public_and_reserved() {
        for key in RESERVED_KEYS {
            assert!(is_reserved(key));
            assert!(PUBLIC_KEYS.contains(&key));
        }
    }
}