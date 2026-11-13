//! Schema v34 -> v35: one more provenance kind on the collaboration ledger
//! (employee mode 0.5 slice 3).
//!
//! A task that stops making progress on its own — failed, blocked, waiting for an
//! answer, or cut off by the startup fence — now wakes the steward with a ledger
//! delivery of `kind = 'stage'` (`session_collaboration::notices`). The ledger's
//! `kind` column carries a `CHECK`, and SQLite cannot alter one, so the table is
//! rebuilt once with the same columns and the widened vocabulary.
//!
//! Two properties make this safe on a real user database:
//!
//! - **It is a rebuild, not a rewrite.** Every row is copied verbatim, the row
//!   count is compared before and after, and the whole file's dangling-reference
//!   count may not increase. A long-lived file arrives with historical orphans
//!   (a 525 MB v32 file carried 214 781 dangling references); refusing the
//!   upgrade because they exist is what once stopped the application from
//!   starting, so they are carried across untouched and only *new* violations
//!   fail the step.
//! - **It is idempotent.** A file created from the current schema, or one whose
//!   step stopped before its version stamp, is completed rather than restarted:
//!   the rebuild is skipped when the table already accepts `'stage'`.
//!
//! Nothing else in the file changes: the four indexes are recreated under their
//! original names, and no other table references this one, so the `DROP` cannot
//! cascade.

use super::{anyhow, Connection, Path, Result};
use rusqlite::Transaction;

/// Every column the table has, in the order both versions declare them.
const COLUMNS: [&str; 22] = [
    "id",
    "plugin_id",
    "source_session_id",
    "source_title",
    "target_session_id",
    "target_title",
    "kind",
    "content",
    "status",
    "notify_on_completion",
    "turn_id",
    "reply_to_message_id",
    "idempotency_key",
    "remaining_hops",
    "permission_ceiling",
    "mandate_json",
    "stage",
    "report_seq",
    "result",
    "error",
    "created_at",
    "updated_at",
];

/// The table as v35 declares it: identical to v34 except for `kind`.
const LEDGER_V35_DDL: &str = r#"
CREATE TABLE session_collaboration_messages_v35 (
  id TEXT PRIMARY KEY,
  plugin_id TEXT NOT NULL,
  source_session_id TEXT NOT NULL,
  source_title TEXT NOT NULL,
  target_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  target_title TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('task', 'message', 'completion', 'stage')),
  content TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted')),
  notify_on_completion INTEGER NOT NULL DEFAULT 0,
  turn_id TEXT REFERENCES turns(id) ON DELETE SET NULL,
  reply_to_message_id TEXT,
  idempotency_key TEXT NOT NULL,
  remaining_hops INTEGER NOT NULL,
  permission_ceiling TEXT NOT NULL CHECK(permission_ceiling IN ('ask', 'accept-edits', 'auto')),
  mandate_json TEXT,
  stage TEXT CHECK (stage IS NULL OR stage IN ('person/answer', 'person/accept',
                'blocked', 'failed', 'queued', 'waiting', 'working')),
  report_seq INTEGER NOT NULL DEFAULT 0 CHECK (report_seq >= 0),
  result TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(plugin_id, source_session_id, idempotency_key)
);
"#;

/// The indexes v34 had. They are dropped with the table and recreated here.
const INDEXES: &str = "
CREATE INDEX IF NOT EXISTS idx_session_collaboration_target
  ON session_collaboration_messages(target_session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_session_collaboration_source
  ON session_collaboration_messages(source_session_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_session_collaboration_turn
  ON session_collaboration_messages(turn_id) WHERE turn_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_session_collaboration_receipt
  ON session_collaboration_messages(reply_to_message_id) WHERE kind = 'completion';
";

fn accepts_stage(tx: &Transaction<'_>) -> Result<bool> {
    let sql: Option<String> = tx
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='session_collaboration_messages'",
            [],
            |row| row.get(0),
        )
        .ok();
    Ok(sql.is_some_and(|sql| sql.contains("'stage'")))
}

fn violations(tx: &Transaction<'_>) -> Result<i64> {
    Ok(
        tx.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
            row.get(0)
        })?,
    )
}

