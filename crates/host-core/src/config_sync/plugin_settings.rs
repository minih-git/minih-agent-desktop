//! Declared plugin settings travel separately from installation intent. Older
//! clients reject the unknown domain instead of publishing their absence as a
//! deletion. Arbitrary plugin files, credentials and absolute paths stay local.
use super::domains::{entity, PortableEntity, DOMAIN_PLUGIN_SETTINGS};
use crate::plugins::{settings, PluginSettingDefinition, PluginSummary};
use crate::state::AppState;
use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeSet;

const MAX_SYNC_BYTES: usize = 64 * 1024;
const MAX_KEYS: usize = 256;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Payload {
    plugin_id: String,
    /// Explicitly managed keys distinguish a reset from a device-local field.
    keys: Vec<String>,
    values: Map<String, Value>,
}

fn private_key(key: &str) -> bool {
    let normalized: String = key
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect();
    key.starts_with('_')
        || [
            "password",
            "passwd",
            "passphrase",
            "secret",
            "apikey",
            "accesskey",
            "accesstoken",
            "refreshtoken",
            "authtoken",
            "authorization",
            "cookie",
        ]
        .iter()
        .any(|part| normalized.contains(part))
}

fn portable_value(value: &Value, depth: usize) -> bool {
    if depth > 16 {
        return false;
    }
    match value {
        Value::String(text) => {
            let text = text.trim();
            let bytes = text.as_bytes();
            !text.starts_with('/')
                && !text.starts_with('\\')
                && !text.starts_with("~/")
                && !text.starts_with("~\\")
                && !text.starts_with("file:")
                && !(bytes.len() > 2
                    && bytes[0].is_ascii_alphabetic()
                    && bytes[1] == b':'
                    && matches!(bytes[2], b'/' | b'\\'))
                && !crate::memory::secrets::looks_like_credential(text)
        }
        Value::Array(items) => items.iter().all(|item| portable_value(item, depth + 1)),
        Value::Object(items) => items
            .iter()
            .all(|(key, item)| !private_key(key) && portable_value(item, depth + 1)),
        _ => true,
    }
}

fn matches_type(definition: &PluginSettingDefinition, value: &Value) -> bool {
    match definition.setting_type.as_str() {
        "string" | "model" | "shortcut" => value.is_string(),
        "number" => value.is_number(),
        "boolean" => value.is_boolean(),
        "select" => definition
            .enum_values
            .iter()
            .any(|option| option.value == *value),
        "json" => true,
        _ => false,
    }
}

fn capture_plugin(st: &AppState, plugin: &PluginSummary) -> Result<Option<PortableEntity>> {
    if plugin.settings.is_empty() || plugin.scope.mode != crate::activation::ActivationMode::Global
    {
        return Ok(None);
    }
    if !settings::exists(&st.data_dir, &plugin.id)? {
        return Ok(None);
    }
    let stored = settings::read(&st.data_dir, &plugin.id)?;
    let mut payload = Payload {
        plugin_id: plugin.id.clone(),
        keys: Vec::new(),
        values: Map::new(),
    };
    for definition in &plugin.settings {
        if private_key(&definition.key) {
            continue;
        }
        if let Some(value) = stored.get(&definition.key) {
            if !matches_type(definition, value) {
                bail!("CONFIG_SYNC_INVALID: a declared plugin setting has an incompatible value");
            }
            if !portable_value(value, 0) {
                continue;
            }
            payload.values.insert(definition.key.clone(), value.clone());
        } else if definition
            .default
            .as_ref()
            .is_some_and(|value| !portable_value(value, 0))
        {
            continue;
        }
        payload.keys.push(definition.key.clone());
    }
    payload.keys.sort();
    if payload.keys.is_empty() {
        return Ok(None);
    }
    if payload.keys.len() > MAX_KEYS || serde_json::to_vec(&payload)?.len() > MAX_SYNC_BYTES {
        bail!("CONFIG_SYNC_LIMIT_EXCEEDED: declared plugin settings are too large");
    }
    Ok(Some(entity(
        DOMAIN_PLUGIN_SETTINGS,
        format!("plugin-settings:{}", plugin.id),
        plugin.name.clone(),
        serde_json::to_value(payload)?,
        true,
        false,
        false,
        Vec::new(),
    )))
}

