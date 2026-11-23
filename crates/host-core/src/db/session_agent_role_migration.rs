//! Schema v44 -> v45: the delegate role a session was created to act in
//! (ADR session-create-model-and-role).
//!
//! One nullable column on `sessions`. It names a subagent definition handle, and
//! only Electron main writes it: the built-in `SessionCreate` tool stamps the
//! role the model asked for, and the runtime turns that handle into a prompt
//! section on every turn. Nothing else in the row changes, so the step is
//! additive and idempotent — no table is rebuilt, no row is rewritten, and a
//! re-run finds the column already there.
//!
//! There is no backfill. The role was never recorded before this version, and
//! guessing one from the transcript (a task session's employee definition, say)
//! would claim a session acts as a role nobody chose for it.

use super::*;
use rusqlite::Transaction;

/// `(column, definition)` for the role column, so the fresh schema and this
/// step cannot drift.
pub(crate) const SESSION_AGENT_ROLE_COLUMNS: [(&str, &str); 1] = [("agent_name", "TEXT")];

fn has_column(tx: &Transaction<'_>, table: &str, name: &str) -> Result<bool> {
    Ok(tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info(?1) WHERE name = ?2)",
        params![table, name],
        |row| row.get(0),
    )?)
}

/// Apply the v45 shape inside the caller's transaction.
pub(crate) fn migrate_v44_to_v45_tx(tx: &Transaction<'_>) -> Result<()> {
    for (column, definition) in SESSION_AGENT_ROLE_COLUMNS {
        if !has_column(tx, "sessions", column)? {
            tx.execute_batch(&format!(
                "ALTER TABLE sessions ADD COLUMN {column} {definition};"
            ))
            .map_err(|error| anyhow!("add sessions.{column}: {error}"))?;
        }
    }
    tx.pragma_update(None, "user_version", 45i64)?;
    Ok(())
}

/// Run the step on a real file: back up the v44 file, then one transaction that
/// either produces the v45 shape and stamps it, or changes nothing.
pub(crate) fn migrate(conn: &Connection, path: &Path) -> Result<()> {
    let backup = create_migration_backup(conn, path, 44)?;
    let tx = conn.unchecked_transaction()?;
    migrate_v44_to_v45_tx(&tx)?;
    tx.commit().with_context(|| {
        format!(
            "commit schema v44 to v45 migration; backup {} remains",
            backup.display()
        )
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{Database, SCHEMA_VERSION};

    fn database() -> (tempfile::TempDir, Database, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pi.sqlite");
        let db = Database::open(&path).unwrap();
        (dir, db, path)
    }

    fn version(conn: &Connection) -> i64 {
        conn.query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap()
    }

    fn column(conn: &Connection, table: &str, name: &str) -> bool {
        conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info(?1) WHERE name = ?2)",
            params![table, name],
            |row| row.get(0),
        )
        .unwrap()
    }

    /// Leave a file exactly as v44 wrote it: the role column gone.
    fn downgrade_to_v44(conn: &Connection) {
        conn.execute_batch(
            "ALTER TABLE sessions DROP COLUMN agent_name;
             PRAGMA user_version = 44;",
        )
        .unwrap();
    }

    #[test]
    fn an_existing_v44_file_gains_the_column_and_keeps_its_rows() {
        let (_dir, db, path) = database();
        let conn = db.conn();
        downgrade_to_v44(conn);
        conn.execute(
            "INSERT INTO sessions (id, title, role, created_at, updated_at)
             VALUES ('existing', 'Existing', 'user', 1, 1)",
            [],
        )
        .unwrap();
        drop(db);

        let db = Database::open(&path).unwrap();
        let conn = db.conn();
        assert_eq!(version(conn), SCHEMA_VERSION);
        assert!(crate::db::migration_backup_path(&path, 44).exists());
        assert!(column(conn, "sessions", "agent_name"));
        // No backfill: the role was never recorded, so nothing is claimed.
        let agent: Option<String> = conn
            .query_row(
                "SELECT agent_name FROM sessions WHERE id = 'existing'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(agent.is_none());
        let title: String = conn
            .query_row(
                "SELECT title FROM sessions WHERE id = 'existing'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(title, "Existing");
    }

    #[test]
    fn the_step_is_idempotent_and_matches_the_fresh_schema() {
        let (dir, db, path) = database();
        let conn = db.conn();
        downgrade_to_v44(conn);
        for _ in 0..2 {
            let tx = conn.unchecked_transaction().unwrap();
            migrate_v44_to_v45_tx(&tx).unwrap();
            tx.commit().unwrap();
        }
        assert_eq!(version(conn), 45);
        assert!(column(conn, "sessions", "agent_name"));
        drop(db);

        // The fresh schema and the migration agree on the column's shape.
        let db = Database::open(&path).unwrap();
        let fresh = Database::open(&dir.path().join("fresh.sqlite")).unwrap();
        let describe = |conn: &Connection| -> Vec<(String, String, bool, Option<String>)> {
            conn.prepare(
                "SELECT name, type, \"notnull\", dflt_value FROM pragma_table_info('sessions')
                 ORDER BY name",
            )
            .unwrap()
            .query_map([], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap()
        };
        assert_eq!(describe(db.conn()), describe(fresh.conn()));
    }
}
