//! Schema v38 -> v39: the employee experience layer (employee mode 0.5 slice 5).
//!
//! An employee keeps lessons from the tasks it already finished, so the next
//! task of the same kind starts knowing the repository's traps, the commands
//! that worked, and why the last attempt failed. The lessons are learned-memory
//! entries in a new scope, `bot`, whose key is the employee's session id, so the
//! existing rules — secrets filtering, fingerprints, tombstones, the manager —
//! apply unchanged.
//!
//! Two tables gained a value, so two tables are rebuilt:
//!
//! - `memory_entries.scope_kind` and `memory_tombstones.scope_kind` allow
//!   `'bot'` beside `'project'` and `'user'`. SQLite cannot alter a `CHECK`, so
//!   each table is recreated with the same columns and copied row by row.
//! - `memory_entries_fts` is external content over `memory_entries`. Dropping
//!   the content table leaves the index pointing at rows that no longer exist,
//!   so the index and its three triggers are recreated and rebuilt from the
//!   copied rows rather than trusted.
//!
//! `memory_session_state` is deliberately **not** touched: employee extraction
//! does not use it (the per-task state lives in `tasks.experience_json`), and a
//! real user file carries historical dangling references in that table. The v32
//! -> v33 step rebuilt `sessions` and one orphan row stopped the whole upgrade,
//! which is why this step compares the file's `foreign_key_check` count before
//! and after the rebuild and refuses only *new* violations.
//!
//! Two additive columns follow on `tasks`:
//!
//! - `experience_json` — the extraction state of one task: `pending`, `done`,
//!   `skipped:disabled`, or `failed:<code>`, with the entry ids it wrote. It is
//!   written in the same transaction that archives the task, and Main drains the
//!   pending rows, so a restart cannot lose a task that still owes its lessons.
//! - `stage_changed_at` — when the current stage was written. The hourly
//!   inspection measures how long a task has been waiting from it; a historic
//!   row leaves it NULL, which the inspection reads as "unknown" and stays
//!   silent about.

use super::{anyhow, Connection, Path, Result};
use rusqlite::Transaction;

/// Every column `memory_entries` has, in the order both versions declare them.
const ENTRY_COLUMNS: [&str; 18] = [
    "id",
    "scope_kind",
    "scope_key",
    "kind",
    "content",
    "rationale",
    "status",
    "origin",
    "evidence",
    "source_session_id",
    "source_message_ids",
    "fingerprint",
    "revision",
    "superseded_by",
    "created_at",
    "updated_at",
    "last_used_at",
    "use_count",
];

/// Every column `memory_tombstones` has.
const TOMBSTONE_COLUMNS: [&str; 7] = [
    "id",
    "scope_kind",
    "scope_key",
    "fingerprint",
    "source_session_id",
    "source_message_ids",
    "created_at",
];

/// `memory_entries` with the widened scope vocabulary.
const ENTRY_V39_DDL: &str = r#"
CREATE TABLE memory_entries_v39 (
  id                 TEXT PRIMARY KEY,
  scope_kind         TEXT NOT NULL CHECK (scope_kind IN ('project', 'user', 'bot')),
  scope_key          TEXT,
  kind               TEXT NOT NULL CHECK (kind IN ('preference', 'feedback', 'fact', 'reference')),
  content            TEXT NOT NULL CHECK (length(content) > 0),
  rationale          TEXT,
  status             TEXT NOT NULL CHECK (status IN ('suggested', 'active', 'archived')),
  origin             TEXT NOT NULL CHECK (origin IN ('explicit', 'user_ui', 'extracted')),
  evidence           TEXT NOT NULL CHECK (evidence IN ('user_stated', 'verified', 'inferred')),
  source_session_id  TEXT,
  source_message_ids TEXT NOT NULL DEFAULT '[]',
  fingerprint        TEXT NOT NULL,
  revision           INTEGER NOT NULL DEFAULT 1,
  superseded_by      TEXT,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  last_used_at       INTEGER,
  use_count          INTEGER NOT NULL DEFAULT 0
);
"#;

