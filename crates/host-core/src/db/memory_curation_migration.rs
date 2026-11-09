//! Schema v40 -> v41: automatic-curation bookkeeping (ADR
//! learned-memory-consolidation).
//!
//! The step is purely additive. It adds no column to `memory_entries`, so no
//! existing note is rewritten, and the three new tables start empty:
//!
//! - `memory_revisions` is the audit trail every automatic change writes in the
//!   same transaction as the change itself, and the source an undo replays.
//! - `memory_curation_state` is the per-scope dirty flag, lease, and backoff.
//! - `memory_curation_rejections` remembers a target set the user undid, so the
//!   next pass does not propose the same cleanup again.
//!
//! All three are device-local: none of them is captured by configuration sync,
//! which is what makes an undo a local action on notes that travel.
//!
//! The `scope_kind` check on the two per-scope tables names `project` and `user`
//! only. Employee experience lives in the `bot` scope (schema v39) and is
//! curated by the employee layer, not by this pass, so a `bot` row is rejected
//! by the table itself rather than by whichever caller forgets to filter it.
//!
//! Because nothing here rebuilds a table and no row is copied, the step cannot
//! trip over the dangling references a long-lived file carries: unlike the v38
//! -> v39 rebuild, it needs no `foreign_key_check` comparison and refuses
//! nothing on that basis.

use super::{create_migration_backup, Connection, Context, Path, Result};

/// Shared verbatim by the fresh schema and the v40 -> v41 migration, so the two
/// cannot drift in table names, checks, indexes, or constraints.
///
/// `before_json` is nullable because an activation has nothing before it; every
/// other operation must record what it replaced, so an undo can put it back.
pub(crate) const MEMORY_CURATION_DDL: &str = r#"
CREATE TABLE IF NOT EXISTS memory_revisions (
  id          INTEGER PRIMARY KEY,
  batch_id    TEXT NOT NULL,
  entry_id    TEXT NOT NULL,
  op          TEXT NOT NULL CHECK (op IN ('activate','merge_new','merge_archive','replace_archive','reword')),
  actor       TEXT NOT NULL CHECK (actor = 'auto'),
  before_json TEXT,
  after_json  TEXT NOT NULL,
  reason      TEXT,
  created_at  INTEGER NOT NULL,
  undone_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_memory_revisions_batch ON memory_revisions(batch_id);
CREATE INDEX IF NOT EXISTS idx_memory_revisions_created
  ON memory_revisions(created_at DESC);

CREATE TABLE IF NOT EXISTS memory_curation_state (
  scope_kind   TEXT NOT NULL CHECK (scope_kind IN ('project', 'user')),
  scope_key    TEXT NOT NULL DEFAULT '',
  dirty_since  INTEGER,
  last_pass_day TEXT,
  lease_owner  TEXT,
  lease_until  INTEGER,
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT,
  PRIMARY KEY (scope_kind, scope_key)
);
CREATE INDEX IF NOT EXISTS idx_memory_curation_state_dirty
  ON memory_curation_state(dirty_since) WHERE dirty_since IS NOT NULL;

CREATE TABLE IF NOT EXISTS memory_curation_rejections (
  scope_kind         TEXT NOT NULL CHECK (scope_kind IN ('project', 'user')),
  scope_key          TEXT NOT NULL DEFAULT '',
  target_fingerprint TEXT NOT NULL,
  created_at         INTEGER NOT NULL,
  PRIMARY KEY (scope_kind, scope_key, target_fingerprint)
);
"#;

pub(crate) fn migrate_v40_to_v41(conn: &Connection, path: &Path) -> Result<()> {
    let backup = create_migration_backup(conn, path, 40)?;
    let tx = conn.unchecked_transaction()?;
    tx.execute_batch(MEMORY_CURATION_DDL)?;
    tx.pragma_update(None, "user_version", 41i64)?;
    tx.commit().with_context(|| {
        format!(
            "commit schema v40 to v41 migration; backup {} remains",
            backup.display()
        )
    })?;
    Ok(())
}
