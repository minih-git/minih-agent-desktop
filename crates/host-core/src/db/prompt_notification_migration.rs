use super::{create_migration_backup, Connection, Context, Path, Result};
use rusqlite::Transaction;

/// Shared verbatim by the fresh schema and the v24 -> v25 migration.
///
/// v25 widens the durable inbox from task outcomes to interactive prompts. A
/// prompt row has no settled turn to deduplicate on, so `turn_id` becomes
/// nullable and `request_id` carries its own uniqueness; `tool_name` lets the
/// renderer name the tool that asked without persisting the prompt text itself.
///
/// The two unique indexes own one family each. `turn_id` is unique only across
/// the task rows: a prompt row records the turn it blocks, and one turn both
/// asks and finishes, so an index over every row would let the prompt row win
/// the key and silently drop the turn's `task.completed` / `task.failed` row.
pub(crate) const NOTIFICATIONS_DDL: &str = r#"
CREATE TABLE IF NOT EXISTS notifications (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN (
    'task.completed', 'task.failed',
    'prompt.ask', 'prompt.permission', 'prompt.plan'
  )),
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  session_title TEXT NOT NULL,
  turn_id    TEXT,
  request_id TEXT,
  tool_name  TEXT,
  error_code TEXT,
  created_at INTEGER NOT NULL,
  read_at    INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_turn
  ON notifications(turn_id)
  WHERE turn_id IS NOT NULL
    AND kind IN ('task.completed', 'task.failed');
CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_request
  ON notifications(request_id) WHERE request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_notifications_created
  ON notifications(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_unread
  ON notifications(created_at DESC) WHERE read_at IS NULL;
"#;

/// The old table constrains `kind` to the two task values and makes `turn_id`
/// `NOT NULL UNIQUE`, so the new shape needs a rebuild rather than an added
/// column. Rows are copied in place; every existing row keeps its id, kind,
/// title, turn, error code, and read state, and gains empty prompt columns.
fn migrate_v24_to_v25_tx(tx: &Transaction<'_>) -> Result<()> {
    tx.execute_batch(
        "DROP INDEX IF EXISTS idx_notifications_created;
         DROP INDEX IF EXISTS idx_notifications_unread;
         ALTER TABLE notifications RENAME TO notifications_v24;",
    )?;
    tx.execute_batch(NOTIFICATIONS_DDL)?;
    tx.execute_batch(
        "INSERT INTO notifications
            (id, kind, session_id, session_title, turn_id, request_id, tool_name,
             error_code, created_at, read_at)
         SELECT id, kind, session_id, session_title, turn_id, NULL, NULL,
                error_code, created_at, read_at
         FROM notifications_v24;
         DROP TABLE notifications_v24;",
    )?;
    tx.pragma_update(None, "user_version", 25i64)?;
    Ok(())
}

pub(crate) fn migrate_v24_to_v25(conn: &Connection, path: &Path) -> Result<()> {
    let backup = create_migration_backup(conn, path, 24)?;
    let tx = conn.unchecked_transaction()?;
    migrate_v24_to_v25_tx(&tx)?;
    tx.commit().with_context(|| {
        format!(
            "commit schema v24 to v25 migration; backup {} remains",
            backup.display()
        )
    })?;
    Ok(())
}
