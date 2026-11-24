use super::*;

/// A declared label: the author's plain string, or the entry a generated sheet
/// reads from a `{ en, "zh-CN" }` map (ADR 0340). The fallback order is the same
/// one every other localized manifest label uses, so a map missing the shell
/// locale reads English rather than nothing.
fn localized_setting_label(value: &Value, locale: &str) -> Option<String> {
    if value.is_string() {
        return value.as_str().map(str::to_string);
    }
    let map = value.as_object()?;
    let mut order = vec![plugin_display_locale(locale)];
    for key in ["en", "zh-CN"] {
        if !order.contains(&key) {
            order.push(key);
        }
    }
    order
        .into_iter()
        .find_map(|key| {
            map.get(key)
                .and_then(Value::as_str)
                .filter(|text| !text.trim().is_empty())
        })
        .map(str::to_string)
}

pub(crate) fn derive_settings(
    manifest: &PluginManifest,
    locale: &str,
) -> Vec<PluginSettingDefinition> {
    let Some(entries) = manifest
        .contributes
        .as_ref()
        .and_then(Value::as_object)
        .and_then(|map| map.get("settings"))
        .and_then(Value::as_array)
    else {
        return Vec::new();
    };
    entries
        .iter()
        .filter_map(|entry| {
            let obj = entry.as_object()?;
            Some(PluginSettingDefinition {
                key: obj.get("key")?.as_str()?.to_string(),
                title: localized_setting_label(obj.get("title")?, locale)?,
                description: obj
                    .get("description")
                    .and_then(|value| localized_setting_label(value, locale)),
                setting_type: obj.get("type")?.as_str()?.to_string(),
                default: obj.get("default").cloned(),
                enum_values: obj
                    .get("enum")
                    .and_then(Value::as_array)
                    .map(|values| {
                        values
                            .iter()
                            .filter_map(|value| {
                                let option = value.as_object()?;
                                Some(PluginSettingOption {
                                    label: localized_setting_label(option.get("label")?, locale)?,
                                    value: option.get("value")?.clone(),
                                })
                            })
                            .collect()
                    })
                    .unwrap_or_default(),
                command: obj
                    .get("command")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                scope: "plugin".into(),
            })
        })
        .collect()
}

/// Capability tokens the UI renders as badges.
pub(crate) fn derive_capabilities(manifest: &PluginManifest) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    if manifest
        .ui
        .as_ref()
        .and_then(|ui| ui.panel.as_ref())
        .is_some()
    {
        out.push("panel".into());
    }
    if manifest.renderer.is_some() {
        out.push("rendererUi".into());
    }
    let map = manifest.contributes.as_ref().and_then(Value::as_object);
    let has = |key: &str| -> bool {
        map.and_then(|m| m.get(key))
            .and_then(Value::as_array)
            .map(|a| !a.is_empty())
            .unwrap_or(false)
    };
    if has("commands") {
        out.push("commands".into());
    }
    if has("views") {
        out.push("views".into());
    }
    if has("agentExtensions") {
        out.push("agentExtension".into());
    }
    if has("composerTransforms") {
        out.push("composerTransform".into());
    }
    if has("providers") {
        out.push("providers".into());
    }
    if has("agentTools") {
        out.push("tools".into());
    }
    if has("skills") {
        out.push("skills".into());
    }
    if has("themes") {
        out.push("themes".into());
    }
    if has("mcpServers") {
        out.push("mcp".into());
    }
    if has("services") {
        out.push("services".into());
    }
    let bus_declared = map
        .and_then(|m| m.get("bus"))
        .and_then(Value::as_object)
        .map(|bus| {
            ["publish", "subscribe"].iter().any(|key| {
                bus.get(*key)
                    .and_then(Value::as_array)
                    .map(|a| !a.is_empty())
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false);
    if bus_declared {
        out.push("bus".into());
    }
    out
}

pub(crate) fn permission_diff(old: &[String], new: &[String]) -> Vec<String> {
    new.iter()
        .filter(|p| !old.iter().any(|o| o == *p))
        .cloned()
        .collect()
}

pub(crate) fn sanitize_id(id: &str) -> String {
    id.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect()
}
