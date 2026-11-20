//! Validate task notification targets before exposing them to the renderer.
use anyhow::Result;
use rusqlite::{params, OptionalExtension};
use serde_json::Value;

use crate::{db::Database, notifications::Notification, plugin_tasks::NOTIFICATION_DEDUPE_PREFIX};

/// Old plugin notifications may predate the reserved prefix. Never treat one
/// as host-authored unless its task, owner and linked session agree with the
/// authoritative task ledger. Ordinary plugin notices are unchanged.
pub fn sanitize(db: &Database, notification: &mut Notification) -> Result<()> {
    let Some(task_id) = notification
        .dedupe_key
        .as_deref()
        .and_then(|key| key.strip_prefix(NOTIFICATION_DEDUPE_PREFIX))
    else {
        return Ok(());
    };
    let linked = notification
        .link_json
        .as_deref()
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
        .and_then(|value| {
            value
                .get("session")
                .and_then(Value::as_str)
                .map(str::to_owned)
        });
    let owner_and_session: Option<(Option<String>, String)> = db
        .conn()
        .query_row(
            "SELECT plugin_id, session_id FROM tasks WHERE id=?1",
            params![task_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let valid = owner_and_session.is_some_and(|(owner, session)| {
        owner.is_some()
            && owner == notification.plugin_id
            && linked.as_deref() == Some(session.as_str())
    });
    if !valid {
        notification.dedupe_key = None;
        notification.link_json = None;
    }
    Ok(())
}
