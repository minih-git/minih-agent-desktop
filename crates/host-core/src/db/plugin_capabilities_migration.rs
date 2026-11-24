//! Schema v42 -> v43: the plugin host capability layer (design: 插件宿主能力六项,
//! phase 2B — B-0).
//!
//! The manifest contract for those capabilities already exists in
//! `packages/plugin-sdk`; this step gives the host the durable shapes behind it
//! and does as little as possible to the rows that are already there.
//!
//! - **`notifications` is rebuilt.** `kind` allows two more values,
//!   `'plugin.alert'` and `'plugin.digest'`, and SQLite cannot alter a `CHECK`. A
//!   plugin notification is not about a conversation, so `session_id` and
//!   `session_title` become nullable and the row carries the plugin's own title,
//!   body, link and dedupe key. Every existing row keeps its id, kind, title,
//!   turn, request, tool, error code, timestamp, and read state, and the four
//!   indexes keep their names, so every query plan is what it was.
//! - **Orphan rows are dropped, and only they.** A notification whose session no
//!   longer exists can never be opened, and the copy filters it out instead of
//!   failing. The counts before, after, and of the dropped rows are compared and
//!   logged; this is the one deletion this step performs.
//! - **`tasks.plugin_id`** names the plugin that created a task. `origin` keeps
//!   its two values (`steward`, `direct`): a plugin task is an ordinary task, and
//!   its origin is not rewritten.
//! - **Three additive tables**: accepted webhook deliveries, plugin schedule
//!   bookkeeping, and per-peer TCP totals. Nothing writes them yet, so like the
//!   v40 -> v41 step they are empty on every existing file.
//!
//! Enforcement stays on throughout: the copy filters every row that would
//! violate the session reference, so `foreign_keys = ON` is never an obstacle.
//! The step compares the row count before, after, and dropped
//! (`after == before - orphans`), re-checks `pragma_foreign_key_check` for the
//! table and refuses only *new* violations, and logs all three counts before it
//! stamps v43.
use super::{anyhow, create_migration_backup, params, Connection, Context, Path, Result};
use rusqlite::Transaction;

/// `(column, definition)` for the columns this step adds to `tasks`.
///
/// `origin` is deliberately absent. A task a plugin started is a task like any
/// other — it keeps `steward` or `direct` — so the plugin is recorded beside the
/// origin instead of replacing one of its values.
pub(crate) const TASK_PLUGIN_COLUMNS: [(&str, &str); 1] = [(
    // The plugin that created the task. NULL for every task a person or the
    // employee started, and for every row written before this column existed.
    "plugin_id",
    "TEXT",
)];

/// The lookup a plugin's own task list needs; partial, because nearly every task
/// belongs to no plugin. Applied by the fresh schema and by the v42 -> v43 step
/// alike, since it only names the column the step adds.
pub(crate) const TASK_PLUGIN_INDEXES: &str = r#"
CREATE INDEX IF NOT EXISTS idx_tasks_plugin
  ON tasks(plugin_id) WHERE plugin_id IS NOT NULL;
"#;

