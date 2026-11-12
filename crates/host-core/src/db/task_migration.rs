//! Schema v32 -> v33: a task under an employee (ADR bot-sessions-and-steward
//! §7, "Tasks under employees").
//!
//! Employee mode 0.5 splits the employee from the work it does. An employee row
//! stays a durable container with a profile, and every piece of work becomes a
//! *task*: its own session (so its own transcript, project and workspace), tied
//! to the employee that owns it.
//!
//! Three additions, all of them additive:
//! - `sessions.role` accepts `'task'`. SQLite cannot alter a `CHECK`, so the
//!   table is rebuilt once, copying every column and preserving every row;
//! - `sessions` gains `owner_session_id` (the employee, for a task session) and
//!   `archived_at` (a task session leaves the sidebar with its task);
//! - a `tasks` table holds what a session cannot: who started the task, which
//!   delivery carries the steward's authorization, the repository and branch it
//!   works on, and its current stage.
//!
//! `tasks.stage` is the ADR's stage vocabulary — the same seven values the
//! collaboration ledger stores — so a task and a delivery never disagree about
//! what "waiting for a person" means.
//!
//! Every pre-existing row keeps its exact meaning: every session stays an
//! ordinary conversation or an employee, `owner_session_id` and `archived_at`
//! are NULL, and `tasks` is empty. The step rewrites the sessions table, so it
//! runs in one transaction that stamps `user_version = 33` only after the last
//! statement succeeds; a failure rolls back and leaves v32 authoritative.

use super::{anyhow, Connection, Context, Path, Result};
use rusqlite::Transaction;

/// Shared verbatim by the fresh schema and the migration so they cannot drift.
pub(crate) const TASKS_DDL: &str = r#"
CREATE TABLE IF NOT EXISTS tasks (
  id                  TEXT PRIMARY KEY,
  -- The employee that owns this task. Deleting the employee is a dismiss, not
  -- a delete, so the row survives; a real delete takes the task with it.
  employee_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  -- The task's own session: one task, one transcript, one workspace.
  session_id          TEXT NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
  title               TEXT NOT NULL,
  -- Who started it: the steward's confirmed card, or the person typing into the
  -- employee's workbench.
  origin              TEXT NOT NULL CHECK (origin IN ('steward', 'direct')),
  project_id          INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  branch              TEXT,
  -- Reserved: a task's isolated worktree path. Nothing writes it yet.
  workspace_path      TEXT,
  -- The ADR's stage vocabulary, written by the host only.
  stage               TEXT NOT NULL CHECK (stage IN (
                        'person/answer', 'person/accept', 'blocked', 'failed',
                        'queued', 'waiting', 'working')),
  -- The ledger delivery that carries this task's authorization, for a task the
  -- steward dispatched. A directly created task has none.
  delivery_id         TEXT,
  source_utterance    TEXT,
  created_at          INTEGER NOT NULL,
  archived_at         INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tasks_employee
  ON tasks(employee_session_id, archived_at);
CREATE INDEX IF NOT EXISTS idx_tasks_delivery
  ON tasks(delivery_id) WHERE delivery_id IS NOT NULL;
"#;

/// `(column, definition)` for the columns this step adds to `sessions` after the
/// table has its final name.
pub(crate) const SESSION_COLUMNS: [(&str, &str); 2] = [
    // The employee a task session belongs to. NULL for every other session.
    // Declared here rather than inside the rebuild: a table cannot reference
    // itself while it is being created.
    (
        "owner_session_id",
        "TEXT REFERENCES sessions(id) ON DELETE CASCADE",
    ),
    // Archived with its task: one timestamp, written in one transaction.
    ("archived_at", "INTEGER"),
];
/// Columns copied by the sessions rebuild: every column v32 had, in the order
/// v33 declares them. The two new columns are not in this list; they start as
/// NULL on every copied row.
const SESSION_COLUMNS_OLD: [&str; 19] = [
    "id",
    "title",
    "project_id",
    "provider_id",
    "model_id",
    "mode",
    "title_source",
    "thinking_level",
    "permission_mode",
    "source",
    "deleted_at",
    "pinned",
    "last_seq",
    "todo_revision",
    "todo_updated_at",
    "role",
    "bot_profile_json",
    "created_at",
    "updated_at",
];

/// `sessions` after this step, spelled out once.
///
/// The only difference from v32 is the widened `role` check; every other column
/// is copied verbatim from `schema.rs`, because a rebuild that silently dropped
/// a column would lose user data. `archived_at` is added after the names are
/// switched, exactly like `owner_employee_id`, so the rebuild never blocks on a
/// reference to the table it is renaming.
const SESSIONS_V33_DDL: &str = r#"
CREATE TABLE sessions_v33 (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL DEFAULT '',
  project_id  INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  provider_id TEXT,
  model_id    TEXT,
  mode        TEXT NOT NULL DEFAULT 'agent',
  title_source TEXT NOT NULL DEFAULT 'legacy'
               CHECK (title_source IN ('legacy', 'default', 'manual', 'generated')),
  thinking_level TEXT NOT NULL DEFAULT 'off'
                CHECK (thinking_level IN ('off', 'minimal', 'low', 'medium',
                                          'high', 'xhigh', 'max', 'omit')),
  permission_mode TEXT NOT NULL DEFAULT 'inherit'
                CHECK (permission_mode IN ('inherit', 'ask', 'accept-edits', 'auto')),
  source      TEXT,
  deleted_at  INTEGER,
  pinned      INTEGER NOT NULL DEFAULT 0,
  last_seq    INTEGER NOT NULL DEFAULT 0,
  todo_revision INTEGER NOT NULL DEFAULT 0,
  todo_updated_at INTEGER,
  role        TEXT NOT NULL DEFAULT 'user'
              CHECK (role IN ('user', 'bot', 'task')),
  bot_profile_json TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
"#;

fn has_column(tx: &Transaction<'_>, table: &str, column: &str) -> Result<bool> {
    Ok(tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info(?1) WHERE name = ?2)",
        rusqlite::params![table, column],
        |row| row.get(0),
    )?)
}

