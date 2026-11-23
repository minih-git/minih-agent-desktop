//! Schema v41 -> v42: the built-in Super Agent (steward) layer is gone.
//!
//! The employee the host used to create for itself carried
//! `bot_profile_json.definition = 'steward'`. That value no longer names
//! anything: the dispatcher layer left the host in 1.7.0, and an employee whose
//! `definition` still says `steward` would be read as a job the delegate catalog
//! does not have.
//!
//! The step is one UPDATE over one table:
//!
//! - **Only the definition is cleared.** `name`, `duty`, `role`,
//!   `permissionMode`, `observe` and `mustAsk` — everything the person reads and
//!   every setting they chose — stay exactly what they were. The session itself
//!   is never deleted, archived or renamed: that conversation, with its
//!   transcript and its memory, is still theirs, and it becomes an ordinary
//!   employee session.
//! - **No table is rebuilt.** No `DROP`, no row copy, no index recreated, so a
//!   long-lived file that carries historical dangling references upgrades
//!   exactly like a clean one. The step still counts
//!   `pragma_foreign_key_check` before and after and refuses only *new*
//!   violations, with enforcement on: rewriting a JSON column cannot add one,
//!   and a check that can never fire is the only kind that is safe to run on a
//!   file with a quarter of a million historical orphan rows.
//! - **Idempotent.** After the first run no row matches any more, and the
//!   version stamp at the end makes the step run once in any case. A file whose
//!   step stopped before the stamp is completed rather than restarted.

use super::{anyhow, create_migration_backup, params, Connection, Context, Path, Result};
use rusqlite::Transaction;

/// The definition value this step clears.
pub(crate) const STEWARD_DEFINITION: &str = "steward";

/// How many rows still claim a definition this product no longer has.
///
/// Read by the tests; a file that was already upgraded answers zero.
#[cfg(test)]
pub(crate) fn remaining(tx: &Transaction<'_>) -> Result<i64> {
    Ok(tx.query_row(
        "SELECT COUNT(*) FROM sessions
          WHERE role = 'bot'
            AND bot_profile_json IS NOT NULL
            AND json_valid(bot_profile_json)
            AND json_extract(bot_profile_json, '$.definition') = ?1",
        params![STEWARD_DEFINITION],
        |row| row.get(0),
    )?)
}

fn violations(tx: &Transaction<'_>) -> Result<i64> {
    Ok(
        tx.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
            row.get(0)
        })?,
    )
}

/// Clear `definition` on every steward profile, inside the caller's transaction.
///
/// `json_remove` drops the key rather than storing `null` or `""`: an absent
/// definition is what "no job" already means everywhere else, and a second
/// spelling of it would have to be special-cased by every reader.
pub(crate) fn migrate_v41_to_v42_tx(tx: &Transaction<'_>) -> Result<usize> {
    let before = violations(tx)?;
    let cleared = tx
        .execute(
            "UPDATE sessions
                SET bot_profile_json = json_remove(bot_profile_json, '$.definition')
              WHERE role = 'bot'
                AND bot_profile_json IS NOT NULL
                AND json_valid(bot_profile_json)
                AND json_extract(bot_profile_json, '$.definition') = ?1",
            params![STEWARD_DEFINITION],
        )
        .map_err(|error| anyhow!("clear the steward definition: {error}"))?;
    let after = violations(tx)?;
    if after > before {
        return Err(anyhow!(
            "clearing the steward definition left {after} foreign-key violations, up from \
             {before}; rolling back to v41"
        ));
    }
    tx.pragma_update(None, "user_version", 42i64)?;
    Ok(cleared)
}

