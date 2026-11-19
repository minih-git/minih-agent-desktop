//! Plugin credential slots (`contributes.credentials`) and their storage.
//!
//! A slot the user fills in Settings is one encrypted blob in the host secret
//! store, under the secret ref `plugin:<pluginId>:cred:<slotId>`. The plaintext
//! is the JSON object of that slot's declared fields, so a slot is stored and
//! cleared as a whole: a half-filled slot is never written and never injected.
//!
//! Two different things leave this module:
//!
//! * declaration metadata — slot id, title, kind, field keys and labels, scope —
//!   which the Settings sheet renders for a plugin whether it is enabled or
//!   disabled, because it is read from the installed `manifest.json` and never
//!   from the plugin process;
//! * the slot's values, only through [`resolve`], which the RPC layer exposes to
//!   Electron Main for host-owned egress injection.
//!
//! The renderer learns whether a slot is configured ([`status`] / [`list`]),
//! never a value, and no plugin-facing API exists at all. Nothing here logs a
//! field value, and the stored shape is never formatted into an error.
//!
//! Slots a manifest no longer declares still have to be removable, and a plugin
//! uninstall has to leave no secret behind even for those. The secret store
//! therefore carries a per-plugin index (`plugin:<pluginId>:cred-index`)
//! listing every slot this host has ever written for that plugin. The index is
//! encrypted like the slots, so it is not a second plaintext record of a user's
//! credentials, and it needs no database migration.

use super::{is_contrib_id, plugin_display_locale, PluginSummary};
use crate::secrets::SecretStore;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};

/// The slot exists in the manifest but has no usable stored value.
pub(crate) const CREDENTIAL_NOT_CONFIGURED: &str = "CREDENTIAL_NOT_CONFIGURED";
/// The submitted field set is not exactly what the slot declares.
pub(crate) const CREDENTIAL_INVALID: &str = "CREDENTIAL_INVALID";
/// The request names a slot the installed manifest does not declare.
pub(crate) const CREDENTIAL_SLOT_NOT_DECLARED: &str = "CREDENTIAL_SLOT_NOT_DECLARED";

/// Largest string one credential field may carry (8 KiB). The Settings sheet
/// asks for a token or a login, never a document; the bound keeps a malformed
/// caller from filling the encrypted store with one slot.
const MAX_FIELD_BYTES: usize = 8 * 1024;

/// What went wrong, in the terms the RPC layer maps to `data.errorCode`.
#[derive(Debug)]
pub(crate) enum CredentialError {
    /// The plugin's own manifest cannot be read or no longer matches its row.
    PluginInvalid(String),
    /// The request names a slot the manifest does not declare.
    SlotNotDeclared(String),
    /// The submitted fields violate the slot's declaration.
    Invalid(String),
    /// The slot is declared but holds nothing this host can inject.
    NotConfigured(String),
    /// The encrypted store failed. Messages never contain a field value.
    Storage(String),
}

impl std::fmt::Display for CredentialError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::PluginInvalid(message)
            | Self::SlotNotDeclared(message)
            | Self::Invalid(message)
            | Self::NotConfigured(message)
            | Self::Storage(message) => f.write_str(message),
        }
    }
}

fn storage(error: anyhow::Error) -> CredentialError {
    CredentialError::Storage(format!("credential store failure: {error}"))
}

/// One field of a slot as the manifest declares it. Only the declaration is
/// kept here — never a user's value.
#[derive(Debug, Clone)]
pub(crate) struct DeclaredField {
    pub key: String,
    /// `label`, still raw: a plain string or a per-locale object.
    pub label: Value,
    pub secret: bool,
}

/// One slot as the manifest declares it.
#[derive(Debug, Clone)]
pub(crate) struct DeclaredSlot {
    pub id: String,
    /// `title`, still raw: a plain string or a per-locale object.
    pub title: Value,
    pub kind: String,
    /// Fields in declaration order.
    pub fields: Vec<DeclaredField>,
    /// `scope.domains`; empty when the slot declares no scope, which the host
    /// reads as "injected nowhere".
    pub domains: Vec<String>,
}

impl DeclaredSlot {
    pub(crate) fn field_keys(&self) -> impl Iterator<Item = &str> {
        self.fields.iter().map(|field| field.key.as_str())
    }
}

/// On-disk shape of one slot. A wrapper rather than a bare map so the format
/// can grow (a rotation timestamp, say) without guessing what an old blob is.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredSlot {
    fields: BTreeMap<String, String>,
}

