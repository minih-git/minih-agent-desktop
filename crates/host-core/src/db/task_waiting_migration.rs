//! Schema v36 -> v37: what a task is waiting on, why it is stuck, and how many
//! times its stage has moved (employee mode 0.5 slice 4a).
//!
//! Three columns, every one of them additive:
//!
//! - `waiting_json` — the requests this task's session has open right now, as
//!   an array of structured entries (`requestId`, `kind`, and the question or
//!   the tool a permission was asked for). The stage is `person/answer` while
//!   that array is not empty, and the person can answer from any surface.
//! - `blocker_json` — what a stuck task reported in its own words: where it is
//!   stuck, what it already tried, and what it suggests. Written by the
//!   `TaskReport` tool, read by the blocked card.
//! - `stage_seq` — a monotonic counter of stage *changes*. It is what makes a
//!   notice exactly-once per change without depending on a delivery: a task the
//!   person started directly has no delivery at all, and a task keeps its stage
//!   across several turns.
//!
//! The step is a pure `ALTER TABLE ... ADD COLUMN`: no table is rebuilt, no row
//! is rewritten, and no statement may fail because a long-lived database
//! arrives with historical foreign-key violations. The v32 -> v33 step rebuilt
//! `sessions` and one orphan row on a real user file refused the whole upgrade,
//! so every later step to this table stays additive.

use super::{anyhow, Connection, Path, Result};
use rusqlite::Transaction;

/// `(column, definition)` for the columns this step adds to `tasks`, shared
/// verbatim by the fresh schema and the migration so they cannot drift.
pub(crate) const TASK_WAITING_COLUMNS: [(&str, &str); 3] = [
    ("waiting_json", "TEXT"),
    ("blocker_json", "TEXT"),
    // SQLite has no counter type; the default makes an old row read as "this
    // stage has never moved", which is true of a task nobody has started.
    ("stage_seq", "INTEGER NOT NULL DEFAULT 0"),
];

/// The `ALTER TABLE` statements for the fresh schema. A new file must end up
/// with exactly the shape the migration produces, so both go through the same
/// list.
pub(crate) fn task_waiting_ddl() -> String {
    TASK_WAITING_COLUMNS
        .iter()
        .map(|(column, definition)| format!("ALTER TABLE tasks ADD COLUMN {column} {definition};"))
        .collect::<Vec<_>>()
        .join("\n")
}

fn has_column(tx: &Transaction<'_>, table: &str, column: &str) -> Result<bool> {
    Ok(tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info(?1) WHERE name = ?2)",
        rusqlite::params![table, column],
        |row| row.get(0),
    )?)
}

pub(crate) fn migrate_v36_to_v37_tx(tx: &Transaction<'_>) -> Result<()> {
    for (column, definition) in TASK_WAITING_COLUMNS {
        // A file that already carries a column (created from the current fresh
        // schema, or a step that stopped before its stamp) is completed, not
        // restarted.
        if !has_column(tx, "tasks", column)? {
            tx.execute_batch(&format!(
                "ALTER TABLE tasks ADD COLUMN {column} {definition};"
            ))
            .map_err(|error| anyhow!("add tasks.{column}: {error}"))?;
        }
    }
    tx.pragma_update(None, "user_version", 37i64)?;
    Ok(())
}

