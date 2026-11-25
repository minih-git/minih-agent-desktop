//! Validation for `AppSettings.browserProxyRouting` (ADR 0342).
//!
//! The routing table is read by Electron main only: it compiles the ordered
//! rules into a PAC script for the built-in browser session. host-core never
//! applies it, but it owns the settings blob, so it rejects a table that would
//! be unusable — an unknown rule type, an invalid pattern, a dangling proxy
//! reference, or a duplicate id — instead of storing it and failing later in
//! the browser.
//!
//! This mirrors `validateBrowserProxyRouting` in
//! `packages/shared/src/browser-proxy-routing.ts`. The renderer validates
//! first for inline feedback; this is the durable gate.

use serde_json::Value;

const MAX_PROFILES: usize = 32;
const MAX_RULES: usize = 200;
const MAX_ID_LENGTH: usize = 64;
const MAX_NAME_LENGTH: usize = 120;
const MAX_PATTERN_LENGTH: usize = 2048;

const RULE_KINDS: [&str; 5] = [
    "host-wildcard",
    "url-wildcard",
    "host-regex",
    "url-regex",
    "ip-cidr",
];

/// Sentinel target meaning "no proxy".
pub const DIRECT_TARGET: &str = "direct";

/// Validate the optional `browserProxyRouting` field of a settings write.
/// An absent or null field is accepted: a build without routing, or a user who
/// never opened the section, keeps the global proxy behaviour.
pub fn validate_browser_proxy_routing(value: &Value) -> Result<(), String> {
    let Some(object) = value.as_object() else {
        return Ok(());
    };
    let Some(routing) = object.get("browserProxyRouting") else {
        return Ok(());
    };
    if routing.is_null() {
        return Ok(());
    }
    let Some(routing) = routing.as_object() else {
        return Err("browserProxyRouting must be an object".into());
    };
    if let Some(enabled) = routing.get("enabled") {
        if !enabled.is_boolean() {
            return Err("browserProxyRouting.enabled must be a boolean".into());
        }
    }

    let profiles = validate_profiles(routing.get("profiles"))?;
    validate_rules(routing.get("rules"), &profiles)?;
    let default_target = routing
        .get("defaultTarget")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    if !is_known_target(default_target, &profiles) {
        return Err(format!(
            "browserProxyRouting.defaultTarget '{default_target}' is not a proxy id"
        ));
    }
    Ok(())
}

struct Profile {
    id: String,
}

fn validate_profiles(value: Option<&Value>) -> Result<Vec<Profile>, String> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    let Some(entries) = value.as_array() else {
        return Err("browserProxyRouting.profiles must be an array".into());
    };
    if entries.len() > MAX_PROFILES {
        return Err(format!(
            "browserProxyRouting.profiles holds more than {MAX_PROFILES} entries"
        ));
    }
    let mut profiles: Vec<Profile> = Vec::with_capacity(entries.len());
    for (index, entry) in entries.iter().enumerate() {
        let position = index + 1;
        let Some(entry) = entry.as_object() else {
            return Err(format!("proxy {position} must be an object"));
        };
        let Some(id) = entry.get("id").and_then(Value::as_str) else {
            return Err(format!("proxy {position} needs an id"));
        };
        let id = id.trim();
        if id.is_empty() || id.len() > MAX_ID_LENGTH {
            return Err(format!("proxy {position} has an unusable id"));
        }
        if profiles.iter().any(|profile| profile.id == id) {
            return Err(format!("duplicate proxy id '{id}'"));
        }
        if let Some(name) = entry.get("name") {
            let Some(name) = name.as_str() else {
                return Err(format!("proxy '{id}' name must be a string"));
            };
            if name.trim().len() > MAX_NAME_LENGTH {
                return Err(format!(
                    "proxy '{id}' name is longer than {MAX_NAME_LENGTH} characters"
                ));
            }
        }
        let Some(url) = entry.get("url").and_then(Value::as_str) else {
            return Err(format!("proxy '{id}' needs a URL"));
        };
        crate::network_proxy::parse_proxy_url(url)
            .map_err(|error| format!("proxy '{id}': {error}"))?;
        profiles.push(Profile { id: id.to_string() });
    }
    Ok(profiles)
}