pub(crate) fn capture(st: &AppState) -> Result<Vec<PortableEntity>> {
    st.plugins
        .list()
        .iter()
        .filter_map(|plugin| capture_plugin(st, plugin).transpose())
        .collect()
}

fn decode(entity: &PortableEntity) -> Result<Payload> {
    if serde_json::to_vec(&entity.payload)?.len() > MAX_SYNC_BYTES {
        bail!("CONFIG_SYNC_LIMIT_EXCEEDED: declared plugin settings are too large");
    }
    let payload: Payload = serde_json::from_value(entity.payload.clone())
        .map_err(|_| anyhow::anyhow!("CONFIG_SYNC_INVALID: invalid plugin settings payload"))?;
    let expected = format!("plugin-settings:{}", payload.plugin_id);
    let identity = entity
        .entity_id
        .strip_suffix(":local")
        .or_else(|| entity.entity_id.strip_suffix(":remote"))
        .unwrap_or(&entity.entity_id);
    if identity != expected
        || (!entity.deleted && !entity.requires_approval)
        || entity.secret_bearing
        || entity.mapping_required
        || !entity.resource_ids.is_empty()
    {
        bail!("CONFIG_SYNC_INVALID: invalid plugin settings identity or approval policy");
    }
    let keys: BTreeSet<_> = payload.keys.iter().collect();
    if keys.len() != payload.keys.len()
        || keys.len() > MAX_KEYS
        || keys.iter().any(|key| private_key(key))
        || payload
            .values
            .iter()
            .any(|(key, value)| !keys.contains(key) || !portable_value(value, 0))
    {
        bail!("CONFIG_SYNC_INVALID: plugin settings contain non-portable fields");
    }
    Ok(payload)
}

pub(crate) fn validate(entity: &PortableEntity) -> Result<()> {
    decode(entity).map(|_| ())
}

pub(crate) fn apply(st: &AppState, entity: &PortableEntity) -> Result<()> {
    let payload = decode(entity)?;
    if entity.deleted {
        return Ok(());
    }
    let Some(plugin) = st.plugins.get(&payload.plugin_id) else {
        bail!("CONFIG_SYNC_DEPENDENCY: install the plugin before restoring its settings");
    };
    if plugin.scope.mode != crate::activation::ActivationMode::Global {
        bail!("CONFIG_SYNC_DEPENDENCY: plugin settings require a global installation");
    }
    // Validate the complete incoming patch before writing any field.
    for key in &payload.keys {
        let Some(definition) = plugin
            .settings
            .iter()
            .find(|definition| definition.key == *key)
        else {
            bail!("CONFIG_SYNC_DEPENDENCY: installed plugin does not declare a synced setting");
        };
        if payload
            .values
            .get(key)
            .is_some_and(|value| !matches_type(definition, value))
        {
            bail!("CONFIG_SYNC_INVALID: synced plugin setting has an incompatible type");
        }
        if definition.setting_type == "model" {
            if let Some(model) = payload
                .values
                .get(key)
                .and_then(Value::as_str)
                .filter(|model| !model.is_empty())
            {
                let Some((provider_id, model_id)) = model.split_once('/') else {
                    bail!("CONFIG_SYNC_INVALID: synced plugin model is not a provider/model key");
                };
                if model_id.is_empty()
                    || crate::providers::get_provider(&st.db, &st.secrets, provider_id)?.is_none()
                {
                    bail!("CONFIG_SYNC_DEPENDENCY: synced plugin model provider is unavailable");
                }
            }
        }
    }
    let mut current = settings::read(&st.data_dir, &plugin.id)?;
    for key in payload.keys {
        // Never replace a device-specific path or credential with another
        // device's portable value or reset.
        if current
            .get(&key)
            .is_some_and(|value| !portable_value(value, 0))
        {
            continue;
        }
        match payload.values.get(&key) {
            Some(value) => {
                current.insert(key, value.clone());
            }
            None => {
                current.remove(&key);
            }
        }
    }
    settings::write(&st.data_dir, &plugin.id, &current)
}

#[cfg(test)]
#[path = "plugin_settings_tests.rs"]
mod tests;
