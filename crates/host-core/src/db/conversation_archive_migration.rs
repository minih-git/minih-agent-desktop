//! Schema v29: the stored summary, its lease, and the deletion record
//! (ADR conversation-archive §3).
//!
//! The step is purely additive: two new tables, no rewritten row, and every
//! session starts with no summary at all — which is exactly the backfill queue a
//! build that turns the feature on has to work through. The DDL lives in one
//! constant shared by the fresh schema and this migration, so the two cannot
//! drift in table names, checks, or indexes.

use super::{create_migration_backup, Connection, Context, Path, Result};

/// Shared verbatim by the fresh schema and the v28 -> v29 migration.
///
/// `conversation_summaries` is one row per session and doubles as the summary
/// generator's cursor, lease, and retry state: the same shape learned-memory
/// extraction uses, so a restart, a duplicate trigger, or a renderer reload can
/// neither repeat a range nor skip one. `conversation_archive_tombstones` keeps
/// the id of a permanently deleted session so a plugin can delete the file that
/// no session row can name any more.
pub(crate) const CONVERSATION_ARCHIVE_DDL: &str = r#"
CREATE TABLE IF NOT EXISTS conversation_summaries (
  session_id  TEXT PRIMARY KEY,
  covered_seq INTEGER NOT NULL DEFAULT 0,
  revision    INTEGER NOT NULL DEFAULT 0,
  summary_json TEXT,
  model_key   TEXT,
  lease_owner TEXT,
  lease_until INTEGER,
  attempts    INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversation_summaries_updated
  ON conversation_summaries(updated_at DESC, session_id ASC);
CREATE INDEX IF NOT EXISTS idx_conversation_summaries_backfill
  ON conversation_summaries(revision, session_id);

CREATE TABLE IF NOT EXISTS conversation_archive_tombstones (
  session_id TEXT PRIMARY KEY,
  deleted_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversation_archive_tombstones_deleted
  ON conversation_archive_tombstones(deleted_at DESC, session_id ASC);
"#;

/// v28 -> v29. The backup is the pre-migration copy a failed commit leaves
/// behind; the two tables start empty by construction.
pub(crate) fn migrate_v28_to_v29(conn: &Connection, path: &Path) -> Result<()> {
    let backup = create_migration_backup(conn, path, 28)?;
    let tx = conn.unchecked_transaction()?;
    tx.execute_batch(CONVERSATION_ARCHIVE_DDL)?;
    tx.pragma_update(None, "user_version", 29i64)?;
    tx.commit().with_context(|| {
        format!(
            "commit schema v28 to v29 migration; backup {} remains",
            backup.display()
        )
    })?;
    Ok(())
}