fn validate_rules(value: Option<&Value>, profiles: &[Profile]) -> Result<(), String> {
    let Some(value) = value else {
        return Ok(());
    };
    let Some(entries) = value.as_array() else {
        return Err("browserProxyRouting.rules must be an array".into());
    };
    if entries.len() > MAX_RULES {
        return Err(format!(
            "browserProxyRouting.rules holds more than {MAX_RULES} entries"
        ));
    }
    let mut ids: Vec<&str> = Vec::with_capacity(entries.len());
    for (index, entry) in entries.iter().enumerate() {
        let position = index + 1;
        let Some(entry) = entry.as_object() else {
            return Err(format!("rule {position} must be an object"));
        };
        let Some(id) = entry.get("id").and_then(Value::as_str) else {
            return Err(format!("rule {position} needs an id"));
        };
        let id = id.trim();
        if id.is_empty() || id.len() > MAX_ID_LENGTH {
            return Err(format!("rule {position} has an unusable id"));
        }
        if ids.contains(&id) {
            return Err(format!("duplicate rule id '{id}'"));
        }
        ids.push(id);
        let Some(kind) = entry.get("kind").and_then(Value::as_str) else {
            return Err(format!("rule '{id}' needs a type"));
        };
        if !RULE_KINDS.contains(&kind) {
            return Err(format!("rule '{id}' has unknown type '{kind}'"));
        }
        let Some(pattern) = entry.get("pattern").and_then(Value::as_str) else {
            return Err(format!("rule '{id}' needs a pattern"));
        };
        if pattern.trim().is_empty() {
            return Err(format!("rule '{id}' needs a pattern"));
        }
        if pattern.len() > MAX_PATTERN_LENGTH {
            return Err(format!(
                "rule '{id}' pattern is longer than {MAX_PATTERN_LENGTH} characters"
            ));
        }
        if kind == "ip-cidr" && !is_cidr(pattern) {
            return Err(format!(
                "rule '{id}' pattern must be an address with a prefix, such as 10.0.0.0/8"
            ));
        }
        let target = entry
            .get("target")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or("");
        if !is_known_target(target, profiles) {
            return Err(format!("rule '{id}' target '{target}' is not a proxy id"));
        }
    }
    Ok(())
}

fn is_known_target(target: &str, profiles: &[Profile]) -> bool {
    target == DIRECT_TARGET || profiles.iter().any(|profile| profile.id == target)
}

