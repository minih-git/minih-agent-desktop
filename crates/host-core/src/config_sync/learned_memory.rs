//! Learned memory in configuration sync (ADR agent-long-term-memory §7).
//!
//! **Compatibility finding, verified in this branch.** The plan gives learned
//! memory its own domain so that a released build ignores it. The *apply* path
//! would indeed ignore a domain it has no adapter for (`ready_entity` ->
//! `is_selected` -> `ALL_DOMAINS`), but the *decode* path refuses it first:
//! `validate_remote_manifest` bails with `CONFIG_SYNC_UNSUPPORTED: remote domain
//! learnedMemory is not supported`, and v0.21.2 does the same
//! (`engine_remote.rs`, the `adapter_for` gate in `read_remote_manifest`). A
//! released device therefore cannot read a revision that carries this domain at
//! all: its head read fails, and with it every later sync and restore, for as
//! long as that revision carries the domain. The behaviour is pinned by
//! `a_revision_carrying_an_unknown_domain_is_refused_not_skipped`.
//!
//! This module is therefore complete and tested but **not shipped as it
//! stands**: the compatibility question needs a decision. Extending the pinned
//! `memory` domain is not the alternative — a released build treats every entity
//! there as pinned project memory, so it would erase pinned notes on a deletion,
//! create groups, and fail a user-scope entity with
//! `CONFIG_SYNC_MAPPING_REQUIRED`.
//!
//! What is implemented here: capture and apply of `active` and `archived`
//! entries of both scopes plus their tombstones, the existing project-identity
//! mapping (deferred as `CONFIG_SYNC_MAPPING_REQUIRED` when a folder is not
//! mapped), the delete / remember-again / fingerprint-merge consistency rules,
//! and the trust boundary every synced entry passes.
//!
//! What travels: `active` and `archived` entries of both scopes, and the
//! tombstones that make a delete stick. What stays on the device that produced
//! it: suggestions, the extraction cursor and session state, the budget ledger,
//! and the usage counters (`last_used_at` / `use_count`) — a merged `use_count`
//! would turn every lookup into a sync edit, so counters are excluded from the
//! payload and two devices that only read their notes never diverge.
//!
//! Provenance is **not** re-checked against local messages on apply: the cited
//! messages belong to the device that wrote the note. The shape that made them
//! trustworthy at the source is still required, and the trust boundary still
//! runs the structural, enum, bound, and credential checks on every entry.

use anyhow::{anyhow, Result};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

use super::domains::{
    entity, project_scope, PortableEntity, ProjectIdentityOverrides, DOMAIN_LEARNED_MEMORY,
};
use super::engine::{mapped_project_paths, StoredConfig};
use crate::db::{now_ms, Database};
use crate::memory::repository::entry_from_row_for_sync;
use crate::memory::{
    is_known, MemoryEntryRecord, MemoryScope, MemoryTombstoneRecord, EVIDENCES, KINDS, ORIGINS,
    SCOPE_PROJECT, SCOPE_USER, STATUSES, STATUS_SUGGESTED,
};
use crate::memory::{secrets, tombstones};
use crate::state::AppState;

/// Most entries one scope contributes to a revision. A revision carrying an
/// unbounded number of notes would make every sync a full-database upload.
pub(crate) const MAX_SYNCED_ENTRIES_PER_SCOPE: i64 = 500;
/// Longest content a synced entry may carry, matching the host's write limit.
const MAX_CONTENT_BYTES: usize = 1024;
const MAX_RATIONALE_BYTES: usize = 512;
/// Longest source-message citation list, matching the host's write limit.
const MAX_SOURCE_MESSAGE_IDS: usize = 16;

/// One entry as it travels. `id` is deliberately absent: it is local to the
/// device that created it, so identity is the fingerprint within a scope.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncedEntry {
    kind: String,
    content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    rationale: Option<String>,
    status: String,
    origin: String,
    evidence: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    source_session_id: Option<String>,
    #[serde(default)]
    source_message_ids: Vec<String>,
    fingerprint: String,
    created_at: i64,
    updated_at: i64,
}

