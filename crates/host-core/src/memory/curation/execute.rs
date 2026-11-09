//! What an automatic pass may read, and the four operations it may apply.
//!
//! The service in Electron main proposes; this module decides. Every item is
//! re-checked against the rows inside one transaction, so a proposal built from
//! a stale reading changes nothing, and the cap is enforced here rather than in
//! the caller.

use super::*;
use crate::db::{now_ms, Database};
use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};

impl Database {
    /// Turn extraction's suggestions into active notes (ADR §6.1).
    ///
    /// Only `origin = extracted` / `status = suggested` rows are eligible, and
    /// the cap is the session-start-scale one: a backlog is drained over several
    /// passes rather than all at once. Every activation is recorded in the same
    /// transaction, which is what makes the inbox's Undo work on it later.
    pub fn activate_memory_suggestions(
        &self,
        scope: &MemoryScope,
        ids: &[String],
        reason: Option<&str>,
    ) -> Result<CurationActivateReport> {
        require_curatable_scope(scope)?;
        let batch_id = new_batch_id();
        let tx = self.conn().unchecked_transaction()?;
        let cap = curation_cap(&tx, scope)?;
        let mut activated = Vec::new();
        let mut skipped = 0usize;
        let mut capped = false;
        for id in ids {
            if activated.len() >= cap {
                capped = true;
                skipped += 1;
                continue;
            }
            let Some(entry) = entry_by_id(&tx, id)? else {
                skipped += 1;
                continue;
            };
            if entry.scope() != *scope
                || entry.origin != ORIGIN_EXTRACTED
                || entry.status != STATUS_SUGGESTED
            {
                skipped += 1;
                continue;
            }
            tx.execute(
                "UPDATE memory_entries SET status = ?1, revision = revision + 1, updated_at = ?2
                 WHERE id = ?3 AND status = ?4",
                params![STATUS_ACTIVE, now_ms(), entry.id, STATUS_SUGGESTED],
            )?;
            let after = entry_by_id(&tx, &entry.id)?
                .map(|entry| MemoryRevisionSnapshot::of(&entry))
                .unwrap_or_else(|| MemoryRevisionSnapshot::of(&entry));
            record_revision(
                &tx,
                &batch_id,
                &entry.id,
                REVISION_ACTIVATE,
                Some(&MemoryRevisionSnapshot::of(&entry)),
                &after,
                reason,
            )?;
            activated.push(entry.id);
        }
        if !activated.is_empty() {
            mark_dirty_tx(&tx, scope, now_ms())?;
        }
        tx.commit()?;
        Ok(CurationActivateReport {
            batch_id,
            activated,
            skipped,
            cap,
            capped,
        })
    }

    /// What one pass may read (ADR §6.2). The host assembles it so the service
    /// can only ever see this scope's own notes: no transcript, no other scope,
    /// no project the session does not own.
    pub fn memory_curation_input(&self, scope: &MemoryScope) -> Result<CurationInputOutcome> {
        require_curatable_scope(scope)?;
        let now = now_ms();
        if !self.memory_curation_dirty(scope)? {
            return Ok(CurationInputOutcome::Skipped(SKIP_NOTHING_CHANGED));
        }
        let cap = curation_cap(self.conn(), scope)?;
        let active = active_entries(self.conn(), scope)?;
        if active.len() < 2 {
            return Ok(CurationInputOutcome::Skipped(SKIP_NOTHING_CHANGED));
        }
        let changed_mark: Option<i64> = self
            .conn()
            .query_row(
                "SELECT dirty_since FROM memory_curation_state
                  WHERE scope_kind = ?1 AND scope_key = ?2",
                params![scope.kind, scope.stored_key()],
                |row| row.get(0),
            )
            .optional()?
            .flatten();
        let mut budget = CURATION_INPUT_MAX_BYTES;
        let mut seen = std::collections::HashSet::new();
        let mut changed = Vec::new();
        for entry in &active {
            if changed_mark.is_some_and(|mark| entry.updated_at < mark) {
                continue;
            }
            if let Some(item) = entry_item(entry, now, &mut budget) {
                seen.insert(entry.id.clone());
                changed.push(item);
            }
        }
        let mut neighbours = Vec::new();
        for entry in &active {
            if !changed.iter().any(|item| item.id == entry.id) {
                continue;
            }
            let found = self.curation_neighbours(scope, &entry.content, &entry.kind, &entry.id)?;
            for neighbour in found {
                if seen.contains(&neighbour.id) {
                    continue;
                }
                if let Some(item) = entry_item(&neighbour, now, &mut budget) {
                    seen.insert(neighbour.id.clone());
                    neighbours.push(item);
                }
            }
            if neighbours.len() as i64 >= CURATION_NEIGHBOURS_PER_ENTRY * active.len() as i64 {
                break;
            }
        }
        let mut others = Vec::new();
        for entry in &active {
            if seen.contains(&entry.id) {
                continue;
            }
            match entry_item(entry, now, &mut budget) {
                Some(item) => {
                    seen.insert(entry.id.clone());
                    others.push(item);
                }
                None => break,
            }
        }
        Ok(CurationInputOutcome::Input(Box::new(CurationInput {
            scope_kind: scope.kind.to_string(),
            scope_key: scope.key.clone(),
            changed,
            neighbours,
            others,
            bytes: CURATION_INPUT_MAX_BYTES - budget,
            cap,
        })))
    }