/// Every slot this host has written for one plugin, so an uninstall can clear
/// slots whose manifest declaration is already gone.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PluginIndex {
    slots: BTreeSet<String>,
}

impl PluginIndex {
    fn insert(&mut self, slot_id: &str) -> bool {
        self.slots.insert(slot_id.to_string())
    }

    fn remove(&mut self, slot_id: &str) -> bool {
        self.slots.remove(slot_id)
    }
}

fn slot_ref(plugin_id: &str, slot_id: &str) -> String {
    format!("plugin:{plugin_id}:cred:{slot_id}")
}

/// Deliberately not in the `plugin:<id>:cred:<slot>` family: a slot id passes
/// the contribution-id grammar and can never produce this ref.
fn index_ref(plugin_id: &str) -> String {
    format!("plugin:{plugin_id}:cred-index")
}

/// Last time a value was handed out, held in memory only.
///
/// Epoch milliseconds — the shape `PluginCredentialStatus` carries to the
/// renderer. Losing it on restart is the right trade: persisting it would write
/// an access log into the plugin's own record for a fact that has no
/// operational consequence.
fn last_used_map() -> &'static Mutex<BTreeMap<(String, String), i64>> {
    static LAST_USED: OnceLock<Mutex<BTreeMap<(String, String), i64>>> = OnceLock::new();
    LAST_USED.get_or_init(|| Mutex::new(BTreeMap::new()))
}

fn last_used_guard() -> MutexGuard<'static, BTreeMap<(String, String), i64>> {
    // A panic elsewhere must not turn every later credential read into a
    // failure: the map is plain data with no invariant to repair.
    last_used_map()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn remember_used(plugin_id: &str, slot_id: &str) {
    last_used_guard().insert(
        (plugin_id.to_string(), slot_id.to_string()),
        super::Utc::now().timestamp_millis(),
    );
}

fn forget_used(plugin_id: &str, slot_id: &str) {
    last_used_guard().remove(&(plugin_id.to_string(), slot_id.to_string()));
}

fn forget_plugin_usage(plugin_id: &str) {
    last_used_guard().retain(|(owner, _), _| owner != plugin_id);
}

pub(crate) fn last_used(plugin_id: &str, slot_id: &str) -> Option<i64> {
    last_used_guard()
        .get(&(plugin_id.to_string(), slot_id.to_string()))
        .copied()
}

/// Read the slots the installed manifest declares.
///
/// The declaration is a file the plugin's install wrote, so it is re-read here
/// and re-checked against the registry row's id: a slot id is part of a secret
/// ref and a field key decides what may be stored, so neither is taken on trust
/// from a stale row. A disabled plugin keeps its installed files, which is why
/// its slots still render in Settings.
pub(crate) fn declared_slots(plugin: &PluginSummary) -> Result<Vec<DeclaredSlot>, CredentialError> {
    let manifest_path = manifest_path(plugin)?;
    let raw = std::fs::read_to_string(&manifest_path).map_err(|_| {
        CredentialError::PluginInvalid(format!(
            "PLUGIN_INVALID: plugin {} is missing its manifest",
            plugin.id
        ))
    })?;
    let manifest: Value = serde_json::from_str(&raw).map_err(|_| {
        CredentialError::PluginInvalid(format!(
            "PLUGIN_INVALID: plugin {} has an unreadable manifest",
            plugin.id
        ))
    })?;
    if manifest.get("id").and_then(Value::as_str) != Some(plugin.id.as_str()) {
        return Err(CredentialError::PluginInvalid(format!(
            "PLUGIN_INVALID: plugin {} does not match the manifest at its install path",
            plugin.id
        )));
    }
    let entries = manifest
        .get("contributes")
        .and_then(Value::as_object)
        .and_then(|contributes| contributes.get("credentials"))
        .and_then(Value::as_array);
    let Some(entries) = entries else {
        return Ok(Vec::new());
    };
    let mut slots: Vec<DeclaredSlot> = Vec::with_capacity(entries.len());
    for entry in entries {
        let id = entry
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| is_contrib_id(id))
            .ok_or_else(|| {
                CredentialError::PluginInvalid(format!(
                    "PLUGIN_INVALID: plugin {} declares a credential slot without a valid id",
                    plugin.id
                ))
            })?;
        if slots.iter().any(|slot| slot.id == id) {
            return Err(CredentialError::PluginInvalid(format!(
                "PLUGIN_INVALID: plugin {} declares credential slot {id} twice",
                plugin.id
            )));
        }
        let Some(fields) = entry.get("fields").and_then(Value::as_array) else {
            return Err(CredentialError::PluginInvalid(format!(
                "PLUGIN_INVALID: credential slot {id} of plugin {} declares no fields",
                plugin.id
            )));
        };
        let mut declared_fields: Vec<DeclaredField> = Vec::with_capacity(fields.len());
        for field in fields {
            let key = field
                .get("key")
                .and_then(Value::as_str)
                .filter(|key| is_contrib_id(key))
                .ok_or_else(|| {
                    CredentialError::PluginInvalid(format!(
                        "PLUGIN_INVALID: credential slot {id} of plugin {} has a field without a valid key",
                        plugin.id
                    ))
                })?;
            if declared_fields.iter().any(|declared| declared.key == key) {
                return Err(CredentialError::PluginInvalid(format!(
                    "PLUGIN_INVALID: credential slot {id} of plugin {} declares field {key} twice",
                    plugin.id
                )));
            }
            declared_fields.push(DeclaredField {
                key: key.to_string(),
                label: field.get("label").cloned().unwrap_or(Value::Null),
                secret: field
                    .get("secret")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            });
        }
        if declared_fields.is_empty() {
            return Err(CredentialError::PluginInvalid(format!(
                "PLUGIN_INVALID: credential slot {id} of plugin {} declares no fields",
                plugin.id
            )));
        }
        let domains = entry
            .get("scope")
            .and_then(Value::as_object)
            .and_then(|scope| scope.get("domains"))
            .and_then(Value::as_array)
            .map(|domains| {
                domains
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::trim)
                    .filter(|domain| !domain.is_empty())
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        slots.push(DeclaredSlot {
            id: id.to_string(),
            title: entry.get("title").cloned().unwrap_or(Value::Null),
            kind: entry
                .get("kind")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            fields: declared_fields,
            domains,
        });
    }
    Ok(slots)
}

