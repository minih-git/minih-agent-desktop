//! Automatic curation of learned memory: records, guardrails, and the input a
//! pass reads (ADR learned-memory-consolidation §3-§6).
//!
//! The switch lives in settings and only Electron main reads it, but every
//! guarantee here is host-enforced: a caller that ignores the caps, the
//! revision check, or the "never reword what the user typed" rule is refused by
//! this module rather than trusted by it. Automatic removal is always an
//! archive (`archived` + `superseded_by`) written together with its revision
//! record, so nothing an automatic pass does is unrecoverable, and no
//! automatic path writes or clears a tombstone — forgetting stays the user's
//! own action.
//!
//! # Scope
//!
//! The pass covers what the person keeps: a project's notes and their own. An
//! employee's lessons are learned memory in the `bot` scope (schema v39) and
//! belong to the employee layer, so this feature never reads, queues, or
//! changes them — see [`curatable`].
//!
//! # Layout
//!
//! - this module: the vocabulary (operations, result codes, records), the scope
//!   rule, and the note helpers every step shares;
//! - [`state`]: the dirty marker, the lease, the once-a-day stamp, and the
//!   target sets the user undid;
//! - [`execute`]: what one pass may read, and the four operations it may apply;
//! - [`undo`]: the audit trail, the manager's list, and undoing one batch.

use anyhow::{anyhow, Result};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::model::*;
use super::{secrets, tombstones};

mod execute;
mod state;
mod undo;

pub(crate) use state::*;
pub(crate) use undo::*;

/// Most items one pass may apply, before the proportional cap applies.
pub(crate) const MAX_CURATION_OPS: usize = 8;
/// Share of a scope's active notes one pass may touch, in percent.
pub(crate) const CURATION_SHARE_PERCENT: i64 = 20;
/// Notes within this window that the user edited or restored are left alone.
pub(crate) const CURATION_USER_QUIET_MS: i64 = 30 * 24 * 3600 * 1000;
/// Longest input one pass may read.
pub(crate) const CURATION_INPUT_MAX_BYTES: usize = 24 * 1024;
/// Neighbours one changed note contributes to the input.
pub(crate) const CURATION_NEIGHBOURS_PER_ENTRY: i64 = 5;
/// Merge targets: at least two, at most five.
pub(crate) const MIN_MERGE_TARGETS: usize = 2;
pub(crate) const MAX_MERGE_TARGETS: usize = 5;
/// Replace targets: one to three.
pub(crate) const MAX_REPLACE_TARGETS: usize = 3;
/// Longest reason a record keeps.
pub(crate) const MAX_CURATION_REASON_BYTES: usize = 280;
/// Lease length for one scope's pass; a crashed owner never blocks it forever.
pub(crate) const CURATION_LEASE_MS: i64 = 10 * 60 * 1000;
/// Longest `last_error` a failed pass records.
pub(crate) const MAX_CURATION_ERROR_CHARS: usize = 200;
/// How long revision records are kept.
pub(crate) const CURATION_REVISION_RETENTION_MS: i64 = 90 * 24 * 3600 * 1000;

/// The operations an automatic pass may perform.
pub(crate) const CURATION_OP_MERGE: &str = "merge";
pub(crate) const CURATION_OP_REPLACE: &str = "replace";
pub(crate) const CURATION_OP_REWORD: &str = "reword";
pub(crate) const CURATION_OP_HINT: &str = "hint";
pub(crate) const CURATION_OPS: [&str; 4] = [
    CURATION_OP_MERGE,
    CURATION_OP_REPLACE,
    CURATION_OP_REWORD,
    CURATION_OP_HINT,
];

/// What one revision row did.
pub(crate) const REVISION_ACTIVATE: &str = "activate";
pub(crate) const REVISION_MERGE_NEW: &str = "merge_new";
pub(crate) const REVISION_MERGE_ARCHIVE: &str = "merge_archive";
pub(crate) const REVISION_REPLACE_ARCHIVE: &str = "replace_archive";
pub(crate) const REVISION_REWORD: &str = "reword";