/// `memory_tombstones` with the widened scope vocabulary.
const TOMBSTONE_V39_DDL: &str = r#"
CREATE TABLE memory_tombstones_v39 (
  id                 INTEGER PRIMARY KEY,
  scope_kind         TEXT NOT NULL CHECK (scope_kind IN ('project', 'user', 'bot')),
  scope_key          TEXT,
  fingerprint        TEXT NOT NULL,
  source_session_id  TEXT,
  source_message_ids TEXT NOT NULL DEFAULT '[]',
  created_at         INTEGER NOT NULL
);
"#;

/// The indexes of both tables. They are dropped with the table and recreated
/// here under their original names, so a query plan is what it was.
const ENTRY_INDEXES: &str = "
CREATE INDEX IF NOT EXISTS idx_memory_entries_scope
  ON memory_entries(scope_kind, scope_key, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_entries_fingerprint
  ON memory_entries(scope_kind, IFNULL(scope_key, ''), fingerprint)
  WHERE status <> 'archived';
CREATE INDEX IF NOT EXISTS idx_memory_entries_recent
  ON memory_entries(updated_at DESC, id ASC);
";

const TOMBSTONE_INDEXES: &str = "
CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_tombstones_fingerprint
  ON memory_tombstones(scope_kind, IFNULL(scope_key, ''), fingerprint);
";

fn accepts_bot(tx: &Transaction<'_>, table: &str) -> Result<bool> {
    let sql: Option<String> = tx
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name = ?1",
            rusqlite::params![table],
            |row| row.get(0),
        )
        .ok();
    Ok(sql.is_some_and(|sql| sql.contains("'bot'")))
}

fn violations(tx: &Transaction<'_>) -> Result<i64> {
    Ok(
        tx.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
            row.get(0)
        })?,
    )
}

fn rows(tx: &Transaction<'_>, table: &str) -> Result<i64> {
    Ok(tx.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
        row.get(0)
    })?)
}

fn searchable(tx: &Transaction<'_>) -> Result<i64> {
    Ok(tx.query_row(
        "SELECT COUNT(*) FROM memory_entries_fts
          WHERE memory_entries_fts MATCH 'the'",
        [],
        |row| row.get(0),
    )?)
}

/// Recreate the external-content index over `memory_entries`.
///
/// `rebuild` re-reads the content table, so the index describes exactly the
/// rows the copy produced — an index carried across a table rebuild would
/// otherwise point at rowids that no longer exist, which is a silent wrong
/// answer rather than a visible failure.
fn rebuild_index(tx: &Transaction<'_>) -> Result<()> {
    tx.execute_batch(
        "DROP TABLE IF EXISTS memory_entries_fts;
         CREATE VIRTUAL TABLE memory_entries_fts USING fts5(
           content,
           rationale,
           content='memory_entries', content_rowid='rowid',
           tokenize='trigram'
         );",
    )
    .map_err(|error| anyhow!("recreate memory_entries_fts: {error}"))?;
    tx.execute_batch(
        "CREATE TRIGGER memory_entries_fts_ai AFTER INSERT ON memory_entries
           BEGIN
             INSERT INTO memory_entries_fts(rowid, content, rationale)
               VALUES (new.rowid, new.content, COALESCE(new.rationale, ''));
           END;
         CREATE TRIGGER memory_entries_fts_ad AFTER DELETE ON memory_entries
           BEGIN
             INSERT INTO memory_entries_fts(memory_entries_fts, rowid, content, rationale)
               VALUES ('delete', old.rowid, old.content, COALESCE(old.rationale, ''));
           END;
         CREATE TRIGGER memory_entries_fts_au
           AFTER UPDATE OF content, rationale ON memory_entries
           BEGIN
             INSERT INTO memory_entries_fts(memory_entries_fts, rowid, content, rationale)
               VALUES ('delete', old.rowid, old.content, COALESCE(old.rationale, ''));
             INSERT INTO memory_entries_fts(rowid, content, rationale)
               VALUES (new.rowid, new.content, COALESCE(new.rationale, ''));
           END;",
    )
    .map_err(|error| anyhow!("recreate memory_entries_fts triggers: {error}"))?;
    tx.execute_batch("INSERT INTO memory_entries_fts(memory_entries_fts) VALUES('rebuild');")
        .map_err(|error| anyhow!("rebuild memory_entries_fts: {error}"))?;
    Ok(())
}

