//! Per-session extraction state: the cursor, the lease, and the retry budget
//! (ADR agent-long-term-memory §4).
//!
//! The host owns this state so a background extraction run stays idempotent
//! across restarts, duplicate triggers, and renderer reloads: a run claims the
//! session with a lease, and only the lease owner may advance the cursor or
//! record a failure.

use anyhow::{anyhow, Result};
use rusqlite::{params, Connection, OptionalExtension, Row};

use crate::db::{now_ms, Database};

use super::model::*;

const STATE_COLUMNS: &str = "session_id, scope_kind, scope_key, cursor_seq, lease_owner, \
     lease_until, attempts, last_error, excluded";

fn state_from_row(row: &Row<'_>) -> rusqlite::Result<MemorySessionStateRecord> {
    Ok(MemorySessionStateRecord {
        session_id: row.get(0)?,
        scope_kind: row.get(1)?,
        scope_key: row.get(2)?,
        cursor_seq: row.get(3)?,
        lease_owner: row.get(4)?,
        lease_until: row.get(5)?,
        attempts: row.get(6)?,
        last_error: row.get(7)?,
        excluded: row.get(8)?,
    })
}

fn state(conn: &Connection, session_id: &str) -> Result<Option<MemorySessionStateRecord>> {
    let sql = format!("SELECT {STATE_COLUMNS} FROM memory_session_state WHERE session_id = ?1");
    conn.query_row(&sql, params![session_id], state_from_row)
        .optional()
        .map_err(Into::into)
}

/// Create the row on first use, stamped with the scope the session's extraction
/// writes into. A group upgrade re-keys it with the entries it produced.
fn ensure_state(db: &Database, conn: &Connection, session_id: &str) -> Result<()> {
    if state(conn, session_id)?.is_some() {
        return Ok(());
    }
    let scopes = db
        .learned_memory_scopes_for_session(session_id)?
        .ok_or_else(|| anyhow!("session not found"))?;
    let scope = scopes
        .into_iter()
        .next()
        .ok_or_else(|| anyhow!("session has no memory scope"))?;
    conn.execute(
        "INSERT OR IGNORE INTO memory_session_state (session_id, scope_kind, scope_key)
         VALUES (?1, ?2, ?3)",
        params![session_id, scope.kind, scope.key],
    )?;
    Ok(())
}

/// Keep an error code readable and bounded. Extraction reports codes, never
/// transcript text, so this never truncates user content.
fn bounded_error(error: &str) -> String {
    error.chars().take(MAX_EXTRACTION_ERROR_CHARS).collect()
}

impl Database {
    pub fn memory_session_state(
        &self,
        session_id: &str,
    ) -> Result<Option<MemorySessionStateRecord>> {
        state(self.conn(), session_id)
    }

    /// "Don't learn from this conversation": skip this session and drop any
    /// lease a running extraction holds on it.
    pub fn set_memory_session_excluded(
        &self,
        session_id: &str,
        excluded: bool,
    ) -> Result<MemorySessionStateRecord> {
        let tx = self.conn().unchecked_transaction()?;
        ensure_state(self, &tx, session_id)?;
        tx.execute(
            "UPDATE memory_session_state
             SET excluded = ?1, lease_owner = NULL, lease_until = NULL
             WHERE session_id = ?2",
            params![excluded, session_id],
        )?;
        let updated = state(&tx, session_id)?
            .ok_or_else(|| anyhow!("memory session state missing after update"))?;
        tx.commit()?;
        Ok(updated)
    }

    /// Take the extraction lease. Returns `None` when another run holds it or
    /// the session is excluded, so a duplicate trigger coalesces into a no-op.
    pub fn claim_memory_extraction(
        &self,
        session_id: &str,
        owner: &str,
        lease_ms: i64,
    ) -> Result<Option<MemorySessionStateRecord>> {
        let tx = self.conn().unchecked_transaction()?;
        ensure_state(self, &tx, session_id)?;
        let now = now_ms();
        let changed = tx.execute(
            "UPDATE memory_session_state
             SET lease_owner = ?1, lease_until = ?2
             WHERE session_id = ?3 AND excluded = 0
               AND (lease_until IS NULL OR lease_until <= ?4)",
            params![owner, now + lease_ms.max(1_000), session_id, now],
        )?;
        if changed == 0 {
            return Ok(None);
        }
        let claimed = state(&tx, session_id)?;
        tx.commit()?;
        Ok(claimed)
    }

    /// Advance the cursor after a run that stored its candidates. The cursor
    /// only moves forward, so a replay can never re-read a consumed range.
    pub fn complete_memory_extraction(
        &self,
        session_id: &str,
        owner: &str,
        cursor_seq: i64,
    ) -> Result<Option<MemorySessionStateRecord>> {
        let tx = self.conn().unchecked_transaction()?;
        let changed = tx.execute(
            "UPDATE memory_session_state
             SET cursor_seq = MAX(cursor_seq, ?1), attempts = 0, last_error = NULL,
                 lease_owner = NULL, lease_until = NULL
             WHERE session_id = ?2 AND lease_owner = ?3",
            params![cursor_seq.max(0), session_id, owner],
        )?;
        if changed == 0 {
            return Ok(None);
        }
        let updated = state(&tx, session_id)?;
        tx.commit()?;
        Ok(updated)
    }

    /// Record a failed run. The cursor stays put so the range is retried, and
    /// the lease is released so the retry does not wait for its expiry.
    pub fn fail_memory_extraction(
        &self,
        session_id: &str,
        owner: &str,
        error: &str,
    ) -> Result<Option<MemorySessionStateRecord>> {
        let tx = self.conn().unchecked_transaction()?;
        let changed = tx.execute(
            "UPDATE memory_session_state
             SET attempts = attempts + 1, last_error = ?1,
                 lease_owner = NULL, lease_until = NULL
             WHERE session_id = ?2 AND lease_owner = ?3",
            params![bounded_error(error), session_id, owner],
        )?;
        if changed == 0 {
            return Ok(None);
        }
        let updated = state(&tx, session_id)?;
        tx.commit()?;
        Ok(updated)
    }
}
