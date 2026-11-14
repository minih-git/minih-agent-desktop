//! Schema v39 -> v40: cards that follow another card, and the task that waits
//! for it (employee mode 0.5 slice 7).
//!
//! A relay is what "one feature branch, several steps" has to become in git: a
//! branch cannot be checked out in two worktrees at once, so the second step
//! starts its own branch from the *end* of the first one's instead of sharing
//! it. Four columns, every one of them additive:
//!
//! - `task_card_drafts.after_draft_id` — the card this one follows, inside the
//!   same turn's batch. It is the steward's declaration that these two steps are
//!   ordered; two cards without it run in parallel, as they always have.
//! - `tasks.relay_parent_task_id` — the task this one continues from, resolved
//!   from `after_draft_id` when the card was confirmed.
//! - `tasks.relay_state` — `waiting` while the previous step runs, `ready` once
//!   it handed off (the host dispatches this one), `orphaned` when the previous
//!   step was abandoned without handing off. NULL is a task in no chain.
//! - `tasks.relay_handoff_at` — when this task handed its work to the next step.
//!   It is the *parent's* own record, and it is what makes "may the next step
//!   start" answerable without asking the next step: a card confirmed after the
//!   handoff starts at once, and a card whose parent was archived without one is
//!   stuck instead of waiting forever.
//!
//! The step is a pure `ALTER TABLE ... ADD COLUMN`: no table is rebuilt and no
//! row is rewritten. The v32 -> v33 step rebuilt `sessions` and one orphan row
//! on a real user file refused the whole upgrade, so every later step that
//! touches these tables stays additive.

use super::{anyhow, Connection, Path, Result};
use rusqlite::Transaction;

/// `(column, definition)` for the columns this step adds to `tasks`, shared
/// verbatim by the fresh schema and the migration so they cannot drift.
pub(crate) const TASK_RELAY_COLUMNS: [(&str, &str); 3] = [
    // The task this one continues from. NULL is "not part of a relay", which is
    // what every task before this slice is.
    ("relay_parent_task_id", "TEXT"),
    // The vocabulary the dock and the dispatcher read. A CHECK is safe on an
    // added column: every existing row gets NULL, and NULL passes.
    (
        "relay_state",
        "TEXT CHECK (relay_state IS NULL OR relay_state IN ('waiting','ready','orphaned'))",
    ),
    // When the work was handed to the next step. NULL is "not handed off (yet)",
    // which is also what an abandoned step keeps, so the two are never confused.
    ("relay_handoff_at", "INTEGER"),
];

/// `(column, definition)` for the columns this step adds to `task_card_drafts`.
///
/// The edge is all a card needs: what became of it is read from the parent
/// *task* (`relay_handoff_at`, `archived_at`), so a confirmation always sees
/// the current truth rather than a snapshot taken when the card was proposed.
pub(crate) const TASK_CARD_AFTER_COLUMNS: [(&str, &str); 1] = [("after_draft_id", "TEXT")];

/// The `ALTER TABLE` statements for the fresh schema. A new file must end up
/// with exactly the shape the migration produces, so both go through the same
/// lists.
pub(crate) fn task_relay_ddl() -> String {
    TASK_RELAY_COLUMNS
        .iter()
        .map(|(column, definition)| format!("ALTER TABLE tasks ADD COLUMN {column} {definition};"))
        .chain(TASK_CARD_AFTER_COLUMNS.iter().map(|(column, definition)| {
            format!("ALTER TABLE task_card_drafts ADD COLUMN {column} {definition};")
        }))
        .collect::<Vec<_>>()
        .join("\n")
}

/// The indexes this slice adds, shared by the fresh schema and the migration.
///
/// The two lookups they cover exist for every task in a chain: the successor of a
/// task being handed off, and the chain a task belongs to.
pub(crate) fn task_relay_indexes() -> &'static str {
    "CREATE INDEX IF NOT EXISTS idx_tasks_relay_parent
       ON tasks(relay_parent_task_id);
     CREATE INDEX IF NOT EXISTS idx_task_card_drafts_after
       ON task_card_drafts(after_draft_id);"
}

fn has_column(tx: &Transaction<'_>, table: &str, column: &str) -> Result<bool> {
    Ok(tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info(?1) WHERE name = ?2)",
        rusqlite::params![table, column],
        |row| row.get(0),
    )?)
}

