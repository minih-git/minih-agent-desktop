//! Host capability blocks from the phase 2B design (插件宿主能力六项):
//! `contributes.credentials` / `webhooks` / `schedules`, plus the top-level
//! `manifest.net.tcp` and `manifest.tasks` blocks.
//!
//! The plugin SDK carries the same checks for authors and editors. The host
//! repeats them at the install boundary because a manifest is JSON from disk
//! and nothing guarantees it passed an SDK validator. A permission is the
//! switch, the manifest field carries the range, and execution stays in the
//! host — nothing here performs work.

use anyhow::{anyhow, bail, Result};
use serde_json::{Map, Value};

use super::labels::is_plugin_label;
use super::{array_of, is_contrib_id, require_permission, PluginManifest};

/// `contributes.credentials[].kind` — how the host injects the stored secret.
const CREDENTIAL_KINDS: [&str; 5] = ["basic", "bearer", "header", "oauth2", "imap"];

/// Largest request body a webhook receiver accepts (256 KiB), mirroring
/// `MAX_WEBHOOK_BODY_BYTES` in the plugin SDK.
const MAX_WEBHOOK_BODY_BYTES: u64 = 262_144;
/// Accepted requests per minute per webhook, mirroring the SDK ceiling.
const MAX_WEBHOOK_RATE_PER_MINUTE: u64 = 120;
/// The scheduler's floor; a faster interval is refused rather than rounded.
const MIN_SCHEDULE_INTERVAL_MINUTES: u64 = 1;
/// Highest permission mode a plugin-created task may run with.
const TASK_PERMISSION_MODES: [&str; 3] = ["ask", "accept-edits", "auto"];

/// Validate the three host-capability contribution blocks.
pub(super) fn validate_contributes(
    map: &Map<String, Value>,
    manifest: &PluginManifest,
) -> Result<()> {
    validate_credentials(map, manifest)?;
    validate_webhooks(map, manifest)?;
    validate_schedules(map, manifest)?;
    Ok(())
}

/// Validate the top-level blocks the manifest keeps outside `contributes`.
pub(crate) fn validate_manifest_capabilities(raw: &Value, manifest: &PluginManifest) -> Result<()> {
    validate_net_tcp(raw.get("net"), manifest)?;
    validate_tasks(raw.get("tasks"), manifest)?;
    Ok(())
}

/// `contributes.credentials`: every slot is user-filled, so the shape is
/// checked at install. A slot the Settings sheet cannot render is a dead
/// permission, and a scope nobody can inject into is an authoring slip.
fn validate_credentials(map: &Map<String, Value>, manifest: &PluginManifest) -> Result<()> {
    let Some(credentials) = map.get("credentials") else {
        return Ok(());
    };
    let entries = array_of(credentials, "contributes.credentials")?;
    let mut seen: Vec<&str> = Vec::new();
    for entry in entries {
        let obj = entry.as_object().ok_or_else(|| {
            anyhow!("PLUGIN_INVALID: contributes.credentials entry must be an object")
        })?;
        let id = obj
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| is_contrib_id(id))
            .ok_or_else(|| anyhow!("PLUGIN_INVALID: credential id is missing or invalid"))?;
        if seen.contains(&id) {
            bail!("PLUGIN_INVALID: duplicate credential id {id}");
        }
        seen.push(id);
        if !obj.get("title").is_some_and(is_plugin_label) {
            bail!("PLUGIN_INVALID: credential {id} requires a title");
        }
        let kind = obj
            .get("kind")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("PLUGIN_INVALID: credential {id} requires a kind"))?;
        if !CREDENTIAL_KINDS.contains(&kind) {
            bail!("PLUGIN_INVALID: credential {id} has unsupported kind {kind}");
        }
        let fields = obj
            .get("fields")
            .map(|fields| array_of(fields, "contributes.credentials.fields"))
            .transpose()?
            .unwrap_or(&[]);
        if fields.is_empty() {
            bail!("PLUGIN_INVALID: credential {id} requires fields");
        }
        let mut keys: Vec<&str> = Vec::new();
        for field in fields {
            let field = field
                .as_object()
                .ok_or_else(|| anyhow!("PLUGIN_INVALID: credential {id} fields must be objects"))?;
            let key = field
                .get("key")
                .and_then(Value::as_str)
                .filter(|key| is_contrib_id(key))
                .ok_or_else(|| {
                    anyhow!("PLUGIN_INVALID: credential {id} field key is missing or invalid")
                })?;
            if keys.contains(&key) {
                bail!("PLUGIN_INVALID: credential {id} declares field {key} twice");
            }
            keys.push(key);
            if !field.get("label").is_some_and(is_plugin_label) {
                bail!("PLUGIN_INVALID: credential {id} field {key} requires a label");
            }
            if let Some(secret) = field.get("secret") {
                if !secret.is_boolean() {
                    bail!("PLUGIN_INVALID: credential {id} field {key} secret must be a boolean");
                }
            }
        }
        if let Some(scope) = obj.get("scope") {
            let scope = scope.as_object().ok_or_else(|| {
                anyhow!("PLUGIN_INVALID: credential {id} scope must be an object")
            })?;
            validate_scope_domains(scope.get("domains"), id)?;
        }
    }
    if !entries.is_empty() {
        require_permission(manifest, "credentials.use", "credential slots")?;
    }
    Ok(())
}