fn manifest_path(plugin: &PluginSummary) -> Result<PathBuf, CredentialError> {
    let path = plugin
        .path
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .ok_or_else(|| {
            CredentialError::PluginInvalid(format!(
                "PLUGIN_INVALID: plugin {} has no install path",
                plugin.id
            ))
        })?;
    Ok(Path::new(path).join("manifest.json"))
}

fn declared_slot(plugin: &PluginSummary, slot_id: &str) -> Result<DeclaredSlot, CredentialError> {
    if !is_contrib_id(slot_id) {
        return Err(CredentialError::Invalid(format!(
            "{CREDENTIAL_INVALID}: invalid credential slot id"
        )));
    }
    declared_slots(plugin)?
        .into_iter()
        .find(|slot| slot.id == slot_id)
        .ok_or_else(|| {
            CredentialError::SlotNotDeclared(format!(
                "{CREDENTIAL_SLOT_NOT_DECLARED}: plugin {} declares no credential slot {slot_id}",
                plugin.id
            ))
        })
}

/// Resolve one declared display string (`title`, a field `label`) for a locale.
///
/// Same order the rest of the plugin surface uses: the shell locale, then
/// English, then whichever translation exists. A plain string is the author's
/// own language and is returned as written.
fn declared_text(raw: &Value, locale: &str) -> String {
    match raw {
        Value::String(text) => text.trim().to_string(),
        Value::Object(map) => {
            let mut order = vec![plugin_display_locale(locale)];
            for key in ["en", "zh-CN"] {
                if !order.contains(&key) {
                    order.push(key);
                }
            }
            for key in order {
                if let Some(text) = map
                    .get(key)
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|text| !text.is_empty())
                {
                    return text.to_string();
                }
            }
            String::new()
        }
        _ => String::new(),
    }
}

/// Does a stored slot still hold every declared field?
///
/// A manifest that added a field makes an older blob incomplete. Reporting it
/// as unconfigured is the fail-closed answer: the user re-enters the slot
/// instead of the host injecting half a credential.
fn covers(stored: &StoredSlot, slot: &DeclaredSlot) -> bool {
    slot.field_keys().all(|key| stored.fields.contains_key(key))
}

fn read_slot(
    secrets: &SecretStore,
    plugin_id: &str,
    slot_id: &str,
) -> Result<Option<StoredSlot>, CredentialError> {
    let raw = match secrets.get(&slot_ref(plugin_id, slot_id)) {
        Ok(Some(raw)) => raw,
        Ok(None) => return Ok(None),
        Err(error) => return Err(storage(error)),
    };
    serde_json::from_str::<StoredSlot>(&raw)
        .map(Some)
        // Never echo the blob: a parse failure may still be plaintext-shaped.
        .map_err(|_| CredentialError::Storage("stored credential slot is unreadable".into()))
}