    /// Apply one pass's items (ADR §4).
    ///
    /// Every item is checked against the current rows inside one transaction:
    /// any item whose target revision moved is refused as `stale` and changes
    /// nothing, an item the user's own edits protect is refused with the code
    /// that says so, and the cap is enforced here rather than in the caller.
    pub fn apply_memory_curation(
        &self,
        scope: &MemoryScope,
        ops: &[CurationOpRequest],
        reason_default: Option<&str>,
    ) -> Result<CurationApplyReport> {
        require_curatable_scope(scope)?;
        tombstones::require_scope_key(scope)?;
        let batch_id = new_batch_id();
        let tx = self.conn().unchecked_transaction()?;
        let cap = curation_cap(&tx, scope)?;
        let mut applied = 0usize;
        let mut capped = false;
        let mut outcomes = Vec::with_capacity(ops.len());
        for op in ops {
            if applied >= cap {
                capped = true;
                outcomes.push(CurationOpOutcome {
                    op: op.op.clone(),
                    result: CURATION_CAPPED,
                });
                continue;
            }
            let result = apply_one(
                &tx,
                scope,
                &batch_id,
                op,
                reason_default,
                ops.len() > MAX_CURATION_OPS,
            )?;
            if result == CURATION_APPLIED {
                applied += 1;
            }
            outcomes.push(CurationOpOutcome {
                op: op.op.clone(),
                result,
            });
        }
        if applied > 0 {
            mark_dirty_tx(&tx, scope, now_ms())?;
        }
        if capped {
            tx.execute(
                "UPDATE memory_curation_state SET last_error = ?1
                  WHERE scope_kind = ?2 AND scope_key = ?3",
                params!["CURATION_CAPPED", scope.kind, scope.stored_key()],
            )?;
        }
        tx.commit()?;
        Ok(CurationApplyReport {
            batch_id,
            applied,
            cap,
            outcomes,
            capped,
        })
    }

    /// Write-scope neighbours of one note: the other active notes of the same
    /// mark, ranked by how many characters they share with it.
    fn curation_neighbours(
        &self,
        scope: &MemoryScope,
        content: &str,
        kind: &str,
        exclude: &str,
    ) -> Result<Vec<MemoryEntryRecord>> {
        crate::session_search::register_contains(self)?;
        let needle = content.chars().take(48).collect::<String>();
        let sql = format!(
            "SELECT {ENTRY_COLUMNS} FROM memory_entries
              WHERE scope_kind = ?1 AND IFNULL(scope_key, '') = ?2 AND status = ?3
                AND kind = ?4 AND id <> ?5
                AND pi_search_contains(content, ?6)
              ORDER BY updated_at DESC LIMIT ?7"
        );
        let mut statement = self.conn().prepare_cached(&sql)?;
        let rows = statement.query_map(
            params![
                scope.kind,
                scope.stored_key(),
                STATUS_ACTIVE,
                kind,
                exclude,
                needle,
                CURATION_NEIGHBOURS_PER_ENTRY
            ],
            entry_from_row,
        )?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }
}