/// Prefix range check without parsing the address: the renderer and Electron
/// main own the exact matcher, and a wrong address here only means a rule that
/// never matches.
fn is_cidr(pattern: &str) -> bool {
    let Some((address, prefix)) = pattern.trim().rsplit_once('/') else {
        return false;
    };
    if address.is_empty() || address.contains(char::is_whitespace) {
        return false;
    }
    let Ok(prefix) = prefix.trim().parse::<u8>() else {
        return false;
    };
    let max = if address.contains(':') { 128 } else { 32 };
    prefix <= max
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn table(value: Value) -> Value {
        json!({ "browserProxyRouting": value })
    }

    #[test]
    fn absent_or_disabled_routing_is_accepted() {
        assert!(validate_browser_proxy_routing(&json!({})).is_ok());
        assert!(validate_browser_proxy_routing(&table(Value::Null)).is_ok());
        assert!(validate_browser_proxy_routing(&table(json!({
            "enabled": false,
            "defaultTarget": "direct"
        })))
        .is_ok());
    }

    #[test]
    fn a_table_needs_an_explicit_default_exit() {
        // The editor always writes one, and a stored table without it would
        // have to guess where unmatched traffic goes.
        let value = table(json!({ "enabled": true }));
        let error = validate_browser_proxy_routing(&value).unwrap_err();
        assert!(error.contains("defaultTarget"), "{error}");
    }

    #[test]
    fn a_complete_table_is_accepted() {
        let value = table(json!({
            "enabled": true,
            "profiles": [
                { "id": "office", "name": "Office", "url": "http://10.1.1.1:3128" },
                { "id": "secure", "name": "Secure", "url": "socks5://u:p@127.0.0.1:1080" }
            ],
            "rules": [
                { "id": "r1", "kind": "host-wildcard", "pattern": "*.corp", "target": "office" },
                { "id": "r2", "kind": "ip-cidr", "pattern": "10.0.0.0/8", "target": "secure" }
            ],
            "defaultTarget": "direct"
        }));
        assert_eq!(validate_browser_proxy_routing(&value), Ok(()));
    }

    #[test]
    fn dangling_references_are_rejected() {
        let dangling_rule = table(json!({
            "rules": [{ "id": "r1", "kind": "host-wildcard", "pattern": "*.corp", "target": "gone" }],
            "defaultTarget": "direct"
        }));
        assert!(validate_browser_proxy_routing(&dangling_rule).is_err());

        let dangling_default = table(json!({ "defaultTarget": "gone" }));
        assert!(validate_browser_proxy_routing(&dangling_default).is_err());

        let no_default = table(json!({ "rules": [] }));
        assert!(validate_browser_proxy_routing(&no_default).is_err());
    }

    #[test]
    fn duplicate_ids_are_rejected() {
        let value = table(json!({
            "profiles": [
                { "id": "p", "url": "http://10.1.1.1:3128" },
                { "id": "p", "url": "http://10.1.1.2:3128" }
            ],
            "defaultTarget": "direct"
        }));
        let error = validate_browser_proxy_routing(&value).unwrap_err();
        assert!(error.contains("duplicate proxy id"), "{error}");
    }

    #[test]
    fn invalid_proxy_urls_and_types_are_rejected() {
        let bad_url = table(json!({
            "profiles": [{ "id": "p", "url": "ftp://10.1.1.1:3128" }],
            "defaultTarget": "direct"
        }));
        assert!(validate_browser_proxy_routing(&bad_url).is_err());

        let bad_kind = table(json!({
            "rules": [{ "id": "r1", "kind": "nope", "pattern": "x", "target": "direct" }],
            "defaultTarget": "direct"
        }));
        let error = validate_browser_proxy_routing(&bad_kind).unwrap_err();
        assert!(error.contains("unknown type"), "{error}");
    }

    #[test]
    fn cidr_rules_need_a_prefix_in_range() {
        let value = |pattern: &str| {
            table(json!({
                "rules": [{ "id": "r1", "kind": "ip-cidr", "pattern": pattern, "target": "direct" }],
                "defaultTarget": "direct"
            }))
        };
        assert!(validate_browser_proxy_routing(&value("10.0.0.0/8")).is_ok());
        assert!(validate_browser_proxy_routing(&value("fe80::/10")).is_ok());
        assert!(validate_browser_proxy_routing(&value("10.0.0.0")).is_err());
        assert!(validate_browser_proxy_routing(&value("10.0.0.0/33")).is_err());
        assert!(validate_browser_proxy_routing(&value("fe80::/129")).is_err());
    }

    #[test]
    fn pattern_and_id_lengths_are_bounded() {
        let long_pattern = "a".repeat(MAX_PATTERN_LENGTH + 1);
        let value = table(json!({
            "rules": [{ "id": "r1", "kind": "host-wildcard", "pattern": long_pattern, "target": "direct" }],
            "defaultTarget": "direct"
        }));
        assert!(validate_browser_proxy_routing(&value).is_err());
    }

    #[test]
    fn pattern_objects_are_reported_by_position() {
        let value = table(json!({ "rules": ["nope"], "defaultTarget": "direct" }));
        let error = validate_browser_proxy_routing(&value).unwrap_err();
        assert!(error.contains("rule 1 must be an object"), "{error}");
    }
}
