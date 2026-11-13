use crate::{db::Database, sessions};
use anyhow::{anyhow, Result};

pub(super) fn effective_mode(db: &Database, session_id: &str) -> Result<String> {
    let mode = sessions::session_permission_mode(db, session_id)?
        .ok_or_else(|| anyhow!("NOT_FOUND: session {session_id}"))?;
    if mode != "inherit" {
        return Ok(mode);
    }
    Ok(db
        .get_setting("app")?
        .and_then(|settings| {
            settings
                .get("defaultPermissionMode")
                .and_then(|value| value.as_str())
                .map(str::to_owned)
        })
        .filter(|mode| sessions::is_valid_permission_mode(mode) && mode != "inherit")
        .unwrap_or_else(|| "ask".into()))
}

/// Capability rank of a permission mode; higher is wider.
///
/// `inherit` never reaches here — `effective_mode` resolves it — and an unknown
/// mode ranks as the narrowest, so a malformed value can only reduce authority.
pub(super) fn rank(mode: &str) -> u8 {
    match mode {
        "auto" => 2,
        "accept-edits" => 1,
        _ => 0,
    }
}

/// The narrower of two concrete permission modes.
///
/// This is how a task card is honoured: the delivery's ceiling becomes the
/// minimum of what the sender may grant and what the card asks for, so a card
/// can only narrow. It is `min` and never "replace", which is what keeps a
/// confirmed `ask` card from being silently widened to its sender's `auto`.
pub(super) fn narrower(left: &str, right: &str) -> String {
    if rank(left) <= rank(right) {
        left.to_string()
    } else {
        right.to_string()
    }
}

/// Session communication is Agent-only; this is the half of [`check_target`]
/// that applies to every delivery.
///
/// It is separate because the rank half is about *who may grant what*, and a
/// delivery whose ceiling was derived from the target itself has nothing left to
/// compare: the target would be checked against its own mode.
pub(super) fn require_agent_mode(db: &Database, session_id: &str) -> Result<()> {
    if sessions::session_mode(db, session_id)?.as_deref() != Some("agent") {
        return Err(anyhow!(
            "PERMISSION_DENIED: session communication requires Agent mode"
        ));
    }
    Ok(())
}

pub(super) fn check_target(db: &Database, session_id: &str, ceiling: &str) -> Result<()> {
    if rank(&effective_mode(db, session_id)?) > rank(ceiling) {
        return Err(anyhow!(
            "PERMISSION_DENIED: target permission mode exceeds the sending session's authorization"
        ));
    }
    require_agent_mode(db, session_id)
}
