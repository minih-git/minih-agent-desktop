//! Label grammar shared by the `contributes` blocks that accept a plain string
//! or a localized title.
//!
//! Kept out of `validation.rs` so the manifest validator stays inside its
//! architecture budget; the rules themselves are unchanged.

use serde_json::Value;

/// A block label is a plain string or both contract locales, mirroring
/// `localizedStringError` in the plugin SDK: a half-translated title would
/// silently fall back at runtime and read as a plugin bug rather than a
/// manifest one.
pub(super) fn is_plugin_label(value: &Value) -> bool {
    if value.as_str().is_some_and(|label| !label.trim().is_empty()) {
        return true;
    }
    value.as_object().is_some_and(|localized| {
        ["en", "zh-CN"].iter().all(|locale| {
            localized
                .get(*locale)
                .and_then(Value::as_str)
                .is_some_and(|label| !label.trim().is_empty())
        })
    })
}

/// A description may be an empty string, which the sheet simply omits, so this
/// is the same grammar as [`is_plugin_label`] without the "says something"
/// requirement on the plain-string form.
pub(super) fn is_optional_plugin_label(value: &Value) -> bool {
    value.is_string() || is_plugin_label(value)
}

pub(super) fn is_shortcut_shape(value: &Value) -> bool {
    let Some(value) = value.as_str() else {
        return false;
    };
    let parts: Vec<&str> = value.split('+').filter(|part| !part.is_empty()).collect();
    if parts.len() < 2
        && !matches!(parts.first(), Some(key) if key.starts_with('F') && key[1..].parse::<u8>().map(|n| (1..=12).contains(&n)).unwrap_or(false))
    {
        return false;
    }
    let Some(key) = parts.last() else {
        return false;
    };
    let named = matches!(
        *key,
        "Enter"
            | "Space"
            | "Tab"
            | "Backspace"
            | "Delete"
            | "Insert"
            | "Home"
            | "End"
            | "PageUp"
            | "PageDown"
            | "ArrowUp"
            | "ArrowDown"
            | "ArrowLeft"
            | "ArrowRight"
            | "Comma"
            | "Period"
            | "Equal"
            | "Minus"
            | "Slash"
            | "Backslash"
            | "Semicolon"
            | "Quote"
            | "BracketLeft"
            | "BracketRight"
            | "Backquote"
    );
    let alpha_numeric = key.len() == 1 && key.chars().all(|ch| ch.is_ascii_alphanumeric());
    let function_key = key.starts_with('F')
        && key[1..]
            .parse::<u8>()
            .map(|number| (1..=12).contains(&number))
            .unwrap_or(false);
    if !(named || alpha_numeric || function_key) {
        return false;
    }
    parts[..parts.len().saturating_sub(1)]
        .iter()
        .all(|part| matches!(*part, "Mod" | "Ctrl" | "Alt" | "Shift"))
}
