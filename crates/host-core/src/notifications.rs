use anyhow::Result;
use rusqlite::{params, OptionalExtension, Transaction};
use serde::Serialize;
use uuid::Uuid;

use crate::db::{ms_to_ts, now_ms, Database, NOTIFICATION_KEEP};

/// One durable inbox row. `kind` names the family: a settled turn
/// (`task.completed` / `task.failed`) or an interactive request the user still
/// has to answer (`prompt.ask` / `prompt.permission` / `prompt.plan`).
///
/// Task rows are deduplicated by `turn_id`; prompt rows have no settled turn to
/// key on, so they carry the runtime `request_id` instead. Prompt rows store the
/// tool name only — never the question or argument text — because that content
/// already lives in the transcript and the inbox is a pointer to it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Notification {
    pub id: String,
    pub kind: String,
    pub session_id: String,
    pub session_title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub read_at: Option<String>,
}

fn notification_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Notification> {
    Ok(Notification {
        id: row.get(0)?,
        kind: row.get(1)?,
        session_id: row.get(2)?,
        session_title: row.get(3)?,
        turn_id: row.get(4)?,
        request_id: row.get(5)?,
        tool_name: row.get(6)?,
        error_code: row.get(7)?,
        created_at: ms_to_ts(row.get(8)?),
        read_at: row.get::<_, Option<i64>>(9)?.map(ms_to_ts),
    })
}

const NOTIFICATION_SELECT: &str =
    "SELECT n.id, n.kind, n.session_id, n.session_title, n.turn_id, n.request_id,
            n.tool_name, n.error_code, n.created_at, n.read_at
     FROM notifications n";

