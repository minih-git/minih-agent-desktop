//! Learned-memory storage: CRUD, compare-and-set updates, the session-start
//! index, search, and the scope lifecycle that follows ADR 0249 project groups.

use anyhow::{anyhow, Result};
use rusqlite::{params, Connection, OptionalExtension, Row};
use uuid::Uuid;

use crate::db::{canonical_project_path, now_ms, Database};

use super::model::*;
use super::tombstones;
use super::validation::{self, MemoryWrite, WriteOutcome, WritePath};

const ENTRY_COLUMNS: &str = "id, scope_kind, scope_key, kind, content, rationale, status, origin, \
     evidence, source_session_id, source_message_ids, fingerprint, revision, superseded_by, \
     created_at, updated_at, last_used_at, use_count";

/// A scope slot that matches nothing, used to keep one statement shape for one
/// or two scopes.
const NO_SCOPE: MemoryScope = MemoryScope {
    kind: "",
    key: None,
};

/// The same column list with a table alias, so a query that joins nothing else
/// still reads unambiguously.
fn qualified_columns(alias: &str) -> String {
    ENTRY_COLUMNS
        .split(", ")
        .map(|column| format!("{alias}{column}"))
        .collect::<Vec<_>>()
        .join(", ")
}

fn entry_from_row(row: &Row<'_>) -> rusqlite::Result<MemoryEntryRecord> {
    let raw_ids: String = row.get(10)?;
    Ok(MemoryEntryRecord {
        id: row.get(0)?,
        scope_kind: row.get(1)?,
        scope_key: row.get(2)?,
        kind: row.get(3)?,
        content: row.get(4)?,
        rationale: row.get(5)?,
        status: row.get(6)?,
        origin: row.get(7)?,
        evidence: row.get(8)?,
        source_session_id: row.get(9)?,
        source_message_ids: tombstones::parse_ids(&raw_ids),
        fingerprint: row.get(11)?,
        revision: row.get(12)?,
        superseded_by: row.get(13)?,
        created_at: row.get(14)?,
        updated_at: row.get(15)?,
        last_used_at: row.get(16)?,
        use_count: row.get(17)?,
    })
}

fn entry_by_id(conn: &Connection, id: &str) -> Result<Option<MemoryEntryRecord>> {
    let sql = format!("SELECT {ENTRY_COLUMNS} FROM memory_entries WHERE id = ?1");
    conn.query_row(&sql, params![id], entry_from_row)
        .optional()
        .map_err(Into::into)
}

fn live_entry_by_fingerprint(
    conn: &Connection,
    scope: &MemoryScope,
    fingerprint: &str,
) -> Result<Option<MemoryEntryRecord>> {
    let sql = format!(
        "SELECT {ENTRY_COLUMNS} FROM memory_entries
         WHERE scope_kind = ?1 AND IFNULL(scope_key, '') = ?2
           AND fingerprint = ?3 AND status <> 'archived'"
    );
    conn.query_row(
        &sql,
        params![scope.kind, scope.stored_key(), fingerprint],
        entry_from_row,
    )
    .optional()
    .map_err(Into::into)
}

fn insert_entry(conn: &Connection, entry: &MemoryEntryRecord) -> Result<()> {
    conn.execute(
        "INSERT INTO memory_entries
           (id, scope_kind, scope_key, kind, content, rationale, status, origin, evidence,
            source_session_id, source_message_ids, fingerprint, revision, superseded_by,
            created_at, updated_at, last_used_at, use_count)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)",
        params![
            entry.id,
            entry.scope_kind,
            entry.scope_key,
            entry.kind,
            entry.content,
            entry.rationale,
            entry.status,
            entry.origin,
            entry.evidence,
            entry.source_session_id,
            tombstones::encode_ids(&entry.source_message_ids),
            entry.fingerprint,
            entry.revision,
            entry.superseded_by,
            entry.created_at,
            entry.updated_at,
            entry.last_used_at,
            entry.use_count
        ],
    )?;
    Ok(())
}

/// Two scope slots for one statement: the session's project scope (or none) and
/// the user scope.
fn scope_slots(scopes: &[MemoryScope]) -> (MemoryScope, MemoryScope) {
    let mut project = NO_SCOPE;
    let mut user = NO_SCOPE;
    for scope in scopes {
        if scope.kind == SCOPE_USER {
            user = MemoryScope::user();
        } else {
            project = scope.clone();
        }
    }
    (project, user)
}

