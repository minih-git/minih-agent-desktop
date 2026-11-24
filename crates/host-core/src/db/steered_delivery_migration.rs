//! Schema v45 -> v46: a delivery a running turn accepted as steering input.
//!
//! A completion receipt that arrives while its target session is busy is queued
//! as a turn of its own. When it is instead folded into the turn that is already
//! running (ADR 0265, `send now`), that turn becomes the delivery's turn: the
//! row has no `turn_id` of its own, so the ledger used to stay `queued` and the
//! next drain opened a second turn for the same content.
//!
//! `host_turn_id` names the turn carrying the input. It is deliberately not
//! `turn_id`: that column is unique and references a turn this delivery started.
//! One additive nullable column and one partial index, so no row is rewritten,
//! the step is idempotent, and a long-lived file keeps everything it had.
//!
//! There is no backfill. Before this version a steered delivery was never
//! recorded, and the app marks those rows `interrupted` on the next start, so
//! guessing which of them were steered would claim work nobody can verify.

use super::*;
use rusqlite::Transaction;

/// `(column, definition)` for the carrying-turn column, so the fresh schema and
/// this step cannot drift.
pub(crate) const SESSION_COLLABORATION_HOST_TURN_COLUMNS: [(&str, &str); 1] =
    [("host_turn_id", "TEXT")];

/// The lookup that turns a settled turn into the deliveries it carried.
const HOST_TURN_INDEX: &str = "CREATE INDEX IF NOT EXISTS idx_session_collaboration_host_turn
  ON session_collaboration_messages(host_turn_id) WHERE host_turn_id IS NOT NULL;";

fn has_column(tx: &Transaction<'_>, table: &str, name: &str) -> Result<bool> {
    Ok(tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info(?1) WHERE name = ?2)",
        params![table, name],
        |row| row.get(0),
    )?)
}

/// Apply the v46 shape inside the caller's transaction.
pub(crate) fn migrate_v45_to_v46_tx(tx: &Transaction<'_>) -> Result<()> {
    for (column, definition) in SESSION_COLLABORATION_HOST_TURN_COLUMNS {
        if !has_column(tx, "session_collaboration_messages", column)? {
            tx.execute_batch(&format!(
                "ALTER TABLE session_collaboration_messages ADD COLUMN {column} {definition};"
            ))
            .map_err(|error| anyhow!("add session_collaboration_messages.{column}: {error}"))?;
        }
    }
    tx.execute_batch(HOST_TURN_INDEX)?;
    tx.pragma_update(None, "user_version", 46i64)?;
    Ok(())
}

/// Run the step on a real file: back up the v45 file, then one transaction that
/// either produces the v46 shape and stamps it, or changes nothing.
pub(crate) fn migrate(conn: &Connection, path: &Path) -> Result<()> {
    let backup = create_migration_backup(conn, path, 45)?;
    let tx = conn.unchecked_transaction()?;
    migrate_v45_to_v46_tx(&tx)?;
    tx.commit().with_context(|| {
        format!(
            "commit schema v45 to v46 migration; backup {} remains",
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

    /// Leave a file exactly as v45 wrote it: the carrying-turn column gone and
    /// one real delivery still in the ledger.
    fn downgrade_to_v45(conn: &Connection) {
        conn.execute_batch(
            "DROP INDEX IF EXISTS idx_session_collaboration_host_turn;
             ALTER TABLE session_collaboration_messages DROP COLUMN host_turn_id;
             PRAGMA user_version = 45;",
        )
        .unwrap();
    }

    fn insert_session(conn: &Connection, id: &str) {
        conn.execute(
            "INSERT INTO sessions (id, title, role, created_at, updated_at)
             VALUES (?1, 'Existing', 'user', 1, 1)",
            params![id],
        )
        .unwrap();
    }

    fn insert_delivery(conn: &Connection, id: &str, target: &str) {
        conn.execute(
            "INSERT INTO session_collaboration_messages
             (id,plugin_id,source_session_id,source_title,target_session_id,target_title,
              kind,content,status,notify_on_completion,turn_id,reply_to_message_id,
              idempotency_key,remaining_hops,permission_ceiling,created_at,updated_at)
             VALUES (?1,'pi.session-orchestrator','sender','Sender',?2,'Target',
              'completion','{}','queued',0,NULL,NULL,'existing',32,'ask',1,1)",
            params![id, target],
        )
        .unwrap();
    }

    #[test]
    fn an_existing_v45_file_gains_the_column_and_keeps_its_rows() {
        let (_dir, db, path) = database();
        let conn = db.conn();
        downgrade_to_v45(conn);
        insert_session(conn, "target");
        insert_delivery(conn, "delivery", "target");
        drop(db);

        let db = Database::open(&path).unwrap();
        let conn = db.conn();
        assert_eq!(version(conn), SCHEMA_VERSION);
        assert!(crate::db::migration_backup_path(&path, 45).exists());
        assert!(column(
            conn,
            "session_collaboration_messages",
            "host_turn_id"
        ));
        // No backfill: nothing claims a carrying turn for an existing row.
        let carried: Option<String> = conn
            .query_row(
                "SELECT host_turn_id FROM session_collaboration_messages WHERE id = 'delivery'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(carried.is_none());
        let status: String = conn
            .query_row(
                "SELECT status FROM session_collaboration_messages WHERE id = 'delivery'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        // The reading path is unchanged: the startup fence still closes a queued
        // delivery no turn is holding, and it says nothing about `host_turn_id`.
        assert_eq!(status, "interrupted");
        let content: String = conn
            .query_row(
                "SELECT content FROM session_collaboration_messages WHERE id = 'delivery'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(content, "{}");
    }

    #[test]
    fn the_step_is_idempotent_and_matches_the_fresh_schema() {
        let (dir, db, path) = database();
        let conn = db.conn();
        downgrade_to_v45(conn);
        for _ in 0..2 {
            let tx = conn.unchecked_transaction().unwrap();
            migrate_v45_to_v46_tx(&tx).unwrap();
            tx.commit().unwrap();
        }
        assert_eq!(version(conn), 46);
        assert!(column(
            conn,
            "session_collaboration_messages",
            "host_turn_id"
        ));
        drop(db);

        // The fresh schema and the migration agree on the column's shape.
        let db = Database::open(&path).unwrap();
        let fresh = Database::open(&dir.path().join("fresh.sqlite")).unwrap();
        let describe = |conn: &Connection| -> Vec<(String, String, bool, Option<String>)> {
            conn.prepare(
                "SELECT name, type, \"notnull\", dflt_value
                 FROM pragma_table_info('session_collaboration_messages')
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
