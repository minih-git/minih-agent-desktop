//! Schema v43 -> v44: where a session came from (ADR persisted-session-origin).
//!
//! Three nullable/defaulted columns on `sessions` and a backfill that reads the
//! evidence the old schema already held. The evidence is incomplete by
//! construction, so the backfill is a priority order rather than a proof:
//! a plugin's link row is the strongest claim, an employee task's role is next,
//! and a run row that owns a transcript is last. Everything else stays `user`,
//! which is also what the column default answers for a row this step never
//! touches.
//!
//! Additive and idempotent: no table is rebuilt, no row is rewritten twice, and
//! the value of `origin` only ever moves away from its default for a row whose
//! creator is recorded somewhere.

use super::*;
use rusqlite::Transaction;

/// `(column, definition)` for the three columns, in one place so the fresh
/// schema and this step cannot drift.
pub(crate) const SESSION_ORIGIN_COLUMNS: [(&str, &str); 3] = [
    (
        "origin",
        "TEXT NOT NULL DEFAULT 'user'
         CHECK (origin IN ('user', 'agent', 'plugin', 'task', 'scheduled'))",
    ),
    ("origin_session_id", "TEXT"),
    ("origin_task_id", "TEXT"),
];

fn has_column(tx: &Transaction<'_>, table: &str, name: &str) -> Result<bool> {
    Ok(tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info(?1) WHERE name = ?2)",
        params![table, name],
        |row| row.get(0),
    )?)
}

fn has_table(tx: &Transaction<'_>, name: &str) -> Result<bool> {
    Ok(tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
        params![name],
        |row| row.get(0),
    )?)
}

/// Apply the v44 shape inside the caller's transaction.
pub(crate) fn migrate_v43_to_v44_tx(tx: &Transaction<'_>) -> Result<()> {
    for (column, definition) in SESSION_ORIGIN_COLUMNS {
        if !has_column(tx, "sessions", column)? {
            tx.execute_batch(&format!(
                "ALTER TABLE sessions ADD COLUMN {column} {definition};"
            ))
            .map_err(|error| anyhow!("add sessions.{column}: {error}"))?;
        }
    }
    backfill(tx)?;
    tx.pragma_update(None, "user_version", 44i64)?;
    Ok(())
}

/// Classify the rows this host already has.
///
/// Each statement only touches rows still at the default, so the order is the
/// precedence and a re-run changes nothing.
fn backfill(tx: &Transaction<'_>) -> Result<()> {
    // A worker session: the plugin wrote the link row that also grants its
    // permission parent. That row is the only trace a plugin spawn left.
    if has_table(tx, "session_collaboration_links")? {
        tx.execute(
            "UPDATE sessions SET
                 origin = 'plugin',
                 origin_session_id = (SELECT l.created_by_session_id
                                      FROM session_collaboration_links l
                                      WHERE l.session_id = sessions.id)
             WHERE origin = 'user'
               AND EXISTS (SELECT 1 FROM session_collaboration_links l
                           WHERE l.session_id = sessions.id)",
            [],
        )?;
    }
    // An employee's task session. `owner_session_id` is the employee, which is
    // exactly the session the new writers record as the origin.
    tx.execute(
        "UPDATE sessions SET origin = 'task', origin_session_id = owner_session_id
         WHERE origin = 'user' AND role = 'task' AND owner_session_id IS NOT NULL",
        [],
    )?;
    tx.execute(
        "UPDATE sessions SET origin = 'task'
         WHERE origin = 'user' AND role = 'task'",
        [],
    )?;
    // A scheduled run's transcript. The latest run names the task, so a task
    // that was deleted after its runs still leaves the id behind.
    if has_table(tx, "task_runs")? {
        tx.execute(
            "UPDATE sessions SET
                 origin = 'scheduled',
                 origin_task_id = (SELECT r.task_id FROM task_runs r
                                   WHERE r.session_id = sessions.id
                                   ORDER BY r.started_at DESC, r.id DESC LIMIT 1)
             WHERE origin = 'user'
               AND EXISTS (SELECT 1 FROM task_runs r WHERE r.session_id = sessions.id)",
            [],
        )?;
    }
    Ok(())
}