#[derive(Debug, Clone)]
pub(crate) struct CreateMemoryRequest {
    pub scope: MemoryScope,
    pub kind: String,
    pub content: String,
    pub rationale: Option<String>,
    pub origin: String,
    pub evidence: String,
    pub status: String,
    pub source_session_id: Option<String>,
    pub source_message_ids: Vec<String>,
    pub override_tombstone: bool,
}

pub(crate) enum CreateMemoryOutcome {
    Created(Box<MemoryEntryRecord>),
    /// The scope already remembers this content; the existing entry is returned
    /// instead of a copy.
    Duplicate(Box<MemoryEntryRecord>),
    Rejected(MemoryRejection),
}

#[derive(Debug, Clone)]
pub(crate) struct UpdateMemoryRequest {
    pub id: String,
    pub revision: i64,
    pub content: Option<String>,
    pub rationale: Option<String>,
    pub kind: Option<String>,
    pub scope: Option<MemoryScope>,
}

pub(crate) enum UpdateMemoryOutcome {
    Updated(Box<MemoryEntryRecord>),
    NotFound,
    /// Another writer moved the entry; the stored row is unchanged.
    RevisionConflict,
    Rejected(MemoryRejection),
}

pub(crate) enum StatusMemoryOutcome {
    Updated(Box<MemoryEntryRecord>),
    NotFound,
    /// Unhiding would create a second live entry with the same content.
    Duplicate,
}

pub(crate) struct SearchMemoryRequest<'a> {
    pub scopes: &'a [MemoryScope],
    pub query: &'a str,
    pub kinds: &'a [String],
    pub limit: i64,
    pub record_use: bool,
}

impl Database {
    /// The learned-memory scope of a project path: the id of the stored project
    /// group that owns it, or the canonical path itself (ADR 0249). Every
    /// worktree of a project shares the main project's identity (ADR 0329).
    pub fn learned_memory_scope_for_path(&self, path: &str) -> Result<MemoryScope> {
        let canonical = canonical_project_path(path)
            .ok_or_else(|| anyhow!("project path must not be blank"))?;
        match self.stored_project_group_for_path(&canonical)? {
            Some(group) => Ok(MemoryScope::project(group.id)),
            None => Ok(MemoryScope::project(canonical)),
        }
    }

    /// The scopes a session reads: its project scope when it has one, then the
    /// user scope. `None` means the session does not exist.
    pub fn learned_memory_scopes_for_session(
        &self,
        session_id: &str,
    ) -> Result<Option<Vec<MemoryScope>>> {
        let project_path: Option<Option<String>> = self
            .conn()
            .query_row(
                "SELECT (SELECT p.path FROM projects p WHERE p.id = s.project_id)
                 FROM sessions s WHERE s.id = ?1",
                params![session_id],
                |row| row.get(0),
            )
            .optional()?;
        let Some(project_path) = project_path else {
            return Ok(None);
        };
        let mut scopes = Vec::with_capacity(2);
        if let Some(path) = project_path {
            scopes.push(self.learned_memory_scope_for_path(&path)?);
        }
        scopes.push(MemoryScope::user());
        Ok(Some(scopes))
    }