/// Credential scopes reuse the egress grammar: a bare hostname or `*.suffix`,
/// at least one entry. Absent means the slot injects nowhere, which is the same
/// fail-closed rule as `manifest.net.domains`.
fn validate_scope_domains(raw: Option<&Value>, id: &str) -> Result<()> {
    let entries = match raw {
        Some(value) => array_of(value, "credential scope.domains")?,
        None => &[],
    };
    if entries.is_empty() {
        bail!("PLUGIN_INVALID: credential {id} scope needs at least one domain");
    }
    for entry in entries {
        let value = entry
            .as_str()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                anyhow!("PLUGIN_INVALID: credential {id} scope domains must be non-empty strings")
            })?;
        let value = value.to_ascii_lowercase();
        if value == "*" {
            bail!("PLUGIN_INVALID: credential {id} scope must not contain \"*\"");
        }
        if value.contains([':', '/', '?', '#']) {
            bail!("PLUGIN_INVALID: credential {id} scope domain {value} must be a bare hostname");
        }
        if !is_hostname(value.strip_prefix("*.").unwrap_or(&value)) {
            bail!("PLUGIN_INVALID: credential {id} scope domain {value} is not a valid hostname");
        }
    }
    Ok(())
}

/// `contributes.webhooks`: the receiver is host-owned. The body and rate
/// ceilings bound the resources a request can spend; source and token checks
/// are enforced by the listener.
fn validate_webhooks(map: &Map<String, Value>, manifest: &PluginManifest) -> Result<()> {
    let Some(webhooks) = map.get("webhooks") else {
        return Ok(());
    };
    let entries = array_of(webhooks, "contributes.webhooks")?;
    let mut seen: Vec<&str> = Vec::new();
    for entry in entries {
        let obj = entry.as_object().ok_or_else(|| {
            anyhow!("PLUGIN_INVALID: contributes.webhooks entry must be an object")
        })?;
        let id = obj
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| is_contrib_id(id))
            .ok_or_else(|| anyhow!("PLUGIN_INVALID: webhook id is missing or invalid"))?;
        if seen.contains(&id) {
            bail!("PLUGIN_INVALID: duplicate webhook id {id}");
        }
        seen.push(id);
        if !obj.get("title").is_some_and(is_plugin_label) {
            bail!("PLUGIN_INVALID: webhook {id} requires a title");
        }
        if let Some(limit) = obj.get("maxBodyBytes") {
            match limit.as_u64() {
                Some(bytes) if (1..=MAX_WEBHOOK_BODY_BYTES).contains(&bytes) => {}
                _ => bail!(
                    "PLUGIN_INVALID: webhook {id} maxBodyBytes must be an integer from 1 to {MAX_WEBHOOK_BODY_BYTES}"
                ),
            }
        }
        if let Some(limit) = obj.get("ratePerMinute") {
            match limit.as_u64() {
                Some(rate) if (1..=MAX_WEBHOOK_RATE_PER_MINUTE).contains(&rate) => {}
                _ => bail!(
                    "PLUGIN_INVALID: webhook {id} ratePerMinute must be an integer from 1 to {MAX_WEBHOOK_RATE_PER_MINUTE}"
                ),
            }
        }
    }
    if !entries.is_empty() {
        require_permission(manifest, "inbound.webhook", "webhook receivers")?;
    }
    Ok(())
}