pub(crate) fn migrate(conn: &Connection, _path: &Path) -> Result<()> {
    let tx = conn.unchecked_transaction()?;
    migrate_v36_to_v37_tx(&tx)?;
    tx.commit()?;
    Ok(())
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

    fn column(conn: &Connection, table: &str, name: &str) -> bool {
        conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info(?1) WHERE name = ?2)",
            rusqlite::params![table, name],
            |row| row.get(0),
        )
        .unwrap()
    }

    fn violations(conn: &Connection) -> i64 {
        conn.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
            row.get(0)
        })
        .unwrap()
    }

    /// Leave a file exactly as v36 wrote it: the three columns gone. `tasks` is
    /// dropped and recreated from the same DDL the earlier steps used, because
    /// SQLite cannot drop a column that is part of a check.
    fn downgrade_to_v36(conn: &Connection) {
        conn.execute_batch(&format!(
            "DROP TABLE tasks;
             {TASKS_V33}
             {WORKSPACE_COLUMNS}
             PRAGMA user_version = 36;",
            TASKS_V33 = crate::db::TASKS_DDL,
            WORKSPACE_COLUMNS = crate::db::task_workspace_ddl(),
        ))
        .unwrap();
    }

    fn seed_task(conn: &Connection, id: &str, stage: &str) {
        conn.execute(
            "INSERT OR IGNORE INTO sessions (id, title, created_at, updated_at, role)
             VALUES ('employee-1', 'Employee', 1, 1, 'bot')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT OR IGNORE INTO sessions (id, title, created_at, updated_at, role)
             VALUES ('task-session-1', 'Task', 1, 1, 'task')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO tasks (id, employee_session_id, session_id, title, origin, stage, created_at)
             VALUES (?1, 'employee-1', 'task-session-1', 'Fix', 'direct', ?2, 1)",
            rusqlite::params![id, stage],
        )
        .unwrap();
    }

    #[test]
    fn a_fresh_database_has_the_waiting_columns_at_the_newest_version() {
        let (_dir, db) = database();
        assert_eq!(version(db.conn()), SCHEMA_VERSION);
        for (column_name, _) in TASK_WAITING_COLUMNS {
            assert!(
                column(db.conn(), "tasks", column_name),
                "tasks.{column_name} is missing from a fresh database"
            );
        }
        seed_task(db.conn(), "task-1", "queued");
        // The defaults describe "nothing open, never moved, not stuck": an old
        // row reads as such without any code special-casing a NULL.
        let (waiting, blocker, seq): (Option<String>, Option<String>, i64) = db
            .conn()
            .query_row(
                "SELECT waiting_json, blocker_json, stage_seq FROM tasks WHERE id = 'task-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(waiting, None);
        assert_eq!(blocker, None);
        assert_eq!(seq, 0);
    }

    /// A v36 file upgrades in place, keeps its rows, and gains the columns.
    #[test]
    fn a_v36_database_gains_the_waiting_columns_and_keeps_its_tasks() {
        let (dir, db) = database();
        let path = dir.path().join("pi.sqlite");
        downgrade_to_v36(db.conn());
        assert!(!column(db.conn(), "tasks", "waiting_json"));
        assert_eq!(version(db.conn()), 36);
        // `queued`, not `working`: a `working` row is a claim about a live turn,
        // and the startup fence that runs on open rightly stops it. This test is
        // about the columns, not about the fence.
        seed_task(db.conn(), "old-task", "queued");
        drop(db);

        let db = Database::open(&path).unwrap();
        assert_eq!(version(db.conn()), SCHEMA_VERSION);
        for (column_name, _) in TASK_WAITING_COLUMNS {
            assert!(column(db.conn(), "tasks", column_name));
        }
        let (title, stage, seq): (String, String, i64) = db
            .conn()
            .query_row(
                "SELECT title, stage, stage_seq FROM tasks WHERE id = 'old-task'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(title, "Fix");
        assert_eq!(stage, "queued");
        assert_eq!(seq, 0);
    }

    #[test]
    fn reopening_a_migrated_database_changes_nothing() {
        let (dir, db) = database();
        let path = dir.path().join("pi.sqlite");
        drop(db);
        let db = Database::open(&path).unwrap();
        let before = version(db.conn());
        drop(db);
        let db = Database::open(&path).unwrap();
        assert_eq!(version(db.conn()), before);
        let count: i64 = db
            .conn()
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('tasks')
                 WHERE name IN ('waiting_json', 'blocker_json', 'stage_seq')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 3);
    }

    /// A real database arrives with orphan rows from an older build. This step
    /// only adds columns, so it must carry them across and never refuse the
    /// upgrade because they exist.
    #[test]
    fn a_v36_database_with_historical_orphans_upgrades_and_keeps_them() {
        let (dir, db) = database();
        let path = dir.path().join("pi.sqlite");
        db.conn()
            .pragma_update(None, "foreign_keys", false)
            .unwrap();
        db.conn()
            .execute_batch(
                "INSERT INTO messages (id, session_id, seq, role, text, created_at)
                 VALUES ('orphan-message', 'gone-session', 1, 'user', 'orphaned', 1);
                 INSERT INTO turns (id, session_id, status, started_at)
                 VALUES ('orphan-turn', 'gone-session', 'completed', 1);",
            )
            .unwrap();
        db.conn().pragma_update(None, "foreign_keys", true).unwrap();
        let before = violations(db.conn());
        assert_eq!(before, 2, "the fixture must carry two orphan rows");
        downgrade_to_v36(db.conn());
        drop(db);

        let db = Database::open(&path).unwrap();
        assert_eq!(version(db.conn()), SCHEMA_VERSION);
        assert_eq!(
            violations(db.conn()),
            before,
            "the additive step added or removed a dangling reference"
        );
        assert!(column(db.conn(), "tasks", "stage_seq"));
    }

    /// A step that stopped before its stamp is completed on the next open
    /// without adding a column twice.
    #[test]
    fn a_partially_applied_step_is_completed() {
        let (dir, db) = database();
        let path = dir.path().join("pi.sqlite");
        downgrade_to_v36(db.conn());
        drop(db);

        {
            let conn = Connection::open(&path).unwrap();
            let tx = conn.unchecked_transaction().unwrap();
            migrate_v36_to_v37_tx(&tx).unwrap();
            // Simulate a failure after the statements but before the stamp.
            drop(tx);
        }
        {
            let conn = Connection::open(&path).unwrap();
            assert_eq!(version(&conn), 36, "an uncommitted step leaves v36");
            assert!(!column(&conn, "tasks", "waiting_json"));
        }

        let db = Database::open(&path).unwrap();
        assert_eq!(version(db.conn()), SCHEMA_VERSION);
        for (column_name, _) in TASK_WAITING_COLUMNS {
            assert!(column(db.conn(), "tasks", column_name));
        }
    }
}