/// A tombstone travels as identity only: the fingerprint blocks the same
/// memory and the cited messages block the same evidence. It has no content.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncedTombstone {
    fingerprint: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    source_session_id: Option<String>,
    #[serde(default)]
    source_message_ids: Vec<String>,
    created_at: i64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncedScope {
    #[serde(default)]
    entries: Vec<SyncedEntry>,
    #[serde(default)]
    tombstones: Vec<SyncedTombstone>,
}

impl SyncedScope {
    fn is_empty(&self) -> bool {
        self.entries.is_empty() && self.tombstones.is_empty()
    }
}

/// Capture every scope that has something worth syncing.
///
/// A scope with neither a live entry nor a tombstone contributes nothing, so a
/// user who never used learned memory adds no entities to a revision.
pub(crate) fn capture_learned_memory(
    st: &mut AppState,
    identities: &ProjectIdentityOverrides,
) -> Result<Vec<PortableEntity>> {
    let mut result = Vec::new();
    // The user scope needs no mapping at all, so it is the one scope that always
    // arrives intact on a device whose folders are different.
    let user = capture_scope(st, &MemoryScope::user())?;
    if !user.is_empty() {
        result.push(entity(
            DOMAIN_LEARNED_MEMORY,
            "learned-memory:user",
            "Learned memory · You",
            json!({ "scopeKind": SCOPE_USER, "scope": user }),
            false,
            true,
            false,
            Vec::new(),
        ));
    }

    // One entity per project identity: the project group for a group member, the
    // project path otherwise — the same identity pinned memory uses.
    let mut seen: Vec<String> = Vec::new();
    for project in st.db.list_projects()? {
        let (project_id, group_id, root_position) = project_scope(st, &project.path, identities)?;
        let logical_id = group_id.clone().unwrap_or_else(|| project_id.clone());
        if seen.contains(&logical_id) {
            continue;
        }
        let scope = st.db.learned_memory_scope_for_path(&project.path)?;
        let synced = capture_scope(st, &scope)?;
        if synced.is_empty() {
            continue;
        }
        seen.push(logical_id.clone());
        let mut payload = json!({
            "scopeKind": SCOPE_PROJECT,
            "projectLogicalId": project_id,
            "projectName": project.name,
            "scope": synced,
        });
        if let Some(object) = payload.as_object_mut() {
            if let Some(group_id) = group_id {
                object.insert("projectGroupLogicalId".into(), Value::String(group_id));
            }
            if let Some(position) = root_position {
                object.insert("projectRootPosition".into(), json!(position));
            }
        }
        result.push(entity(
            DOMAIN_LEARNED_MEMORY,
            format!("learned-memory:{logical_id}"),
            project.name,
            payload,
            false,
            // A note is content the user wrote or accepted, so the entity is
            // secret-bearing in the same sense pinned memory is: the sync UI
            // says so before anything travels.
            true,
            true,
            Vec::new(),
        ));
    }
    Ok(result)
}

fn capture_scope(st: &AppState, scope: &MemoryScope) -> Result<SyncedScope> {
    let entries = st
        .db
        .list_syncable_memory_entries(scope, MAX_SYNCED_ENTRIES_PER_SCOPE)?
        .into_iter()
        .map(|entry| SyncedEntry {
            kind: entry.kind,
            content: entry.content,
            rationale: entry.rationale,
            status: entry.status,
            origin: entry.origin,
            evidence: entry.evidence,
            source_session_id: entry.source_session_id,
            source_message_ids: entry.source_message_ids,
            fingerprint: entry.fingerprint,
            created_at: entry.created_at,
            updated_at: entry.updated_at,
        })
        .collect();
    let tombstones = st
        .db
        .list_memory_tombstones(scope)?
        .into_iter()
        .map(|tombstone| SyncedTombstone {
            fingerprint: tombstone.fingerprint,
            source_session_id: tombstone.source_session_id,
            source_message_ids: tombstone.source_message_ids,
            created_at: tombstone.created_at,
        })
        .collect();
    Ok(SyncedScope {
        entries,
        tombstones,
    })
}