pub(crate) fn migrate_v39_to_v40_tx(tx: &Transaction<'_>) -> Result<()> {
    for (column, definition) in TASK_RELAY_COLUMNS {
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
    for (column, definition) in TASK_CARD_AFTER_COLUMNS {
        if !has_column(tx, "task_card_drafts", column)? {
            tx.execute_batch(&format!(
                "ALTER TABLE task_card_drafts ADD COLUMN {column} {definition};"
            ))
            .map_err(|error| anyhow!("add task_card_drafts.{column}: {error}"))?;
        }
    }
    tx.execute_batch(task_relay_indexes())?;
    tx.pragma_update(None, "user_version", 40i64)?;
    Ok(())
}

pub(crate) fn migrate(conn: &Connection, _path: &Path) -> Result<()> {
    let tx = conn.unchecked_transaction()?;
    migrate_v39_to_v40_tx(&tx)?;
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

    /// Leave a file exactly as v39 wrote it: the four columns gone. Both tables
    /// are dropped and recreated from the DDL the earlier steps used, because
    /// SQLite cannot drop a column that is part of a check.
    fn downgrade_to_v39(conn: &Connection) {
        conn.execute_batch(&format!(
            "DROP TABLE task_card_drafts;
             {DRAFTS}
             DROP TABLE tasks;
             {TASKS_V33}
             {WORKSPACE}
             {WAITING}
             {DELIVERY}
             PRAGMA user_version = 39;",
            DRAFTS = crate::db::TASK_CARD_DRAFT_DDL,
            TASKS_V33 = crate::db::TASKS_DDL,
            WORKSPACE = crate::db::task_workspace_ddl(),
            WAITING = crate::db::task_waiting_ddl(),
            // The v37 -> v38 step adds the tasks columns *and* the draft's
            // `batch_id`, so this one call reproduces both tables' shape at v39.
            DELIVERY = crate::db::task_delivery_ddl(),
        ))
        .unwrap();
    }

    fn seed(conn: &Connection) {
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
            "INSERT OR IGNORE INTO sessions (id, title, created_at, updated_at, role)
             VALUES ('steward-1', 'Super Agent', 1, 1, 'bot')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO tasks (id, employee_session_id, session_id, title, origin, stage, created_at)
             VALUES ('task-1', 'employee-1', 'task-session-1', 'Fix', 'direct', 'queued', 1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO task_card_drafts
               (id, session_id, status, card_json, card_hash, source_utterance,
                target_session_id, created_at, updated_at)
             VALUES ('draft-1', 'steward-1', 'proposed', '{}', 'hash', 'fix it',
                     'employee-1', 1, 1)",
            [],
        )
        .unwrap();
    }

    #[test]
    fn a_fresh_database_has_the_relay_columns_at_the_newest_version() {
        let (_dir, db) = database();
        assert_eq!(version(db.conn()), SCHEMA_VERSION);
        for (column_name, _) in TASK_RELAY_COLUMNS {
            assert!(
                column(db.conn(), "tasks", column_name),
                "tasks.{column_name} is missing from a fresh database"
            );
        }
        for (column_name, _) in TASK_CARD_AFTER_COLUMNS {
            assert!(
                column(db.conn(), "task_card_drafts", column_name),
                "task_card_drafts.{column_name} is missing from a fresh database"
            );
        }
        seed(db.conn());
        // The defaults describe "in no chain": every task that existed before
        // this slice reads as such without any code special-casing a NULL.
        let (parent, state, handoff): (Option<String>, Option<String>, Option<i64>) = db
            .conn()
            .query_row(
                "SELECT relay_parent_task_id, relay_state, relay_handoff_at
                   FROM tasks WHERE id = 'task-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(parent, None);
        assert_eq!(state, None);
        assert_eq!(handoff, None);
    }

    /// The vocabulary is enforced, so a typo in a handoff cannot create a stage
    /// nothing reads.
    #[test]
    fn an_unknown_relay_state_is_refused() {
        let (_dir, db) = database();
        seed(db.conn());
        let refused = db.conn().execute(
            "UPDATE tasks SET relay_state = 'handedoff' WHERE id = 'task-1'",
            [],
        );
        assert!(refused.is_err(), "an unknown relay_state was accepted");
    }

    #[test]
    fn a_v39_database_gains_the_relay_columns_and_keeps_its_rows() {
        let (dir, db) = database();
        let path = dir.path().join("pi.sqlite");
        downgrade_to_v39(db.conn());
        assert!(!column(db.conn(), "tasks", "relay_state"));
        assert!(!column(db.conn(), "task_card_drafts", "after_draft_id"));
        assert_eq!(version(db.conn()), 39);
        seed(db.conn());
        drop(db);

        let db = Database::open(&path).unwrap();
        assert_eq!(version(db.conn()), SCHEMA_VERSION);
        for (column_name, _) in TASK_RELAY_COLUMNS {
            assert!(column(db.conn(), "tasks", column_name));
        }
        for (column_name, _) in TASK_CARD_AFTER_COLUMNS {
            assert!(column(db.conn(), "task_card_drafts", column_name));
        }
        let (title, parent): (String, Option<String>) = db
            .conn()
            .query_row(
                "SELECT title, relay_parent_task_id FROM tasks WHERE id = 'task-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(title, "Fix");
        assert_eq!(parent, None);
        let drafts: i64 = db
            .conn()
            .query_row("SELECT COUNT(*) FROM task_card_drafts", [], |row| row.get(0))
            .unwrap();
        assert_eq!(drafts, 1, "the migration dropped a draft");
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
                 WHERE name IN ('relay_parent_task_id', 'relay_state', 'relay_handoff_at')",
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
    fn a_v39_database_with_historical_orphans_upgrades_and_keeps_them() {
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
        downgrade_to_v39(db.conn());
        drop(db);

        let db = Database::open(&path).unwrap();
        assert_eq!(version(db.conn()), SCHEMA_VERSION);
        assert_eq!(
            violations(db.conn()),
            before,
            "the additive step added or removed a dangling reference"
        );
        assert!(column(db.conn(), "tasks", "relay_state"));
    }

    /// A step that stopped before its stamp is completed on the next open
    /// without adding a column twice.
    #[test]
    fn a_partially_applied_step_is_completed() {
        let (dir, db) = database();
        let path = dir.path().join("pi.sqlite");
        downgrade_to_v39(db.conn());
        drop(db);

        {
            let conn = Connection::open(&path).unwrap();
            let tx = conn.unchecked_transaction().unwrap();
            migrate_v39_to_v40_tx(&tx).unwrap();
            // Simulate a failure after the statements but before the stamp.
            drop(tx);
        }
        {
            let conn = Connection::open(&path).unwrap();
            assert_eq!(version(&conn), 39, "an uncommitted step leaves v39");
            assert!(!column(&conn, "tasks", "relay_state"));
        }

        let db = Database::open(&path).unwrap();
        assert_eq!(version(db.conn()), SCHEMA_VERSION);
        for (column_name, _) in TASK_RELAY_COLUMNS {
            assert!(column(db.conn(), "tasks", column_name));
        }
    }
}