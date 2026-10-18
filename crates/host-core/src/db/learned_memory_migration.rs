//! Schema v25 -> v26: the learned-memory tables (ADR agent-long-term-memory).
//!
//! The step is purely additive. Pinned project memory keeps its `kv` records and
//! its behavior, and the new tables start empty, so no existing row is rewritten
//! and no user data is migrated.

use super::{create_migration_backup, Connection, Context, Path, Result};

/// Shared verbatim by the fresh schema and the v25 -> v26 migration, so the two
/// cannot drift in table names, checks, indexes, or triggers.
///
/// `memory_entries` is the learned layer, `memory_tombstones` is the
/// content-free record of what the user forgot, and `memory_session_state` is the
/// per-session extraction cursor and lease. The FTS index mirrors the message
/// index of ADR session-content-search: external content plus triggers.
pub(crate) const LEARNED_MEMORY_DDL: &str = r#"
CREATE TABLE IF NOT EXISTS memory_entries (
  id                 TEXT PRIMARY KEY,
  scope_kind         TEXT NOT NULL CHECK (scope_kind IN ('project', 'user')),
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
CREATE INDEX IF NOT EXISTS idx_memory_entries_scope
  ON memory_entries(scope_kind, scope_key, status);
-- One live entry per fingerprint in a scope. Archived rows stay out of the key
-- so the manager can keep an archived history beside a re-learned entry.
CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_entries_fingerprint
  ON memory_entries(scope_kind, IFNULL(scope_key, ''), fingerprint)
  WHERE status <> 'archived';
CREATE INDEX IF NOT EXISTS idx_memory_entries_recent
  ON memory_entries(updated_at DESC, id ASC);

CREATE TABLE IF NOT EXISTS memory_tombstones (
  id                 INTEGER PRIMARY KEY,
  scope_kind         TEXT NOT NULL CHECK (scope_kind IN ('project', 'user')),
  scope_key          TEXT,
  fingerprint        TEXT NOT NULL,
  source_session_id  TEXT,
  source_message_ids TEXT NOT NULL DEFAULT '[]',
  created_at         INTEGER NOT NULL
);
-- One tombstone per fingerprint in a scope, so a repeated delete is idempotent
-- and its source messages merge instead of piling up.
CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_tombstones_fingerprint
  ON memory_tombstones(scope_kind, IFNULL(scope_key, ''), fingerprint);

CREATE TABLE IF NOT EXISTS memory_session_state (
  session_id  TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  scope_kind  TEXT NOT NULL CHECK (scope_kind IN ('project', 'user')),
  scope_key   TEXT,
  cursor_seq  INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_until INTEGER,
  attempts    INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT,
  excluded    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_memory_session_state_scope
  ON memory_session_state(scope_kind, scope_key);

CREATE VIRTUAL TABLE IF NOT EXISTS memory_entries_fts USING fts5(
  content,
  rationale,
  content='memory_entries', content_rowid='rowid',
  tokenize='trigram'
);
CREATE TRIGGER IF NOT EXISTS memory_entries_fts_ai AFTER INSERT ON memory_entries
  BEGIN
    INSERT INTO memory_entries_fts(rowid, content, rationale)
      VALUES (new.rowid, new.content, COALESCE(new.rationale, ''));
  END;
CREATE TRIGGER IF NOT EXISTS memory_entries_fts_ad AFTER DELETE ON memory_entries
  BEGIN
    INSERT INTO memory_entries_fts(memory_entries_fts, rowid, content, rationale)
      VALUES ('delete', old.rowid, old.content, COALESCE(old.rationale, ''));
  END;
CREATE TRIGGER IF NOT EXISTS memory_entries_fts_au
  AFTER UPDATE OF content, rationale ON memory_entries
  BEGIN
    INSERT INTO memory_entries_fts(memory_entries_fts, rowid, content, rationale)
      VALUES ('delete', old.rowid, old.content, COALESCE(old.rationale, ''));
    INSERT INTO memory_entries_fts(rowid, content, rationale)
      VALUES (new.rowid, new.content, COALESCE(new.rationale, ''));
  END;
"#;

pub(crate) fn migrate_v25_to_v26(conn: &Connection, path: &Path) -> Result<()> {
    let backup = create_migration_backup(conn, path, 25)?;
    let tx = conn.unchecked_transaction()?;
    tx.execute_batch(LEARNED_MEMORY_DDL)?;
    tx.pragma_update(None, "user_version", 26i64)?;
    tx.commit().with_context(|| {
        format!(
            "commit schema v25 to v26 migration; backup {} remains",
            backup.display()
        )
    })?;
    Ok(())
}