/// Apply one learned-memory entity.
///
/// A payload whose folder is not mapped is refused with
/// `CONFIG_SYNC_MAPPING_REQUIRED`, which the sync engine turns into a pending
/// item for that entity alone — one unmapped folder must never fail the whole
/// revision.
pub(crate) fn apply_learned_memory(
    st: &mut AppState,
    config: &mut StoredConfig,
    entity: &PortableEntity,
) -> Result<()> {
    let scope_kind = entity
        .payload
        .get("scopeKind")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let scope = match scope_kind {
        SCOPE_USER => MemoryScope::user(),
        SCOPE_PROJECT => {
            let Some(paths) = mapped_project_paths(config, &entity.payload)? else {
                return Err(anyhow!(
                    "CONFIG_SYNC_MAPPING_REQUIRED: learned memory needs a local folder"
                ));
            };
            // The folder's own identity decides the scope, exactly as it does for
            // a note written here: a folder that belongs to a stored group keeps
            // the group's memory, and one that does not keeps its own path.
            st.db.learned_memory_scope_for_path(&paths[0])?
        }
        _ => return Ok(()),
    };
    if entity.deleted {
        return st.db.delete_synced_memory_scope(&scope);
    }
    let Some(payload) = entity.payload.get("scope") else {
        return Ok(());
    };
    apply_scope(st, &scope, payload)
}

fn apply_scope(st: &AppState, scope: &MemoryScope, payload: &Value) -> Result<()> {
    let entries = parse_entries(payload);
    let tombstones = parse_tombstones(payload);
    for tombstone in &tombstones {
        // A tombstone that is older than the note this device already holds is
        // stale: the other device deleted, then the user pressed "remember
        // again", and that newer note travels as an entry below.
        if st
            .db
            .live_memory_entry_by_fingerprint(scope, &tombstone.fingerprint)?
            .is_some_and(|entry| entry.updated_at > tombstone.created_at)
        {
            continue;
        }
        // A delete propagates by erasing what it names and by blocking the same
        // memory and the same evidence from coming back.
        st.db
            .delete_synced_memory_entry(scope, &tombstone.fingerprint)?;
        tombstones::write(
            st.db.conn(),
            scope,
            &tombstone.fingerprint,
            tombstone.source_session_id.as_deref(),
            &tombstone.source_message_ids,
            tombstone.created_at.max(0),
        )?;
    }
    for entry in &entries {
        let local_tombstone = st
            .db
            .memory_tombstone(scope, &entry.fingerprint)?
            .map(|tombstone| tombstone.created_at);
        if let Some(created_at) = local_tombstone {
            // The note is newer than the delete this device holds: the user
            // brought it back on the other device, so the delete no longer
            // stands here either.
            if entry.created_at > created_at {
                tombstones::clear(st.db.conn(), scope, &entry.fingerprint)?;
            } else {
                continue;
            }
        } else if tombstones::blocks(
            st.db.conn(),
            scope,
            &entry.fingerprint,
            &entry.source_message_ids,
        )? {
            // Blocked through a cited message rather than the fingerprint: the
            // same evidence was forgotten here, and that verdict stands.
            continue;
        }
        st.db.upsert_synced_memory_entry(scope, entry)?;
    }
    Ok(())
}

fn parse_entries(payload: &Value) -> Vec<SyncedEntry> {
    payload
        .get("entries")
        .and_then(Value::as_array)
        .map(|raw| {
            raw.iter()
                .filter_map(|item| serde_json::from_value::<SyncedEntry>(item.clone()).ok())
                .filter(is_usable)
                .collect()
        })
        .unwrap_or_default()
}

fn parse_tombstones(payload: &Value) -> Vec<SyncedTombstone> {
    payload
        .get("tombstones")
        .and_then(Value::as_array)
        .map(|raw| {
            raw.iter()
                .filter_map(|item| serde_json::from_value::<SyncedTombstone>(item.clone()).ok())
                .filter(|tombstone| !tombstone.fingerprint.trim().is_empty())
                .collect()
        })
        .unwrap_or_default()
}