fn read_index(secrets: &SecretStore, plugin_id: &str) -> Result<PluginIndex, CredentialError> {
    match secrets.get(&index_ref(plugin_id)) {
        Ok(Some(raw)) => serde_json::from_str::<PluginIndex>(&raw)
            .map_err(|_| CredentialError::Storage("stored credential index is unreadable".into())),
        Ok(None) => Ok(PluginIndex::default()),
        Err(error) => Err(storage(error)),
    }
}

fn write_index(
    secrets: &SecretStore,
    plugin_id: &str,
    index: &PluginIndex,
) -> Result<(), CredentialError> {
    let reference = index_ref(plugin_id);
    if index.slots.is_empty() {
        return secrets.delete(&reference).map_err(storage);
    }
    let payload = serde_json::to_string(index).map_err(|error| storage(error.into()))?;
    secrets.set(&reference, &payload).map_err(storage)?;
    Ok(())
}

fn configured(
    secrets: &SecretStore,
    plugin_id: &str,
    slot: &DeclaredSlot,
) -> Result<bool, CredentialError> {
    Ok(read_slot(secrets, plugin_id, &slot.id)?
        .map(|stored| covers(&stored, slot))
        .unwrap_or(false))
}

/// Slot metadata plus `configured` / `lastUsedAt`, and not one stored value.
///
/// This is what the Settings sheet renders, for an enabled or a disabled plugin
/// alike: everything except the two state fields comes from the installed
/// manifest, so no plugin process is involved.
pub(crate) fn status(
    secrets: &SecretStore,
    plugin: &PluginSummary,
    locale: &str,
) -> Result<Value, CredentialError> {
    let declared = declared_slots(plugin)?;
    let mut slots = Vec::with_capacity(declared.len());
    for slot in &declared {
        let fields: Vec<Value> = slot
            .fields
            .iter()
            .map(|field| {
                json!({
                    "key": field.key,
                    "label": declared_text(&field.label, locale),
                    "secret": field.secret,
                })
            })
            .collect();
        slots.push(json!({
            "id": slot.id,
            "title": declared_text(&slot.title, locale),
            "kind": slot.kind,
            "fields": fields,
            "scope": { "domains": slot.domains },
            "configured": configured(secrets, &plugin.id, slot)?,
            "lastUsedAt": last_used(&plugin.id, &slot.id),
        }));
    }
    Ok(json!({ "slots": slots }))
}

/// The same slots with nothing but their state, for callers that only need to
/// know which ones are filled (the Plugins page badge, a pre-flight check).
pub(crate) fn list(
    secrets: &SecretStore,
    plugin: &PluginSummary,
) -> Result<Value, CredentialError> {
    let declared = declared_slots(plugin)?;
    let mut slots = Vec::with_capacity(declared.len());
    for slot in &declared {
        slots.push(json!({
            "id": slot.id,
            "configured": configured(secrets, &plugin.id, slot)?,
        }));
    }
    Ok(json!({ "slots": slots }))
}

/// Store one whole slot.
///
/// The index is written before the blob: a slot the index does not list would
/// survive an uninstall, while an index entry without a blob only costs one
/// failed delete later.
pub(crate) fn set(
    secrets: &SecretStore,
    plugin: &PluginSummary,
    slot_id: &str,
    fields: Map<String, Value>,
) -> Result<(), CredentialError> {
    let slot = declared_slot(plugin, slot_id)?;
    let values = validated_fields(&slot, fields)?;
    let mut index = read_index(secrets, &plugin.id)?;
    if index.insert(slot_id) {
        write_index(secrets, &plugin.id, &index)?;
    }
    let payload = serde_json::to_string(&StoredSlot { fields: values })
        .map_err(|error| storage(error.into()))?;
    secrets
        .set(&slot_ref(&plugin.id, slot_id), &payload)
        .map_err(storage)?;
    // A fresh value has not been handed to anyone yet.
    forget_used(&plugin.id, slot_id);
    Ok(())
}