/// The three tables no existing file has, shared verbatim by the fresh schema
/// and this step so both paths end up identical.
pub(crate) const PLUGIN_CAPABILITY_TABLES_DDL: &str = r#"
-- One accepted inbound webhook request (`inbound.webhook`). The host owns the
-- listening socket, the path, and the per-webhook token; what it keeps here is
-- the delivery, so a request accepted just before a restart is still owed to
-- the plugin instead of being silently lost. The body itself is never stored:
-- `body_ref` names where the accepted copy lives, and the token lives in the
-- secret store.
CREATE TABLE IF NOT EXISTS plugin_webhook_events (
  id           TEXT PRIMARY KEY,
  plugin_id    TEXT NOT NULL,
  webhook_id   TEXT NOT NULL,
  source_ip    TEXT,
  body_ref     TEXT,
  received_at  INTEGER,
  delivered_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_plugin_webhook_events_delivery
  ON plugin_webhook_events(plugin_id, webhook_id, delivered_at);

-- One plugin-owned timer (`scheduler`). Independent of `scheduled_tasks`: this
-- calls a plugin function, spends no model tokens, and needs no prompt. The row
-- keeps what the host knows from the last attempt, not the declaration itself —
-- `every` / `cron` / `runWhen` stay in the manifest.
CREATE TABLE IF NOT EXISTS plugin_schedules (
  plugin_id   TEXT NOT NULL,
  schedule_id TEXT NOT NULL,
  last_run_at INTEGER,
  last_ok     INTEGER,
  attempts    INTEGER,
  paused      INTEGER DEFAULT 0,
  PRIMARY KEY (plugin_id, schedule_id)
);

-- Host-mediated TCP (`net.tcp`), totalled per peer per day. The plugin never
-- holds a socket of its own, so this is the only record of what its traffic
-- cost.
CREATE TABLE IF NOT EXISTS plugin_tcp_usage (
  plugin_id TEXT NOT NULL,
  host      TEXT NOT NULL,
  port      INTEGER NOT NULL,
  bytes_in  INTEGER,
  bytes_out INTEGER,
  day       TEXT NOT NULL,
  PRIMARY KEY (plugin_id, host, port, day)
);
"#;

/// The `ALTER TABLE` statements for the fresh schema. A new file ends up with
/// exactly the shape the migration produces because both go through this list.
pub(crate) fn plugin_task_ddl() -> String {
    TASK_PLUGIN_COLUMNS
        .iter()
        .map(|(column, definition)| format!("ALTER TABLE tasks ADD COLUMN {column} {definition};"))
        .collect::<Vec<_>>()
        .join("\n")
}

fn has_column(tx: &Transaction<'_>, table: &str, column: &str) -> Result<bool> {
    Ok(tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info(?1) WHERE name = ?2)",
        params![table, column],
        |row| row.get(0),
    )?)
}

fn rows(tx: &Transaction<'_>, table: &str) -> Result<i64> {
    Ok(
        tx.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
            row.get(0)
        })?,
    )
}

/// Foreign-key violations of one table, read from the file's own violation list
/// rather than a per-statement check, so a historical orphan elsewhere in the
/// file is not mistaken for damage this step did.
fn table_violations(tx: &Transaction<'_>, table: &str) -> Result<i64> {
    Ok(tx.query_row(
        "SELECT COUNT(*) FROM pragma_foreign_key_check WHERE \"table\" = ?1",
        params![table],
        |row| row.get(0),
    )?)
}

/// How many notification rows point at a session that does not exist.
fn orphan_notifications(tx: &Transaction<'_>) -> Result<i64> {
    Ok(tx.query_row(
        "SELECT COUNT(*) FROM notifications n
          WHERE n.session_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.id = n.session_id)",
        [],
        |row| row.get(0),
    )?)
}