/// The trust boundary for one synced entry: structure, enums, bounds, and the
/// credential detector. A field this build cannot read drops that entry alone;
/// the rest of the scope still applies.
fn is_usable(entry: &SyncedEntry) -> bool {
    if !is_known(&entry.kind, &KINDS) || !is_known(&entry.status, &STATUSES) {
        return false;
    }
    if !is_known(&entry.origin, &ORIGINS) || !is_known(&entry.evidence, &EVIDENCES) {
        return false;
    }
    // Only what the user can act on travels; a suggestion is device-local.
    if entry.status == STATUS_SUGGESTED {
        return false;
    }
    if entry.content.trim().is_empty()
        || entry.content.len() > MAX_CONTENT_BYTES
        || entry.fingerprint.trim().is_empty()
    {
        return false;
    }
    if entry
        .rationale
        .as_deref()
        .is_some_and(|rationale| rationale.len() > MAX_RATIONALE_BYTES)
    {
        return false;
    }
    if entry.source_message_ids.len() > MAX_SOURCE_MESSAGE_IDS {
        return false;
    }
    // A credential that reached one device's database must not be written on
    // another, and the refused text reaches no log.
    if secrets::looks_like_credential(&entry.content)
        || entry
            .rationale
            .as_deref()
            .is_some_and(secrets::looks_like_credential)
    {
        return false;
    }
    true
}

