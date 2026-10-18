//! Learned memory: the host-owned layer between the user's pinned project
//! memory (ADR 0234, unchanged) and the transcripts (ADR agent-long-term-memory).
//!
//! `model` holds the records and limits, `repository` the storage operations,
//! `validation` the rules every writer shares, `secrets` the credential
//! detector, `tombstones` the identity and forgetting guarantees, and
//! `extraction` the per-session cursor and lease the optional extractor uses.

mod extraction;
mod model;
mod repository;
mod secrets;
mod tombstones;
mod validation;

#[cfg(test)]
#[path = "lifecycle_tests.rs"]
mod lifecycle_tests;
#[cfg(test)]
#[path = "provenance_tests.rs"]
mod provenance_tests;
#[cfg(test)]
mod tests;

pub(crate) use model::{
    is_known, MemoryEntryRecord, MemoryScope, EVIDENCES, EVIDENCE_USER_STATED, EVIDENCE_VERIFIED,
    EXTRACTION_LEASE_MS, KINDS, MAX_LIST_LIMIT, MAX_SEARCH_LIMIT, ORIGINS, ORIGIN_EXPLICIT,
    ORIGIN_USER_UI, SCOPES, SCOPE_PROJECT, SCOPE_USER, STATUSES, STATUS_ACTIVE, STATUS_ARCHIVED,
};
pub(crate) use repository::{
    delete_learned_scope_tx, rekey_learned_memory_to_group, CreateMemoryOutcome,
    CreateMemoryRequest, SearchMemoryRequest, StatusMemoryOutcome, SuggestionOutcome,
    UpdateMemoryOutcome, UpdateMemoryRequest,
};
/// The same `verified` rule the write path enforces, so the tool refuses it
/// before the write instead of after.
pub(crate) use validation::allows_verified;
