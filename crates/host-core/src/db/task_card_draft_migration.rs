//! Schema v31 -> v32: durable task-card drafts (ADR bot-sessions-and-steward).
//!
//! A draft is what a person is shown before they confirm anything, so it has to
//! outlive the Electron main process that rendered it: a card proposed on
//! Monday must still be the card confirmed on Tuesday. It belongs to the
//! steward session that proposed it, which is a real foreign key, so dismissing
//! the employee discards its drafts with it.
//!
//! A table rather than a `kv` row: drafts are listable per session, bounded per
//! session, and need a partial unique index for "one open draft per card hash".
//! The step is additive — no existing row changes — so it is not destructive and
//! keeps no `pi.sqlite.v31.bak`, exactly like v30 -> v31.

use super::{Connection, Context, Path, Result};
use rusqlite::Transaction;

/// Shared verbatim by the fresh schema and the migration so they cannot drift.
pub(crate) const TASK_CARD_DRAFT_DDL: &str = r#"
CREATE TABLE IF NOT EXISTS task_card_drafts (
  id                 TEXT PRIMARY KEY,
  session_id         TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  status             TEXT NOT NULL CHECK (status IN ('proposed', 'confirmed', 'dropped')),
  -- The normalized card the person was shown. Its hash is what a confirmation
  -- must match, so a revise cannot be confirmed by a stale click.
  card_json          TEXT NOT NULL,
  card_hash          TEXT NOT NULL,
  source_utterance   TEXT NOT NULL,
  target_session_id  TEXT NOT NULL,
  -- How a confirmation happened, and what it produced. Both stay NULL while the
  -- draft is proposed, so "was this clicked by a person" is answered by a row
  -- rather than by a flag the caller supplies.
  confirmed_by       TEXT CHECK (confirmed_by IS NULL OR confirmed_by IN ('user', 'policy')),
  confirmed_at       INTEGER,
  delivery_id        TEXT,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_card_drafts_session
  ON task_card_drafts(session_id, created_at DESC);
-- One open draft per (session, card): re-proposing the same card is the same
-- card, not a second one the person must reconcile.
CREATE UNIQUE INDEX IF NOT EXISTS idx_task_card_drafts_open
  ON task_card_drafts(session_id, card_hash) WHERE status = 'proposed';
"#;

pub(crate) fn migrate_v31_to_v32_tx(tx: &Transaction<'_>) -> Result<()> {
    tx.execute_batch(TASK_CARD_DRAFT_DDL)?;
    tx.pragma_update(None, "user_version", 32i64)?;
    Ok(())
}

/// Additive, so no backup copy precedes it; a failure still rolls back the whole
/// transaction and leaves v31 authoritative.
pub(crate) fn migrate(conn: &Connection, _path: &Path) -> Result<()> {
    let tx = conn.unchecked_transaction()?;
    migrate_v31_to_v32_tx(&tx).context("apply schema v31 to v32 task card draft migration")?;
    tx.commit().context("commit schema v31 to v32 migration")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{Database, SCHEMA_VERSION};

    fn database() -> (tempfile::TempDir, Database) {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
        (dir, db)
    }

    fn version(conn: &Connection) -> i64 {
        conn.query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap()
    }

    fn has_table(conn: &Connection, name: &str) -> bool {
        conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
            [name],
            |row| row.get(0),
        )
        .unwrap()
    }

    #[test]
    fn a_fresh_database_has_the_draft_table_at_the_newest_version() {
        let (_dir, db) = database();
        assert_eq!(version(db.conn()), SCHEMA_VERSION);
        assert!(has_table(db.conn(), "task_card_drafts"));
        let empty: i64 = db
            .conn()
            .query_row("SELECT COUNT(*) FROM task_card_drafts", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(empty, 0);
    }

    #[test]
    fn a_v31_database_gains_the_table_without_touching_its_rows() {
        let (dir, db) = database();
        let session = crate::sessions::create_session_with_options(
            &db,
            crate::sessions::SessionCreateOptions {
                title: Some("Existing".into()),
                mode: Some("agent".into()),
                ..Default::default()
            },
        )
        .unwrap();
        let path = dir.path().join("pi.sqlite");
        db.conn()
            .execute_batch(
                "PRAGMA foreign_keys = OFF;
                 DROP TABLE task_card_drafts;
                 PRAGMA user_version = 31;",
            )
            .unwrap();
        assert!(!has_table(db.conn(), "task_card_drafts"));
        drop(db);

        let db = Database::open(&path).unwrap();
        assert_eq!(version(db.conn()), SCHEMA_VERSION);
        assert!(has_table(db.conn(), "task_card_drafts"));
        let summaries = crate::sessions::list_sessions(&db).unwrap();
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].id, session.id);
    }

    #[test]
    fn a_status_outside_the_vocabulary_is_refused_by_the_schema() {
        let (_dir, db) = database();
        let session = crate::sessions::create_session_with_options(
            &db,
            crate::sessions::SessionCreateOptions {
                title: Some("Steward".into()),
                mode: Some("agent".into()),
                ..Default::default()
            },
        )
        .unwrap();
        let insert = |status: &str| {
            db.conn().execute(
                "INSERT INTO task_card_drafts
                 (id, session_id, status, card_json, card_hash, source_utterance,
                  target_session_id, created_at, updated_at)
                 VALUES (?1, ?2, ?3, '{}', 'h', 'u', ?2, 1, 1)",
                rusqlite::params![format!("d-{status}"), session.id, status],
            )
        };
        assert!(insert("proposed").is_ok());
        assert!(insert("approved").is_err());
    }

    #[test]
    fn a_draft_is_deleted_with_its_session() {
        let (_dir, db) = database();
        let steward = crate::sessions::create_session_with_options(
            &db,
            crate::sessions::SessionCreateOptions {
                title: Some("Steward".into()),
                mode: Some("agent".into()),
                ..Default::default()
            },
        )
        .unwrap();
        db.conn()
            .execute(
                "INSERT INTO task_card_drafts
                 (id, session_id, status, card_json, card_hash, source_utterance,
                  target_session_id, created_at, updated_at)
                 VALUES ('d1', ?1, 'proposed', '{}', 'h', 'u', ?1, 1, 1)",
                rusqlite::params![steward.id],
            )
            .unwrap();
        db.conn()
            .execute(
                "DELETE FROM sessions WHERE id = ?1",
                rusqlite::params![steward.id],
            )
            .unwrap();
        let remaining: i64 = db
            .conn()
            .query_row("SELECT COUNT(*) FROM task_card_drafts", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(remaining, 0);
    }

    #[test]
    fn only_one_open_draft_per_card_hash_exists_per_session() {
        let (_dir, db) = database();
        let session = crate::sessions::create_session_with_options(
            &db,
            crate::sessions::SessionCreateOptions {
                title: Some("Steward".into()),
                mode: Some("agent".into()),
                ..Default::default()
            },
        )
        .unwrap();
        let insert = |id: &str, hash: &str, status: &str| {
            db.conn().execute(
                "INSERT INTO task_card_drafts
                 (id, session_id, status, card_json, card_hash, source_utterance,
                  target_session_id, created_at, updated_at)
                 VALUES (?1, ?2, ?3, '{}', ?4, 'u', ?2, 1, 1)",
                rusqlite::params![id, session.id, status, hash],
            )
        };
        assert!(insert("d1", "same", "proposed").is_ok());
        // The same card proposed twice is the same draft, not two.
        assert!(insert("d2", "same", "proposed").is_err());
        // A settled draft no longer occupies that slot.
        assert!(insert("d3", "same", "dropped").is_ok());
        assert!(insert("d4", "other", "proposed").is_ok());
    }
}