impl Database {
    /// Notes of one scope that travel, newest first, without device-local
    /// counters.
    pub(crate) fn list_syncable_memory_entries(
        &self,
        scope: &MemoryScope,
        limit: i64,
    ) -> Result<Vec<MemoryEntryRecord>> {
        let mut statement = self.conn().prepare_cached(
            "SELECT id, scope_kind, scope_key, kind, content, rationale, status, origin,
                    evidence, source_session_id, source_message_ids, fingerprint, revision,
                    superseded_by, created_at, updated_at, last_used_at, use_count
               FROM memory_entries
              WHERE scope_kind = ?1 AND IFNULL(scope_key, '') = ?2
                AND status IN ('active', 'archived')
              ORDER BY created_at DESC, id ASC
              LIMIT ?3",
        )?;
        let rows = statement
            .query_map(
                params![scope.kind, scope.stored_key(), limit.max(1)],
                entry_from_row_for_sync,
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// Tombstones of one scope, oldest first.
    pub(crate) fn list_memory_tombstones(
        &self,
        scope: &MemoryScope,
    ) -> Result<Vec<MemoryTombstoneRecord>> {
        let mut statement = self.conn().prepare_cached(
            "SELECT fingerprint, source_session_id, source_message_ids, created_at
               FROM memory_tombstones
              WHERE scope_kind = ?1 AND IFNULL(scope_key, '') = ?2
              ORDER BY created_at ASC, fingerprint ASC",
        )?;
        let rows = statement
            .query_map(params![scope.kind, scope.stored_key()], |row| {
                let raw: String = row.get(2)?;
                Ok(MemoryTombstoneRecord {
                    fingerprint: row.get(0)?,
                    source_session_id: row.get(1)?,
                    source_message_ids: tombstones::parse_ids(&raw),
                    created_at: row.get(3)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub(crate) fn memory_tombstone(
        &self,
        scope: &MemoryScope,
        fingerprint: &str,
    ) -> Result<Option<MemoryTombstoneRecord>> {
        let row = self
            .conn()
            .query_row(
                "SELECT fingerprint, source_session_id, source_message_ids, created_at
                   FROM memory_tombstones
                  WHERE scope_kind = ?1 AND IFNULL(scope_key, '') = ?2 AND fingerprint = ?3",
                params![scope.kind, scope.stored_key(), fingerprint],
                |row| {
                    let raw: String = row.get(2)?;
                    Ok(MemoryTombstoneRecord {
                        fingerprint: row.get(0)?,
                        source_session_id: row.get(1)?,
                        source_message_ids: tombstones::parse_ids(&raw),
                        created_at: row.get(3)?,
                    })
                },
            )
            .optional()?;
        Ok(row)
    }

    /// The live entry a fingerprint already holds in this scope, if any. The
    /// uniqueness index allows exactly one, so this is also the merge key for two
    /// devices that wrote the same sentence.
    pub(crate) fn live_memory_entry_by_fingerprint(
        &self,
        scope: &MemoryScope,
        fingerprint: &str,
    ) -> Result<Option<MemoryEntryRecord>> {
        let mut statement = self.conn().prepare_cached(
            "SELECT id, scope_kind, scope_key, kind, content, rationale, status, origin,
                    evidence, source_session_id, source_message_ids, fingerprint, revision,
                    superseded_by, created_at, updated_at, last_used_at, use_count
               FROM memory_entries
              WHERE scope_kind = ?1 AND IFNULL(scope_key, '') = ?2 AND fingerprint = ?3
                AND status IN ('active', 'archived')",
        )?;
        let row = statement
            .query_row(
                params![scope.kind, scope.stored_key(), fingerprint],
                entry_from_row_for_sync,
            )
            .optional()?;
        Ok(row)
    }

    /// Delete one fingerprint's live entry in a scope, if this device has it.
    pub(crate) fn delete_synced_memory_entry(
        &self,
        scope: &MemoryScope,
        fingerprint: &str,
    ) -> Result<bool> {
        let removed = self.conn().execute(
            "DELETE FROM memory_entries
              WHERE scope_kind = ?1 AND IFNULL(scope_key, '') = ?2 AND fingerprint = ?3
                AND status IN ('active', 'archived')",
            params![scope.kind, scope.stored_key(), fingerprint],
        )?;
        Ok(removed > 0)
    }

    /// A deleted entity means the scope itself is gone.
    pub(crate) fn delete_synced_memory_scope(&self, scope: &MemoryScope) -> Result<()> {
        self.conn().execute(
            "DELETE FROM memory_entries
              WHERE scope_kind = ?1 AND IFNULL(scope_key, '') = ?2
                AND status IN ('active', 'archived')",
            params![scope.kind, scope.stored_key()],
        )?;
        Ok(())
    }

    /// Insert or update one synced entry, keyed by fingerprint.
    ///
    /// Two devices that created the same sentence have different ids and the
    /// same fingerprint, and the live-entry uniqueness index allows exactly one
    /// row, so this merges rather than inserting a copy. The later `updated_at`
    /// wins the fields; the id already on this device is kept, so an open manager
    /// and a receipt keep pointing at the same row.
    pub(crate) fn upsert_synced_memory_entry(
        &self,
        scope: &MemoryScope,
        entry: &SyncedEntry,
    ) -> Result<()> {
        tombstones::require_scope_key(scope)?;
        let source_ids = tombstones::encode_ids(&entry.source_message_ids);
        if let Some(existing) = self.live_memory_entry_by_fingerprint(scope, &entry.fingerprint)? {
            if entry.updated_at <= existing.updated_at {
                // This device already holds a newer edit of the same note.
                return Ok(());
            }
            self.conn().execute(
                "UPDATE memory_entries
                    SET kind = ?1, content = ?2, rationale = ?3, status = ?4, origin = ?5,
                        evidence = ?6, source_session_id = ?7, source_message_ids = ?8,
                        updated_at = ?9, revision = revision + 1
                  WHERE id = ?10",
                params![
                    entry.kind,
                    entry.content,
                    entry.rationale,
                    entry.status,
                    entry.origin,
                    entry.evidence,
                    entry.source_session_id,
                    source_ids,
                    entry.updated_at.max(0),
                    existing.id
                ],
            )?;
            return Ok(());
        }
        let now = now_ms();
        self.conn().execute(
            "INSERT INTO memory_entries
               (id, scope_kind, scope_key, kind, content, rationale, status, origin, evidence,
                source_session_id, source_message_ids, fingerprint, revision, superseded_by,
                created_at, updated_at, last_used_at, use_count)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 1, NULL, ?13, ?14, NULL, 0)",
            params![
                Uuid::new_v4().to_string(),
                scope.kind,
                scope.key.as_deref(),
                entry.kind,
                entry.content,
                entry.rationale,
                entry.status,
                entry.origin,
                entry.evidence,
                entry.source_session_id,
                source_ids,
                entry.fingerprint,
                entry.created_at.max(0),
                entry.updated_at.max(now)
            ],
        )?;
        Ok(())
    }
}
