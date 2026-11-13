//! Schema v35 -> v36: the steward's default name is `Super Agent` (employee
//! mode 0.5 slice 3, follow-up).
//!
//! The name a person sees is the employee's own `bot_profile_json.name`, and the
//! session title is kept equal to it. Writers that changed the default used to
//! seed the word 管家, which the person then read in the sidebar, on every task
//! card, and in the task's origin chip. This step moves rows that still carry
//! **exactly** that default in both places to `Super Agent`; a name the person
//! chose is never rewritten, because a rename is theirs to make and this step
//! cannot tell a chosen name from a default one by inspection — only by equality
//! with the value the code used to write.
//!
//! Two properties this step needs on a real user database:
//!
//! - **It is an UPDATE, not a rebuild.** No table is dropped, no row is copied,
//!   and no foreign key is re-checked, so a long-lived file that already carries
//!   historical orphans upgrades exactly like a clean one. (The orphan count is
//!   asserted unchanged in the tests rather than assumed.)
//! - **It is idempotent.** After the first run no row matches any more, and the
//!   version stamp at the end makes the step run once in any case. A file whose
//!   step stopped before the stamp is completed rather than restarted.

use super::{anyhow, Connection, Path, Result};
use rusqlite::{params, Transaction};

use crate::session_collaboration::bots::STEWARD_DEFAULT_NAME;

/// Every name this product ever wrote as the steward's default.
///
/// `管家` is what `DEFAULT_CREW` seeded before this change; there is no English
/// default in the code to migrate, so nothing else is listed — a name that only
/// appears in a translation was never written to the database.
pub(crate) const OLD_STEWARD_DEFAULTS: [&str; 1] = ["管家"];

/// Rename untouched steward rows, in one transaction with the version stamp.
pub(crate) fn migrate_v35_to_v36_tx(tx: &Transaction<'_>) -> Result<()> {
    for old in OLD_STEWARD_DEFAULTS {
        tx.execute(
            // Both places must still say the old default: a row where the
            // person changed only the title (or only the profile name) is a row
            // they edited, and half-renaming it would lose their choice.
            "UPDATE sessions
                SET title = ?2,
                    bot_profile_json = json_set(bot_profile_json, '$.name', ?2)
              WHERE role = 'bot'
                AND deleted_at IS NULL
                AND title = ?1
                AND bot_profile_json IS NOT NULL
                AND json_valid(bot_profile_json)
                AND json_extract(bot_profile_json, '$.name') = ?1",
            params![old, STEWARD_DEFAULT_NAME],
        )
        .map_err(|error| anyhow!("rename the steward seeded as {old}: {error}"))?;
    }
    tx.pragma_update(None, "user_version", 36i64)?;
    Ok(())
}

pub(crate) fn migrate(conn: &Connection, _path: &Path) -> Result<()> {
    let tx = conn.unchecked_transaction()?;
    migrate_v35_to_v36_tx(&tx)?;
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

    fn violations_now(conn: &Connection) -> i64 {
        conn.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
            row.get(0)
        })
        .unwrap()
    }

    /// A steward row as the previous build wrote it: title and profile name both
    /// the old default.
    fn seed_steward(conn: &Connection, id: &str, title: &str, name: &str) {
        conn.execute(
            "INSERT INTO sessions (id, title, role, bot_profile_json, created_at, updated_at)
             VALUES (?1, ?2, 'bot', ?3, 1, 1)",
            params![
                id,
                title,
                format!(r#"{{"name":"{name}","duty":"Dispatch work","permissionMode":"ask","mustAsk":[],"observe":false,"definition":"steward"}}"#)
            ],
        )
        .unwrap();
    }

    /// Re-open the file the way the application does, which is where the chain
    /// runs.
    fn reopen(dir: &tempfile::TempDir) -> Database {
        Database::open(&dir.path().join("pi.sqlite")).unwrap()
    }

    fn name_of(db: &Database, id: &str) -> (String, String) {
        db.conn()
            .query_row(
                "SELECT title, json_extract(bot_profile_json, '$.name') FROM sessions WHERE id=?1",
                params![id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap()
    }

    #[test]
    fn an_untouched_default_is_renamed_in_both_places() {
        let (dir, db) = database();
        seed_steward(db.conn(), "steward", "管家", "管家");
        db.conn()
            .pragma_update(None, "user_version", 35i64)
            .unwrap();
        drop(db);

        let db = reopen(&dir);
        assert_eq!(version(db.conn()), SCHEMA_VERSION);
        assert_eq!(
            name_of(&db, "steward"),
            (
                STEWARD_DEFAULT_NAME.to_string(),
                STEWARD_DEFAULT_NAME.to_string()
            ),
            "an untouched default becomes the new default, in both places"
        );
        // Nothing else about the row changed: the profile still describes the
        // same employee, down to its definition.
        let definition: String = db
            .conn()
            .query_row(
                "SELECT json_extract(bot_profile_json, '$.definition') FROM sessions WHERE id='steward'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(definition, "steward");
    }

    #[test]
    fn a_name_the_person_chose_is_never_rewritten() {
        let (dir, db) = database();
        seed_steward(db.conn(), "chosen", "阿福", "阿福");
        // Only one of the two places edited is still an edit: the person owns
        // the name, and a half-renamed row must not be "completed" for them.
        seed_steward(db.conn(), "half", "阿福", "管家");
        db.conn()
            .pragma_update(None, "user_version", 35i64)
            .unwrap();
        drop(db);

        let db = reopen(&dir);
        assert_eq!(version(db.conn()), SCHEMA_VERSION);
        assert_eq!(
            name_of(&db, "chosen"),
            ("阿福".to_string(), "阿福".to_string())
        );
        assert_eq!(
            name_of(&db, "half"),
            ("阿福".to_string(), "管家".to_string())
        );
    }

    #[test]
    fn a_database_with_historical_orphans_upgrades_and_keeps_them() {
        let (dir, db) = database();
        seed_steward(db.conn(), "steward", "管家", "管家");
        // A long-lived file carries references to rows that were deleted before
        // foreign keys were enforced. The rename is an UPDATE, so it must not
        // care; the count is checked rather than assumed.
        db.conn()
            .pragma_update(None, "foreign_keys", false)
            .unwrap();
        db.conn()
            .execute(
                "INSERT INTO session_collaboration_messages
                 (id, plugin_id, source_session_id, source_title, target_session_id, target_title,
                  kind, content, status, notify_on_completion, idempotency_key, remaining_hops,
                  permission_ceiling, created_at, updated_at)
                 VALUES ('orphan', 'builtin:session-messaging', 'steward', '管家',
                  'deleted-session', 'gone', 'task', 'x', 'completed', 0, 'one', 32, 'ask', 1, 1)",
                [],
            )
            .unwrap();
        db.conn().pragma_update(None, "foreign_keys", true).unwrap();
        let orphans_before = violations_now(db.conn());
        assert_eq!(orphans_before, 1);
        db.conn()
            .pragma_update(None, "user_version", 35i64)
            .unwrap();
        drop(db);

        let db = reopen(&dir);
        assert_eq!(version(db.conn()), SCHEMA_VERSION);
        assert_eq!(
            name_of(&db, "steward").0,
            STEWARD_DEFAULT_NAME,
            "the upgrade is not refused because history is untidy"
        );
        assert_eq!(
            violations_now(db.conn()),
            orphans_before,
            "a rename neither creates nor repairs dangling references"
        );
    }
}
