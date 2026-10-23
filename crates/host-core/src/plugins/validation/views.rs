//! `contributes.views` validation.
//!
//! A view is an isolated page the host offers somewhere: the right work panel by
//! default, or — with `placement: "sidebar"` — one row near the top of the left
//! sidebar that opens the page in the main content area (ADR
//! optional-terminal-plugin). Everything here decides whether the declaration can
//! be offered at all; where it is offered is the only field the host reads back.

use super::contribution_ids::is_contrib_id;
use super::{array_of, require_permission, safe_join};
use crate::plugins::manifest::PluginManifest;
use anyhow::{anyhow, bail, Result};
use serde_json::{Map, Value};
use std::path::Path;

pub(super) fn validate_views(
    root: &Path,
    map: &Map<String, Value>,
    manifest: &PluginManifest,
) -> Result<()> {
    let Some(views) = map.get("views") else {
        return Ok(());
    };
    let entries = array_of(views, "contributes.views")?;
    if !entries.is_empty() {
        require_permission(manifest, "ui.view", "views")?;
    }
    let mut seen: Vec<&str> = Vec::new();
    for entry in entries {
        let obj = entry
            .as_object()
            .ok_or_else(|| anyhow!("PLUGIN_INVALID: contributes.views entry must be an object"))?;
        let id = obj
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| is_contrib_id(id))
            .ok_or_else(|| anyhow!("PLUGIN_INVALID: view id is missing or invalid"))?;
        if seen.contains(&id) {
            bail!("PLUGIN_INVALID: duplicate view id {id}");
        }
        seen.push(id);
        // A title may be a plain string or a { en, "zh-CN" } object; the
        // per-locale completeness check belongs to the SDK validator, which the
        // packaging tool runs. Here we only require something rendered.
        let has_title = match obj.get("title") {
            Some(Value::String(text)) => !text.trim().is_empty(),
            Some(Value::Object(title)) => title.values().any(|value| {
                value
                    .as_str()
                    .map(|text| !text.trim().is_empty())
                    .unwrap_or(false)
            }),
            _ => false,
        };
        if !has_title {
            bail!("PLUGIN_INVALID: view {id} requires a title");
        }
        // Placement decides where the host offers the view: `panel` (the default)
        // in the right work panel, `sidebar` as a left-sidebar entry that opens
        // the page in the main content area. An unknown value is a manifest
        // error, not a silent fallback.
        if let Some(placement) = obj.get("placement") {
            if !matches!(placement.as_str(), Some("panel") | Some("sidebar")) {
                bail!("PLUGIN_INVALID: view {id} placement must be panel or sidebar");
            }
        }
        let entry_path = obj
            .get("entry")
            .and_then(Value::as_str)
            .filter(|entry| !entry.trim().is_empty())
            .ok_or_else(|| anyhow!("PLUGIN_INVALID: view {id} requires an entry"))?;
        let resolved = safe_join(root, entry_path)?;
        if !resolved.exists() {
            bail!("PLUGIN_INVALID: view entry missing: {entry_path}");
        }
    }
    Ok(())
}