/// Rebuild `notifications` into the v43 shape, dropping rows whose session is
/// gone. The old table is renamed rather than dropped first so the copy reads
/// from a named table and the indexes can be recreated under their own names.
fn rebuild_notifications(tx: &Transaction<'_>) -> Result<i64> {
    let before = rows(tx, "notifications")?;
    let orphans = orphan_notifications(tx)?;
    let violations_before = table_violations(tx, "notifications")?;
    tx.execute_batch(
        "DROP INDEX IF EXISTS idx_notifications_turn;
         DROP INDEX IF EXISTS idx_notifications_request;
         DROP INDEX IF EXISTS idx_notifications_created;
         DROP INDEX IF EXISTS idx_notifications_unread;
         DROP INDEX IF EXISTS idx_notifications_plugin_dedupe;
         ALTER TABLE notifications RENAME TO notifications_v42;",
    )
    .map_err(|error| anyhow!("step 1/4 retire the v42 notifications table: {error}"))?;
    tx.execute_batch(super::NOTIFICATIONS_DDL)
        .map_err(|error| anyhow!("step 2/4 create the v43 notifications table: {error}"))?;
    // Every old column is copied by name; the plugin columns start NULL, which
    // is what "not a plugin notification" means for the widened CHECK.
    tx.execute_batch(
        "INSERT INTO notifications
           (id, kind, session_id, session_title, turn_id, request_id, tool_name,
            error_code, created_at, read_at)
         SELECT n.id, n.kind, n.session_id, n.session_title, n.turn_id,
                n.request_id, n.tool_name, n.error_code, n.created_at, n.read_at
           FROM notifications_v42 n
          WHERE n.session_id IS NOT NULL
            AND EXISTS (SELECT 1 FROM sessions s WHERE s.id = n.session_id)
          ORDER BY n.created_at, n.id;",
    )
    .map_err(|error| anyhow!("step 3/4 copy notifications: {error}"))?;
    tx.execute_batch("DROP TABLE notifications_v42;")
        .map_err(|error| anyhow!("step 3/4 drop the v42 notifications table: {error}"))?;

    let after = rows(tx, "notifications")?;
    let expected = before - orphans;
    if after != expected {
        return Err(anyhow!(
            "step 3/4 notifications kept {after} of {before} rows ({orphans} pointed at a deleted \
             session, so {expected} were expected); rolling back to v42"
        ));
    }
    let violations_after = table_violations(tx, "notifications")?;
    if violations_after > violations_before {
        return Err(anyhow!(
            "step 4/4 the rebuild left {violations_after} notifications pointing at a missing \
             session, up from {violations_before}; rolling back to v42"
        ));
    }
    tracing::info!(
        before,
        orphans,
        after,
        "notifications rebuilt for schema v43"
    );
    Ok(orphans)
}

/// Apply the v43 shape inside the caller's transaction. Idempotent: a file that
/// already carries the new columns is completed rather than rebuilt.
pub(crate) fn migrate_v42_to_v43_tx(tx: &Transaction<'_>) -> Result<usize> {
    // The column is the shape test, not the code in `sqlite_master`: `'plugin'`
    // is a substring of every `plugin_id` spelling.
    let dropped = if has_column(tx, "notifications", "plugin_id")? {
        0
    } else {
        rebuild_notifications(tx)?
    };
    for (column, definition) in TASK_PLUGIN_COLUMNS {
        if !has_column(tx, "tasks", column)? {
            tx.execute_batch(&format!(
                "ALTER TABLE tasks ADD COLUMN {column} {definition};"
            ))
            .map_err(|error| anyhow!("add tasks.{column}: {error}"))?;
        }
    }
    tx.execute_batch(TASK_PLUGIN_INDEXES)
        .map_err(|error| anyhow!("create idx_tasks_plugin: {error}"))?;
    tx.execute_batch(PLUGIN_CAPABILITY_TABLES_DDL)
        .map_err(|error| anyhow!("create the plugin capability tables: {error}"))?;
    tx.pragma_update(None, "user_version", 43i64)?;
    Ok(dropped as usize)
}