/// Result codes, reported in the log and in the `complete` answer. They are
/// codes, never content.
pub(crate) const CURATION_APPLIED: &str = "applied";
pub(crate) const CURATION_STALE: &str = "stale";
pub(crate) const CURATION_CAPPED: &str = "capped";
pub(crate) const CURATION_REJECTED: &str = "rejected";
pub(crate) const CURATION_USER_EDITED: &str = "user-edited";
pub(crate) const CURATION_EXPLICIT_REWORD: &str = "explicit-reword";
pub(crate) const CURATION_ALREADY_DONE: &str = "already-undone";
pub(crate) const CURATION_TOMBSTONED: &str = "tombstoned";

/// The four parts of a note an automatic change can move.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MemoryRevisionSnapshot {
    pub content: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub superseded_by: Option<String>,
    pub revision: i64,
}

impl MemoryRevisionSnapshot {
    fn of(entry: &MemoryEntryRecord) -> Self {
        Self {
            content: entry.content.clone(),
            status: entry.status.clone(),
            superseded_by: entry.superseded_by.clone(),
            revision: entry.revision,
        }
    }
}

/// One row of the audit trail, as the manager lists it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MemoryRevisionRecord {
    pub id: i64,
    pub batch_id: String,
    pub entry_id: String,
    pub op: String,
    pub actor: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub before: Option<MemoryRevisionSnapshot>,
    pub after: MemoryRevisionSnapshot,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub created_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub undone_at: Option<i64>,
    /// The scope the row belongs to; internal, used by the undo to name the
    /// scope it writes its rejection into.
    #[serde(skip)]
    pub scope: Option<MemoryScope>,
}

/// One item a pass proposed, after the RPC boundary checked its shape.
#[derive(Debug, Clone)]
pub(crate) struct CurationOpRequest {
    pub op: String,
    pub target_ids: Vec<String>,
    pub target_revisions: Vec<i64>,
    pub content: Option<String>,
    pub reason: Option<String>,
    /// `merge` only: the kind of the new note. Defaults to the targets' kind.
    pub kind: Option<String>,
}

/// What applying one item did.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CurationOpOutcome {
    pub op: String,
    /// `applied`, `stale`, `rejected`, or a guardrail refusal code.
    pub result: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CurationApplyReport {
    pub batch_id: String,
    /// Items that changed something.
    pub applied: usize,
    /// Most items one pass in this scope may apply.
    pub cap: usize,
    pub outcomes: Vec<CurationOpOutcome>,
    /// True when the pass tried to do more than the cap allows.
    pub capped: bool,
}

/// What `activate` did with the candidates it was handed.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CurationActivateReport {
    pub batch_id: String,
    pub activated: Vec<String>,
    pub skipped: usize,
    pub cap: usize,
    pub capped: bool,
}

/// One note as a pass sees it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CurationInputEntry {
    pub id: String,
    pub kind: String,
    pub origin: String,
    pub evidence: String,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rationale: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub revision: i64,
    /// Whether a pass may reword it: only an extracted note, and only when the
    /// user has not touched it in the quiet window.
    pub rewordable: bool,
    pub user_edited: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CurationInput {
    pub scope_kind: String,
    pub scope_key: Option<String>,
    /// Notes whose revision moved since the previous pass; the pass starts here.
    pub changed: Vec<CurationInputEntry>,
    /// Full-text neighbours of the changed notes, of the same kind.
    pub neighbours: Vec<CurationInputEntry>,
    /// The rest of the scope's active notes, newest first.
    pub others: Vec<CurationInputEntry>,
    pub bytes: usize,
    pub cap: usize,
}

/// What an undo did.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", tag = "result")]
pub(crate) enum CurationUndoReport {
    Undone { undone: usize },
    Conflict,
    AlreadyUndone,
    NotFound,
}