fn rows(tx: &Transaction<'_>) -> Result<i64> {
    Ok(tx.query_row(
        "SELECT COUNT(*) FROM session_collaboration_messages",
        [],
        |row| row.get(0),
    )?)
}

pub(crate) fn migrate_v34_to_v35_tx(tx: &Transaction<'_>) -> Result<()> {
    if !accepts_stage(tx)? {
        let violations_before = violations(tx)?;
        let rows_before = rows(tx)?;
        tx.execute_batch(LEDGER_V35_DDL)
            .map_err(|error| anyhow!("create session_collaboration_messages_v35: {error}"))?;
        let columns = COLUMNS.join(", ");
        tx.execute_batch(&format!(
            "INSERT INTO session_collaboration_messages_v35 ({columns})
             SELECT {columns} FROM session_collaboration_messages;"
        ))
        .map_err(|error| anyhow!("copy the collaboration ledger: {error}"))?;
        tx.execute_batch("DROP TABLE session_collaboration_messages;")
            .map_err(|error| anyhow!("drop the v34 collaboration ledger: {error}"))?;
        tx.execute_batch("ALTER TABLE session_collaboration_messages_v35 RENAME TO session_collaboration_messages;")
            .map_err(|error| anyhow!("rename the v35 collaboration ledger: {error}"))?;
        let rows_after = rows(tx)?;
        if rows_after != rows_before {
            return Err(anyhow!(
                "the rebuild kept {rows_after} of {rows_before} ledger rows; rolling back to v34"
            ));
        }
        let violations_after = violations(tx)?;
        if violations_after > violations_before {
            return Err(anyhow!(
                "the rebuild increased dangling references from {violations_before} to \
                 {violations_after}; rolling back to v34"
            ));
        }
        tx.execute_batch(INDEXES)
            .map_err(|error| anyhow!("recreate collaboration ledger indexes: {error}"))?;
    }
    tx.pragma_update(None, "user_version", 35i64)?;
    Ok(())
}

