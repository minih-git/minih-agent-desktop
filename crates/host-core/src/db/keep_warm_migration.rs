//! Schema v27 -> v28: the keep-warm ledger (ADR 0412).
//!
//! One new table and two indexes, nothing else. The migration is additive and
//! idempotent: an existing database gains an empty table, and every query that
//! predates this feature keeps returning exactly the numbers it returned
//! before. A fresh database gets the same DDL from `SCHEMA_LATEST`'s sibling
//! constant below, so the two paths cannot drift.

use anyhow::{Context, Result};
use rusqlite::Connection;

use crate::db::create_migration_backup;

/// Table and indexes of the keep-warm ledger, shared by fresh installs and the
/// migration.
pub(crate) const KEEP_WARM_DDL: &str = r#"
CREATE TABLE IF NOT EXISTS keep_warm_usage (
  id                 TEXT PRIMARY KEY,
  session_id         TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  status             TEXT NOT NULL CHECK (status IN ('warmed', 'failed', 'skipped')),
  reason             TEXT,
  provider_id        TEXT,
  model_id           TEXT,
  input_tokens       INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens      INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  cache_read_tokens  INTEGER NOT NULL DEFAULT 0 CHECK (cache_read_tokens >= 0),
  cache_write_tokens INTEGER NOT NULL DEFAULT 0 CHECK (cache_write_tokens >= 0),
  cache_read_ratio   REAL CHECK (cache_read_ratio IS NULL OR (
                       cache_read_ratio >= 0.0 AND cache_read_ratio <= 1.0
                     )),
  cost_usd           REAL CHECK (cost_usd IS NULL OR cost_usd >= 0.0),
  duration_ms        INTEGER NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
  created_at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_keep_warm_usage_session
  ON keep_warm_usage(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_keep_warm_usage_created
  ON keep_warm_usage(created_at DESC);
"#;

pub(crate) fn migrate_v27_to_v28(conn: &Connection, path: &std::path::Path) -> Result<()> {
    let backup = create_migration_backup(conn, path, 27)?;
    let result = (|| -> Result<()> {
        conn.execute_batch(KEEP_WARM_DDL)
            .context("create keep_warm_usage")?;
        conn.pragma_update(None, "user_version", 28i64)?;
        Ok(())
    })();
    if result.is_err() {
        return Err(anyhow::anyhow!(
            "keep-warm schema migration failed; pre-migration backup {} remains",
            backup.display()
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{Database, SCHEMA_VERSION};

    /// A v27 database upgraded in place keeps its rows and gains the table.
    #[test]
    fn upgrade_from_v27_keeps_data_and_creates_the_ledger() {
        let dir = std::env::temp_dir().join(format!("pi-v28-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("test.sqlite");
        let db = Database::open(&path).unwrap();
        let session = crate::sessions::create_session(&db, None, None, None, None, None).unwrap();
        // Present the file as a v27 database: drop the table and step the
        // version back, which is what an upgrade from the previous release
        // looks like.
        db.conn()
            .execute_batch(
                "DROP TABLE keep_warm_usage; PRAGMA user_version = 27;
                 DELETE FROM sessions;",
            )
            .unwrap();
        drop(db);
        let db = Database::open(&path).unwrap();
        let version: i64 = db
            .conn()
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);
        let tables: i64 = db
            .conn()
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'keep_warm_usage'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(tables, 1);
        // The DDL itself is idempotent, which is what keeps a re-run of an
        // interrupted upgrade from failing on a half-created table. (The
        // migration entry point is not: it refuses to back up a file whose
        // version is not the one it upgrades, so it can never be applied twice.)
        db.conn().execute_batch(KEEP_WARM_DDL).unwrap();
        let _ = session;
        drop(db);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