pub(crate) fn migrate_v32_to_v33_tx(conn: &Connection, tx: &Transaction<'_>) -> Result<()> {
    // A file that already carries the new columns (created from the current
    // DDL, or a step that stopped before its stamp) is completed, not restarted:
    // its `role` check already accepts `'task'`, so the rebuild is skipped.
    //
    // The two self-references make this check load-bearing: SQLite resolves a
    // reference to `sessions` to whichever table currently holds that name, so
    // dropping and renaming a table that other tables point at must only ever
    // happen on a v32 file, where nothing points at it yet.
    let rebuilt = has_column(tx, "sessions", "owner_session_id")?;
    // Constraint enforcement is a whole-file switch that SQLite bumps on the
    // file header, so it has to be turned off before any transaction starts;
    // inside one, `PRAGMA foreign_keys` is a silent no-op and the drop below
    // would cascade. When it is still on here, the caller did not prepare the
    // connection and this step refuses instead of emptying every session-owned
    // table.
    let enforcing: i64 = conn.query_row("PRAGMA foreign_keys", [], |row| row.get(0))?;
    if !rebuilt && enforcing != 0 {
        return Err(anyhow!(
            "INVALID_STATE: the v32 -> v33 step needs foreign key enforcement off before its transaction"
        ));
    }
    if !rebuilt {
        // Dropping a table other tables reference makes SQLite run an implicit
        // `DELETE FROM`, so a cascade would silently empty every session-owned
        // row. The caller turned enforcement off before this transaction began
        // (checked above); the rebuild then re-points every reference at the
        // new table and the whole file is validated before this transaction
        // commits.
        rebuild_sessions(tx)?;
    }
    // Both columns join after the names are final: the employee link references
    // the table it lives in, and a step that stopped before its stamp is
    // completed here instead of restarting the rebuild.
    for (column, definition) in SESSION_COLUMNS {
        if !has_column(tx, "sessions", column)? {
            tx.execute_batch(&format!(
                "ALTER TABLE sessions ADD COLUMN {column} {definition};"
            ))
            .with_context(|| format!("add sessions.{column}"))?;
        }
    }
    // The indexes went with the dropped table; recreate them under their
    // original names so every existing query keeps its plan.
    tx.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_sessions_updated_id ON sessions(updated_at DESC, id DESC);
         CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id) WHERE project_id IS NOT NULL;
         CREATE INDEX IF NOT EXISTS idx_sessions_deleted ON sessions(deleted_at) WHERE deleted_at IS NOT NULL;",
    )
    .context("recreate session indexes")?;
    tx.execute_batch(TASKS_DDL).context("create tasks")?;
    tx.pragma_update(None, "user_version", 33i64)?;
    Ok(())
}

