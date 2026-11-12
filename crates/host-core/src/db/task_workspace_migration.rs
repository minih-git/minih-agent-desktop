//! Schema v33 -> v34: the workspace a task works in (ADR 0329 amendment
//! 2026-11, employee mode 0.5 slice 2).
//!
//! A task that touches a repository does its work in its own git worktree
//! (`<top level>/.worktree/<short id>-<slug>`). The `worktrees` table of
//! ADR 0329 already holds the folder, the branch and the port block; what a
//! task needs on top is where it is in preparing that workspace, why it failed,
//! which commit it started from, and how its work will be delivered.
//!
//! Five columns, every one of them additive:
//!
//! - `workspace_status` — `none` (no repository), `preparing`, `ready`, `failed`;
//! - `workspace_error` — why preparation failed, in the person's words;
//! - `base_ref` — the ref the branch was created from (`refs/remotes/origin/main`);
//! - `base_remote` — whether that ref was fetched from the remote;
//! - `delivery_mode` — `pr` (a GitHub remote), `local` (merge back into the
//!   project), or `none` (no repository).
//!
//! `workspace_path` and `branch` already exist from v33 and are written when the
//! workspace becomes ready.
//!
//! The step is a pure `ALTER TABLE ... ADD COLUMN`: no table is rebuilt, no row
//! is rewritten, and no statement may fail because a long-lived database
//! arrives with historical foreign-key violations. That is deliberate — the
//! v32 -> v33 step rebuilt `sessions`, and one orphan row on a real user file
//! refused the whole upgrade and stopped the application from starting.

use super::{anyhow, Connection, Path, Result};
use rusqlite::Transaction;

/// `(column, definition)` for the columns this step adds to `tasks`, shared
/// verbatim by the fresh schema and the migration so they cannot drift.
pub(crate) const TASK_WORKSPACE_COLUMNS: [(&str, &str); 6] = [
    (
        "workspace_status",
        "TEXT NOT NULL DEFAULT 'none'
         CHECK (workspace_status IN ('none', 'preparing', 'ready', 'failed'))",
    ),
    ("workspace_error", "TEXT"),
    ("base_ref", "TEXT"),
    // SQLite has no boolean; 0/1 keeps the value readable in a raw query.
    ("base_remote", "INTEGER NOT NULL DEFAULT 0"),
    (
        "delivery_mode",
        "TEXT CHECK (delivery_mode IN ('pr', 'local', 'none'))",
    ),
    // The branch the task actually works on. `branch` keeps its v33 meaning —
    // the branch the task asked for (`repo.ref` on a card) — so a reader can
    // still tell what was wanted from what was created.
    ("workspace_branch", "TEXT"),
];

