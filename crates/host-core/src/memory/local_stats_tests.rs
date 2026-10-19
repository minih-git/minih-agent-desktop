//! Device-local counter tests (plan §1).
//!
//! The counters exist so the manager can answer "how is this feature doing on
//! this machine". What matters is that each one counts the right thing, that a
//! refusal nobody made is not counted, and that the numbers survive a restart
//! while staying out of every synced payload (that half lives in
//! `config_sync`).

use super::model::*;
use super::repository::{CreateMemoryOutcome, CreateMemoryRequest, SuggestionOutcome};
use super::tests::{created, open, project_dir, rejection_of, request};
use crate::db::Database;

/// A pending suggestion, the shape only extraction may produce.
fn suggestion(db: &Database, scope: &MemoryScope, content: &str) -> MemoryEntryRecord {
    match db
        .create_memory_entry(CreateMemoryRequest {
            scope: scope.clone(),
            kind: KIND_FACT.to_string(),
            content: content.to_string(),
            rationale: None,
            origin: ORIGIN_EXTRACTED.to_string(),
            evidence: EVIDENCE_INFERRED.to_string(),
            status: STATUS_SUGGESTED.to_string(),
            source_session_id: None,
            source_message_ids: Vec::new(),
            override_tombstone: false,
        })
        .unwrap()
    {
        CreateMemoryOutcome::Created(entry) => *entry,
        _ => panic!("expected a stored suggestion"),
    }
}

#[test]
fn a_tombstone_block_is_counted_apart_from_the_extractor() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(&dir);
    let project = project_dir(&dir, "app");
    let scope = db.learned_memory_scope_for_path(&project).unwrap();
    let entry = created(
        db.create_memory_entry(request(
            &scope,
            KIND_FACT,
            "Deploys on Fridays.",
            ORIGIN_USER_UI,
        ))
        .unwrap(),
    );
    assert!(db.delete_memory_entry(&entry.id).unwrap());
    assert_eq!(
        db.memory_local_stats().unwrap().blocked_from_create,
        0,
        "a delete is not a block"
    );

    // The user's own write path, blocked by the tombstone it left behind.
    let rejected = db
        .create_memory_entry(request(
            &scope,
            KIND_FACT,
            "Deploys on Fridays.",
            ORIGIN_USER_UI,
        ))
        .unwrap();
    assert_eq!(rejection_of(&rejected).code, REJECT_TOMBSTONED);
    assert_eq!(db.memory_local_stats().unwrap().blocked_from_create, 1);

    // The extractor's path, blocked by the same delete. A hit is blocked and
    // counted, never surfaced, so this is the "re-suggested" measure.
    let mut extraction = request(&scope, KIND_FACT, "Deploys on Fridays.", ORIGIN_EXTRACTED);
    extraction.status = STATUS_SUGGESTED.to_string();
    extraction.evidence = EVIDENCE_INFERRED.to_string();
    let rejected = db.create_memory_entry(extraction).unwrap();
    assert_eq!(rejection_of(&rejected).code, REJECT_TOMBSTONED);
    let stats = db.memory_local_stats().unwrap();
    assert_eq!(stats.blocked_from_extraction, 1);
    assert_eq!(stats.blocked_from_create, 1);
}

#[test]
fn only_a_decision_that_happened_is_counted() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(&dir);
    let project = project_dir(&dir, "app");
    let scope = db.learned_memory_scope_for_path(&project).unwrap();
    let accepted = suggestion(&db, &scope, "Prefers terse replies.");
    let rejected = suggestion(&db, &scope, "Reviews on Fridays.");
    assert!(matches!(
        db.decide_memory_suggestion(&accepted.id, true).unwrap(),
        SuggestionOutcome::Accepted(_)
    ));
    assert!(matches!(
        db.decide_memory_suggestion(&rejected.id, false).unwrap(),
        SuggestionOutcome::Rejected
    ));
    // The same suggestion cannot be decided twice, so the rate cannot be
    // inflated by a repeated click or a retried request.
    assert!(matches!(
        db.decide_memory_suggestion(&accepted.id, true).unwrap(),
        SuggestionOutcome::NotFound
    ));
    let stats = db.memory_local_stats().unwrap();
    assert_eq!(stats.suggestions_accepted, 1);
    assert_eq!(stats.suggestions_rejected, 1);
}

#[test]
fn counters_start_at_zero_and_survive_a_restart() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("pi.sqlite");
    {
        let db = Database::open(&path).unwrap();
        assert_eq!(db.memory_local_stats().unwrap().suggestions_accepted, 0);
        assert_eq!(db.memory_local_stats().unwrap().index_captured_at, None);
        db.record_memory_suggestion_decision(true).unwrap();
        db.record_memory_index_capture(3, 512, 1, 42).unwrap();
        // The next launch replaces the snapshot rather than adding to it: the
        // manager shows the most recent session start.
        db.record_memory_index_capture(4, 700, 0, 99).unwrap();
    }
    let reopened = Database::open(&path).unwrap();
    let stats = reopened.memory_local_stats().unwrap();
    assert_eq!(stats.suggestions_accepted, 1);
    assert_eq!(stats.suggestions_rejected, 0);
    assert_eq!(stats.index_entries, 4);
    assert_eq!(stats.index_bytes, 700);
    assert_eq!(stats.index_omitted, 0);
    assert_eq!(stats.index_captured_at, Some(99));
}
