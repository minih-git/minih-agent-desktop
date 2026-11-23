//! The delegate role a session was created to act in
//! (ADR session-create-model-and-role).
//!
//! `SessionCreate({ agent })` names one subagent definition, and the created
//! session records that handle so the runtime can put the definition's prompt in
//! its system prompt on every turn. The column is provenance of *behaviour*, not
//! of authorship: it says which role the session acts in, never who may do what.
//!
//! Two rules keep it honest:
//!
//! - The handle must have the shape a definition file name can have, so a value
//!   that cannot name a definition is refused before a row is written.
//! - Only Electron main writes it. The renderer's IPC handler drops the key and
//!   the RACP catalog builds its own payload, exactly as it does for the origin
//!   columns (ADR persisted-session-origin).
//!
//! The runtime resolves the handle against the definitions it was launched with,
//! so a role whose definition was deleted or switched off simply stops adding a
//! section — the row keeps the name, which is what the sidebar shows.

use crate::db::{anyhow, Result};
use serde_json::Value;

/// Longest handle `packages/shared` accepts for a definition name.
pub const MAX_AGENT_NAME_CHARS: usize = 40;

/// A definition handle, or the refusal that says why it is not one.
///
/// The shape mirrors `packages/shared`'s definition-name rule
/// (`^[a-z0-9][a-z0-9-]{0,39}$`) so a stored role is always a name the catalog
/// could have offered. Trimming happens first: the model sometimes pads a value
/// with whitespace, and that is not a different role.
pub fn normalize_agent_name(raw: &str) -> Result<String> {
    let name = raw.trim();
    if name.is_empty() {
        return Err(anyhow!("INVALID_ARGUMENT: agentName must not be empty"));
    }
    if name.chars().count() > MAX_AGENT_NAME_CHARS {
        return Err(anyhow!(
            "INVALID_ARGUMENT: agentName must be at most {MAX_AGENT_NAME_CHARS} characters"
        ));
    }
    let mut chars = name.chars();
    let starts_well = chars
        .next()
        .is_some_and(|first| first.is_ascii_lowercase() || first.is_ascii_digit());
    let rest_well = name
        .chars()
        .skip(1)
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if !starts_well || !rest_well {
        return Err(anyhow!(
            "INVALID_ARGUMENT: agentName must be a definition handle (lowercase letters, digits and '-')"
        ));
    }
    Ok(name.to_string())
}

/// Read the optional role out of `session.create` params.
///
/// Omitted and null both mean "an ordinary conversation", so every existing
/// caller keeps creating one.
pub fn from_params(params: &Value) -> Result<Option<String>> {
    match params.get("agentName") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(normalize_agent_name(value)?)),
        Some(_) => Err(anyhow!("INVALID_ARGUMENT: agentName must be a string")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_definition_handle_is_accepted() {
        assert_eq!(normalize_agent_name("fixer").unwrap(), "fixer");
        assert_eq!(
            normalize_agent_name("  code-reviewer  ").unwrap(),
            "code-reviewer"
        );
        assert_eq!(normalize_agent_name("agent-2").unwrap(), "agent-2");
        // The shared definition-name rule accepts a trailing dash, so this one
        // must too: the two sides never disagree about which handle exists.
        assert_eq!(normalize_agent_name("trailing-").unwrap(), "trailing-");
    }

    #[test]
    fn anything_else_is_refused() {
        for raw in [
            "",
            "   ",
            "-leading",
            "Code-Reviewer",
            "with space",
            "with/slash",
        ] {
            assert!(normalize_agent_name(raw).is_err(), "{raw:?} is refused");
        }
        assert!(normalize_agent_name(&"a".repeat(MAX_AGENT_NAME_CHARS + 1)).is_err());
        assert!(normalize_agent_name(&"a".repeat(MAX_AGENT_NAME_CHARS)).is_ok());
    }

    #[test]
    fn omitted_and_null_mean_an_ordinary_session() {
        assert!(from_params(&json!({ "title": "Work" })).unwrap().is_none());
        assert!(from_params(&json!({ "agentName": null }))
            .unwrap()
            .is_none());
        assert_eq!(
            from_params(&json!({ "agentName": " fixer " }))
                .unwrap()
                .as_deref(),
            Some("fixer")
        );
        assert!(from_params(&json!({ "agentName": 7 })).is_err());
    }
}