/// Run the step on a real file: backup the v42 file first, then one transaction
/// that either produces the v43 shape and stamps it, or changes nothing.
pub(crate) fn migrate(conn: &Connection, path: &Path) -> Result<()> {
    let backup = create_migration_backup(conn, path, 42)?;
    // Enforcement stays on. The copy drops every row that would violate the
    // session reference, so nothing this step writes can dangle.
    conn.pragma_update(None, "foreign_keys", true)?;
    let tx = conn.unchecked_transaction()?;
    migrate_v42_to_v43_tx(&tx)?;
    tx.commit().with_context(|| {
        format!(
            "commit schema v42 to v43 migration; backup {} remains",
            backup.display()
        )
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{Database, SCHEMA_VERSION};

    /// The notifications table exactly as v25 -> v42 wrote it.
    const NOTIFICATIONS_V42_DDL: &str = r#"
CREATE TABLE notifications (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN (
    'task.completed', 'task.failed',
    'prompt.ask', 'prompt.permission', 'prompt.plan'
  )),
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  session_title TEXT NOT NULL,
  turn_id    TEXT,
  request_id TEXT,
  tool_name  TEXT,
  error_code TEXT,
  created_at INTEGER NOT NULL,
  read_at    INTEGER
);
CREATE UNIQUE INDEX idx_notifications_turn
  ON notifications(turn_id)
  WHERE turn_id IS NOT NULL
    AND kind IN ('task.completed', 'task.failed');
CREATE UNIQUE INDEX idx_notifications_request
  ON notifications(request_id) WHERE request_id IS NOT NULL;
CREATE INDEX idx_notifications_created ON notifications(created_at DESC);
CREATE INDEX idx_notifications_unread
  ON notifications(created_at DESC) WHERE read_at IS NULL;
"#;

    fn database() -> (tempfile::TempDir, Database, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pi.sqlite");
        let db = Database::open(&path).unwrap();
        (dir, db, path)
    }

    fn version(conn: &Connection) -> i64 {
        conn.query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap()
    }

    fn count(conn: &Connection, table: &str) -> i64 {
        conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
            row.get(0)
        })
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

    fn index(conn: &Connection, name: &str) -> bool {
        conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?1)",
            params![name],
            |row| row.get(0),
        )
        .unwrap()
    }

    /// `(name, declared type, NOT NULL, default, position in the primary key)`.
    fn columns(conn: &Connection, table: &str) -> Vec<(String, String, bool, Option<String>, i64)> {
        let mut statement = conn
            .prepare(
                "SELECT name, type, \"notnull\", dflt_value, pk
                   FROM pragma_table_info(?1) ORDER BY cid",
            )
            .unwrap();
        statement
            .query_map(params![table], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap()
    }

    /// One line per column, so an assertion reads as the declared shape.
    fn shape(conn: &Connection, table: &str) -> Vec<String> {
        columns(conn, table)
            .into_iter()
            .map(|(name, ty, not_null, default, pk)| {
                format!(
                    "{name} {ty} notnull={} default={} pk={pk}",
                    i64::from(not_null),
                    default.as_deref().unwrap_or("NULL")
                )
            })
            .collect()
    }

    fn index_columns(conn: &Connection, name: &str) -> Vec<String> {
        let mut statement = conn
            .prepare("SELECT name FROM pragma_index_info(?1) ORDER BY seqno")
            .unwrap();
        statement
            .query_map(params![name], |row| row.get(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap()
    }

    fn notification_violations(conn: &Connection) -> i64 {
        conn.query_row(
            "SELECT COUNT(*) FROM pragma_foreign_key_check WHERE \"table\" = 'notifications'",
            [],
            |row| row.get(0),
        )
        .unwrap()
    }

    fn foreign_keys_on(conn: &Connection) -> bool {
        conn.query_row("PRAGMA foreign_keys", [], |row| row.get::<_, i64>(0))
            .unwrap()
            != 0
    }

    fn seed_session(conn: &Connection, id: &str) {
        conn.execute(
            "INSERT OR IGNORE INTO sessions (id, title, created_at, updated_at)
             VALUES (?1, 'Session', 1, 1)",
            params![id],
        )
        .unwrap();
    }

    /// Leave a file exactly as v42 wrote it: the plugin columns and the three
    /// tables gone, and the notifications table back in its v42 shape.
    fn downgrade_to_v42(conn: &Connection) {
        conn.execute_batch(&format!(
            "DROP TABLE IF EXISTS plugin_webhook_events;
             DROP TABLE IF EXISTS plugin_schedules;
             DROP TABLE IF EXISTS plugin_tcp_usage;
             DROP INDEX IF EXISTS idx_tasks_plugin;
             ALTER TABLE tasks DROP COLUMN plugin_id;
             DROP INDEX IF EXISTS idx_notifications_turn;
             DROP INDEX IF EXISTS idx_notifications_request;
             DROP INDEX IF EXISTS idx_notifications_created;
             DROP INDEX IF EXISTS idx_notifications_unread;
             DROP INDEX IF EXISTS idx_notifications_plugin_dedupe;
             ALTER TABLE notifications RENAME TO notifications_v43;
             {NOTIFICATIONS_V42_DDL}
             INSERT INTO notifications
               (id, kind, session_id, session_title, turn_id, request_id, tool_name,
                error_code, created_at, read_at)
             SELECT id, kind, session_id, session_title, turn_id, request_id,
                    tool_name, error_code, created_at, read_at
               FROM notifications_v43;
             DROP TABLE notifications_v43;
             PRAGMA user_version = 42;"
        ))
        .unwrap();
    }

    fn seed_notifications(conn: &Connection, rows: i64, session_id: &str) {
        for i in 0..rows {
            conn.execute(
                "INSERT INTO notifications
                   (id, kind, session_id, session_title, turn_id, error_code, created_at, read_at)
                 VALUES (?1, 'task.completed', ?2, 'Session', NULL, NULL, ?3, NULL)",
                params![format!("n-{i}"), session_id, i],
            )
            .unwrap();
        }
    }

    #[test]
    fn a_fresh_file_carries_the_exact_plugin_shapes() {
        let (_dir, db, _path) = database();
        let conn = db.conn();
        assert_eq!(SCHEMA_VERSION, 46);
        assert_eq!(version(conn), SCHEMA_VERSION);

        // notifications: the plugin family's five columns, and the two session
        // columns a plugin row does not carry.
        assert_eq!(
            shape(conn, "notifications"),
            [
                "id TEXT notnull=0 default=NULL pk=1",
                "kind TEXT notnull=1 default=NULL pk=0",
                "session_id TEXT notnull=0 default=NULL pk=0",
                "session_title TEXT notnull=0 default=NULL pk=0",
                "turn_id TEXT notnull=0 default=NULL pk=0",
                "request_id TEXT notnull=0 default=NULL pk=0",
                "tool_name TEXT notnull=0 default=NULL pk=0",
                "error_code TEXT notnull=0 default=NULL pk=0",
                "plugin_id TEXT notnull=0 default=NULL pk=0",
                "title TEXT notnull=0 default=NULL pk=0",
                "body TEXT notnull=0 default=NULL pk=0",
                "link_json TEXT notnull=0 default=NULL pk=0",
                "dedupe_key TEXT notnull=0 default=NULL pk=0",
                "created_at INTEGER notnull=1 default=NULL pk=0",
                "read_at INTEGER notnull=0 default=NULL pk=0",
            ]
        );

        // tasks: one nullable column beside the untouched origin.
        assert!(
            shape(conn, "tasks")
                .contains(&"plugin_id TEXT notnull=0 default=NULL pk=0".to_string()),
            "tasks.plugin_id is one nullable TEXT column"
        );
        assert!(index(conn, "idx_tasks_plugin"));

        assert_eq!(
            shape(conn, "plugin_webhook_events"),
            [
                "id TEXT notnull=0 default=NULL pk=1",
                "plugin_id TEXT notnull=1 default=NULL pk=0",
                "webhook_id TEXT notnull=1 default=NULL pk=0",
                "source_ip TEXT notnull=0 default=NULL pk=0",
                "body_ref TEXT notnull=0 default=NULL pk=0",
                "received_at INTEGER notnull=0 default=NULL pk=0",
                "delivered_at INTEGER notnull=0 default=NULL pk=0",
            ]
        );
        assert_eq!(
            index_columns(conn, "idx_plugin_webhook_events_delivery"),
            ["plugin_id", "webhook_id", "delivered_at"]
        );

        assert_eq!(
            shape(conn, "plugin_schedules"),
            [
                "plugin_id TEXT notnull=1 default=NULL pk=1",
                "schedule_id TEXT notnull=1 default=NULL pk=2",
                "last_run_at INTEGER notnull=0 default=NULL pk=0",
                "last_ok INTEGER notnull=0 default=NULL pk=0",
                "attempts INTEGER notnull=0 default=NULL pk=0",
                "paused INTEGER notnull=0 default=0 pk=0",
            ]
        );

        assert_eq!(
            shape(conn, "plugin_tcp_usage"),
            [
                "plugin_id TEXT notnull=1 default=NULL pk=1",
                "host TEXT notnull=1 default=NULL pk=2",
                "port INTEGER notnull=1 default=NULL pk=3",
                "bytes_in INTEGER notnull=0 default=NULL pk=0",
                "bytes_out INTEGER notnull=0 default=NULL pk=0",
                "day TEXT notnull=1 default=NULL pk=4",
            ]
        );

        for table in [
            "plugin_webhook_events",
            "plugin_schedules",
            "plugin_tcp_usage",
        ] {
            assert_eq!(count(conn, table), 0, "{table} starts empty");
        }

        // The four original inbox indexes keep their names; the dedupe index is
        // the one addition.
        for name in [
            "idx_notifications_turn",
            "idx_notifications_request",
            "idx_notifications_created",
            "idx_notifications_unread",
            "idx_notifications_plugin_dedupe",
        ] {
            assert!(index(conn, name), "{name}");
        }
    }

    #[test]
    fn the_seven_kinds_and_the_plugin_check_hold_together() {
        let (_dir, db, _path) = database();
        let conn = db.conn();
        seed_session(conn, "s1");

        let insert = |id: &str, kind: &str, session: Option<&str>, plugin: Option<&str>| {
            conn.execute(
                "INSERT INTO notifications
                   (id, kind, session_id, session_title, plugin_id, created_at)
                 VALUES (?1, ?2, ?3, 'Session', ?4, 1)",
                params![id, kind, session, plugin],
            )
        };

        // The plugin family: both kinds name a plugin, and neither needs a
        // conversation (though a plugin row may still name the one it is about).
        assert!(insert("p-1", "plugin.alert", None, Some("acme")).is_ok());
        assert!(insert("p-2", "plugin.digest", None, Some("acme")).is_ok());
        assert!(insert("p-3", "plugin.alert", Some("s1"), Some("acme")).is_ok());
        assert!(
            insert("p-4", "plugin.alert", None, None).is_err(),
            "a plugin row must name its plugin"
        );
        assert!(
            insert("p-5", "plugin", None, Some("acme")).is_err(),
            "the kinds are plugin.alert / plugin.digest, not plugin"
        );
        assert!(
            insert("p-6", "plugin.warning", None, Some("acme")).is_err(),
            "only the two plugin kinds exist"
        );

        // The five original kinds, unchanged, and none of them may name a plugin.
        for (index, kind) in [
            "task.completed",
            "task.failed",
            "prompt.ask",
            "prompt.permission",
            "prompt.plan",
        ]
        .iter()
        .enumerate()
        {
            assert!(
                insert(&format!("k-{index}"), kind, Some("s1"), None).is_ok(),
                "{kind}"
            );
            assert!(
                insert(&format!("bad-{index}"), kind, Some("s1"), Some("acme")).is_err(),
                "{kind} may not name a plugin"
            );
        }
        assert!(
            insert("other", "task.queued", Some("s1"), None).is_err(),
            "the kind vocabulary is closed"
        );

        // `dedupe_key` is the plugin's own id for the event: a redelivery
        // collides, another plugin's identical key does not.
        let dedupe = |id: &str, plugin: &str, key: &str| {
            conn.execute(
                "INSERT INTO notifications (id, kind, plugin_id, dedupe_key, created_at)
                 VALUES (?1, 'plugin.alert', ?2, ?3, 2)",
                params![id, plugin, key],
            )
        };
        assert!(dedupe("d-1", "acme", "evt-1").is_ok());
        assert!(dedupe("d-2", "acme", "evt-1").is_err());
        assert!(dedupe("d-3", "other", "evt-1").is_ok());
    }

    #[test]
    fn every_notification_row_survives_the_rebuild_with_its_indexes() {
        let (_dir, db, path) = database();
        downgrade_to_v42(db.conn());
        seed_session(db.conn(), "s1");
        // 199 task rows plus the prompt row below is exactly the 200 the inbox
        // keeps, so opening the file cannot prune a row and the comparison is
        // the migration's copy alone.
        seed_notifications(db.conn(), 199, "s1");
        db.conn()
            .execute(
                "INSERT INTO notifications
                   (id, kind, session_id, session_title, request_id, tool_name, created_at, read_at)
                 VALUES ('prompt-1', 'prompt.permission', 's1', 'Session', 'req-1', 'shell', 500, 600)",
                [],
            )
            .unwrap();
        assert_eq!(count(db.conn(), "notifications"), 200);
        drop(db);

        // The real open path: v42 in, v43 out, with a backup to go back to.
        let db = Database::open(&path).unwrap();
        let conn = db.conn();
        assert_eq!(version(conn), SCHEMA_VERSION);
        assert_eq!(count(conn, "notifications"), 200, "no row was lost");
        let backup = crate::db::migration_backup_path(&path, 42);
        assert!(backup.exists(), "the v42 file was backed up");
        let backup_version: i64 = Connection::open(&backup)
            .unwrap()
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(backup_version, 42, "the backup is the v42 file");

        let (kind, title, tool, read_at): (String, String, Option<String>, Option<i64>) = conn
            .query_row(
                "SELECT kind, session_title, tool_name, read_at FROM notifications
                  WHERE id = 'prompt-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(kind, "prompt.permission");
        assert_eq!(title, "Session");
        assert_eq!(tool.as_deref(), Some("shell"));
        assert_eq!(read_at, Some(600), "the read state is kept");

        // The four indexes keep their names, and the table is clean.
        for name in [
            "idx_notifications_turn",
            "idx_notifications_request",
            "idx_notifications_created",
            "idx_notifications_unread",
            "idx_notifications_plugin_dedupe",
        ] {
            assert!(index(conn, name), "{name} was recreated");
        }
        assert_eq!(notification_violations(conn), 0);
        assert!(foreign_keys_on(conn), "enforcement stays on");
        assert!(column(conn, "notifications", "plugin_id"));

        // The rebuilt table accepts the plugin family this step added: a row
        // with no session, and no foreign-key violation in the table.
        conn.execute(
            "INSERT INTO notifications (id, kind, plugin_id, title, created_at)
             VALUES ('plugin-1', 'plugin.alert', 'acme', 'Acme', 900)",
            [],
        )
        .unwrap();
        assert_eq!(notification_violations(conn), 0);

        // The rest of the step happened in the same transaction.
        assert!(column(conn, "tasks", "plugin_id"));
        for table in [
            "plugin_webhook_events",
            "plugin_schedules",
            "plugin_tcp_usage",
        ] {
            assert_eq!(count(conn, table), 0, "{table} was created");
        }
    }

    #[test]
    fn a_notification_for_a_deleted_session_is_dropped() {
        let (_dir, db, _path) = database();
        let conn = db.conn();
        downgrade_to_v42(conn);
        seed_session(conn, "s1");
        seed_notifications(conn, 3, "s1");
        // A long-lived file can carry rows whose session a rebuild with
        // enforcement off removed; that is the state this step repairs.
        conn.pragma_update(None, "foreign_keys", false).unwrap();
        for id in ["gone-1", "gone-2"] {
            conn.execute(
                "INSERT INTO notifications (id, kind, session_id, session_title, created_at)
                 VALUES (?1, 'task.completed', ?2, 'Gone', 7)",
                params![id, id],
            )
            .unwrap();
        }
        conn.pragma_update(None, "foreign_keys", true).unwrap();
        assert_eq!(notification_violations(conn), 2);

        let tx = conn.unchecked_transaction().unwrap();
        let dropped = migrate_v42_to_v43_tx(&tx).unwrap();
        tx.commit().unwrap();

        assert_eq!(dropped, 2, "the count of dropped rows is reported");
        assert_eq!(count(conn, "notifications"), 3, "the reachable rows stay");
        assert_eq!(notification_violations(conn), 0);
        let remaining: Vec<String> = conn
            .prepare("SELECT id FROM notifications ORDER BY created_at")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert_eq!(remaining, ["n-0", "n-1", "n-2"]);
    }

    #[test]
    fn an_empty_v42_file_upgrades() {
        let (_dir, db, _path) = database();
        let conn = db.conn();
        downgrade_to_v42(conn);
        assert_eq!(count(conn, "notifications"), 0);

        let tx = conn.unchecked_transaction().unwrap();
        assert_eq!(migrate_v42_to_v43_tx(&tx).unwrap(), 0);
        tx.commit().unwrap();

        assert_eq!(version(conn), 43);
        assert_eq!(count(conn, "notifications"), 0);
        assert!(column(conn, "notifications", "plugin_id"));
        assert!(column(conn, "tasks", "plugin_id"));
    }

    #[test]
    fn the_step_is_idempotent() {
        let (_dir, db, _path) = database();
        let conn = db.conn();
        downgrade_to_v42(conn);
        seed_session(conn, "s1");
        seed_notifications(conn, 5, "s1");

        for _ in 0..2 {
            let tx = conn.unchecked_transaction().unwrap();
            migrate_v42_to_v43_tx(&tx).unwrap();
            tx.commit().unwrap();
        }

        assert_eq!(version(conn), 43);
        assert_eq!(count(conn, "notifications"), 5);
        assert!(column(conn, "notifications", "plugin_id"));
        assert!(column(conn, "tasks", "plugin_id"));
        assert_eq!(notification_violations(conn), 0);
        let indexes: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index'
                  AND name IN ('idx_notifications_turn', 'idx_notifications_request',
                               'idx_notifications_created', 'idx_notifications_unread',
                               'idx_notifications_plugin_dedupe')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(indexes, 5, "the second run did not lose an index");
    }

    #[test]
    fn a_task_keeps_its_origin_and_gains_its_plugin() {
        let (_dir, db, _path) = database();
        let conn = db.conn();
        downgrade_to_v42(conn);
        seed_session(conn, "employee-1");
        seed_session(conn, "task-session-1");
        seed_session(conn, "task-session-2");
        conn.execute(
            "INSERT INTO tasks (id, employee_session_id, session_id, title, origin, stage, created_at)
             VALUES ('task-1', 'employee-1', 'task-session-1', 'Fix', 'direct', 'queued', 1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO tasks (id, employee_session_id, session_id, title, origin, stage, created_at)
             VALUES ('task-2', 'employee-1', 'task-session-2', 'Report', 'steward', 'queued', 2)",
            [],
        )
        .unwrap();

        let tx = conn.unchecked_transaction().unwrap();
        migrate_v42_to_v43_tx(&tx).unwrap();
        tx.commit().unwrap();

        let (origin, plugin): (String, Option<String>) = conn
            .query_row(
                "SELECT origin, plugin_id FROM tasks WHERE id = 'task-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(origin, "direct", "the origin is not rewritten");
        assert_eq!(plugin, None, "an older task belongs to no plugin");
        let other: String = conn
            .query_row("SELECT origin FROM tasks WHERE id = 'task-2'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(other, "steward");

        conn.execute(
            "UPDATE tasks SET plugin_id = 'acme' WHERE id = 'task-1'",
            [],
        )
        .unwrap();
        assert!(
            conn.execute(
                "INSERT INTO tasks (id, employee_session_id, session_id, title, origin, stage, created_at)
                 VALUES ('task-3', 'employee-1', 'task-session-1', 'Odd', 'plugin', 'queued', 3)",
                [],
            )
            .is_err(),
            "the origin vocabulary is unchanged"
        );
    }
}