/// `contributes.schedules`: one timer is either a fixed interval or a cron
/// expression, never both. Two declarations for one tick would leave the host
/// picking one and the author believing the other.
fn validate_schedules(map: &Map<String, Value>, manifest: &PluginManifest) -> Result<()> {
    let Some(schedules) = map.get("schedules") else {
        return Ok(());
    };
    let entries = array_of(schedules, "contributes.schedules")?;
    let mut seen: Vec<&str> = Vec::new();
    for entry in entries {
        let obj = entry.as_object().ok_or_else(|| {
            anyhow!("PLUGIN_INVALID: contributes.schedules entry must be an object")
        })?;
        let id = obj
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| is_contrib_id(id))
            .ok_or_else(|| anyhow!("PLUGIN_INVALID: schedule id is missing or invalid"))?;
        if seen.contains(&id) {
            bail!("PLUGIN_INVALID: duplicate schedule id {id}");
        }
        seen.push(id);
        if !obj.get("title").is_some_and(is_plugin_label) {
            bail!("PLUGIN_INVALID: schedule {id} requires a title");
        }
        let every = obj.get("every");
        let cron = obj.get("cron");
        if every.is_some() == cron.is_some() {
            bail!("PLUGIN_INVALID: schedule {id} needs exactly one of every or cron");
        }
        if let Some(every) = every {
            let valid = every.as_str().is_some_and(is_valid_every);
            if !valid {
                bail!(
                    "PLUGIN_INVALID: schedule {id} every must be an interval of at least one minute, e.g. \"5m\""
                );
            }
        }
        if let Some(cron) = cron {
            if !cron.as_str().is_some_and(is_valid_cron) {
                bail!("PLUGIN_INVALID: schedule {id} cron must be a five-field expression");
            }
        }
        if let Some(run_when) = obj.get("runWhen") {
            if !matches!(run_when.as_str(), Some("always" | "idle")) {
                bail!("PLUGIN_INVALID: schedule {id} runWhen must be \"always\" or \"idle\"");
            }
        }
    }
    if !entries.is_empty() {
        require_permission(manifest, "scheduler", "plugin schedules")?;
    }
    Ok(())
}

/// Fixed interval, `<n><s|m|h|d>`. Seconds are accepted only at one minute or
/// more, because a faster declaration would silently become something else.
fn is_valid_every(value: &str) -> bool {
    let trimmed = value.trim();
    let Some(unit) = trimmed.chars().last() else {
        return false;
    };
    if !matches!(unit, 's' | 'm' | 'h' | 'd') {
        return false;
    }
    let amount = &trimmed[..trimmed.len() - unit.len_utf8()];
    // `[1-9][0-9]*`: no leading zero, no sign, and no exponent.
    if amount.is_empty()
        || amount.len() > 18
        || amount.starts_with('0')
        || !amount.chars().all(|digit| digit.is_ascii_digit())
    {
        return false;
    }
    let Ok(amount) = amount.parse::<u64>() else {
        return false;
    };
    if unit == 's' {
        return amount >= MIN_SCHEDULE_INTERVAL_MINUTES * 60;
    }
    true
}

/// Five fields, each a cron token; sub-minute granularity is not expressible.
fn is_valid_cron(value: &str) -> bool {
    let fields: Vec<&str> = value.split_whitespace().collect();
    fields.len() == 5 && fields.iter().all(|field| is_cron_field(field))
}

fn is_cron_field(field: &str) -> bool {
    let mut chars = field.chars();
    match chars.next() {
        Some(first) if first.is_ascii_digit() || first == '*' => chars.all(|character| {
            character.is_ascii_digit() || matches!(character, '*' | ',' | '/' | '-')
        }),
        _ => false,
    }
}