    /// Entries of one scope, newest first. `status` and `kind` are optional
    /// filters, so one statement serves the manager's list, its filters, and the
    /// suggestion inbox.
    pub fn list_memory_entries(
        &self,
        scope: &MemoryScope,
        status: Option<&str>,
        kind: Option<&str>,
        limit: i64,
        offset: i64,
    ) -> Result<Vec<MemoryEntryRecord>> {
        let sql = format!(
            "SELECT {ENTRY_COLUMNS} FROM memory_entries
             WHERE scope_kind = ?1 AND IFNULL(scope_key, '') = ?2
               AND (?3 IS NULL OR status = ?3)
               AND (?4 IS NULL OR kind = ?4)
             ORDER BY updated_at DESC, id ASC
             LIMIT ?5 OFFSET ?6"
        );
        let mut statement = self.conn().prepare_cached(&sql)?;
        let rows = statement.query_map(
            params![
                scope.kind,
                scope.stored_key(),
                status,
                kind,
                limit.clamp(1, MAX_LIST_LIMIT),
                offset.max(0)
            ],
            entry_from_row,
        )?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn create_memory_entry(&self, request: CreateMemoryRequest) -> Result<CreateMemoryOutcome> {
        tombstones::require_scope_key(&request.scope)?;
        if !matches!(request.status.as_str(), STATUS_ACTIVE | STATUS_SUGGESTED) {
            return Ok(CreateMemoryOutcome::Rejected(MemoryRejection::new(
                REJECT_INVALID_FIELD,
                "status is not a supported value",
            )));
        }
        let tx = self.conn().unchecked_transaction()?;
        let write = MemoryWrite {
            scope: request.scope.clone(),
            kind: request.kind.clone(),
            content: request.content.clone(),
            rationale: request.rationale.clone(),
            origin: request.origin.clone(),
            evidence: request.evidence.clone(),
            source_session_id: request.source_session_id.clone(),
            source_message_ids: request.source_message_ids.clone(),
            override_tombstone: request.override_tombstone,
        };
        if let WriteOutcome::Rejected(rejection) =
            validation::validate(&tx, &write, WritePath::Create)?
        {
            return Ok(CreateMemoryOutcome::Rejected(rejection));
        }
        let fingerprint = tombstones::fingerprint(&request.kind, &request.content);
        if let Some(existing) = live_entry_by_fingerprint(&tx, &request.scope, &fingerprint)? {
            return Ok(CreateMemoryOutcome::Duplicate(Box::new(existing)));
        }
        // Only an explicit user request to remember the same content again
        // clears a tombstone (ADR §6).
        if request.origin == ORIGIN_EXPLICIT && request.override_tombstone {
            tombstones::clear(&tx, &request.scope, &fingerprint)?;
        }
        let now = now_ms();
        let entry = MemoryEntryRecord {
            id: Uuid::new_v4().to_string(),
            scope_kind: request.scope.kind.to_string(),
            scope_key: request.scope.key.clone(),
            kind: request.kind,
            content: request.content,
            rationale: request.rationale,
            status: request.status,
            origin: request.origin,
            evidence: request.evidence,
            source_session_id: request.source_session_id,
            source_message_ids: request.source_message_ids,
            fingerprint,
            revision: 1,
            superseded_by: None,
            created_at: now,
            updated_at: now,
            last_used_at: None,
            use_count: 0,
        };
        insert_entry(&tx, &entry)?;
        tx.commit()?;
        Ok(CreateMemoryOutcome::Created(Box::new(entry)))
    }

    /// Edit an entry. The update is compare-and-set on `revision`, so a
    /// background writer can never overwrite a user edit.
    pub fn update_memory_entry(&self, request: UpdateMemoryRequest) -> Result<UpdateMemoryOutcome> {
        let tx = self.conn().unchecked_transaction()?;
        let Some(current) = entry_by_id(&tx, &request.id)? else {
            return Ok(UpdateMemoryOutcome::NotFound);
        };
        if current.revision != request.revision {
            return Ok(UpdateMemoryOutcome::RevisionConflict);
        }
        let scope = request.scope.unwrap_or_else(|| current.scope());
        tombstones::require_scope_key(&scope)?;
        let kind = request.kind.unwrap_or_else(|| current.kind.clone());
        let content = request.content.unwrap_or_else(|| current.content.clone());
        let rationale = request.rationale.or_else(|| current.rationale.clone());
        let write = MemoryWrite {
            scope: scope.clone(),
            kind: kind.clone(),
            content: content.clone(),
            rationale: rationale.clone(),
            origin: current.origin.clone(),
            evidence: current.evidence.clone(),
            source_session_id: current.source_session_id.clone(),
            source_message_ids: current.source_message_ids.clone(),
            override_tombstone: false,
        };
        if let WriteOutcome::Rejected(rejection) =
            validation::validate(&tx, &write, WritePath::Update)?
        {
            return Ok(UpdateMemoryOutcome::Rejected(rejection));
        }
        let fingerprint = tombstones::fingerprint(&kind, &content);
        let collision = live_entry_by_fingerprint(&tx, &scope, &fingerprint)?;
        if collision.is_some_and(|entry| entry.id != current.id) {
            return Ok(UpdateMemoryOutcome::Rejected(MemoryRejection::new(
                REJECT_DUPLICATE_CONTENT,
                "another memory in this scope already holds this content",
            )));
        }
        let now = now_ms();
        let changed = tx.execute(
            "UPDATE memory_entries
             SET content = ?1, rationale = ?2, kind = ?3, scope_kind = ?4, scope_key = ?5,
                 fingerprint = ?6, revision = revision + 1, updated_at = ?7
             WHERE id = ?8 AND revision = ?9",
            params![
                content,
                rationale,
                kind,
                scope.kind,
                scope.key,
                fingerprint,
                now,
                current.id,
                request.revision
            ],
        )?;
        if changed == 0 {
            return Ok(UpdateMemoryOutcome::RevisionConflict);
        }
        let updated = entry_by_id(&tx, &current.id)?;
        tx.commit()?;
        Ok(match updated {
            Some(entry) => UpdateMemoryOutcome::Updated(Box::new(entry)),
            None => UpdateMemoryOutcome::NotFound,
        })
    }

    /// Hide or unhide an entry. Neither direction writes a tombstone: the
    /// entry still exists, so nothing can be re-learned from its evidence.
    pub fn set_memory_entry_status(&self, id: &str, status: &str) -> Result<StatusMemoryOutcome> {
        if !matches!(status, STATUS_ACTIVE | STATUS_ARCHIVED) {
            return Err(anyhow!("unsupported memory status"));
        }
        let tx = self.conn().unchecked_transaction()?;
        let Some(current) = entry_by_id(&tx, id)? else {
            return Ok(StatusMemoryOutcome::NotFound);
        };
        if status == STATUS_ACTIVE {
            let collision = live_entry_by_fingerprint(&tx, &current.scope(), &current.fingerprint)?;
            if collision.is_some_and(|entry| entry.id != current.id) {
                return Ok(StatusMemoryOutcome::Duplicate);
            }
        }
        tx.execute(
            "UPDATE memory_entries SET status = ?1, revision = revision + 1, updated_at = ?2
             WHERE id = ?3",
            params![status, now_ms(), id],
        )?;
        let updated = entry_by_id(&tx, id)?;
        tx.commit()?;
        Ok(match updated {
            Some(entry) => StatusMemoryOutcome::Updated(Box::new(entry)),
            None => StatusMemoryOutcome::NotFound,
        })
    }

    /// Forget an entry: archive it and record a tombstone that blocks the same
    /// fingerprint and the same source messages from ever coming back.
    /// Idempotent, so a repeated delete is harmless.
    pub fn delete_memory_entry(&self, id: &str) -> Result<bool> {
        let tx = self.conn().unchecked_transaction()?;
        let Some(entry) = entry_by_id(&tx, id)? else {
            return Ok(false);
        };
        let now = now_ms();
        tx.execute(
            "UPDATE memory_entries SET status = ?1, revision = revision + 1, updated_at = ?2
             WHERE id = ?3",
            params![STATUS_ARCHIVED, now, id],
        )?;
        tombstones::write(
            &tx,
            &entry.scope(),
            &entry.fingerprint,
            entry.source_session_id.as_deref(),
            &entry.source_message_ids,
            now,
        )?;
        tx.commit()?;
        Ok(true)
    }

    /// Accept a suggestion, or reject it and remember the refusal so the same
    /// evidence never proposes it again.
    pub fn decide_memory_suggestion(
        &self,
        id: &str,
        accept: bool,
    ) -> Result<Option<MemoryEntryRecord>> {
        let tx = self.conn().unchecked_transaction()?;
        let Some(entry) = entry_by_id(&tx, id)? else {
            return Ok(None);
        };
        if entry.status != STATUS_SUGGESTED {
            return Ok(None);
        }
        let now = now_ms();
        if accept {
            tx.execute(
                "UPDATE memory_entries SET status = ?1, revision = revision + 1, updated_at = ?2
                 WHERE id = ?3 AND status = ?4",
                params![STATUS_ACTIVE, now, id, STATUS_SUGGESTED],
            )?;
        } else {
            tx.execute(
                "UPDATE memory_entries SET status = ?1, revision = revision + 1, updated_at = ?2
                 WHERE id = ?3 AND status = ?4",
                params![STATUS_ARCHIVED, now, id, STATUS_SUGGESTED],
            )?;
            tombstones::write(
                &tx,
                &entry.scope(),
                &entry.fingerprint,
                entry.source_session_id.as_deref(),
                &entry.source_message_ids,
                now,
            )?;
        }
        let updated = entry_by_id(&tx, id)?;
        tx.commit()?;
        Ok(updated)
    }

    /// The session-start index: active entries of the project scope and the user
    /// scope, explicit ones first, then by recency of use, inside a fixed budget.
    /// Ordering is total, so two launches of the same data return the same lines.
    pub fn learned_memory_index(&self, path: &str) -> Result<MemoryIndex> {
        let project = self.learned_memory_scope_for_path(path)?;
        let (project_slot, user_slot) = scope_slots(&[project, MemoryScope::user()]);
        let sql = format!(
            "SELECT {ENTRY_COLUMNS} FROM memory_entries
             WHERE status = ?1
               AND ((scope_kind = ?2 AND IFNULL(scope_key, '') = ?3)
                 OR (scope_kind = ?4 AND IFNULL(scope_key, '') = ?5))
             ORDER BY CASE WHEN origin = ?6 THEN 0 ELSE 1 END,
                      last_used_at DESC, updated_at DESC, id ASC"
        );
        let mut statement = self.conn().prepare_cached(&sql)?;
        let rows = statement.query_map(
            params![
                STATUS_ACTIVE,
                project_slot.kind,
                project_slot.stored_key(),
                user_slot.kind,
                user_slot.stored_key(),
                ORIGIN_EXPLICIT
            ],
            entry_from_row,
        )?;
        let mut entries = Vec::new();
        let mut bytes = 0usize;
        let mut omitted = 0i64;
        for row in rows {
            let entry = row?;
            let cost = entry.index_bytes();
            if entries.len() >= INDEX_MAX_LINES || bytes + cost > INDEX_MAX_BYTES {
                omitted += 1;
                continue;
            }
            bytes += cost;
            entries.push(MemoryIndexEntry::from(&entry));
        }
        Ok(MemoryIndex {
            entries,
            omitted_count: omitted,
            bytes,
        })
    }

    /// Search active entries of the given scopes. Hits refresh `last_used_at`
    /// and `use_count`; the session-start index alone does not.
    pub fn search_memory_entries(
        &self,
        request: SearchMemoryRequest<'_>,
    ) -> Result<Vec<MemoryEntryRecord>> {
        let query = request.query.trim();
        if query.is_empty() {
            return Ok(Vec::new());
        }
        crate::session_search::register_contains(self)?;
        let (project_slot, user_slot) = scope_slots(request.scopes);
        let kinds = if request.kinds.is_empty() {
            None
        } else {
            Some(tombstones::encode_ids(request.kinds))
        };
        // Trigram FTS is a prefilter for ASCII and uncased text such as CJK, the
        // same rule the session search uses; the literal scan stays the
        // authority so no case mapping is lost.
        let fts = if query.chars().count() >= 3
            && !query.contains('\u{0307}')
            && query
                .chars()
                .all(|ch| ch.is_ascii() || (!ch.is_lowercase() && !ch.is_uppercase()))
        {
            "AND m.rowid IN (SELECT rowid FROM memory_entries_fts WHERE memory_entries_fts MATCH ?7)"
        } else {
            // The bound value is never NULL, so this arm filters nothing.
            "AND ?7 IS NOT NULL"
        };
        let sql = format!(
            "SELECT {} FROM memory_entries m
             WHERE m.status = ?1
               AND ((m.scope_kind = ?2 AND IFNULL(m.scope_key, '') = ?3)
                 OR (m.scope_kind = ?4 AND IFNULL(m.scope_key, '') = ?5))
               AND (?6 IS NULL OR m.kind IN (SELECT value FROM json_each(?6)))
               AND (pi_search_contains(m.content, ?8)
                    OR pi_search_contains(COALESCE(m.rationale, ''), ?8)) {fts}
             ORDER BY m.updated_at DESC, m.id ASC
             LIMIT ?9",
            qualified_columns("m.")
        );
        let quoted = format!("\"{}\"", query.replace('"', "\"\""));
        let limit = request.limit.clamp(1, MAX_SEARCH_LIMIT);
        let mut statement = self.conn().prepare_cached(&sql)?;
        let rows = statement.query_map(
            params![
                STATUS_ACTIVE,
                project_slot.kind,
                project_slot.stored_key(),
                user_slot.kind,
                user_slot.stored_key(),
                kinds,
                quoted,
                query,
                limit
            ],
            entry_from_row,
        )?;
        let mut entries = rows.collect::<rusqlite::Result<Vec<_>>>()?;
        if request.record_use && !entries.is_empty() {
            let now = now_ms();
            for entry in &mut entries {
                self.conn().execute(
                    "UPDATE memory_entries
                     SET last_used_at = ?1, use_count = use_count + 1
                     WHERE id = ?2",
                    params![now, entry.id],
                )?;
                entry.last_used_at = Some(now);
                entry.use_count += 1;
            }
        }
        Ok(entries)
    }

    /// Delete every learned entry, tombstone, and session state row of one
    /// scope. Group-scoped rows survive a member project's removal because their
    /// key is the group id.
    pub fn delete_learned_memory_scope(&self, scope: &MemoryScope) -> Result<()> {
        let tx = self.conn().unchecked_transaction()?;
        delete_learned_scope_tx(&tx, scope)?;
        tx.commit()?;
        Ok(())
    }

    /// Project removal: drop the learned memory keyed by this project's own
    /// path. A stored group's memory is keyed by the group id and stays with the
    /// group.
    pub fn delete_project_learned_memory(&self, path: &str) -> Result<()> {
        let canonical = canonical_project_path(path)
            .ok_or_else(|| anyhow!("project path must not be blank"))?;
        self.delete_learned_memory_scope(&MemoryScope::project(canonical))
    }
}

/// Delete every learned row of one scope inside the caller's transaction, so a
/// group record and the learned memory it owned disappear together.
pub(crate) fn delete_learned_scope_tx(conn: &Connection, scope: &MemoryScope) -> Result<()> {
    for table in [
        "memory_entries",
        "memory_tombstones",
        "memory_session_state",
    ] {
        conn.execute(
            &format!("DELETE FROM {table} WHERE scope_kind = ?1 AND IFNULL(scope_key, '') = ?2"),
            params![scope.kind, scope.stored_key()],
        )?;
    }
    Ok(())
}

/// Move path-scoped learned memory onto the group that now owns those roots,
/// deduplicating by fingerprint. Runs inside the caller's transaction so a group
/// never exists without the memory that belonged to its roots (ADR §2).
pub(crate) fn rekey_learned_memory_to_group(
    conn: &Connection,
    paths: &[String],
    group_id: &str,
) -> Result<()> {
    for path in paths {
        conn.execute(
            "UPDATE memory_entries SET scope_key = ?1
             WHERE scope_kind = 'project' AND scope_key = ?2
               AND NOT EXISTS (
                 SELECT 1 FROM memory_entries other
                 WHERE other.scope_kind = 'project'
                   AND IFNULL(other.scope_key, '') = ?1
                   AND other.fingerprint = memory_entries.fingerprint
                   AND other.status <> 'archived'
               )",
            params![group_id, path],
        )?;
        conn.execute(
            "DELETE FROM memory_entries WHERE scope_kind = 'project' AND scope_key = ?1",
            params![path],
        )?;
        conn.execute(
            "UPDATE memory_tombstones SET scope_key = ?1
             WHERE scope_kind = 'project' AND scope_key = ?2
               AND NOT EXISTS (
                 SELECT 1 FROM memory_tombstones other
                 WHERE other.scope_kind = 'project'
                   AND IFNULL(other.scope_key, '') = ?1
                   AND other.fingerprint = memory_tombstones.fingerprint
               )",
            params![group_id, path],
        )?;
        conn.execute(
            "DELETE FROM memory_tombstones WHERE scope_kind = 'project' AND scope_key = ?1",
            params![path],
        )?;
        conn.execute(
            "UPDATE memory_session_state SET scope_key = ?1
             WHERE scope_kind = 'project' AND scope_key = ?2",
            params![group_id, path],
        )?;
    }
    Ok(())
}
