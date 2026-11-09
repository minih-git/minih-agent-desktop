//! The audit trail automatic curation writes, the manager's list of it, and
//! undoing one batch.
//!
//! Every row is compared against its `after` snapshot before anything is
//! written, so a note that moved since the pass makes the whole batch a
//! conflict rather than a wrong undo.

use super::*;
use crate::db::{now_ms, Database};
use anyhow::Result;
use rusqlite::{params, Connection, Row};

impl Database {
    /// The batches of one scope, newest first, for the manager's "recently
    /// curated" list. A batch whose rows are all undone is left out: there is
    /// nothing left to read or to undo.
    pub fn memory_curation_batches(
        &self,
        scope: &MemoryScope,
        since: i64,
        limit: i64,
    ) -> Result<Vec<MemoryRevisionRecord>> {
        require_curatable_scope(scope)?;
        let mut statement = self.conn().prepare_cached(
            "SELECT id, batch_id, entry_id, op, actor, before_json, after_json, reason,
                    created_at, undone_at
               FROM memory_revisions
              WHERE created_at >= ?1
                AND batch_id IN (
                  SELECT batch_id FROM memory_revisions
                   WHERE created_at >= ?1 AND undone_at IS NULL
                   GROUP BY batch_id)
                AND entry_id IN (
                  SELECT id FROM memory_entries
                   WHERE scope_kind = ?2 AND IFNULL(scope_key, '') = ?3)
              ORDER BY created_at DESC, id ASC
              LIMIT ?4",
        )?;
        let rows = statement
            .query_map(
                params![since, scope.kind, scope.stored_key(), limit.clamp(1, 200)],
                revision_from_row,
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// How many automatic changes this scope saw since `since`.
    pub fn count_memory_curation_changes(&self, scope: &MemoryScope, since: i64) -> Result<i64> {
        require_curatable_scope(scope)?;
        self.conn()
            .query_row(
                "SELECT COUNT(*) FROM memory_revisions
                  WHERE created_at >= ?1 AND undone_at IS NULL
                    AND entry_id IN (
                      SELECT id FROM memory_entries
                       WHERE scope_kind = ?2 AND IFNULL(scope_key, '') = ?3)",
                params![since, scope.kind, scope.stored_key()],
                |row| row.get(0),
            )
            .map_err(Into::into)
    }

    /// Undo one batch (ADR §5).
    ///
    /// Every row is re-checked against its `after_json` first: a note that
    /// changed since the pass (the user's edit, a sync apply) makes the whole
    /// undo a `MEMORY_UNDO_CONFLICT` with nothing written. Undoing a merge or a
    /// replace also records the target set as rejected, so the next pass does
    /// not propose the same cleanup again.
    pub fn undo_memory_curation(&self, batch_id: &str) -> Result<CurationUndoReport> {
        let tx = self.conn().unchecked_transaction()?;
        let Some(rows) = revision_rows(&tx, batch_id)? else {
            return Ok(CurationUndoReport::NotFound);
        };
        if rows.iter().all(|row| row.undone_at.is_some()) {
            return Ok(CurationUndoReport::AlreadyUndone);
        }
        // Nothing automatic can produce a `bot` batch, and the two bookkeeping
        // tables refuse that scope outright. A batch naming one is therefore not
        // ours to undo: refuse before any row is written rather than archive an
        // employee's lesson.
        for scope in rows.iter().filter_map(|row| row.scope.as_ref()) {
            require_curatable_scope(scope)?;
        }
        let undo_scope = rows
            .iter()
            .find_map(|row| row.scope.clone())
            .unwrap_or_else(MemoryScope::user);
        // The version check comes first and covers every row: one note that
        // moved since the pass makes the whole batch a conflict with nothing
        // written, so a half-applied undo can never happen.
        let mut restores = Vec::new();
        for row in rows.iter().filter(|row| row.undone_at.is_none()) {
            let Some(current) = entry_by_id(&tx, &row.entry_id)? else {
                // The note was deleted after the pass. Deleting is the user's
                // own action and it wins: an undo cannot revive what they chose
                // to erase, and it cannot archive a merged note that is gone.
                if matches!(
                    row.op.as_str(),
                    REVISION_MERGE_NEW | REVISION_REWORD | REVISION_ACTIVATE
                ) {
                    return Ok(CurationUndoReport::Conflict);
                }
                continue;
            };
            if !row.matches(&current) {
                return Ok(CurationUndoReport::Conflict);
            }
            restores.push((row.clone(), current));
        }
        let mut restored_targets: Vec<String> = Vec::new();
        for (row, current) in &restores {
            match row.op.as_str() {
                REVISION_ACTIVATE => {
                    // The same meaning as the inbox's Discard: the text is
                    // erased and the evidence behind it is remembered as
                    // rejected. That is the user's own decision, so it is the
                    // one place an undo may write a tombstone (ADR §6).
                    tombstones::write(
                        &tx,
                        &current.scope(),
                        &current.fingerprint,
                        current.source_session_id.as_deref(),
                        &current.source_message_ids,
                        now_ms(),
                    )?;
                    tx.execute(
                        "DELETE FROM memory_entries WHERE id = ?1",
                        params![current.id],
                    )?;
                }
                REVISION_MERGE_NEW => {
                    tx.execute(
                        "UPDATE memory_entries
                         SET status = ?1, superseded_by = NULL, revision = revision + 1,
                             updated_at = ?2
                         WHERE id = ?3",
                        params![STATUS_ARCHIVED, now_ms(), current.id],
                    )?;
                }
                REVISION_MERGE_ARCHIVE | REVISION_REPLACE_ARCHIVE => {
                    let status = row
                        .before
                        .as_ref()
                        .map(|before| before.status.as_str())
                        .unwrap_or(STATUS_ACTIVE);
                    tx.execute(
                        "UPDATE memory_entries
                         SET status = ?1, superseded_by = NULL, revision = revision + 1,
                             updated_at = ?2
                         WHERE id = ?3",
                        params![status, now_ms(), current.id],
                    )?;
                    // The set the user put back is not proposed again.
                    restored_targets.push(current.fingerprint.clone());
                }
                REVISION_REWORD => {
                    let before = row.before.as_ref().expect("a reword records its before");
                    tx.execute(
                        "UPDATE memory_entries
                         SET content = ?1, fingerprint = ?2, revision = revision + 1,
                             updated_at = ?3
                         WHERE id = ?4",
                        params![
                            before.content,
                            tombstones::fingerprint(&current.kind, &before.content),
                            now_ms(),
                            current.id
                        ],
                    )?;
                }
                _ => {}
            }
        }
        let mut rejected: Vec<String> = Vec::new();
        if !restored_targets.is_empty() {
            let mut fingerprints: Vec<&str> = restored_targets.iter().map(String::as_str).collect();
            rejected.push(target_set_fingerprint(&undo_scope, &mut fingerprints));
        }
        if !rejected.is_empty() {
            for fingerprint in rejected {
                tx.execute(
                    "INSERT OR IGNORE INTO memory_curation_rejections
                       (scope_kind, scope_key, target_fingerprint, created_at)
                     VALUES (?1, ?2, ?3, ?4)",
                    params![
                        undo_scope.kind,
                        undo_scope.stored_key(),
                        fingerprint,
                        now_ms()
                    ],
                )?;
            }
            mark_dirty_tx(&tx, &undo_scope, now_ms())?;
        }
        tx.execute(
            "UPDATE memory_revisions SET undone_at = ?1 WHERE batch_id = ?2 AND undone_at IS NULL",
            params![now_ms(), batch_id],
        )?;
        tx.commit()?;
        Ok(CurationUndoReport::Undone {
            undone: restores.len(),
        })
    }
}

impl MemoryRevisionRecord {
    /// Whether the note still holds what the pass left it as. A mismatch means
    /// the user or a sync moved it after the automatic change.
    ///
    /// A merge archives its targets, so the successor the batch created is read
    /// as the merge left it: active, unwritten, and at the revision this row
    /// recorded. Its `after_json` is the insert, and the archives that follow it
    /// are the targets, never the successor itself.
    fn matches(&self, entry: &MemoryEntryRecord) -> bool {
        entry.revision == self.after.revision
            && entry.status == self.after.status
            && entry.content == self.after.content
    }
}

pub(crate) fn record_revision(
    conn: &Connection,
    batch_id: &str,
    entry_id: &str,
    op: &str,
    before: Option<&MemoryRevisionSnapshot>,
    after: &MemoryRevisionSnapshot,
    reason: Option<&str>,
) -> Result<()> {
    conn.execute(
        "INSERT INTO memory_revisions
           (batch_id, entry_id, op, actor, before_json, after_json, reason, created_at)
         VALUES (?1, ?2, ?3, 'auto', ?4, ?5, ?6, ?7)",
        params![
            batch_id,
            entry_id,
            op,
            before.map(serde_json::to_string).transpose()?,
            serde_json::to_string(after)?,
            reason,
            now_ms()
        ],
    )?;
    Ok(())
}

const REVISION_COLUMNS: &str = "r.id, r.batch_id, r.entry_id, r.op, r.actor, r.before_json, \
     r.after_json, r.reason, r.created_at, r.undone_at";

fn revision_from_row(row: &Row<'_>) -> rusqlite::Result<MemoryRevisionRecord> {
    let before_raw: Option<String> = row.get(5)?;
    let after_raw: String = row.get(6)?;
    Ok(MemoryRevisionRecord {
        id: row.get(0)?,
        batch_id: row.get(1)?,
        entry_id: row.get(2)?,
        op: row.get(3)?,
        actor: row.get(4)?,
        before: before_raw.and_then(|raw| serde_json::from_str(&raw).ok()),
        after: serde_json::from_str(&after_raw).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                6,
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        })?,
        reason: row.get(7)?,
        created_at: row.get(8)?,
        undone_at: row.get(9)?,
        scope: None,
    })
}

fn revision_rows(conn: &Connection, batch_id: &str) -> Result<Option<Vec<MemoryRevisionRecord>>> {
    let sql = format!(
        "SELECT {REVISION_COLUMNS}, e.scope_kind, e.scope_key
           FROM memory_revisions r
           LEFT JOIN memory_entries e ON e.id = r.entry_id
          WHERE r.batch_id = ?1
          ORDER BY r.id ASC"
    );
    let mut statement = conn.prepare_cached(&sql)?;
    let rows = statement
        .query_map(params![batch_id], |row| {
            let mut record = revision_from_row(row)?;
            // A row whose note was deleted since keeps no scope of its own; the
            // caller then falls back to the scope of the batch's other notes.
            record.scope = row
                .get::<_, Option<String>>(10)?
                .map(|kind| scope_from_row(&kind, row.get(11).ok().flatten()));
            Ok(record)
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(if rows.is_empty() { None } else { Some(rows) })
}
