//! The per-scope bookkeeping automatic curation keeps: the dirty marker, the
//! lease, the once-a-day stamp, and the target sets the user undid.
//!
//! `mark_dirty_tx` is the one entry point here that does not refuse the `bot`
//! scope: it is called from the write paths every scope shares, and an
//! employee's lessons (schema v39) must keep being written. It skips that scope
//! instead — no row is created, so no pass is ever queued for it — while every
//! entry point that would read or claim a scope refuses it by name
//! ([`require_curatable_scope`]).

use super::*;
use crate::db::{now_ms, Database};
use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};

impl Database {
    /// Take the curation lease for one scope. `None` means another pass holds
    /// it, or the scope already ran today.
    pub fn claim_memory_curation(
        &self,
        scope: &MemoryScope,
        owner: &str,
        day: &str,
        lease_ms: i64,
    ) -> Result<bool> {
        require_curatable_scope(scope)?;
        tombstones::require_scope_key(scope)?;
        let tx = self.conn().unchecked_transaction()?;
        ensure_state_row(&tx, scope)?;
        let now = now_ms();
        // The day is stamped at claim time, not at completion: one local day
        // gets one pass whether it succeeds, finds nothing, or fails, so a scope
        // that keeps failing cannot spend the budget retrying all day.
        let changed = tx.execute(
            "UPDATE memory_curation_state
             SET lease_owner = ?1, lease_until = ?2, last_pass_day = ?6
             WHERE scope_kind = ?3 AND scope_key = ?4
               AND (lease_until IS NULL OR lease_until <= ?5)
               AND (last_pass_day IS NULL OR last_pass_day <> ?6)",
            params![
                owner,
                now + lease_ms.max(1_000),
                scope.kind,
                scope.stored_key(),
                now,
                day
            ],
        )?;
        tx.commit()?;
        Ok(changed > 0)
    }

    /// Why a claim was refused, for a caller that wants to report it.
    pub fn memory_curation_claim_refusal(
        &self,
        scope: &MemoryScope,
        day: &str,
    ) -> Result<&'static str> {
        require_curatable_scope(scope)?;
        let row: Option<(Option<String>, Option<String>, Option<i64>)> = self
            .conn()
            .query_row(
                "SELECT last_pass_day, lease_owner, lease_until
                   FROM memory_curation_state
                  WHERE scope_kind = ?1 AND scope_key = ?2",
                params![scope.kind, scope.stored_key()],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        let Some((last_pass_day, _lease_owner, _lease_until)) = row else {
            return Ok(SKIP_BUSY);
        };
        // The day's pass already ran, and a finished pass releases its lease, so
        // this is not a race: it is the once-a-day rule.
        if last_pass_day.as_deref() == Some(day) {
            return Ok(SKIP_ALREADY_RAN_TODAY);
        }
        Ok(SKIP_BUSY)
    }

    /// Release the lease after a finished pass and stamp the local day it ran
    /// on, so the scope waits until tomorrow even if it stays dirty.
    pub fn complete_memory_curation(
        &self,
        scope: &MemoryScope,
        owner: &str,
        day: &str,
    ) -> Result<bool> {
        require_curatable_scope(scope)?;
        let changed = self.conn().execute(
            "UPDATE memory_curation_state
             SET lease_owner = NULL, lease_until = NULL, attempts = 0, last_error = NULL,
                 last_pass_day = ?1, dirty_since = NULL
             WHERE scope_kind = ?2 AND scope_key = ?3 AND lease_owner = ?4",
            params![day, scope.kind, scope.stored_key(), owner],
        )?;
        Ok(changed > 0)
    }

