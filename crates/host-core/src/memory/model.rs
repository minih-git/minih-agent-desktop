//! Learned-memory records, enums, and limits (ADR agent-long-term-memory).
//!
//! The pinned project memory of ADR 0234 is a separate layer with its own
//! storage and editor; nothing here reads or writes it.

use serde::Serialize;

pub const SCOPE_PROJECT: &str = "project";
pub const SCOPE_USER: &str = "user";
pub const SCOPES: [&str; 2] = [SCOPE_PROJECT, SCOPE_USER];

pub const KIND_PREFERENCE: &str = "preference";
pub const KIND_FEEDBACK: &str = "feedback";
pub const KIND_FACT: &str = "fact";
pub const KIND_REFERENCE: &str = "reference";
pub const KINDS: [&str; 4] = [KIND_PREFERENCE, KIND_FEEDBACK, KIND_FACT, KIND_REFERENCE];

pub const STATUS_SUGGESTED: &str = "suggested";
pub const STATUS_ACTIVE: &str = "active";
pub const STATUS_ARCHIVED: &str = "archived";
pub const STATUSES: [&str; 3] = [STATUS_SUGGESTED, STATUS_ACTIVE, STATUS_ARCHIVED];

pub const ORIGIN_EXPLICIT: &str = "explicit";
pub const ORIGIN_USER_UI: &str = "user_ui";
pub const ORIGIN_EXTRACTED: &str = "extracted";
pub const ORIGINS: [&str; 3] = [ORIGIN_EXPLICIT, ORIGIN_USER_UI, ORIGIN_EXTRACTED];

pub const EVIDENCE_USER_STATED: &str = "user_stated";
pub const EVIDENCE_VERIFIED: &str = "verified";
pub const EVIDENCE_INFERRED: &str = "inferred";
pub const EVIDENCES: [&str; 3] = [EVIDENCE_USER_STATED, EVIDENCE_VERIFIED, EVIDENCE_INFERRED];

/// Largest `content` the host stores for one entry (ADR: 1 KiB).
pub const MAX_CONTENT_BYTES: usize = 1024;
/// Largest optional `rationale` the host stores for one entry.
pub const MAX_RATIONALE_BYTES: usize = 512;
/// Most source messages one entry may cite.
pub const MAX_SOURCE_MESSAGE_IDS: usize = 16;
/// Page size cap for `memory.list`.
pub const MAX_LIST_LIMIT: i64 = 200;
/// Result cap for `memory.search`.
pub const MAX_SEARCH_LIMIT: i64 = 20;
/// Session-start index: at most this many entries.
pub const INDEX_MAX_LINES: usize = 40;
/// Session-start index: at most this many bytes, counted as
/// `content + rationale + INDEX_ENTRY_OVERHEAD_BYTES` per entry, which is what
/// the runtime section spends on the entry beyond its own text.
pub const INDEX_MAX_BYTES: usize = 6 * 1024;
/// Per-entry accounting overhead for the index budget (kind, date, markers).
pub const INDEX_ENTRY_OVERHEAD_BYTES: usize = 48;
/// Extraction lease length; a crashed owner never blocks the session forever.
pub const EXTRACTION_LEASE_MS: i64 = 10 * 60 * 1000;
/// Longest `last_error` the host records for a failed extraction run. It holds
/// a code from the service, never transcript text.
pub const MAX_EXTRACTION_ERROR_CHARS: usize = 200;

pub fn is_known(value: &str, allowed: &[&str]) -> bool {
    allowed.contains(&value)
}

/// `project` or `user` plus the scope key. A project scope key is the owning
/// project group id, or the canonical project path for a project that is not in
/// a stored group (ADR 0249); the user scope has no key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemoryScope {
    pub kind: &'static str,
    pub key: Option<String>,
}

impl MemoryScope {
    pub fn project(key: impl Into<String>) -> Self {
        Self {
            kind: SCOPE_PROJECT,
            key: Some(key.into()),
        }
    }

