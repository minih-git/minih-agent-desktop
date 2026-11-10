//! Schema v30 -> v31: bot sessions and the frozen task mandate
//! (ADR bot-sessions-and-steward).
//!
//! Two defaulted and nullable columns on `sessions` and three on the
//! collaboration ledger. The step is additive: no row is rewritten and every
//! pre-existing session stays an ordinary conversation, so it is not a
//! destructive step and this build keeps no `pi.sqlite.v30.bak` copy — the same
//! distinction ADR 0329 records for v23 -> v24 and the archive step records for
//! v28 -> v29.
//!
//! Each column is still probed with `pragma_table_info` before it is added.
//! `user_version` is the authority, but a database that already carries some of
//! these columns (a fresh file created from the current DDL, or a re-opened
//! fixture) must not fail on a duplicate `ALTER TABLE`, and a failed step must
//! leave nothing half-applied: every statement runs in one transaction that
//! stamps the version only after the last one succeeds.
//!
//! The encoded Mandate is stored and returned opaquely. Its shape, bounds, and
//! invariants live in one shared codec (`packages/shared/src/bot-session.ts`),
//! so the host never becomes a second definition of what a card may say.

use super::{Connection, Context, Path, Result};
use rusqlite::{params, Transaction};

/// `(table, column, definition)` for every column this step adds.
pub(crate) const COLUMNS: [(&str, &str, &str); 5] = [
    // A bot is a session with an explicit role; absence means a conversation.
    (
        "sessions",
        "role",
        "TEXT NOT NULL DEFAULT 'user'
         CHECK (role IN ('user', 'bot'))",
    ),
    // Encoded bot profile: only meaningful (and only present) for a bot.
    ("sessions", "bot_profile_json", "TEXT"),
    // The frozen authorization of the delivery. Opaque to the host.
    ("session_collaboration_messages", "mandate_json", "TEXT"),
    // The derived task stage. Never replaces the delivery `status`.
    (
        "session_collaboration_messages",
        "stage",
        "TEXT CHECK (stage IS NULL OR stage IN ('person/answer', 'person/accept',
                     'blocked', 'failed', 'queued', 'waiting', 'working'))",
    ),
    // Monotonic report counter: an out-of-order report is ignorable.
    (
        "session_collaboration_messages",
        "report_seq",
        "INTEGER NOT NULL DEFAULT 0 CHECK (report_seq >= 0)",
    ),
];

pub(crate) fn migrate_v30_to_v31_tx(tx: &Transaction<'_>) -> Result<()> {
    for (table, column, definition) in COLUMNS {
        let exists: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info(?1) WHERE name = ?2)",
            params![table, column],
            |row| row.get(0),
        )?;
        if exists {
            continue;
        }
        tx.execute_batch(&format!(
            "ALTER TABLE {table} ADD COLUMN {column} {definition};"
        ))
        .with_context(|| format!("add {table}.{column}"))?;
    }
    tx.pragma_update(None, "user_version", 31i64)?;
    Ok(())
}

/// Non-destructive, so no backup copy precedes the step; a failure still rolls
/// back the whole transaction and leaves v30 authoritative.
pub(crate) fn migrate_v30_to_v31(conn: &Connection) -> Result<()> {
    let tx = conn.unchecked_transaction()?;
    migrate_v30_to_v31_tx(&tx).context("apply schema v30 to v31 bot session migration")?;
    tx.commit().context("commit schema v30 to v31 migration")
}

/// Kept beside the step so a path-taking caller matches every other migration.
pub(crate) fn migrate(conn: &Connection, _path: &Path) -> Result<()> {
    migrate_v30_to_v31(conn)
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

    fn has_column(conn: &Connection, table: &str, column: &str) -> bool {
        conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info(?1) WHERE name = ?2)",
            params![table, column],
            |row| row.get(0),
        )
        .unwrap()
    }

    fn version(conn: &Connection) -> i64 {
        conn.query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap()
    }

    /// A database created before the step: the columns are gone but every row
    /// keeps its meaning, which is exactly what a v30 file looked like.
    fn downgrade_to_v30(conn: &Connection) {
        conn.execute_batch(
            "PRAGMA foreign_keys = OFF;
             ALTER TABLE sessions DROP COLUMN role;
             ALTER TABLE sessions DROP COLUMN bot_profile_json;
             ALTER TABLE session_collaboration_messages DROP COLUMN mandate_json;
             ALTER TABLE session_collaboration_messages DROP COLUMN stage;
             ALTER TABLE session_collaboration_messages DROP COLUMN report_seq;",
        )
        .unwrap();
        conn.pragma_update(None, "user_version", 30).unwrap();
    }

    #[test]
    fn a_fresh_database_reaches_the_newest_version_with_every_column() {
        let (_dir, db) = database();
        assert_eq!(version(db.conn()), SCHEMA_VERSION);
        for (table, column, _) in COLUMNS {
            assert!(has_column(db.conn(), table, column), "{table}.{column}");
        }
        let default: String = db
            .conn()
            .query_row(
                "SELECT \"dflt_value\" FROM pragma_table_info('sessions') WHERE name = 'role'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(default, "'user'");
    }

    #[test]
    fn a_v30_database_upgrades_without_touching_its_rows() {
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
        downgrade_to_v30(db.conn());
        assert!(!has_column(db.conn(), "sessions", "role"));
        drop(db);

        let db = Database::open(&path).unwrap();
        assert_eq!(version(db.conn()), SCHEMA_VERSION);
        for (table, column, _) in COLUMNS {
            assert!(has_column(db.conn(), table, column), "{table}.{column}");
        }
        let summaries = crate::sessions::list_sessions(&db).unwrap();
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].id, session.id);
        assert_eq!(summaries[0].role.as_deref(), Some("user"));
        assert!(summaries[0].bot_profile.is_none());
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
                 WHERE name IN ('role', 'bot_profile_json')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 2);
    }

    /// A step that stops half-way must leave v30 authoritative and be
    /// completed by the next open, thanks to the per-column probe.
    #[test]
    fn a_partially_applied_step_rolls_back_then_completes() {
        let (dir, db) = database();
        let path = dir.path().join("pi.sqlite");
        downgrade_to_v30(db.conn());
        drop(db);

        {
            let conn = Connection::open(&path).unwrap();
            let tx = conn.unchecked_transaction().unwrap();
            migrate_v30_to_v31_tx(&tx).unwrap();
            // Simulate a failure after the statements but before the stamp.
            drop(tx);
        }
        {
            let conn = Connection::open(&path).unwrap();
            assert_eq!(version(&conn), 30, "an uncommitted step leaves v30");
            assert!(!has_column(&conn, "sessions", "role"));
        }

        let db = Database::open(&path).unwrap();
        assert_eq!(version(db.conn()), SCHEMA_VERSION);
        for (table, column, _) in COLUMNS {
            assert!(has_column(db.conn(), table, column), "{table}.{column}");
        }
        let non_zero: i64 = db
            .conn()
            .query_row(
                "SELECT COUNT(*) FROM session_collaboration_messages WHERE report_seq <> 0",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(non_zero, 0);
    }
}