/// Run the step on a real file: backup first, then one transaction that either
/// clears every steward definition and stamps v42, or changes nothing.
pub(crate) fn migrate(conn: &Connection, path: &Path) -> Result<()> {
    let backup = create_migration_backup(conn, path, 41)?;
    // Enforcement stays on. The step cannot add a dangling reference, and a file
    // that already carries historical ones must still open.
    conn.pragma_update(None, "foreign_keys", true)?;
    let tx = conn.unchecked_transaction()?;
    migrate_v41_to_v42_tx(&tx)?;
    tx.commit().with_context(|| {
        format!(
            "commit schema v41 to v42 migration; backup {} remains",
            backup.display()
        )
    })?;
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

    fn version(db: &Database) -> i64 {
        db.conn()
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap()
    }

    fn seed(db: &Database, id: &str, profile: &str) {
        db.conn()
            .execute(
                "INSERT INTO sessions
                   (id, title, mode, permission_mode, role, bot_profile_json, created_at, updated_at)
                 VALUES (?1, 'Super Agent', 'agent', 'ask', 'bot', ?2, 1, 1)",
                params![id, profile],
            )
            .unwrap();
    }

    fn profile(db: &Database, id: &str) -> serde_json::Value {
        let raw: String = db
            .conn()
            .query_row(
                "SELECT bot_profile_json FROM sessions WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )
            .unwrap();
        serde_json::from_str(&raw).unwrap()
    }

    /// A fresh file is already at the current version, so the upgrade is
    /// exercised on a copy of the previous shape.
    #[test]
    fn a_steward_session_keeps_everything_but_its_definition() {
        let (_dir, db) = database();
        seed(
            &db,
            "steward",
            r#"{"name":"Super Agent","duty":"Dispatch work","permissionMode":"ask",
                "mustAsk":["deploy"],"observe":false,"definition":"steward"}"#,
        );
        seed(
            &db,
            "worker",
            r#"{"name":"Router 后端","duty":"Fix the router","permissionMode":"accept-edits",
                "mustAsk":[],"observe":false,"definition":"explorer"}"#,
        );
        let before: i64 = db
            .conn()
            .query_row("SELECT COUNT(*) FROM sessions", [], |row| row.get(0))
            .unwrap();

        let tx = db.conn().unchecked_transaction().unwrap();
        let cleared = migrate_v41_to_v42_tx(&tx).unwrap();
        tx.commit().unwrap();

        assert_eq!(cleared, 1, "only the steward row carries that definition");
        let downgraded = profile(&db, "steward");
        assert_eq!(downgraded["name"], serde_json::json!("Super Agent"));
        assert_eq!(downgraded["duty"], serde_json::json!("Dispatch work"));
        assert_eq!(downgraded["permissionMode"], serde_json::json!("ask"));
        assert_eq!(downgraded["mustAsk"], serde_json::json!(["deploy"]));
        assert_eq!(downgraded["observe"], serde_json::json!(false));
        assert!(
            downgraded.get("definition").is_none(),
            "the definition is cleared, not renamed: {downgraded}"
        );

        // The session is still there, still an employee, still titled what the
        // person saw.
        let (title, role): (String, String) = db
            .conn()
            .query_row(
                "SELECT title, role FROM sessions WHERE id = 'steward'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(title, "Super Agent");
        assert_eq!(role, "bot");
        let after: i64 = db
            .conn()
            .query_row("SELECT COUNT(*) FROM sessions", [], |row| row.get(0))
            .unwrap();
        assert_eq!(after, before, "no session was removed");

        // An employee hired for a real job is untouched.
        assert_eq!(
            profile(&db, "worker")["definition"],
            serde_json::json!("explorer")
        );
    }

    #[test]
    fn the_step_is_idempotent() {
        let (_dir, db) = database();
        seed(
            &db,
            "steward",
            r#"{"name":"Super Agent","definition":"steward"}"#,
        );
        for _ in 0..2 {
            let tx = db.conn().unchecked_transaction().unwrap();
            migrate_v41_to_v42_tx(&tx).unwrap();
            tx.commit().unwrap();
        }
        let tx = db.conn().unchecked_transaction().unwrap();
        assert_eq!(remaining(&tx).unwrap(), 0);
        assert_eq!(version(&db), 42);
        // The step stamps 42; newer steps own the head (v43 adds the plugin
        // capability columns and tables, v44 the session origin, v45 the
        // delegate role a session acts in).
        assert_eq!(SCHEMA_VERSION, 45);
    }

    #[test]
    fn a_row_with_no_json_profile_is_skipped_rather_than_failing() {
        let (_dir, db) = database();
        db.conn()
            .execute(
                "INSERT INTO sessions (id, title, mode, permission_mode, role, created_at, updated_at)
                 VALUES ('bare', 'Bare', 'agent', 'ask', 'bot', 1, 1)",
                [],
            )
            .unwrap();
        let tx = db.conn().unchecked_transaction().unwrap();
        assert_eq!(migrate_v41_to_v42_tx(&tx).unwrap(), 0);
        tx.commit().unwrap();
    }
}