/// Rows the foreign key checker reports for the whole file.
///
/// A long-lived user database can arrive with violations already in it: orphan
/// `messages`, `turns` or `artifacts` rows whose session was deleted by an older
/// build are real and expected (the development database is clean, which is why
/// this only shows up on a real one). Deleting them is a separate decision that
/// needs the person's authorization and a backup, so this step never touches
/// them. What it must prove is the narrower thing: the rebuild *added* none.
fn foreign_key_violations(tx: &Transaction<'_>) -> Result<i64> {
    Ok(
        tx.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
            row.get(0)
        })?,
    )
}

fn session_rows(tx: &Transaction<'_>) -> Result<i64> {
    Ok(tx.query_row("SELECT COUNT(*) FROM sessions", [], |row| row.get(0))?)
}

/// Replace `sessions` with the v33 table, keeping every row and re-pointing
/// every reference at the new table.
///
/// Three things are proved before this transaction may commit:
///
/// - the copy kept every session (`sessions` has the same row count afterwards);
/// - it introduced no new dangling reference. A file that already carries
///   orphan rows — a real user database does — moves the same violations from
///   the old table to the new one, so only an *increase* is a rebuild failure;
/// - nothing else about the file changed, because the only statement that
///   touches another table is the `ALTER TABLE ... RENAME`, which rewrites the
///   references' target name in place.
fn rebuild_sessions(tx: &Transaction<'_>) -> Result<()> {
    let violations_before = foreign_key_violations(tx)?;
    let rows_before = session_rows(tx)?;
    tx.execute_batch(SESSIONS_V33_DDL)
        .context("create sessions_v33")?;
    let columns = SESSION_COLUMNS_OLD.join(", ");
    tx.execute_batch(&format!(
        "INSERT INTO sessions_v33 ({columns}) SELECT {columns} FROM sessions;"
    ))
    .context("copy sessions into sessions_v33")?;
    tx.execute_batch("DROP TABLE sessions;")
        .context("drop sessions v32")?;
    tx.execute_batch("ALTER TABLE sessions_v33 RENAME TO sessions;")
        .context("rename sessions_v33")?;
    let rows_after = session_rows(tx)?;
    if rows_after != rows_before {
        return Err(anyhow!(
            "the rebuild kept {rows_after} of {rows_before} sessions; rolling back to v32"
        ));
    }
    let violations_after = foreign_key_violations(tx)?;
    if violations_after > violations_before {
        return Err(anyhow!(
            "the rebuild increased dangling references from {violations_before} to \
             {violations_after}; rolling back to v32"
        ));
    }
    Ok(())
}