/// A rebuild has to run with constraint enforcement off: the copy would
/// otherwise refuse the orphan rows a real database legitimately carries.
pub(crate) fn migrate(conn: &Connection, _path: &Path) -> Result<()> {
    conn.pragma_update(None, "foreign_keys", false)?;
    let result = (|| {
        let tx = conn.unchecked_transaction()?;
        migrate_v34_to_v35_tx(&tx)?;
        tx.commit()?;
        Ok(())
    })();
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

    fn violations_now(conn: &Connection) -> i64 {
        conn.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
            row.get(0)
        })
        .unwrap()
    }

    fn kinds(conn: &Connection) -> Vec<String> {
        let mut statement = conn
            .prepare("SELECT kind FROM session_collaboration_messages ORDER BY rowid")
            .unwrap();
        statement
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<String>>>()
            .unwrap()
    }

    fn seed_sessions(conn: &Connection) {
        conn.execute(
            "INSERT INTO sessions (id, title, role, created_at, updated_at)
             VALUES ('steward', 'Steward', 'bot', 1, 1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sessions (id, title, role, created_at, updated_at)
             VALUES ('task-session', 'Task', 'task', 1, 1)",
            [],
        )
        .unwrap();
    }

    /// A v34 file: the ledger's `kind` check without `'stage'`.
    fn downgrade_to_v34(conn: &Connection) {
        conn.execute_batch(
            "DROP TABLE session_collaboration_messages;
             CREATE TABLE session_collaboration_messages (
               id TEXT PRIMARY KEY,
               plugin_id TEXT NOT NULL,
               source_session_id TEXT NOT NULL,
               source_title TEXT NOT NULL,
               target_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
               target_title TEXT NOT NULL,
               kind TEXT NOT NULL CHECK(kind IN ('task', 'message', 'completion')),
               content TEXT NOT NULL,
               status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'completed',
                        'failed', 'cancelled', 'interrupted')),
               notify_on_completion INTEGER NOT NULL DEFAULT 0,
               turn_id TEXT REFERENCES turns(id) ON DELETE SET NULL,
               reply_to_message_id TEXT,
               idempotency_key TEXT NOT NULL,
               remaining_hops INTEGER NOT NULL,
               permission_ceiling TEXT NOT NULL CHECK(permission_ceiling IN ('ask', 'accept-edits', 'auto')),
               mandate_json TEXT,
               stage TEXT CHECK (stage IS NULL OR stage IN ('person/answer', 'person/accept',
                             'blocked', 'failed', 'queued', 'waiting', 'working')),
               report_seq INTEGER NOT NULL DEFAULT 0 CHECK (report_seq >= 0),
               result TEXT,
               error TEXT,
               created_at INTEGER NOT NULL,
               updated_at INTEGER NOT NULL,
               UNIQUE(plugin_id, source_session_id, idempotency_key)
             );
             CREATE INDEX idx_session_collaboration_target
               ON session_collaboration_messages(target_session_id, created_at DESC);
             CREATE INDEX idx_session_collaboration_source
               ON session_collaboration_messages(source_session_id, created_at DESC);
             CREATE UNIQUE INDEX idx_session_collaboration_turn
               ON session_collaboration_messages(turn_id) WHERE turn_id IS NOT NULL;
             CREATE UNIQUE INDEX idx_session_collaboration_receipt
               ON session_collaboration_messages(reply_to_message_id) WHERE kind = 'completion';
             PRAGMA user_version = 34;",
        )
        .unwrap();
    }

    fn seed_delivery(conn: &Connection, id: &str, kind: &str, key: &str) {
        conn.execute(
            "INSERT INTO session_collaboration_messages
             (id, plugin_id, source_session_id, source_title, target_session_id, target_title,
              kind, content, status, notify_on_completion, idempotency_key, remaining_hops,
              permission_ceiling, created_at, updated_at)
             VALUES (?1, 'builtin:session-messaging', 'steward', 'Steward', 'task-session', 'Task',
              ?2, 'Fix the login timeout', 'queued', 0, ?3, 32, 'ask', 1, 1)",
            rusqlite::params![id, kind, key],
        )
        .unwrap();
    }

    #[test]
    fn a_fresh_database_accepts_a_stage_delivery() {
        let (_dir, db) = database();
        assert_eq!(version(db.conn()), SCHEMA_VERSION);
        seed_sessions(db.conn());
        // The vocabulary is the column's, not only the host's.
        assert!(accepts_stage(&db.conn().unchecked_transaction().unwrap()).unwrap());
        seed_delivery(db.conn(), "notice-1", "stage", "one");
        assert_eq!(kinds(db.conn()), vec!["stage".to_string()]);
        assert!(db
            .conn()
            .execute(
                "INSERT INTO session_collaboration_messages
                 (id, plugin_id, source_session_id, source_title, target_session_id, target_title,
                  kind, content, status, notify_on_completion, idempotency_key, remaining_hops,
                  permission_ceiling, created_at, updated_at)
                 VALUES ('x', 'p', 'steward', 'S', 'task-session', 'T',
                  'signed', 'c', 'queued', 0, 'two', 32, 'ask', 1, 1)",
                [],
            )
            .is_err());
    }

    /// A v34 file keeps every row and gains the kind the steward needs.
    #[test]
    fn a_v34_database_keeps_its_deliveries_and_accepts_stage() {
        let (dir, db) = database();
        let path = dir.path().join("pi.sqlite");
        seed_sessions(db.conn());
        downgrade_to_v34(db.conn());
        seed_delivery(db.conn(), "old-task", "task", "one");
        seed_delivery(db.conn(), "old-receipt", "completion", "two");
        drop(db);

        let db = Database::open(&path).unwrap();
        assert_eq!(version(db.conn()), SCHEMA_VERSION);
        assert_eq!(
            kinds(db.conn()),
            vec!["task".to_string(), "completion".to_string()]
        );
        seed_delivery(db.conn(), "notice", "stage", "three");
        assert_eq!(kinds(db.conn()).len(), 3);
        // The indexes came back with the table.
        let indexes: i64 = db
            .conn()
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='index'
                  AND tbl_name='session_collaboration_messages' AND name LIKE 'idx_%'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(indexes, 4);
    }

    #[test]
    fn reopening_a_migrated_database_changes_nothing() {
        let (dir, db) = database();
        let path = dir.path().join("pi.sqlite");
        drop(db);
        let db = Database::open(&path).unwrap();
        seed_sessions(db.conn());
        seed_delivery(db.conn(), "notice", "stage", "one");
        drop(db);
        let db = Database::open(&path).unwrap();
        assert_eq!(version(db.conn()), SCHEMA_VERSION);
        assert_eq!(kinds(db.conn()), vec!["stage".to_string()]);
    }

    /// A real database carries orphan rows from older builds. The rebuild must
    /// carry them across and never refuse the upgrade because they exist.
    #[test]
    fn a_v34_database_with_historical_orphans_upgrades_and_keeps_them() {
        let (dir, db) = database();
        let path = dir.path().join("pi.sqlite");
        seed_sessions(db.conn());
        downgrade_to_v34(db.conn());
        db.conn()
            .pragma_update(None, "foreign_keys", false)
            .unwrap();
        // A delivery whose target session was deleted by an older build.
        db.conn()
            .execute(
                "INSERT INTO session_collaboration_messages
                 (id, plugin_id, source_session_id, source_title, target_session_id, target_title,
                  kind, content, status, notify_on_completion, idempotency_key, remaining_hops,
                  permission_ceiling, created_at, updated_at)
                 VALUES ('orphan', 'p', 'steward', 'S', 'gone-session', 'Gone',
                  'task', 'c', 'completed', 0, 'k', 32, 'ask', 1, 1)",
                [],
            )
            .unwrap();
        db.conn().pragma_update(None, "foreign_keys", true).unwrap();
        let before = violations_now(db.conn());
        assert_eq!(before, 1, "the fixture must carry one orphan row");
        drop(db);

        let db = Database::open(&path).unwrap();
        assert_eq!(version(db.conn()), SCHEMA_VERSION);
        assert_eq!(
            violations_now(db.conn()),
            before,
            "the rebuild added or removed a dangling reference"
        );
        assert_eq!(kinds(db.conn()), vec!["task".to_string()]);
    }

    /// A step that stopped before its stamp is completed on the next open.
    #[test]
    fn a_partially_applied_step_is_completed() {
        let (dir, db) = database();
        let path = dir.path().join("pi.sqlite");
        seed_sessions(db.conn());
        downgrade_to_v34(db.conn());
        drop(db);
        {
            let conn = Connection::open(&path).unwrap();
            conn.pragma_update(None, "foreign_keys", false).unwrap();
            let tx = conn.unchecked_transaction().unwrap();
            migrate_v34_to_v35_tx(&tx).unwrap();
            // Simulate a failure after the statements but before the commit.
            drop(tx);
        }
        {
            let conn = Connection::open(&path).unwrap();
            assert_eq!(version(&conn), 34);
            assert!(!accepts_stage(&conn.unchecked_transaction().unwrap()).unwrap());
        }
        let db = Database::open(&path).unwrap();
        assert_eq!(version(db.conn()), SCHEMA_VERSION);
        assert!(accepts_stage(&db.conn().unchecked_transaction().unwrap()).unwrap());
    }
}