/// `(column, definition)` for the columns this step adds to `tasks`.
pub(crate) const TASK_EXPERIENCE_COLUMNS: [(&str, &str); 2] = [
    // The extraction state of one archived task, as JSON.
    ("experience_json", "TEXT"),
    // When the current stage was written; NULL on a row from an older build.
    ("stage_changed_at", "INTEGER"),
];

/// The `ALTER TABLE` statements for the fresh schema. A new file must end up
/// with exactly the shape the migration produces, so both go through the same
/// list.
pub(crate) fn bot_memory_ddl() -> String {
    TASK_EXPERIENCE_COLUMNS
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

/// Rebuild `memory_entries`: create the widened table, copy every row in its
/// original order, count, swap, and restore the indexes and the search index.
fn rebuild_entries(tx: &Transaction<'_>) -> Result<()> {
    let before = rows(tx, "memory_entries")?;
    tx.execute_batch(ENTRY_V39_DDL)
        .map_err(|error| anyhow!("step 1/4 create memory_entries_v39: {error}"))?;
    let columns = ENTRY_COLUMNS.join(", ");
    tx.execute_batch(&format!(
        "INSERT INTO memory_entries_v39 ({columns})
         SELECT {columns} FROM memory_entries ORDER BY rowid;"
    ))
    .map_err(|error| anyhow!("step 2/4 copy memory_entries: {error}"))?;
    tx.execute_batch("DROP TABLE memory_entries;")
        .map_err(|error| anyhow!("step 3/4 drop the v38 memory_entries: {error}"))?;
    tx.execute_batch("ALTER TABLE memory_entries_v39 RENAME TO memory_entries;")
        .map_err(|error| anyhow!("step 3/4 rename memory_entries_v39: {error}"))?;
    let after = rows(tx, "memory_entries")?;
    if after != before {
        return Err(anyhow!(
            "step 3/4 memory_entries kept {after} of {before} rows; rolling back to v38"
        ));
    }
    tx.execute_batch(ENTRY_INDEXES)
        .map_err(|error| anyhow!("step 4/4 recreate memory_entries indexes: {error}"))?;
    rebuild_index(tx).map_err(|error| anyhow!("step 4/4 {error}"))?;
    Ok(())
}

/// Rebuild `memory_tombstones` the same way. Its integer primary key is copied
/// explicitly: a tombstone's id is its identity across a configuration sync.
fn rebuild_tombstones(tx: &Transaction<'_>) -> Result<()> {
    let before = rows(tx, "memory_tombstones")?;
    tx.execute_batch(TOMBSTONE_V39_DDL)
        .map_err(|error| anyhow!("step 1/4 create memory_tombstones_v39: {error}"))?;
    let columns = TOMBSTONE_COLUMNS.join(", ");
    tx.execute_batch(&format!(
        "INSERT INTO memory_tombstones_v39 ({columns})
         SELECT {columns} FROM memory_tombstones ORDER BY id;"
    ))
    .map_err(|error| anyhow!("step 2/4 copy memory_tombstones: {error}"))?;
    tx.execute_batch("DROP TABLE memory_tombstones;")
        .map_err(|error| anyhow!("step 3/4 drop the v38 memory_tombstones: {error}"))?;
    tx.execute_batch("ALTER TABLE memory_tombstones_v39 RENAME TO memory_tombstones;")
        .map_err(|error| anyhow!("step 3/4 rename memory_tombstones_v39: {error}"))?;
    let after = rows(tx, "memory_tombstones")?;
    if after != before {
        return Err(anyhow!(
            "step 3/4 memory_tombstones kept {after} of {before} rows; rolling back to v38"
        ));
    }
    tx.execute_batch(TOMBSTONE_INDEXES)
        .map_err(|error| anyhow!("step 4/4 recreate memory_tombstones indexes: {error}"))?;
    Ok(())
}

pub(crate) fn migrate_v38_to_v39_tx(tx: &Transaction<'_>) -> Result<()> {
    if !accepts_bot(tx, "memory_entries")? || !accepts_bot(tx, "memory_tombstones")? {
        let violations_before = violations(tx)?;
        let hits_before = searchable(tx)?;
        rebuild_entries(tx)?;
        rebuild_tombstones(tx)?;
        let violations_after = violations(tx)?;
        if violations_after > violations_before {
            return Err(anyhow!(
                "step 4/4 the rebuild increased dangling references from {violations_before} to \
                 {violations_after}; rolling back to v38"
            ));
        }
        // The search index has to describe the same rows it described before, or
        // a note the user could find yesterday is unfindable today.
        let hits_after = searchable(tx)?;
        if hits_after != hits_before {
            return Err(anyhow!(
                "step 4/4 memory_entries_fts matched {hits_after} rows after the rebuild, not \
                 {hits_before}; rolling back to v38"
            ));
        }
    }
    for (column, definition) in TASK_EXPERIENCE_COLUMNS {
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
    tx.pragma_update(None, "user_version", 39i64)?;
    Ok(())
}

/// A rebuild has to run with constraint enforcement off: a real database
/// legitimately carries historical orphan rows, and turning the copy into a
/// failure is what once stopped the application from starting.
pub(crate) fn migrate(conn: &Connection, _path: &Path) -> Result<()> {
    conn.pragma_update(None, "foreign_keys", false)?;
    let result = (|| {
        let tx = conn.unchecked_transaction()?;
        migrate_v38_to_v39_tx(&tx)?;
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

    fn count(conn: &Connection, table: &str) -> i64 {
        conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
            row.get(0)
        })
        .unwrap()
    }

    /// The ids `memory_entries_fts` matches for one term, so a rebuild that
    /// silently lost the index is caught.
    fn hits(conn: &Connection, term: &str) -> Vec<String> {
        let mut statement = conn
            .prepare(
                "SELECT m.id FROM memory_entries_fts f
                 JOIN memory_entries m ON m.rowid = f.rowid
                 WHERE memory_entries_fts MATCH ?1 ORDER BY m.id",
            )
            .unwrap();
        statement
            .query_map([term], |row| row.get(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<String>>>()
            .unwrap()
    }

    fn seed_entry(conn: &Connection, id: &str, scope: &str, key: Option<&str>, content: &str) {
        conn.execute(
            "INSERT INTO memory_entries
             (id, scope_kind, scope_key, kind, content, status, origin, evidence,
              source_message_ids, fingerprint, revision, created_at, updated_at, use_count)
             VALUES (?1, ?2, ?3, 'fact', ?4, 'active', 'user_ui', 'verified',
                     '[]', ?5, 1, 1, 1, 0)",
            rusqlite::params![id, scope, key, content, format!("fp-{id}")],
        )
        .unwrap();
    }

    fn seed_tombstone(conn: &Connection, id: i64, scope: &str, key: Option<&str>, fp: &str) {
        conn.execute(
            "INSERT INTO memory_tombstones
             (id, scope_kind, scope_key, fingerprint, source_message_ids, created_at)
             VALUES (?1, ?2, ?3, ?4, '[]', 1)",
            rusqlite::params![id, scope, key, fp],
        )
        .unwrap();
    }

    /// Leave the file exactly as v38 wrote it: both `CHECK`s without `'bot'`,
    /// no `tasks.experience_json`, no `tasks.stage_changed_at`.
    fn downgrade_to_v38(conn: &Connection) {
        conn.pragma_update(None, "foreign_keys", false).unwrap();
        conn.execute_batch("DROP TABLE IF EXISTS memory_entries_fts;")
            .unwrap();
        for (table, columns, ddl, indexes) in [
            (
                "memory_entries",
                ENTRY_COLUMNS.join(", "),
                ENTRY_V39_DDL.replace("memory_entries_v39", "memory_entries_v38"),
                ENTRY_INDEXES,
            ),
            (
                "memory_tombstones",
                TOMBSTONE_COLUMNS.join(", "),
                TOMBSTONE_V39_DDL.replace("memory_tombstones_v39", "memory_tombstones_v38"),
                TOMBSTONE_INDEXES,
            ),
        ] {
            // The v38 CHECK: the same column list, minus the new value.
            conn.execute_batch(&ddl.replace(", 'bot'", "")).unwrap();
            conn.execute_batch(&format!(
                "INSERT INTO {table}_v38 ({columns}) SELECT {columns} FROM {table};"
            ))
            .unwrap();
            conn.execute_batch(&format!("DROP TABLE {table};")).unwrap();
            conn.execute_batch(&format!("ALTER TABLE {table}_v38 RENAME TO {table};"))
                .unwrap();
            conn.execute_batch(indexes).unwrap();
        }
        conn.execute_batch(
            "CREATE VIRTUAL TABLE memory_entries_fts USING fts5(
               content, rationale, content='memory_entries', content_rowid='rowid',
               tokenize='trigram');
             CREATE TRIGGER memory_entries_fts_ai AFTER INSERT ON memory_entries
               BEGIN
                 INSERT INTO memory_entries_fts(rowid, content, rationale)
                   VALUES (new.rowid, new.content, COALESCE(new.rationale, ''));
               END;
             CREATE TRIGGER memory_entries_fts_ad AFTER DELETE ON memory_entries
               BEGIN
                 INSERT INTO memory_entries_fts(memory_entries_fts, rowid, content, rationale)
                   VALUES ('delete', old.rowid, old.content, COALESCE(old.rationale, ''));
               END;
             CREATE TRIGGER memory_entries_fts_au
               AFTER UPDATE OF content, rationale ON memory_entries
               BEGIN
                 INSERT INTO memory_entries_fts(memory_entries_fts, rowid, content, rationale)
                   VALUES ('delete', old.rowid, old.content, COALESCE(old.rationale, ''));
                 INSERT INTO memory_entries_fts(rowid, content, rationale)
                   VALUES (new.rowid, new.content, COALESCE(new.rationale, ''));
               END;
             INSERT INTO memory_entries_fts(memory_entries_fts) VALUES('rebuild');",
        )
        .unwrap();
        for (column, _) in TASK_EXPERIENCE_COLUMNS {
            conn.execute_batch(&format!("ALTER TABLE tasks DROP COLUMN {column};"))
                .unwrap();
        }
        conn.pragma_update(None, "user_version", 38i64).unwrap();
        conn.pragma_update(None, "foreign_keys", true).unwrap();
    }

    #[test]
    fn a_fresh_database_accepts_the_employee_scope() {
        let (_dir, db) = database();
        assert_eq!(db.conn().query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), SCHEMA_VERSION);
        seed_entry(db.conn(), "lesson-1", "bot", Some("employee-1"), "mvnw verify broke on JDK 17");
        seed_tombstone(db.conn(), 1, "bot", Some("employee-1"), "fp-x");
        for (column, _) in TASK_EXPERIENCE_COLUMNS {
            let present = db
                .conn()
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM pragma_table_info('tasks') WHERE name = ?1)",
                    [column],
                    |row| row.get::<_, bool>(0),
                )
                .unwrap();
            assert!(present, "tasks.{column} is missing from a fresh database");
        }
    }

    /// The upgrade keeps every row, keeps the search index answering the same
    /// question, and lets an employee scope be written afterwards.
    #[test]
    fn a_v38_database_keeps_its_rows_its_search_hits_and_learns_the_employee_scope() {
        let (dir, db) = database();
        let path = dir.path().join("pi.sqlite");
        seed_entry(db.conn(), "proj-1", "project", Some("/repo/a"), "the migration needs a backup");
        seed_entry(db.conn(), "user-1", "user", None, "the user prefers Chinese replies");
        seed_tombstone(db.conn(), 7, "project", Some("/repo/a"), "fp-proj-1");
        downgrade_to_v38(db.conn());
        assert_eq!(version(db.conn()), 38);
        let entries_before = count(db.conn(), "memory_entries");
        let tombstones_before = count(db.conn(), "memory_tombstones");
        let hits_before = hits(db.conn(), "migration");
        assert_eq!(hits_before, vec!["proj-1".to_string()]);
        drop(db);

        let db = Database::open(&path).unwrap();
        assert_eq!(version(db.conn()), SCHEMA_VERSION);
        assert_eq!(count(db.conn(), "memory_entries"), entries_before);
        assert_eq!(count(db.conn(), "memory_tombstones"), tombstones_before);
        assert_eq!(hits(db.conn(), "migration"), hits_before);
        assert_eq!(hits(db.conn(), "Chinese"), vec!["user-1".to_string()]);
        // The primary key survived the copy, so a tombstone still names the same
        // memory on another device.
        let tombstone_id: i64 = db
            .conn()
            .query_row("SELECT id FROM memory_tombstones", [], |row| row.get(0))
            .unwrap();
        assert_eq!(tombstone_id, 7);
        seed_entry(db.conn(), "lesson-1", "bot", Some("employee-1"), "the gate needs cargo fmt first");
        assert_eq!(hits(db.conn(), "cargo"), vec!["lesson-1".to_string()]);
    }

    /// Running the step twice is a no-op: a second open of the same file, or a
    /// step that stopped before its stamp, must not rebuild anything again.
    #[test]
    fn the_step_is_idempotent() {
        let (dir, db) = database();
        let path = dir.path().join("pi.sqlite");
        seed_entry(db.conn(), "proj-1", "project", Some("/repo/a"), "the migration needs a backup");
        downgrade_to_v38(db.conn());
        drop(db);

        let db = Database::open(&path).unwrap();
        assert_eq!(version(db.conn()), SCHEMA_VERSION);
        db.conn()
            .pragma_update(None, "user_version", 38i64)
            .unwrap();
        drop(db);

        let db = Database::open(&path).unwrap();
        assert_eq!(version(db.conn()), SCHEMA_VERSION);
        assert_eq!(count(db.conn(), "memory_entries"), 1);
        assert_eq!(hits(db.conn(), "migration").len(), 1);
    }

    /// A real user file arrives with historical dangling references, in
    /// `memory_session_state` among others. The upgrade must carry them across
    /// untouched instead of refusing to start.
    #[test]
    fn historical_foreign_key_violations_do_not_block_the_upgrade() {
        let (dir, db) = database();
        let path = dir.path().join("pi.sqlite");
        seed_entry(db.conn(), "proj-1", "project", Some("/repo/a"), "the migration needs a backup");
        downgrade_to_v38(db.conn());
        // A state row whose session was deleted by an older build.
        db.conn()
            .pragma_update(None, "foreign_keys", false)
            .unwrap();
        db.conn()
            .execute(
                "INSERT INTO memory_session_state (session_id, scope_kind, scope_key)
                 VALUES ('gone-session', 'project', '/repo/a')",
                [],
            )
            .unwrap();
        db.conn().pragma_update(None, "foreign_keys", true).unwrap();
        let before = violations_now(db.conn());
        assert!(before > 0, "the fixture must carry a violation");
        drop(db);

        let db = Database::open(&path).unwrap();
        assert_eq!(version(db.conn()), SCHEMA_VERSION);
        assert_eq!(violations_now(db.conn()), before);
        assert_eq!(count(db.conn(), "memory_entries"), 1);
    }
}