/// Additive in what it stores, but the widened `role` check forces one table
/// rebuild, and a rebuild has to run with constraint enforcement off.
pub(crate) fn migrate(conn: &Connection, _path: &Path) -> Result<()> {
    conn.pragma_update(None, "foreign_keys", false)?;
    let result = (|| {
        let tx = conn.unchecked_transaction()?;
        migrate_v32_to_v33_tx(conn, &tx).context("apply schema v32 to v33 task migration")?;
        tx.commit().context("commit schema v32 to v33 migration")
    })();
    // The switch belongs to this file open and is restored whatever happened,
    // so every later statement in this process is enforced as before.
    conn.pragma_update(None, "foreign_keys", true)?;
    result
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

    fn has_table(conn: &Connection, name: &str) -> bool {
        conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
            [name],
            |row| row.get(0),
        )
        .unwrap()
    }

    /// Leave a file exactly as v32 wrote it: the two columns gone and the role
    /// check narrowed again, without dropping any row.
    fn downgrade_to_v32(conn: &Connection) {
        // The shape v32 wrote, and nothing later: `role` back to two values, the
        // two v33 columns gone, `tasks` gone. The table is rebuilt instead of
        // having its columns dropped, because a dozen tables reference
        // `sessions(id)` and a rebuild re-points every one of them, exactly as it
        // does for the real step.
        conn.execute_batch(
            "PRAGMA foreign_keys = OFF;
             DROP INDEX IF EXISTS idx_sessions_updated_id;
             DROP INDEX IF EXISTS idx_sessions_project;
             DROP INDEX IF EXISTS idx_sessions_deleted;
             DROP TABLE tasks;
             CREATE TABLE sessions_v32 (
               id          TEXT PRIMARY KEY,
               title       TEXT NOT NULL DEFAULT '',
               project_id  INTEGER REFERENCES projects(id) ON DELETE SET NULL,
               provider_id TEXT,
               model_id    TEXT,
               mode        TEXT NOT NULL DEFAULT 'agent',
               title_source TEXT NOT NULL DEFAULT 'legacy'
                            CHECK (title_source IN ('legacy', 'default', 'manual', 'generated')),
               thinking_level TEXT NOT NULL DEFAULT 'off'
                             CHECK (thinking_level IN ('off', 'minimal', 'low', 'medium',
                                                       'high', 'xhigh', 'max', 'omit')),
               permission_mode TEXT NOT NULL DEFAULT 'inherit'
                             CHECK (permission_mode IN ('inherit', 'ask', 'accept-edits', 'auto')),
               source      TEXT,
               deleted_at  INTEGER,
               pinned      INTEGER NOT NULL DEFAULT 0,
               last_seq    INTEGER NOT NULL DEFAULT 0,
               todo_revision INTEGER NOT NULL DEFAULT 0,
               todo_updated_at INTEGER,
               role        TEXT NOT NULL DEFAULT 'user'
                           CHECK (role IN ('user', 'bot')),
               bot_profile_json TEXT,
               created_at  INTEGER NOT NULL,
               updated_at  INTEGER NOT NULL
             );
             INSERT INTO sessions_v32 (
               id, title, project_id, provider_id, model_id, mode, title_source,
               thinking_level, permission_mode, source, deleted_at, pinned, last_seq,
               todo_revision, todo_updated_at, role, bot_profile_json, created_at, updated_at
             )
             SELECT id, title, project_id, provider_id, model_id, mode, title_source,
               thinking_level, permission_mode, source, deleted_at, pinned, last_seq,
               todo_revision, todo_updated_at, role, bot_profile_json, created_at, updated_at
             FROM sessions;
             DROP TABLE sessions;
             ALTER TABLE sessions_v32 RENAME TO sessions;
             CREATE INDEX idx_sessions_updated_id ON sessions(updated_at DESC, id DESC);
             CREATE INDEX idx_sessions_project ON sessions(project_id) WHERE project_id IS NOT NULL;
             CREATE INDEX idx_sessions_deleted ON sessions(deleted_at) WHERE deleted_at IS NOT NULL;
             PRAGMA user_version = 32;",
        )
        .unwrap();
    }

    #[test]
    fn a_fresh_database_has_the_task_table_at_the_newest_version() {
        let (_dir, db) = database();
        assert_eq!(version(db.conn()), SCHEMA_VERSION);
        assert!(has_table(db.conn(), "tasks"));
        assert!(column(db.conn(), "sessions", "owner_session_id"));
        assert!(column(db.conn(), "sessions", "archived_at"));
        let empty: i64 = db
            .conn()
            .query_row("SELECT COUNT(*) FROM tasks", [], |row| row.get(0))
            .unwrap();
        assert_eq!(empty, 0);
    }

    /// The rebuild must not lose a session, a role, or a worktree binding.
    #[test]
    fn a_v32_database_upgrades_without_touching_its_rows() {
        let (dir, db) = database();
        let chat = crate::sessions::create_session_with_options(
            &db,
            crate::sessions::SessionCreateOptions {
                title: Some("Existing conversation".into()),
                mode: Some("agent".into()),
                ..Default::default()
            },
        )
        .unwrap();
        let employee = crate::sessions::create_session_with_options(
            &db,
            crate::sessions::SessionCreateOptions {
                title: Some("Router 后端".into()),
                mode: Some("agent".into()),
                permission_mode: Some("accept-edits".into()),
                role: Some("bot".into()),
                bot_profile_json: Some(
                    r#"{"name":"Router 后端","permissionMode":"accept-edits","mustAsk":[],"observe":false}"#
                        .into(),
                ),
                ..Default::default()
            },
        )
        .unwrap();
        let path = dir.path().join("pi.sqlite");
        downgrade_to_v32(db.conn());
        assert!(!column(db.conn(), "sessions", "owner_session_id"));
        drop(db);

        let db = Database::open(&path).unwrap();
        assert_eq!(version(db.conn()), SCHEMA_VERSION);
        assert!(has_table(db.conn(), "tasks"));
        for summary in crate::sessions::list_sessions(&db).unwrap() {
            if summary.id == chat.id {
                assert_eq!(summary.role.as_deref(), Some("user"));
                assert!(summary.bot_profile.is_none());
            } else {
                assert_eq!(summary.id, employee.id);
                assert_eq!(summary.role.as_deref(), Some("bot"));
                assert!(summary.bot_profile.is_some());
            }
        }
        // The two new columns are NULL on every pre-existing row.
        let owned: i64 = db
            .conn()
            .query_row(
                "SELECT COUNT(*) FROM sessions WHERE owner_session_id IS NOT NULL OR archived_at IS NOT NULL",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(owned, 0);
        // And the widened check accepts the new role without accepting a
        // value nobody defined.
        db.conn()
            .execute(
                "INSERT INTO sessions (id, title, created_at, updated_at, role)
                 VALUES ('task-1', 'Task', 1, 1, 'task')",
                [],
            )
            .unwrap();
        assert!(db
            .conn()
            .execute(
                "INSERT INTO sessions (id, title, created_at, updated_at, role)
                 VALUES ('bad-1', 'Bad', 1, 1, 'worker')",
                [],
            )
            .is_err());
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
                "SELECT COUNT(*) FROM pragma_table_info('sessions')
                 WHERE name IN ('owner_session_id', 'archived_at')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 2);
    }

    /// A step that stopped half-way must leave v32 authoritative and be
    /// completed by the next open, without duplicating the rebuild.
    #[test]
    fn a_partially_applied_step_rolls_back_then_completes() {
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
        downgrade_to_v32(db.conn());
        drop(db);

        {
            let conn = Connection::open(&path).unwrap();
            conn.pragma_update(None, "foreign_keys", false).unwrap();
            let tx = conn.unchecked_transaction().unwrap();
            migrate_v32_to_v33_tx(&conn, &tx).unwrap();
            // Simulate a failure after the statements but before the stamp.
            drop(tx);
        }
        {
            let conn = Connection::open(&path).unwrap();
            assert_eq!(version(&conn), 32, "an uncommitted step leaves v32");
            assert!(!column(&conn, "sessions", "owner_session_id"));
        }

        let db = Database::open(&path).unwrap();
        assert_eq!(version(db.conn()), SCHEMA_VERSION);
        assert!(column(db.conn(), "sessions", "owner_session_id"));
        assert!(has_table(db.conn(), "tasks"));
        let summaries = crate::sessions::list_sessions(&db).unwrap();
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].id, session.id);
    }

    /// A task row is bound to two real sessions, and the schema is what says so.
    #[test]
    fn a_task_needs_an_employee_a_session_and_a_known_origin() {
        let (_dir, db) = database();
        for (id, role) in [
            ("employee-1", "bot"),
            ("task-1", "task"),
            ("task-2", "task"),
            ("task-3", "task"),
        ] {
            db.conn()
                .execute(
                    "INSERT INTO sessions (id, title, created_at, updated_at, role)
                     VALUES (?1, ?1, 1, 1, ?2)",
                    rusqlite::params![id, role],
                )
                .unwrap();
        }
        let insert = |id: &str, origin: &str, stage: &str| {
            db.conn().execute(
                "INSERT INTO tasks (id, employee_session_id, session_id, title, origin, stage, created_at)
                 VALUES (?1, 'employee-1', ?2, 'Fix the timeout', ?3, ?4, 1)",
                rusqlite::params![format!("row-{id}-{origin}-{stage}"), id, origin, stage],
            )
        };
        assert!(insert("task-1", "steward", "queued").is_ok());
        // A vocabulary nobody defined is refused, in both columns.
        assert!(insert("task-2", "elsewhere", "queued").is_err());
        assert!(insert("task-2", "steward", "person/waiting").is_err());
        // One session carries exactly one task.
        assert!(insert("task-1", "direct", "working").is_err());
        // And the employee has to be a real session.
        assert!(db
            .conn()
            .execute(
                "INSERT INTO tasks (id, employee_session_id, session_id, title, origin, stage, created_at)
                 VALUES ('orphan', 'nobody', 'task-3', 'Fix', 'steward', 'queued', 1)",
                [],
            )
            .is_err());
        // A steward's task names the delivery that carried its authorization.
        db.conn()
            .execute(
                "INSERT INTO tasks (id, employee_session_id, session_id, title, origin, stage, delivery_id, created_at)
                 VALUES ('with-delivery', 'employee-1', 'task-2', 'Fix',
                         'steward', 'working', 'delivery-1', 1)",
                [],
            )
            .unwrap();
    }

    fn violations(conn: &Connection) -> i64 {
        conn.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
            row.get(0)
        })
        .unwrap()
    }

    /// A real database arrives with orphan rows from an older build, so the step
    /// must prove it *added* no dangling reference rather than that there are
    /// none.
    ///
    /// Before this was fixed, one historical orphan refused the whole upgrade and
    /// the application could not start (observed on a 525 MB v32 user file with
    /// 214 781 violations), while every development database — and therefore
    /// every test — was clean. Repairing those rows is a separate decision that
    /// needs the person's authorization and a backup, so this step must carry
    /// them across untouched.
    #[test]
    fn a_v32_database_with_historical_orphans_upgrades_and_keeps_them() {
        let (dir, db) = database();
        let session = crate::sessions::create_session_with_options(
            &db,
            crate::sessions::SessionCreateOptions {
                title: Some("Existing conversation".into()),
                mode: Some("agent".into()),
                ..Default::default()
            },
        )
        .unwrap();
        let path = dir.path().join("pi.sqlite");
        // Rows whose session no longer exists, which is what an older build left
        // behind when it deleted a session without cascading.
        db.conn()
            .pragma_update(None, "foreign_keys", false)
            .unwrap();
        db.conn()
            .execute_batch(
                "INSERT INTO messages (id, session_id, seq, role, text, created_at)
                 VALUES ('orphan-message', 'gone-session', 1, 'user', 'orphaned', 1);
                 INSERT INTO turns (id, session_id, status, started_at)
                 VALUES ('orphan-turn', 'gone-session', 'completed', 1);
                 INSERT INTO artifacts (session_id, path, op, updated_at)
                 VALUES ('gone-session', '/tmp/a.txt', 'write', 1);
                 INSERT INTO session_todo (session_id, position, content, status, updated_at)
                 VALUES ('gone-session', 0, 'orphaned', 'pending', 1);",
            )
            .unwrap();
        db.conn().pragma_update(None, "foreign_keys", true).unwrap();
        let before = violations(db.conn());
        assert_eq!(before, 4, "the fixture must carry four orphan rows");
        downgrade_to_v32(db.conn());
        drop(db);

        let db = Database::open(&path).unwrap();
        assert_eq!(version(db.conn()), SCHEMA_VERSION);
        assert_eq!(
            violations(db.conn()),
            before,
            "the rebuild added or removed a dangling reference"
        );
        // The orphans are exactly what they were, in every table that holds one.
        for (sql, expected) in [
            (
                "SELECT text FROM messages WHERE id = 'orphan-message'",
                Some("orphaned"),
            ),
            (
                "SELECT status FROM turns WHERE id = 'orphan-turn'",
                Some("completed"),
            ),
            (
                "SELECT op FROM artifacts WHERE session_id = 'gone-session'",
                Some("write"),
            ),
            (
                "SELECT content FROM session_todo WHERE session_id = 'gone-session'",
                Some("orphaned"),
            ),
        ] {
            let kept: Option<String> = db.conn().query_row(sql, [], |row| row.get(0)).unwrap();
            assert_eq!(kept.as_deref(), expected, "{sql}");
        }
        let summaries = crate::sessions::list_sessions(&db).unwrap();
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].id, session.id);
    }
}
