//! Term-ranked learned-memory search (ADR learned-memory-recall §1).
//!
//! The tests protect three claims the old substring search could not make: a
//! query is matched by its words instead of by its exact text, the result is
//! ordered by how much of the query a note answers, and the two machine-read
//! filters — `exclude_ids` and `min_match_terms` — decide what a caller sees
//! instead of the caller filtering afterwards.

use super::model::*;
use super::repository::*;
use super::tests::{created, open, project_dir, request};
use crate::db::Database;

/// Store one active entry and return its id.
fn note(db: &Database, scope: &MemoryScope, content: &str) -> String {
    created(
        db.create_memory_entry(request(scope, KIND_FACT, content, ORIGIN_USER_UI))
            .unwrap(),
    )
    .id
}

fn search(db: &Database, scope: &MemoryScope, query: &str) -> Vec<MemorySearchHit> {
    db.search_memory_entries(SearchMemoryRequest {
        scopes: std::slice::from_ref(scope),
        query,
        kinds: &[],
        limit: 10,
        record_use: false,
        exclude_ids: &[],
        min_match_terms: 1,
    })
    .unwrap()
}

fn ids(hits: &[MemorySearchHit]) -> Vec<&str> {
    hits.iter().map(|hit| hit.entry.id.as_str()).collect()
}

#[test]
fn a_note_matching_more_terms_ranks_above_an_older_single_word_hit() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(&dir);
    let project = project_dir(&dir, "app");
    let scope = db.learned_memory_scope_for_path(&project).unwrap();
    // The stronger note is written first, so recency alone would rank the other
    // one on top: only the term count can produce this order.
    let strong = note(
        &db,
        &scope,
        "The gateway deploy reports to the release channel.",
    );
    let weak = note(&db, &scope, "The gateway listens on 8787.");

    let hits = search(&db, &scope, "gateway deploy release");
    assert_eq!(ids(&hits), vec![strong.as_str(), weak.as_str()]);
    assert_eq!(hits[0].matched_terms, vec!["gateway", "deploy", "release"]);
    assert_eq!(hits[1].matched_terms, vec!["gateway"]);
}

#[test]
fn a_verbatim_phrase_ranks_above_the_same_term_count() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(&dir);
    let project = project_dir(&dir, "app");
    let scope = db.learned_memory_scope_for_path(&project).unwrap();
    let scattered = note(
        &db,
        &scope,
        "Deploy notes: the scheduler is the gateway's caller.",
    );
    let phrase = note(
        &db,
        &scope,
        "The gateway deploy needs a maintenance window.",
    );

    // Both match the same two terms; only one contains them adjacent, in order.
    let hits = search(&db, &scope, "gateway deploy");
    assert_eq!(ids(&hits), vec![phrase.as_str(), scattered.as_str()]);
}

#[test]
fn a_chinese_query_is_split_into_its_words() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(&dir);
    let project = project_dir(&dir, "app");
    let scope = db.learned_memory_scope_for_path(&project).unwrap();
    let id = note(&db, &scope, "这条学习记忆记录了索引与预算的关系。");

    // Neither the query as a whole nor a sentence is in the note: only the
    // query's own words are, and that is enough to find it.
    let hits = search(&db, &scope, "索引 预算");
    assert_eq!(ids(&hits), vec![id.as_str()]);
    assert_eq!(hits[0].matched_terms, vec!["索引", "预算"]);
}

#[test]
fn excluded_ids_are_never_returned() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(&dir);
    let project = project_dir(&dir, "app");
    let scope = db.learned_memory_scope_for_path(&project).unwrap();
    let indexed = note(&db, &scope, "The gateway deploy runs on Fridays.");
    let overflow = note(&db, &scope, "The gateway deploy is in the runbook.");

    let hits = db
        .search_memory_entries(SearchMemoryRequest {
            scopes: std::slice::from_ref(&scope),
            query: "gateway deploy",
            kinds: &[],
            limit: 10,
            record_use: false,
            exclude_ids: std::slice::from_ref(&indexed),
            min_match_terms: 1,
        })
        .unwrap();
    assert_eq!(ids(&hits), vec![overflow.as_str()]);
}

#[test]
fn min_match_terms_keeps_only_a_real_overlap() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(&dir);
    let project = project_dir(&dir, "app");
    let scope = db.learned_memory_scope_for_path(&project).unwrap();
    let one = note(&db, &scope, "The gateway listens on 8787.");
    let two = note(&db, &scope, "The gateway deploy runs on Fridays.");

    let strict = db
        .search_memory_entries(SearchMemoryRequest {
            scopes: std::slice::from_ref(&scope),
            query: "gateway deploy",
            kinds: &[],
            limit: 10,
            record_use: false,
            exclude_ids: &[],
            min_match_terms: 2,
        })
        .unwrap();
    assert_eq!(ids(&strict), vec![two.as_str()]);

    // One matching term is the tool's own threshold, so the same query still
    // finds the note that shares a single word.
    let loose = search(&db, &scope, "gateway deploy");
    assert_eq!(loose.len(), 2);
    assert!(loose.iter().any(|hit| hit.entry.id == one));
}

#[test]
fn a_search_use_counts_and_a_recall_does_not() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(&dir);
    let project = project_dir(&dir, "app");
    let scope = db.learned_memory_scope_for_path(&project).unwrap();
    let id = note(&db, &scope, "The gateway deploy runs on Fridays.");

    // The per-turn recall reads the same rows and must leave the counters alone:
    // the model did not ask for it, so it cannot look like a search hit.
    let recalled = search(&db, &scope, "gateway deploy");
    assert_eq!(recalled[0].entry.use_count, 0);
    assert!(recalled[0].entry.last_used_at.is_none());

    let searched = db
        .search_memory_entries(SearchMemoryRequest {
            scopes: std::slice::from_ref(&scope),
            query: "gateway deploy",
            kinds: &[],
            limit: 10,
            record_use: true,
            exclude_ids: &[],
            min_match_terms: 1,
        })
        .unwrap();
    assert_eq!(searched[0].entry.id, id);
    assert_eq!(searched[0].entry.use_count, 1);
    assert!(searched[0].entry.last_used_at.is_some());
}

#[test]
fn an_archived_note_and_a_deleted_note_are_never_returned() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(&dir);
    let project = project_dir(&dir, "app");
    let scope = db.learned_memory_scope_for_path(&project).unwrap();
    let archived = note(&db, &scope, "The gateway deploy is archived here.");
    let deleted = note(&db, &scope, "The gateway deploy is forgotten here.");

    db.set_memory_entry_status(&archived, STATUS_ARCHIVED)
        .unwrap();
    assert!(db.delete_memory_entry(&deleted).unwrap());
    assert!(search(&db, &scope, "gateway deploy").is_empty());
}

#[test]
fn the_index_carries_the_ids_of_what_it_shows() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(&dir);
    let project = project_dir(&dir, "app");
    let scope = db.learned_memory_scope_for_path(&project).unwrap();
    let kept = note(&db, &scope, "The gateway deploy runs on Fridays.");

    let index = db.learned_memory_index_for_path(Some(&project)).unwrap();
    assert_eq!(index.ids, vec![kept.clone()]);
    assert_eq!(
        index
            .entries
            .iter()
            .map(|entry| entry.id.clone())
            .collect::<Vec<_>>(),
        vec![kept]
    );
}