/// Insert the durable fact for a newly terminal turn. The caller owns the
/// transaction so the turn update and notification cannot diverge.
pub fn insert_for_terminal_turn(
    tx: &Transaction<'_>,
    turn_id: &str,
    status: &str,
    error_code: Option<&str>,
) -> Result<Option<Notification>> {
    let kind = match status {
        "completed" => "task.completed",
        "error" => "task.failed",
        _ => return Ok(None),
    };
    let Some((session_id, session_title)) = tx
        .query_row(
            "SELECT t.session_id, s.title
             FROM turns t JOIN sessions s ON s.id = t.session_id
             WHERE t.id = ?1",
            params![turn_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()?
    else {
        return Ok(None);
    };

    let id = Uuid::new_v4().to_string();
    let created_at = now_ms();
    let inserted = tx
        .prepare_cached(
            "INSERT INTO notifications
                (id, kind, session_id, session_title, turn_id, error_code, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT DO NOTHING",
        )?
        .execute(params![
            id,
            kind,
            session_id,
            session_title,
            turn_id,
            error_code,
            created_at
        ])?;
    if inserted == 0 {
        return Ok(None);
    }
    prune_oldest(tx)?;

    Ok(Some(Notification {
        id,
        kind: kind.to_string(),
        session_id,
        session_title,
        turn_id: Some(turn_id.to_string()),
        request_id: None,
        tool_name: None,
        error_code: error_code.map(str::to_string),
        created_at: ms_to_ts(created_at),
        read_at: None,
    }))
}

/// Record that one session is waiting on the user. The renderer reports the
/// request when it arrives, so a prompt survives a window that was hidden, a
/// toast that auto-dismissed, or a focus that never saw the card — the three
/// ways an interactive request used to disappear without a trace.
///
/// `request_id` is the runtime's own id for the request, which makes the row
/// exactly-once even when the renderer replays an event after a reload.
pub fn insert_for_prompt(
    db: &Database,
    kind: &str,
    session_id: &str,
    request_id: &str,
    tool_name: Option<&str>,
    turn_id: Option<&str>,
) -> Result<Option<Notification>> {
    if !matches!(kind, "prompt.ask" | "prompt.permission" | "prompt.plan") {
        return Ok(None);
    }
    let request_id = request_id.trim();
    if request_id.is_empty() {
        return Ok(None);
    }
    let Some(session_title) = db
        .conn()
        .query_row(
            "SELECT title FROM sessions WHERE id = ?1",
            params![session_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?
    else {
        return Ok(None);
    };

    let id = Uuid::new_v4().to_string();
    let created_at = now_ms();
    let inserted = db
        .conn()
        .prepare_cached(
            "INSERT INTO notifications
                (id, kind, session_id, session_title, turn_id, request_id, tool_name, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT DO NOTHING",
        )?
        .execute(params![
            id,
            kind,
            session_id,
            session_title,
            turn_id,
            request_id,
            tool_name,
            created_at
        ])?;
    if inserted == 0 {
        return Ok(None);
    }
    prune_oldest(db.conn())?;

    Ok(Some(Notification {
        id,
        kind: kind.to_string(),
        session_id: session_id.to_string(),
        session_title,
        turn_id: turn_id.map(str::to_string),
        request_id: Some(request_id.to_string()),
        tool_name: tool_name.map(str::to_string),
        error_code: None,
        created_at: ms_to_ts(created_at),
        read_at: None,
    }))
}

/// Keep the newest `NOTIFICATION_KEEP` rows globally. Prompt rows share the
/// same budget: a pending prompt is the newest reminder at the moment it is
/// written, and its row is cheap to re-read from the transcript afterwards.
fn prune_oldest(conn: &rusqlite::Connection) -> Result<()> {
    conn.execute(
        "DELETE FROM notifications
         WHERE id IN (
           SELECT id FROM notifications
           ORDER BY created_at DESC, id DESC
           LIMIT -1 OFFSET ?1
         )",
        params![NOTIFICATION_KEEP],
    )?;
    Ok(())
}

pub fn list(db: &Database, unread_only: bool, limit: i64) -> Result<(Vec<Notification>, i64)> {
    let limit = limit.clamp(1, NOTIFICATION_KEEP);
    let sql = if unread_only {
        format!(
            "{NOTIFICATION_SELECT}
             WHERE n.read_at IS NULL
             ORDER BY n.created_at DESC, n.id DESC LIMIT ?1"
        )
    } else {
        format!(
            "{NOTIFICATION_SELECT}
             ORDER BY n.created_at DESC, n.id DESC LIMIT ?1"
        )
    };
    let mut stmt = db.conn().prepare_cached(&sql)?;
    let rows = stmt.query_map(params![limit], notification_from_row)?;
    let notifications = rows.collect::<rusqlite::Result<Vec<_>>>()?;
    let unread_count = db.conn().query_row(
        "SELECT COUNT(*) FROM notifications WHERE read_at IS NULL",
        [],
        |row| row.get(0),
    )?;
    Ok((notifications, unread_count))
}

pub fn mark_read(db: &Database, id: &str) -> Result<bool> {
    let updated = db
        .conn()
        .prepare_cached("UPDATE notifications SET read_at = COALESCE(read_at, ?1) WHERE id = ?2")?
        .execute(params![now_ms(), id])?;
    Ok(updated > 0)
}

pub fn mark_all_read(db: &Database) -> Result<()> {
    db.conn()
        .prepare_cached("UPDATE notifications SET read_at = ?1 WHERE read_at IS NULL")?
        .execute(params![now_ms()])?;
    Ok(())
}

pub fn clear(db: &Database) -> Result<()> {
    db.conn().execute("DELETE FROM notifications", [])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sessions;

    fn test_db() -> Database {
        let dir = std::env::temp_dir().join(format!("minih-agent-desktop-test-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        Database::open(&dir.join("test.sqlite")).unwrap()
    }

    #[test]
    fn prompt_rows_are_exactly_once_and_markable() {
        let db = test_db();
        let session = sessions::create_session(
            &db,
            Some("Investigate build".into()),
            None,
            None,
            None,
            None,
        )
        .unwrap();

        let ask = insert_for_prompt(&db, "prompt.ask", &session.id, "req-ask-1", None, None)
            .unwrap()
            .expect("prompt row inserted");
        assert_eq!(ask.kind, "prompt.ask");
        assert_eq!(ask.session_title, "Investigate build");
        assert_eq!(ask.request_id.as_deref(), Some("req-ask-1"));
        assert!(ask.turn_id.is_none());
        assert!(ask.tool_name.is_none());
        assert!(ask.read_at.is_none());

        // A replayed event must not create a second reminder.
        assert!(
            insert_for_prompt(&db, "prompt.ask", &session.id, "req-ask-1", None, None)
                .unwrap()
                .is_none()
        );
        // Unknown kinds and blank request ids are rejected, not stored.
        assert!(
            insert_for_prompt(&db, "prompt.bogus", &session.id, "req-x", None, None)
                .unwrap()
                .is_none()
        );
        assert!(
            insert_for_prompt(&db, "prompt.plan", &session.id, "   ", None, None)
                .unwrap()
                .is_none()
        );
        // A session that no longer exists cannot own a reminder.
        assert!(
            insert_for_prompt(&db, "prompt.plan", "missing-session", "req-y", None, None)
                .unwrap()
                .is_none()
        );

        let permission = insert_for_prompt(
            &db,
            "prompt.permission",
            &session.id,
            "req-perm-1",
            Some("Bash"),
            Some("turn-1"),
        )
        .unwrap()
        .expect("permission row inserted");
        assert_eq!(permission.tool_name.as_deref(), Some("Bash"));
        assert_eq!(permission.turn_id.as_deref(), Some("turn-1"));

        let (all, unread) = list(&db, false, 50).unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(unread, 2);
        assert_eq!(list(&db, true, 50).unwrap().0.len(), 2);

        assert!(mark_read(&db, &ask.id).unwrap());
        assert_eq!(list(&db, true, 50).unwrap().1, 1);

        clear(&db).unwrap();
        assert!(list(&db, false, 50).unwrap().0.is_empty());
    }

    #[test]
    fn a_prompt_row_never_consumes_its_turn_terminal_notification() {
        let db = test_db();
        let session =
            sessions::create_session(&db, Some("Blocked turn".into()), None, None, None, None)
                .unwrap();
        let turn = sessions::begin_turn(&db, &session.id, None, None).unwrap();

        // A turn may ask more than once, so two prompt rows share one turn.
        assert!(insert_for_prompt(
            &db,
            "prompt.permission",
            &session.id,
            "req-permission",
            Some("Bash"),
            Some(&turn),
        )
        .unwrap()
        .is_some());
        assert!(
            insert_for_prompt(&db, "prompt.ask", &session.id, "req-ask", None, Some(&turn),)
                .unwrap()
                .is_some()
        );

        // The turn still owns exactly one terminal row: the prompt rows above
        // must not have taken its dedupe key.
        let settled = sessions::end_turn(&db, &turn, "completed", None, None, true).unwrap();
        let terminal = settled.notification.expect("terminal row inserted");
        assert_eq!(terminal.kind, "task.completed");
        assert_eq!(terminal.turn_id.as_deref(), Some(turn.as_str()));

        // Replaying a prompt event stays exactly-once.
        assert!(insert_for_prompt(
            &db,
            "prompt.permission",
            &session.id,
            "req-permission",
            Some("Bash"),
            Some(&turn),
        )
        .unwrap()
        .is_none());

        let (all, unread) = list(&db, false, 50).unwrap();
        assert_eq!(all.len(), 3);
        assert_eq!(unread, 3);
    }

    #[test]
    fn list_read_and_clear_lifecycle() {
        let db = test_db();
        let session =
            sessions::create_session(&db, Some("Build release".into()), None, None, None, None)
                .unwrap();
        let completed = sessions::begin_turn(&db, &session.id, None, None).unwrap();
        let completed_result =
            sessions::end_turn(&db, &completed, "completed", None, None, true).unwrap();
        assert_eq!(
            completed_result.notification.unwrap().kind,
            "task.completed"
        );
        let failed = sessions::begin_turn(&db, &session.id, None, None).unwrap();
        let failed_result =
            sessions::end_turn(&db, &failed, "error", Some("MODEL_ERROR"), None, true).unwrap();
        assert_eq!(failed_result.notification.unwrap().kind, "task.failed");
        assert!(sessions::rename_session(&db, &session.id, "Renamed session").unwrap());

        let (all, unread) = list(&db, false, 50).unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(unread, 2);
        let failed_notification = all
            .iter()
            .find(|notification| notification.kind == "task.failed")
            .unwrap();
        assert_eq!(failed_notification.session_title, "Build release");
        assert_eq!(
            failed_notification.error_code.as_deref(),
            Some("MODEL_ERROR")
        );

        assert!(mark_read(&db, &failed_notification.id).unwrap());
        assert!(!mark_read(&db, "missing").unwrap());
        let (unread_items, unread) = list(&db, true, 50).unwrap();
        assert_eq!(unread_items.len(), 1);
        assert_eq!(unread, 1);

        mark_all_read(&db).unwrap();
        assert_eq!(list(&db, true, 50).unwrap().1, 0);
        clear(&db).unwrap();
        assert!(list(&db, false, 50).unwrap().0.is_empty());
    }

    #[test]
    fn terminal_turns_keep_only_the_latest_two_hundred_notifications() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.sqlite");
        let db = Database::open(&path).unwrap();
        let session =
            sessions::create_session(&db, Some("Long task".into()), None, None, None, None)
                .unwrap();

        for _ in 0..201 {
            let turn = sessions::begin_turn(&db, &session.id, None, None).unwrap();
            let result = sessions::end_turn(&db, &turn, "completed", None, None, true).unwrap();
            assert!(result.notification.is_some());
        }

        let stored: i64 = db
            .conn()
            .query_row("SELECT COUNT(*) FROM notifications", [], |row| row.get(0))
            .unwrap();
        assert_eq!(stored, NOTIFICATION_KEEP);
        assert_eq!(list(&db, false, 500).unwrap().0.len(), 200);

        drop(db);
        let reopened = Database::open(&path).unwrap();
        let stored_after_restart: i64 = reopened
            .conn()
            .query_row("SELECT COUNT(*) FROM notifications", [], |row| row.get(0))
            .unwrap();
        assert_eq!(stored_after_restart, NOTIFICATION_KEEP);
    }
}