/// Run the step on a real file: back up the v43 file, then one transaction that
/// either produces the v44 shape and stamps it, or changes nothing.
pub(crate) fn migrate(conn: &Connection, path: &Path) -> Result<()> {
    let backup = create_migration_backup(conn, path, 43)?;
    let tx = conn.unchecked_transaction()?;
    migrate_v43_to_v44_tx(&tx)?;
    tx.commit().with_context(|| {
        format!(
            "commit schema v43 to v44 migration; backup {} remains",
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

    fn seed_session(conn: &Connection, id: &str, role: &str) {
        conn.execute(
            "INSERT OR IGNORE INTO sessions (id, title, role, created_at, updated_at)
             VALUES (?1, ?2, ?3, 1, 1)",
            params![id, format!("Session {id}"), role],
        )
        .unwrap();
    }
    fn seed_scheduled_task(conn: &Connection, id: &str) {
        conn.execute(
            "INSERT OR IGNORE INTO scheduled_tasks (id, title, prompt, created_at, updated_at)
             VALUES (?1, ?2, 'prompt', 1, 1)",
            params![id, format!("Task {id}")],
        )
        .unwrap();
    }

    /// Leave a file exactly as v43 wrote it: the three columns gone.
    fn downgrade_to_v43(conn: &Connection) {
        conn.execute_batch(
            "ALTER TABLE sessions DROP COLUMN origin;
             ALTER TABLE sessions DROP COLUMN origin_session_id;
             ALTER TABLE sessions DROP COLUMN origin_task_id;
             PRAGMA user_version = 43;",
        )
        .unwrap();
    }

    fn origins(conn: &Connection) -> Vec<(String, Option<String>, Option<String>)> {
        conn.prepare("SELECT id, origin, origin_session_id FROM sessions ORDER BY id")
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap()
    }

    #[test]
    fn every_creator_the_old_schema_recorded_is_recovered() {
        let (_dir, db, path) = database();
        let conn = db.conn();
        downgrade_to_v43(conn);
        seed_session(conn, "user-session", "user");
        seed_session(conn, "employee", "bot");
        seed_session(conn, "task-session", "task");
        seed_session(conn, "worker", "user");
        seed_session(conn, "run", "user");
        // The evidence the old schema kept: a task session belongs to its
        // employee, a worker has a collaboration link, and a run owns a row in
        // `task_runs`.
        conn.execute(
            "UPDATE sessions SET owner_session_id = 'employee' WHERE id = 'task-session'",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO session_collaboration_links
               (session_id, created_by_session_id, plugin_id, created_at)
             VALUES ('worker', 'user-session', 'acme', 2)",
            [],
        )
        .unwrap();
        seed_scheduled_task(conn, "nightly");
        conn.execute(
            "INSERT INTO task_runs (id, task_id, session_id, status, started_at)
             VALUES ('run-1', 'nightly', 'run', 'completed', 3)",
            [],
        )
        .unwrap();
        drop(db);

        let db = Database::open(&path).unwrap();
        let conn = db.conn();
        assert_eq!(version(conn), SCHEMA_VERSION);
        assert!(crate::db::migration_backup_path(&path, 43).exists());
        assert_eq!(
            origins(conn),
            vec![
                ("employee".into(), Some("user".into()), None),
                // A run names its task in `origin_task_id` (asserted below), not
                // a parent session.
                ("run".into(), Some("scheduled".into()), None),
                (
                    "task-session".into(),
                    Some("task".into()),
                    Some("employee".into())
                ),
                ("user-session".into(), Some("user".into()), None),
                (
                    "worker".into(),
                    Some("plugin".into()),
                    Some("user-session".into())
                ),
            ]
        );
        let task_id: Option<String> = conn
            .query_row(
                "SELECT origin_task_id FROM sessions WHERE id = 'run'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(task_id.as_deref(), Some("nightly"));
    }

    #[test]
    fn the_latest_run_names_the_task_of_a_reused_conversation() {
        let (_dir, db, path) = database();
        let conn = db.conn();
        downgrade_to_v43(conn);
        seed_session(conn, "shared", "user");
        for (id, task, started) in [("r-1", "first", 10), ("r-2", "second", 20)] {
            seed_scheduled_task(conn, task);
            conn.execute(
                "INSERT INTO task_runs (id, task_id, session_id, status, started_at)
                 VALUES (?1, ?2, 'shared', 'completed', ?3)",
                params![id, task, started],
            )
            .unwrap();
        }
        drop(db);

        let db = Database::open(&path).unwrap();
        let task_id: String = db
            .conn()
            .query_row(
                "SELECT origin_task_id FROM sessions WHERE id = 'shared'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(task_id, "second", "the most recent run wins");
    }

    #[test]
    fn an_empty_v43_file_upgrades_and_the_step_is_idempotent() {
        let (dir, db, path) = database();
        let conn = db.conn();
        downgrade_to_v43(conn);
        for _ in 0..2 {
            let tx = conn.unchecked_transaction().unwrap();
            migrate_v43_to_v44_tx(&tx).unwrap();
            tx.commit().unwrap();
        }
        assert_eq!(version(conn), 44);
        for name in ["origin", "origin_session_id", "origin_task_id"] {
            assert!(column(conn, "sessions", name), "sessions.{name} exists");
        }
        drop(db);

        // The fresh schema and the migration agree on the columns' shape.
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