/// Drop one slot. Returns whether a value was there.
///
/// The slot does not have to be declared any more: a manifest that dropped a
/// slot must not strand its stored value, so the plugin's existence is the only
/// precondition.
pub(crate) fn clear(
    secrets: &SecretStore,
    plugin: &PluginSummary,
    slot_id: &str,
) -> Result<bool, CredentialError> {
    if !is_contrib_id(slot_id) {
        return Err(CredentialError::Invalid(format!(
            "{CREDENTIAL_INVALID}: invalid credential slot id"
        )));
    }
    let reference = slot_ref(&plugin.id, slot_id);
    let existed = secrets.has(&reference);
    secrets.delete(&reference).map_err(storage)?;
    let mut index = read_index(secrets, &plugin.id)?;
    if index.remove(slot_id) {
        write_index(secrets, &plugin.id, &index)?;
    }
    forget_used(&plugin.id, slot_id);
    Ok(existed)
}

/// The declared fields of one slot, ready for host-owned injection.
///
/// This is the only path that returns plaintext, and it fails closed: an
/// incomplete blob, an undeclared field set or a missing value all answer
/// `CREDENTIAL_NOT_CONFIGURED` rather than a partial credential.
pub(crate) fn resolve(
    secrets: &SecretStore,
    plugin: &PluginSummary,
    slot_id: &str,
) -> Result<BTreeMap<String, String>, CredentialError> {
    let slot = declared_slot(plugin, slot_id)?;
    let not_configured = || {
        CredentialError::NotConfigured(format!(
            "{CREDENTIAL_NOT_CONFIGURED}: credential slot {slot_id} of plugin {} has no stored value",
            plugin.id
        ))
    };
    let stored = read_slot(secrets, &plugin.id, slot_id)?.ok_or_else(not_configured)?;
    let mut fields = BTreeMap::new();
    for key in slot.field_keys() {
        let value = stored.fields.get(key).ok_or_else(not_configured)?;
        fields.insert(key.to_string(), value.clone());
    }
    remember_used(&plugin.id, slot_id);
    Ok(fields)
}

/// Remove every slot this host stored for a plugin, including slots the current
/// manifest no longer declares, plus the plugin's index.
///
/// Called on uninstall only. Disabling a plugin keeps the values: re-enabling
/// must not ask the user to paste a token the host still holds.
pub(crate) fn purge_plugin(data_dir: &Path, plugin_id: &str) -> Result<usize, CredentialError> {
    let secrets = SecretStore::open(data_dir).map_err(storage)?;
    let index = read_index(&secrets, plugin_id)?;
    let mut removed = 0;
    for slot_id in &index.slots {
        let reference = slot_ref(plugin_id, slot_id);
        if secrets.has(&reference) {
            removed += 1;
        }
        secrets.delete(&reference).map_err(storage)?;
    }
    secrets.delete(&index_ref(plugin_id)).map_err(storage)?;
    forget_plugin_usage(plugin_id);
    Ok(removed)
}

/// The submitted map must be exactly the slot's declared fields, each a
/// non-empty string. Anything else is refused as a whole.
fn validated_fields(
    slot: &DeclaredSlot,
    fields: Map<String, Value>,
) -> Result<BTreeMap<String, String>, CredentialError> {
    if let Some(key) = fields
        .keys()
        .find(|key| !slot.field_keys().any(|declared| declared == *key))
    {
        return Err(CredentialError::Invalid(format!(
            "{CREDENTIAL_INVALID}: credential slot {} does not declare field {key}",
            slot.id
        )));
    }
    let mut values = BTreeMap::new();
    for key in slot.field_keys() {
        let value = fields.get(key).ok_or_else(|| {
            CredentialError::Invalid(format!(
                "{CREDENTIAL_INVALID}: credential slot {} is missing field {key}",
                slot.id
            ))
        })?;
        let value = value.as_str().ok_or_else(|| {
            CredentialError::Invalid(format!(
                "{CREDENTIAL_INVALID}: credential slot {} field {key} must be a string",
                slot.id
            ))
        })?;
        if value.trim().is_empty() {
            return Err(CredentialError::Invalid(format!(
                "{CREDENTIAL_INVALID}: credential slot {} field {key} is empty",
                slot.id
            )));
        }
        if value.len() > MAX_FIELD_BYTES {
            return Err(CredentialError::Invalid(format!(
                "{CREDENTIAL_INVALID}: credential slot {} field {key} exceeds {MAX_FIELD_BYTES} bytes",
                slot.id
            )));
        }
        values.insert(key.to_string(), value.to_string());
    }
    Ok(values)
}

#[cfg(test)]
#[path = "credentials_tests.rs"]
mod tests;