pub(crate) enum CurationInputOutcome {
    Input(Box<CurationInput>),
    Skipped(&'static str),
}

/// Reasons a scope is not curated right now.
pub(crate) const SKIP_NOTHING_CHANGED: &str = "nothing-changed";
pub(crate) const SKIP_ALREADY_RAN_TODAY: &str = "already-ran-today";
pub(crate) const SKIP_BUSY: &str = "busy";

/// Whether automatic curation may touch this scope at all.
///
/// The pass covers what the person keeps: a project's notes and their own. An
/// employee's lessons live in the `bot` scope (schema v39) and are the employee
/// layer's to maintain, so this feature leaves them alone entirely. The two
/// bookkeeping tables refuse that scope in their `CHECK` as well; this is the
/// rule the host applies before any SQL runs.
pub(crate) fn curatable(scope: &MemoryScope) -> bool {
    scope.kind != SCOPE_BOT
}

/// Refuse a scope automatic curation does not own.
///
/// A refusal, not a silent no-op: the caller named a scope this feature has no
/// pass for, and answering "nothing to do" would read as a successful empty
/// pass over notes that were never eligible in the first place.
pub(crate) fn require_curatable_scope(scope: &MemoryScope) -> Result<()> {
    if curatable(scope) {
        Ok(())
    } else {
        Err(anyhow!(
            "automatic curation does not cover scope kind '{}'",
            scope.kind
        ))
    }
}

/// The scope a stored `scope_kind` / `scope_key` pair names.
fn scope_from_row(kind: &str, key: Option<String>) -> MemoryScope {
    match kind {
        SCOPE_USER => MemoryScope::user(),
        SCOPE_BOT => MemoryScope::bot(key.unwrap_or_default()),
        _ => MemoryScope {
            kind: SCOPE_PROJECT,
            key,
        },
    }
}

const ENTRY_COLUMNS: &str = "id, scope_kind, scope_key, kind, content, rationale, status, origin, \
     evidence, source_session_id, source_message_ids, fingerprint, revision, superseded_by, \
     created_at, updated_at, last_used_at, use_count";

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

pub(crate) fn entry_by_id(conn: &Connection, id: &str) -> Result<Option<MemoryEntryRecord>> {
    let sql = format!("SELECT {ENTRY_COLUMNS} FROM memory_entries WHERE id = ?1");
    conn.query_row(&sql, params![id], entry_from_row)
        .optional()
        .map_err(Into::into)
}

fn active_entries(conn: &Connection, scope: &MemoryScope) -> Result<Vec<MemoryEntryRecord>> {
    let sql = format!(
        "SELECT {ENTRY_COLUMNS} FROM memory_entries
          WHERE scope_kind = ?1 AND IFNULL(scope_key, '') = ?2 AND status = ?3
          ORDER BY updated_at DESC, id ASC
          LIMIT ?4"
    );
    let mut statement = conn.prepare_cached(&sql)?;
    let rows = statement.query_map(
        params![
            scope.kind,
            scope.stored_key(),
            STATUS_ACTIVE,
            MAX_LIST_LIMIT
        ],
        entry_from_row,
    )?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// How many notes one pass may touch: at most twenty percent of the scope's
/// active notes, never more than the absolute ceiling, and never less than one
/// — a scope with one note still gets help.
pub(crate) fn curation_cap(conn: &Connection, scope: &MemoryScope) -> Result<usize> {
    let active: i64 = conn.query_row(
        "SELECT COUNT(*) FROM memory_entries
          WHERE scope_kind = ?1 AND IFNULL(scope_key, '') = ?2 AND status = ?3",
        params![scope.kind, scope.stored_key(), STATUS_ACTIVE],
        |row| row.get(0),
    )?;
    let share = active * CURATION_SHARE_PERCENT / 100;
    Ok(share.clamp(1, MAX_CURATION_OPS as i64) as usize)
}

/// Whether the user has ever authored this note by hand: the content the pass
/// would rewrite is their own sentence, so a pass never rewrites it at all.
fn user_authored(entry: &MemoryEntryRecord) -> bool {
    entry.origin != ORIGIN_EXTRACTED
}

/// Whether the user's own hand is still on a note: they edited it, or wrote it,
/// inside the quiet window.
///
/// This is the rule ADR §4 states. It protects the content the user just chose
/// — the wording a reword would replace, the sentence a replace would put
/// away — from being changed while it is fresh. A merge only reads the targets
/// and writes a new note beside them, so it is not gated on freshness; the
/// origin rules govern it instead.
///
/// An automatic change also moves `updated_at` (an activation, a reword, an
/// undo), so an extracted note never reads as user-edited: no automatic path
/// sets `explicit` or `user_ui`, so the origin is what separates the two.
fn user_touched(entry: &MemoryEntryRecord, now: i64) -> bool {
    if !user_authored(entry) {
        return false;
    }
    let cut = now - CURATION_USER_QUIET_MS;
    entry.created_at >= cut || (entry.updated_at > entry.created_at && entry.updated_at >= cut)
}

/// Whether a pass may put a note out of the way by merging it into a new note.
fn is_mergeable(entry: &MemoryEntryRecord) -> bool {
    entry.status == STATUS_ACTIVE
}

fn entry_item(
    entry: &MemoryEntryRecord,
    now: i64,
    budget: &mut usize,
) -> Option<CurationInputEntry> {
    let user_edited = user_touched(entry, now);
    let cost = entry.content.len() + entry.rationale.as_deref().map(str::len).unwrap_or(0) + 96;
    if cost > *budget {
        return None;
    }
    *budget -= cost;
    Some(CurationInputEntry {
        id: entry.id.clone(),
        kind: entry.kind.clone(),
        origin: entry.origin.clone(),
        evidence: entry.evidence.clone(),
        content: entry.content.clone(),
        rationale: entry.rationale.clone(),
        created_at: entry.created_at,
        updated_at: entry.updated_at,
        revision: entry.revision,
        rewordable: entry.origin == ORIGIN_EXTRACTED && !user_edited,
        user_edited,
    })
}

/// The identity of a target set: the scope plus every target's fingerprint in a
/// stable order. Apply and undo both use it, so a set the user undid is exactly
/// the set the next pass recognises.
pub(crate) fn target_set_fingerprint(scope: &MemoryScope, fingerprints: &mut [&str]) -> String {
    fingerprints.sort_unstable();
    let mut hasher = Sha256::new();
    hasher.update(scope.kind.as_bytes());
    hasher.update(b"\n");
    hasher.update(scope.stored_key().as_bytes());
    for fingerprint in fingerprints.iter() {
        hasher.update(b"\n");
        hasher.update(fingerprint.as_bytes());
    }
    hex::encode(hasher.finalize())
}

/// Whether this exact target set was undone before, so the next pass proposes
/// something else instead of the same cleanup.
fn rejected_target_set(
    conn: &Connection,
    scope: &MemoryScope,
    targets: &[MemoryEntryRecord],
) -> Result<bool> {
    let mut fingerprints: Vec<&str> = targets
        .iter()
        .map(|entry| entry.fingerprint.as_str())
        .collect();
    let set_fingerprint = target_set_fingerprint(scope, &mut fingerprints);
    let blocked: bool = conn.query_row(
        "SELECT EXISTS(
           SELECT 1 FROM memory_curation_rejections
            WHERE scope_kind = ?1 AND scope_key = ?2 AND target_fingerprint = ?3)",
        params![scope.kind, scope.stored_key(), set_fingerprint],
        |row| row.get(0),
    )?;
    Ok(blocked)
}

fn bounded_reason(reason: &str) -> String {
    let trimmed = reason.trim();
    let mut end = trimmed.len().min(MAX_CURATION_REASON_BYTES);
    while end > 0 && !trimmed.is_char_boundary(end) {
        end -= 1;
    }
    trimmed[..end].to_string()
}

fn new_batch_id() -> String {
    uuid::Uuid::new_v4().to_string()
}