    pub fn user() -> Self {
        Self {
            kind: SCOPE_USER,
            key: None,
        }
    }

    /// The key as stored: `''` for the user scope, so a lookup can compare
    /// `IFNULL(scope_key, '')` without a second branch.
    pub fn stored_key(&self) -> &str {
        self.key.as_deref().unwrap_or("")
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryEntryRecord {
    pub id: String,
    pub scope_kind: String,
    pub scope_key: Option<String>,
    pub kind: String,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rationale: Option<String>,
    pub status: String,
    pub origin: String,
    pub evidence: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_session_id: Option<String>,
    pub source_message_ids: Vec<String>,
    pub fingerprint: String,
    pub revision: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub superseded_by: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_used_at: Option<i64>,
    pub use_count: i64,
}

impl MemoryEntryRecord {
    pub fn scope(&self) -> MemoryScope {
        MemoryScope {
            kind: if self.scope_kind == SCOPE_USER {
                SCOPE_USER
            } else {
                SCOPE_PROJECT
            },
            key: self.scope_key.clone(),
        }
    }

    /// Bytes this entry spends in the session-start index budget.
    pub fn index_bytes(&self) -> usize {
        INDEX_ENTRY_OVERHEAD_BYTES
            + self.content.len()
            + self.rationale.as_deref().map(str::len).unwrap_or(0)
    }
}

/// One entry of the session-start index. The runtime renders one line per entry
/// and points at `MemorySearch` when `omitted_count` is not zero.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryIndexEntry {
    pub id: String,
    pub kind: String,
    pub scope_kind: String,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rationale: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_used_at: Option<i64>,
}

impl From<&MemoryEntryRecord> for MemoryIndexEntry {
    fn from(entry: &MemoryEntryRecord) -> Self {
        Self {
            id: entry.id.clone(),
            kind: entry.kind.clone(),
            scope_kind: entry.scope_kind.clone(),
            content: entry.content.clone(),
            rationale: entry.rationale.clone(),
            created_at: entry.created_at,
            updated_at: entry.updated_at,
            last_used_at: entry.last_used_at,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryIndex {
    pub entries: Vec<MemoryIndexEntry>,
    /// Active entries the budget left out; the runtime states the count.
    pub omitted_count: i64,
    /// Bytes the returned entries spend in the budget.
    pub bytes: usize,
}

/// A write the host refused. The code is stable and the message never repeats
/// the refused text, so a rejected credential never reaches a log.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MemoryRejection {
    pub code: &'static str,
    pub message: String,
}

pub const REJECT_EMPTY_CONTENT: &str = "MEMORY_EMPTY_CONTENT";
pub const REJECT_CONTENT_TOO_LARGE: &str = "MEMORY_CONTENT_TOO_LARGE";
pub const REJECT_RATIONALE_TOO_LARGE: &str = "MEMORY_RATIONALE_TOO_LARGE";
pub const REJECT_INVALID_FIELD: &str = "MEMORY_INVALID_FIELD";
pub const REJECT_DUPLICATE_CONTENT: &str = "MEMORY_DUPLICATE_CONTENT";
pub const REJECT_CREDENTIAL_DETECTED: &str = "MEMORY_CREDENTIAL_DETECTED";
pub const REJECT_PROVENANCE_REQUIRED: &str = "MEMORY_PROVENANCE_REQUIRED";
pub const REJECT_TOMBSTONED: &str = "MEMORY_TOMBSTONED";

impl MemoryRejection {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

/// Per-session extraction state. `cursor_seq` and the lease make a background
/// run idempotent across restarts, duplicates, and reloads.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemorySessionStateRecord {
    pub session_id: String,
    pub scope_kind: String,
    pub scope_key: Option<String>,
    pub cursor_seq: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lease_owner: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lease_until: Option<i64>,
    pub attempts: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    pub excluded: bool,
}