/// One item, inside the caller's transaction. Returns a result code.
fn apply_one(
    conn: &Connection,
    scope: &MemoryScope,
    batch_id: &str,
    op: &CurationOpRequest,
    reason_default: Option<&str>,
    over_limit: bool,
) -> Result<&'static str> {
    if over_limit || !is_known(&op.op, &CURATION_OPS) {
        return Ok(CURATION_REJECTED);
    }
    if op.target_ids.is_empty() || op.target_ids.len() != op.target_revisions.len() {
        return Ok(CURATION_REJECTED);
    }
    let mut targets = Vec::with_capacity(op.target_ids.len());
    for (id, revision) in op.target_ids.iter().zip(&op.target_revisions) {
        let Some(entry) = entry_by_id(conn, id)? else {
            return Ok(CURATION_STALE);
        };
        if entry.scope() != *scope || entry.revision != *revision {
            return Ok(CURATION_STALE);
        }
        targets.push(entry);
    }
    let reason = op.reason.as_deref().or(reason_default).map(bounded_reason);
    let now = now_ms();
    match op.op.as_str() {
        CURATION_OP_MERGE => {
            if !(MIN_MERGE_TARGETS..=MAX_MERGE_TARGETS).contains(&op.target_ids.len()) {
                return Ok(CURATION_REJECTED);
            }
            if targets.iter().any(|entry| !is_mergeable(entry)) {
                return Ok(CURATION_REJECTED);
            }
            let kind = targets[0].kind.clone();
            if targets.iter().any(|entry| entry.kind != kind) {
                return Ok(CURATION_REJECTED);
            }
            let kind = op.kind.clone().unwrap_or(kind);
            if !is_known(&kind, &KINDS) {
                return Ok(CURATION_REJECTED);
            }
            let Some(content) = op
                .content
                .as_deref()
                .map(str::trim)
                .filter(|c| !c.is_empty())
            else {
                return Ok(CURATION_REJECTED);
            };
            let merged = merge_note(&targets, &kind, content, now)?;
            if let Some(code) = validate_merged(conn, scope, &merged)? {
                return Ok(code);
            }
            if rejected_target_set(conn, scope, &targets)? {
                return Ok(CURATION_ALREADY_DONE);
            }
            // The merged note replaces all targets, so the row they point at
            // exists before they are archived.
            let new_id = uuid::Uuid::new_v4().to_string();
            let fingerprint = tombstones::fingerprint(&merged.kind, &merged.content);
            conn.execute(
                "INSERT INTO memory_entries
                   (id, scope_kind, scope_key, kind, content, rationale, status, origin, evidence,
                    source_session_id, source_message_ids, fingerprint, revision, superseded_by,
                    created_at, updated_at, last_used_at, use_count)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 1, NULL, ?13, ?14, NULL, 0)",
                params![
                    new_id,
                    scope.kind,
                    scope.key.as_deref(),
                    merged.kind,
                    merged.content,
                    merged.rationale,
                    STATUS_ACTIVE,
                    merged.origin,
                    merged.evidence,
                    merged.source_session_id,
                    tombstones::encode_ids(&merged.source_message_ids),
                    fingerprint,
                    now,
                    now
                ],
            )?;
            let new_entry = entry_by_id(conn, &new_id)?.expect("the note was just inserted");
            record_revision(
                conn,
                batch_id,
                &new_id,
                REVISION_MERGE_NEW,
                None,
                &MemoryRevisionSnapshot::of(&new_entry),
                reason.as_deref(),
            )?;
            for entry in &targets {
                let index = conn.execute(
                    "UPDATE memory_entries
                     SET status = ?1, superseded_by = ?2, revision = revision + 1, updated_at = ?3
                     WHERE id = ?4 AND revision = ?5",
                    params![STATUS_ARCHIVED, new_id, now, entry.id, entry.revision],
                )?;
                if index == 0 {
                    return Ok(CURATION_STALE);
                }
                let after = entry_by_id(conn, &entry.id)?
                    .map(|entry| MemoryRevisionSnapshot::of(&entry))
                    .unwrap_or_else(|| MemoryRevisionSnapshot::of(entry));
                record_revision(
                    conn,
                    batch_id,
                    &entry.id,
                    REVISION_MERGE_ARCHIVE,
                    Some(&MemoryRevisionSnapshot::of(entry)),
                    &after,
                    reason.as_deref(),
                )?;
            }
            Ok(CURATION_APPLIED)
        }
        CURATION_OP_REPLACE => {
            if op.target_ids.len() > MAX_REPLACE_TARGETS {
                return Ok(CURATION_REJECTED);
            }
            // The newest target is the successor; the rest are the notes it
            // makes obsolete. A set where one of the others is newer than the
            // successor is a contradiction, not a replacement.
            let successor = targets
                .iter()
                .max_by_key(|entry| (entry.created_at, entry.updated_at))
                .cloned()
                .expect("a non-empty target list");
            if targets
                .iter()
                .any(|entry| entry.id == successor.id && entry.status != STATUS_ACTIVE)
            {
                return Ok(CURATION_STALE);
            }
            let victims: Vec<&MemoryEntryRecord> = targets
                .iter()
                .filter(|entry| entry.id != successor.id)
                .collect();
            if victims.is_empty() {
                return Ok(CURATION_REJECTED);
            }
            if victims
                .iter()
                .any(|entry| !is_mergeable(entry) || user_touched(entry, now))
            {
                return Ok(CURATION_USER_EDITED);
            }
            if rejected_target_set(conn, scope, &targets)? {
                return Ok(CURATION_ALREADY_DONE);
            }
            for entry in &victims {
                let changed = conn.execute(
                    "UPDATE memory_entries
                     SET status = ?1, superseded_by = ?2, revision = revision + 1, updated_at = ?3
                     WHERE id = ?4 AND revision = ?5",
                    params![STATUS_ARCHIVED, successor.id, now, entry.id, entry.revision],
                )?;
                if changed == 0 {
                    return Ok(CURATION_STALE);
                }
                let after = entry_by_id(conn, &entry.id)?
                    .map(|entry| MemoryRevisionSnapshot::of(&entry))
                    .unwrap_or_else(|| MemoryRevisionSnapshot::of(entry));
                record_revision(
                    conn,
                    batch_id,
                    &entry.id,
                    REVISION_REPLACE_ARCHIVE,
                    Some(&MemoryRevisionSnapshot::of(entry)),
                    &after,
                    reason.as_deref(),
                )?;
            }
            Ok(CURATION_APPLIED)
        }
        CURATION_OP_REWORD => {
            if op.target_ids.len() != 1 {
                return Ok(CURATION_REJECTED);
            }
            let target = &targets[0];
            if target.origin != ORIGIN_EXTRACTED {
                return Ok(CURATION_EXPLICIT_REWORD);
            }
            if target.status != STATUS_ACTIVE {
                return Ok(CURATION_STALE);
            }
            if user_authored(target) {
                return Ok(CURATION_EXPLICIT_REWORD);
            }
            if user_touched(target, now) {
                return Ok(CURATION_USER_EDITED);
            }
            let Some(content) = op
                .content
                .as_deref()
                .map(str::trim)
                .filter(|c| !c.is_empty())
            else {
                return Ok(CURATION_REJECTED);
            };
            if content == target.content {
                return Ok(CURATION_REJECTED);
            }
            if content.len() > MAX_CONTENT_BYTES || secrets::looks_like_credential(content) {
                return Ok(REJECT_CREDENTIAL_DETECTED);
            }
            if op
                .reason
                .as_deref()
                .is_some_and(secrets::looks_like_credential)
            {
                return Ok(REJECT_CREDENTIAL_DETECTED);
            }
            let fingerprint = tombstones::fingerprint(&target.kind, content);
            if tombstones::blocks(conn, scope, &fingerprint, &target.source_message_ids)? {
                return Ok(CURATION_TOMBSTONED);
            }
            let collision: Option<String> = conn
                .query_row(
                    "SELECT id FROM memory_entries
                      WHERE scope_kind = ?1 AND IFNULL(scope_key, '') = ?2
                        AND fingerprint = ?3 AND status <> 'archived' AND id <> ?4",
                    params![scope.kind, scope.stored_key(), fingerprint, target.id],
                    |row| row.get(0),
                )
                .optional()?;
            if collision.is_some() {
                return Ok(REJECT_DUPLICATE_CONTENT);
            }
            let changed = conn.execute(
                "UPDATE memory_entries
                 SET content = ?1, fingerprint = ?2, revision = revision + 1, updated_at = ?3
                 WHERE id = ?4 AND revision = ?5",
                params![content, fingerprint, now, target.id, target.revision],
            )?;
            if changed == 0 {
                return Ok(CURATION_STALE);
            }
            let after = entry_by_id(conn, &target.id)?
                .map(|entry| MemoryRevisionSnapshot::of(&entry))
                .unwrap_or_else(|| MemoryRevisionSnapshot::of(target));
            record_revision(
                conn,
                batch_id,
                &target.id,
                REVISION_REWORD,
                Some(&MemoryRevisionSnapshot::of(target)),
                &after,
                reason.as_deref(),
            )?;
            Ok(CURATION_APPLIED)
        }
        // A volatility hint changes no note; it is kept in the answer only, for
        // a later review feature to read (ADR §2).
        CURATION_OP_HINT => Ok(CURATION_APPLIED),
        _ => Ok(CURATION_REJECTED),
    }
}