/// `manifest.net.tcp`: literal endpoints only, and the `net.tcp` permission is
/// the switch — the same fail-closed rule as `net.domains`.
///
/// There is no entry cap: four is the ceiling on how many connections may be
/// open at once, not on how many endpoints an author may declare.
fn validate_net_tcp(net: Option<&Value>, manifest: &PluginManifest) -> Result<()> {
    let Some(net) = net else {
        return Ok(());
    };
    let net = net
        .as_object()
        .ok_or_else(|| anyhow!("PLUGIN_INVALID: manifest.net must be an object"))?;
    let Some(tcp) = net.get("tcp") else {
        return Ok(());
    };
    let entries = array_of(tcp, "manifest.net.tcp")?;
    let mut seen: Vec<(String, u64)> = Vec::new();
    for entry in entries {
        let endpoint = entry
            .as_object()
            .ok_or_else(|| anyhow!("PLUGIN_INVALID: manifest.net.tcp entries must be objects"))?;
        let host = endpoint
            .get("host")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|host| !host.is_empty())
            .ok_or_else(|| anyhow!("PLUGIN_INVALID: manifest.net.tcp entries need a host"))?;
        let host = host.to_ascii_lowercase();
        if host.contains('*') {
            bail!("PLUGIN_INVALID: manifest.net.tcp host must be literal, not {host}");
        }
        if host.contains([':', '/', '?', '#']) || !is_hostname(&host) {
            bail!("PLUGIN_INVALID: manifest.net.tcp host is not a bare hostname: {host}");
        }
        let port = endpoint
            .get("port")
            .and_then(Value::as_u64)
            .filter(|port| (1..=65535).contains(port))
            .ok_or_else(|| {
                anyhow!("PLUGIN_INVALID: manifest.net.tcp {host} needs a port from 1 to 65535")
            })?;
        if !endpoint.get("tls").is_some_and(Value::is_boolean) {
            bail!("PLUGIN_INVALID: manifest.net.tcp {host}:{port} needs tls: true or false");
        }
        if seen.contains(&(host.clone(), port)) {
            bail!("PLUGIN_INVALID: manifest.net.tcp lists {host}:{port} twice");
        }
        seen.push((host, port));
    }
    if !entries.is_empty() {
        require_permission(manifest, "net.tcp", "raw tcp endpoints")?;
    }
    Ok(())
}

/// `manifest.tasks`: the ceiling a plugin-created task may run with. A word the
/// host does not know would silently become `accept-edits`, so it is refused at
/// install instead; declaring a higher ceiling than the employee's own is
/// harmless because the host takes the lower one.
fn validate_tasks(tasks: Option<&Value>, manifest: &PluginManifest) -> Result<()> {
    let Some(tasks) = tasks else {
        return Ok(());
    };
    let tasks = tasks
        .as_object()
        .ok_or_else(|| anyhow!("PLUGIN_INVALID: manifest.tasks must be an object"))?;
    let Some(manage) = tasks.get("manage") else {
        return Ok(());
    };
    let manage = manage
        .as_object()
        .ok_or_else(|| anyhow!("PLUGIN_INVALID: manifest.tasks.manage must be an object"))?;
    let Some(max_permission) = manage.get("maxPermission") else {
        return Ok(());
    };
    let mode = max_permission.as_str().unwrap_or_default();
    if !TASK_PERMISSION_MODES.contains(&mode) {
        bail!(
            "PLUGIN_INVALID: manifest.tasks.manage.maxPermission must be one of ask, accept-edits, auto"
        );
    }
    require_permission(manifest, "tasks.manage", "task permission ceilings")?;
    Ok(())
}

/// Mirrors `HOSTNAME` in the plugin SDK's egress policy: dot-separated labels
/// that start and end alphanumeric. `value` is already lowercased.
fn is_hostname(value: &str) -> bool {
    !value.is_empty()
        && value.split('.').all(|label| {
            !label.is_empty()
                && label.starts_with(|character: char| character.is_ascii_alphanumeric())
                && label.ends_with(|character: char| character.is_ascii_alphanumeric())
                && label
                    .chars()
                    .all(|character| character.is_ascii_alphanumeric() || character == '-')
        })
}