    /// Record a failed pass. The dirty flag stays, so the next trigger retries;
    /// the counter is what the service backs off on.
    pub fn fail_memory_curation(
        &self,
        scope: &MemoryScope,
        owner: &str,
        error: &str,
    ) -> Result<Option<i64>> {
        require_curatable_scope(scope)?;
        let bounded: String = error.chars().take(MAX_CURATION_ERROR_CHARS).collect();
        let tx = self.conn().unchecked_transaction()?;
        let changed = tx.execute(
            "UPDATE memory_curation_state
             SET attempts = attempts + 1, last_error = ?1, lease_owner = NULL, lease_until = NULL
             WHERE scope_kind = ?2 AND scope_key = ?3 AND lease_owner = ?4",
            params![bounded, scope.kind, scope.stored_key(), owner],
        )?;
        if changed == 0 {
            return Ok(None);
        }
        let attempts: i64 = tx.query_row(
            "SELECT attempts FROM memory_curation_state WHERE scope_kind = ?1 AND scope_key = ?2",
            params![scope.kind, scope.stored_key()],
            |row| row.get(0),
        )?;
        tx.commit()?;
        Ok(Some(attempts))
    }

    /// Whether one scope has anything to curate.
    pub fn memory_curation_dirty(&self, scope: &MemoryScope) -> Result<bool> {
        require_curatable_scope(scope)?;
        self.conn()
            .query_row(
                "SELECT EXISTS(
                   SELECT 1 FROM memory_curation_state
                    WHERE scope_kind = ?1 AND scope_key = ?2 AND dirty_since IS NOT NULL)",
                params![scope.kind, scope.stored_key()],
                |row| row.get(0),
            )
            .map_err(Into::into)
    }

    /// Scopes with something to curate, oldest change first.
    ///
    /// A `bot` row cannot be stored (the table's check names `project` and
    /// `user` only), so the filter is belt and braces: if one ever appeared, the
    /// queue would skip it rather than hand an employee's lessons to this pass.
    pub fn dirty_memory_curation_scopes(&self) -> Result<Vec<MemoryScope>> {
        let mut statement = self.conn().prepare_cached(
            "SELECT scope_kind, scope_key FROM memory_curation_state
              WHERE dirty_since IS NOT NULL
              ORDER BY dirty_since ASC, scope_key ASC
              LIMIT 20",
        )?;
        let rows = statement
            .query_map([], |row| {
                let kind: String = row.get(0)?;
                let key: String = row.get(1)?;
                Ok(scope_from_row(&kind, Some(key)))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows.into_iter().filter(curatable).collect())
    }

    /// Drop revision records and rejections past their retention.
    pub fn prune_memory_curation(&self) -> Result<usize> {
        let cutoff = now_ms() - CURATION_REVISION_RETENTION_MS;
        let removed = self.conn().execute(
            "DELETE FROM memory_revisions WHERE created_at < ?1 AND undone_at IS NOT NULL",
            params![cutoff],
        )?;
        Ok(removed)
    }
}

fn ensure_state_row(conn: &Connection, scope: &MemoryScope) -> Result<()> {
    conn.execute(
        "INSERT OR IGNORE INTO memory_curation_state (scope_kind, scope_key) VALUES (?1, ?2)",
        params![scope.kind, scope.stored_key()],
    )?;
    Ok(())
}

/// Mark one scope as having something to curate, inside the caller's
/// transaction. A scope already dirty keeps its first timestamp, so the queue
/// stays first-come-first-served.
///
/// The `bot` scope is skipped, not refused: every write path shares this call,
/// and an employee's lesson must still be written even though no pass will ever
/// look at it. Skipping writes nothing, so the queue cannot claim a scope this
/// feature does not curate.
pub(crate) fn mark_dirty_tx(conn: &Connection, scope: &MemoryScope, now: i64) -> Result<()> {
    if !curatable(scope) {
        return Ok(());
    }
    conn.execute(
        "INSERT INTO memory_curation_state (scope_kind, scope_key, dirty_since)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(scope_kind, scope_key) DO UPDATE SET
           dirty_since = COALESCE(memory_curation_state.dirty_since, excluded.dirty_since)",
        params![scope.kind, scope.stored_key(), now],
    )?;
    Ok(())
}