/// The note a merge produces, with the provenance rule applied: source messages
/// are unioned (bounded), a fact or reference takes the weakest evidence, and
/// the origin is the strongest of the targets, so merging never demotes what
/// the user wrote and never promotes what they did not.
fn merge_note(
    targets: &[MemoryEntryRecord],
    kind: &str,
    content: &str,
    _now: i64,
) -> Result<MemoryEntryRecord> {
    let mut message_ids: Vec<String> = Vec::new();
    for entry in targets {
        for id in &entry.source_message_ids {
            if message_ids.len() >= MAX_SOURCE_MESSAGE_IDS {
                break;
            }
            if !message_ids.iter().any(|known| known == id) {
                message_ids.push(id.clone());
            }
        }
    }
    let origin_rank = |origin: &str| match origin {
        ORIGIN_EXPLICIT => 3,
        ORIGIN_USER_UI => 2,
        _ => 1,
    };
    let evidence_rank = |evidence: &str| match evidence {
        EVIDENCE_VERIFIED => 3,
        EVIDENCE_USER_STATED => 2,
        _ => 1,
    };
    let origin = targets
        .iter()
        .max_by_key(|entry| origin_rank(&entry.origin))
        .map(|entry| entry.origin.clone())
        .unwrap_or_else(|| ORIGIN_EXTRACTED.to_string());
    let evidence = targets
        .iter()
        .min_by_key(|entry| evidence_rank(&entry.evidence))
        .map(|entry| entry.evidence.clone())
        .unwrap_or_else(|| EVIDENCE_INFERRED.to_string());
    let source_session_id = targets
        .iter()
        .find_map(|entry| entry.source_session_id.clone());
    Ok(MemoryEntryRecord {
        id: String::new(),
        scope_kind: targets[0].scope_kind.clone(),
        scope_key: targets[0].scope_key.clone(),
        kind: kind.to_string(),
        content: content.to_string(),
        rationale: targets.iter().find_map(|entry| entry.rationale.clone()),
        status: STATUS_ACTIVE.to_string(),
        origin,
        evidence,
        source_session_id,
        source_message_ids: message_ids,
        fingerprint: tombstones::fingerprint(kind, content),
        revision: 1,
        superseded_by: None,
        created_at: 0,
        updated_at: 0,
        last_used_at: None,
        use_count: 0,
    })
}

