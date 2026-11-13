//! Schema v37 -> v38: a task's completion, its acceptance and the delivery the
//! host performed for it (employee mode 0.5 slice 4b).
//!
//! Four additions, every one of them additive:
//!
//! - `tasks.accepted_at` — the person said the work is acceptable. It is *not*
//!   an archive: the task stays, its completion card stays reachable, and the
//!   merge can still be done from it later. `NULL` means "not accepted yet".
//! - `tasks.result_json` — what the employee delivered, in its own structured
//!   words: a summary, one line per acceptance criterion with ✓/✗, and what is
//!   left over. Written by `TaskReport { status: "ready" }`, cleared when a new
//!   turn starts, because the result of a finished turn is not the result of the
//!   next one.
//! - `tasks.delivery_json` — the fixed steps the host executed to land the work
//!   (`read-pr`, `gate`, `head`, `land`, `push-main`, `push-remotes`,
//!   `verify-merged`, `delete-branches`, `cleanup`) with their status and time.
//!   It exists so a retry continues from the first unfinished step instead of
//!   repeating an irreversible one.
//! - `task_card_drafts.batch_id` — one sentence split into several cards is one
//!   batch. Main fills it from the turn id, so the summary card can appear once
//!   every task of that batch is finished.
//!
//! The step is a pure `ALTER TABLE ... ADD COLUMN`: no table is rebuilt, no row
//! is rewritten, and no statement may fail because a long-lived database arrives
//! with historical foreign-key violations. The v32 -> v33 step rebuilt
//! `sessions` and one orphan row on a real user file refused the whole upgrade,
//! so every later step stays additive.

use super::{anyhow, Connection, Path, Result};
use rusqlite::Transaction;

/// `(column, definition)` for the columns this step adds to `tasks`, shared
/// verbatim by the fresh schema and the migration so they cannot drift.
pub(crate) const TASK_DELIVERY_COLUMNS: [(&str, &str); 3] = [
    ("accepted_at", "INTEGER"),
    ("result_json", "TEXT"),
    ("delivery_json", "TEXT"),
];

/// The columns this step adds to `task_card_drafts`.
pub(crate) const TASK_CARD_BATCH_COLUMNS: [(&str, &str); 1] = [("batch_id", "TEXT")];

/// The `ALTER TABLE` statements for the fresh schema. A new file must end up
/// with exactly the shape the migration produces, so both go through the same
/// list.
pub(crate) fn task_delivery_ddl() -> String {
    TASK_DELIVERY_COLUMNS
        .iter()
        .map(|(column, definition)| format!("ALTER TABLE tasks ADD COLUMN {column} {definition};"))
        .chain(TASK_CARD_BATCH_COLUMNS.iter().map(|(column, definition)| {
            format!("ALTER TABLE task_card_drafts ADD COLUMN {column} {definition};")
        }))
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

fn has_table(tx: &Transaction<'_>, table: &str) -> Result<bool> {
    Ok(tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
        rusqlite::params![table],
        |row| row.get(0),
    )?)
}