/// The `ALTER TABLE` statements for the fresh schema. A new file must end up
/// with exactly the shape the migration produces, so both go through the same
/// list.
pub(crate) fn task_workspace_ddl() -> String {
    TASK_WORKSPACE_COLUMNS
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

pub(crate) fn migrate_v33_to_v34_tx(tx: &Transaction<'_>) -> Result<()> {
    for (column, definition) in TASK_WORKSPACE_COLUMNS {
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
    tx.pragma_update(None, "user_version", 34i64)?;
    Ok(())
}

pub(crate) fn migrate(conn: &Connection, _path: &Path) -> Result<()> {
    let tx = conn.unchecked_transaction()?;
    migrate_v33_to_v34_tx(&tx)?;
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

    /// Leave a file exactly as v33 wrote it: the five columns gone. `tasks` is
    /// dropped and recreated because SQLite cannot drop a column here, and no
    /// other table references it.
    fn downgrade_to_v33(conn: &Connection) {
        conn.execute_batch(&format!(
            "DROP TABLE tasks;
             {TASKS_V33}
             PRAGMA user_version = 33;",
            TASKS_V33 = crate::db::TASKS_DDL
        ))
        .unwrap();
    }

    #[test]
    fn a_fresh_database_has_the_workspace_columns_at_the_newest_version() {
        let (_dir, db) = database();
        assert_eq!(version(db.conn()), SCHEMA_VERSION);
        for (column_name, _) in TASK_WORKSPACE_COLUMNS {
            assert!(
                column(db.conn(), "tasks", column_name),
                "tasks.{column_name} is missing from a fresh database"
            );
        }
        // The defaults describe "no workspace": an old row reads as such
        // without any code special-casing a NULL.
        db.conn()
            .execute(
                "INSERT INTO sessions (id, title, created_at, updated_at, role)
                 VALUES ('employee-1', 'Employee', 1, 1, 'bot')",
                [],
            )
            .unwrap();
        db.conn()
            .execute(
                "INSERT INTO sessions (id, title, created_at, updated_at, role)
                 VALUES ('task-session-1', 'Task', 1, 1, 'task')",
                [],
            )
            .unwrap();
        db.conn()
            .execute(
                "INSERT INTO tasks (id, employee_session_id, session_id, title, origin, stage, created_at)
                 VALUES ('task-1', 'employee-1', 'task-session-1', 'Fix', 'direct', 'queued', 1)",
                [],
            )
            .unwrap();
        let (status, remote): (String, i64) = db
            .conn()
            .query_row(
                "SELECT workspace_status, base_remote FROM tasks WHERE id = 'task-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(status, "none");
        assert_eq!(remote, 0);
        // The vocabulary is enforced by the column, not only by the host.
        assert!(db
            .conn()
            .execute(
                "UPDATE tasks SET workspace_status = 'ready' WHERE id = 'task-1'",
                [],
            )
            .is_ok());
        assert!(db
            .conn()
            .execute(
                "UPDATE tasks SET workspace_status = 'starting' WHERE id = 'task-1'",
                [],
            )
            .is_err());
        assert!(db
            .conn()
            .execute(
                "UPDATE tasks SET delivery_mode = 'ftp' WHERE id = 'task-1'",
                [],
            )
            .is_err());
    }

    /// A v33 file upgrades in place, keeps its rows, and gains the columns.
    #[test]
    fn a_v33_database_gains_the_workspace_columns_and_keeps_its_tasks() {
        let (dir, db) = database();
        let path = dir.path().join("pi.sqlite");
        db.conn()
            .execute(
                "INSERT INTO sessions (id, title, created_at, updated_at, role)
                 VALUES ('employee-1', 'Employee', 1, 1, 'bot')",
                [],
            )
            .unwrap();
        db.conn()
            .execute(
                "INSERT INTO sessions (id, title, created_at, updated_at, role)
                 VALUES ('task-session-1', 'Task', 1, 1, 'task')",
                [],
            )
            .unwrap();
        downgrade_to_v33(db.conn());
        assert!(!column(db.conn(), "tasks", "workspace_status"));
        assert_eq!(version(db.conn()), 33);
        db.conn()
            .execute(
                "INSERT INTO tasks (id, employee_session_id, session_id, title, origin, stage, created_at)
                 VALUES ('old-task', 'employee-1', 'task-session-1', 'Fix', 'steward', 'working', 1)",
                [],
            )
            .unwrap();
        drop(db);

        let db = Database::open(&path).unwrap();
        assert_eq!(version(db.conn()), SCHEMA_VERSION);
        for (column_name, _) in TASK_WORKSPACE_COLUMNS {
            assert!(column(db.conn(), "tasks", column_name));
        }
        // The pre-existing task is untouched, and reads as "no workspace".
        let (title, status): (String, String) = db
            .conn()
            .query_row(
                "SELECT title, workspace_status FROM tasks WHERE id = 'old-task'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(title, "Fix");
        assert_eq!(status, "none");
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
                 WHERE name IN ('workspace_status', 'workspace_error', 'base_ref',
                                'base_remote', 'delivery_mode', 'workspace_branch')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 6);
    }

    /// A real database arrives with orphan rows from an older build. This step
    /// only adds columns, so it must carry them across and never refuse the
    /// upgrade because they exist.
    #[test]
    fn a_v33_database_with_historical_orphans_upgrades_and_keeps_them() {
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
        downgrade_to_v33(db.conn());
        drop(db);

        let db = Database::open(&path).unwrap();
        assert_eq!(version(db.conn()), SCHEMA_VERSION);
        assert_eq!(
            violations(db.conn()),
            before,
            "the additive step added or removed a dangling reference"
        );
        assert!(column(db.conn(), "tasks", "workspace_status"));
    }

    /// A step that stopped before its stamp is completed on the next open
    /// without adding a column twice.
    #[test]
    fn a_partially_applied_step_is_completed() {
        let (dir, db) = database();
        let path = dir.path().join("pi.sqlite");
        downgrade_to_v33(db.conn());
        drop(db);

        {
            let conn = Connection::open(&path).unwrap();
            let tx = conn.unchecked_transaction().unwrap();
            migrate_v33_to_v34_tx(&tx).unwrap();
            // Simulate a failure after the statements but before the stamp.
            drop(tx);
        }
        {
            let conn = Connection::open(&path).unwrap();
            assert_eq!(version(&conn), 33, "an uncommitted step leaves v33");
            assert!(!column(&conn, "tasks", "workspace_status"));
        }

        let db = Database::open(&path).unwrap();
        assert_eq!(version(db.conn()), SCHEMA_VERSION);
        for (column_name, _) in TASK_WORKSPACE_COLUMNS {
            assert!(column(db.conn(), "tasks", column_name));
        }
    }
}