/// The write rules a merged note must still satisfy: size, credential
/// detector, and the tombstones that keep a forgotten note forgotten.
fn validate_merged(
    conn: &Connection,
    scope: &MemoryScope,
    merged: &MemoryEntryRecord,
) -> Result<Option<&'static str>> {
    if merged.content.trim().is_empty() {
        return Ok(Some(REJECT_EMPTY_CONTENT));
    }
    if merged.content.len() > MAX_CONTENT_BYTES {
        return Ok(Some(REJECT_CONTENT_TOO_LARGE));
    }
    if secrets::looks_like_credential(&merged.content) {
        return Ok(Some(REJECT_CREDENTIAL_DETECTED));
    }
    if tombstones::blocks(conn, scope, &merged.fingerprint, &merged.source_message_ids)? {
        return Ok(Some(REJECT_TOMBSTONED));
    }
    // A merge produces one active note per fingerprint in a scope.
    let collision: Option<String> = conn
        .query_row(
            "SELECT id FROM memory_entries
              WHERE scope_kind = ?1 AND IFNULL(scope_key, '') = ?2
                AND fingerprint = ?3 AND status <> 'archived'",
            params![scope.kind, scope.stored_key(), merged.fingerprint],
            |row| row.get(0),
        )
        .optional()?;
    if collision.is_some() {
        // The scope already has exactly this note, so there is nothing to merge.
        return Ok(Some(CURATION_ALREADY_DONE));
    }
    Ok(None)
}