pub(crate) fn migrate_v37_to_v38_tx(tx: &Transaction<'_>) -> Result<()> {
    for (column, definition) in TASK_DELIVERY_COLUMNS {
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
    if has_table(tx, "task_card_drafts")? {
        for (column, definition) in TASK_CARD_BATCH_COLUMNS {
            if !has_column(tx, "task_card_drafts", column)? {
                tx.execute_batch(&format!(
                    "ALTER TABLE task_card_drafts ADD COLUMN {column} {definition};"
                ))
                .map_err(|error| anyhow!("add task_card_drafts.{column}: {error}"))?;
            }
        }
    }
    tx.pragma_update(None, "user_version", 38i64)?;
    Ok(())
}

pub(crate) fn migrate(conn: &Connection, _path: &Path) -> Result<()> {
    let tx = conn.unchecked_transaction()?;
    migrate_v37_to_v38_tx(&tx)?;
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

    /// Leave a file exactly as v37 wrote it: the four columns gone. Both `tasks`
    /// and `task_card_drafts` were extended with plain added columns, so SQLite
    /// can drop them without rebuilding either table.
    fn downgrade_to_v37(conn: &Connection) {
        for (column, _) in TASK_DELIVERY_COLUMNS {
            conn.execute_batch(&format!("ALTER TABLE tasks DROP COLUMN {column};"))
                .unwrap();
        }
        for (column, _) in TASK_CARD_BATCH_COLUMNS {
            conn.execute_batch(&format!(
                "ALTER TABLE task_card_drafts DROP COLUMN {column};"
            ))
            .unwrap();
        }
        conn.pragma_update(None, "user_version", 37i64).unwrap();
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

    fn seed_draft(conn: &Connection, id: &str) {
        conn.execute(
            "INSERT OR IGNORE INTO sessions (id, title, created_at, updated_at, role)
             VALUES ('steward-1', 'Super Agent', 1, 1, 'bot')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO task_card_drafts
             (id, session_id, status, card_json, card_hash, source_utterance,
              target_session_id, created_at, updated_at)
             VALUES (?1, 'steward-1', 'proposed', '{}', 'hash', 'do it', 'employee-1', 1, 1)",
            rusqlite::params![id],
        )
        .unwrap();
    }

    #[test]
    fn a_fresh_database_has_the_delivery_columns_at_the_newest_version() {
        let (_dir, db) = database();
        assert_eq!(version(db.conn()), SCHEMA_VERSION);
        for (column_name, _) in TASK_DELIVERY_COLUMNS {
            assert!(
                column(db.conn(), "tasks", column_name),
                "tasks.{column_name} is missing from a fresh database"
            );
        }
        for (column_name, _) in TASK_CARD_BATCH_COLUMNS {
            assert!(
                column(db.conn(), "task_card_drafts", column_name),
                "task_card_drafts.{column_name} is missing from a fresh database"
            );
        }
        seed_task(db.conn(), "task-1", "person/accept");
        // The defaults describe "not accepted, nothing reported, nothing run":
        // an old row reads as such without any code special-casing a NULL.
        let (accepted, result, delivery): (Option<i64>, Option<String>, Option<String>) = db
            .conn()
            .query_row(
                "SELECT accepted_at, result_json, delivery_json FROM tasks WHERE id = 'task-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(accepted, None);
        assert_eq!(result, None);
        assert_eq!(delivery, None);
    }

    /// A v37 file upgrades in place, keeps its rows, and gains the columns.
    #[test]
    fn a_v37_database_gains_the_delivery_columns_and_keeps_its_rows() {
        let (dir, db) = database();
        let path = dir.path().join("pi.sqlite");
        downgrade_to_v37(db.conn());
        assert!(!column(db.conn(), "tasks", "accepted_at"));
        assert!(!column(db.conn(), "task_card_drafts", "batch_id"));
        assert_eq!(version(db.conn()), 37);
        seed_task(db.conn(), "old-task", "person/accept");
        seed_draft(db.conn(), "old-draft");
        drop(db);

        let db = Database::open(&path).unwrap();
        assert_eq!(version(db.conn()), SCHEMA_VERSION);
        for (column_name, _) in TASK_DELIVERY_COLUMNS {
            assert!(column(db.conn(), "tasks", column_name));
        }
        assert!(column(db.conn(), "task_card_drafts", "batch_id"));
        let (title, stage): (String, String) = db
            .conn()
            .query_row("SELECT title, stage FROM tasks WHERE id = 'old-task'", [], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .unwrap();
        assert_eq!(title, "Fix");
        assert_eq!(stage, "person/accept");
        // The row that was already there keeps its meaning: an old card has no
        // batch, and a NULL batch is never grouped into a summary.
        let batch: Option<String> = db
            .conn()
            .query_row(
                "SELECT batch_id FROM task_card_drafts WHERE id = 'old-draft'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(batch, None);
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
                 WHERE name IN ('accepted_at', 'result_json', 'delivery_json')",
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
    fn a_v37_database_with_historical_orphans_upgrades_and_keeps_them() {
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
        downgrade_to_v37(db.conn());
        drop(db);

        let db = Database::open(&path).unwrap();
        assert_eq!(version(db.conn()), SCHEMA_VERSION);
        assert_eq!(
            violations(db.conn()),
            before,
            "the additive step added or removed a dangling reference"
        );
        assert!(column(db.conn(), "tasks", "delivery_json"));
    }

    /// A step that stopped before its stamp is completed on the next open
    /// without adding a column twice.
    #[test]
    fn a_partially_applied_step_is_completed() {
        let (dir, db) = database();
        let path = dir.path().join("pi.sqlite");
        downgrade_to_v37(db.conn());
        drop(db);

        {
            let conn = Connection::open(&path).unwrap();
            let tx = conn.unchecked_transaction().unwrap();
            migrate_v37_to_v38_tx(&tx).unwrap();
            // Simulate a failure after the statements but before the stamp.
            drop(tx);
        }
        {
            let conn = Connection::open(&path).unwrap();
            assert_eq!(version(&conn), 37, "an uncommitted step leaves v37");
            assert!(!column(&conn, "tasks", "accepted_at"));
        }

        let db = Database::open(&path).unwrap();
        assert_eq!(version(db.conn()), SCHEMA_VERSION);
        for (column_name, _) in TASK_DELIVERY_COLUMNS {
            assert!(column(db.conn(), "tasks", column_name));
        }
    }
}