//! Learned-memory scope, index, search, lifecycle, and extraction-state tests.

use rusqlite::params;

use super::model::*;
use super::repository::*;
use super::tests::{created, open, project_dir, rejection_of, request, session_with_message};
use super::tombstones;

// ---- scope isolation -------------------------------------------------------

#[test]
fn scopes_are_isolated_between_projects_and_the_user() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(&dir);
    let first = project_dir(&dir, "first");
    let second = project_dir(&dir, "second");
    let first_scope = db.learned_memory_scope_for_path(&first).unwrap();
    let second_scope = db.learned_memory_scope_for_path(&second).unwrap();
    assert_ne!(first_scope.key, second_scope.key);

    created(
        db.create_memory_entry(request(
            &first_scope,
            KIND_FACT,
            "First project fact.",
            ORIGIN_USER_UI,
        ))
        .unwrap(),
    );
    created(
        db.create_memory_entry(request(
            &second_scope,
            KIND_FACT,
            "Second project fact.",
            ORIGIN_USER_UI,
        ))
        .unwrap(),
    );
    created(
        db.create_memory_entry(request(
            &MemoryScope::user(),
            KIND_FACT,
            "User wide fact.",
            ORIGIN_USER_UI,
        ))
        .unwrap(),
    );

    let first_entries = db
        .list_memory_entries(&first_scope, None, None, 10, 0)
        .unwrap();
    assert_eq!(first_entries.len(), 1);
    assert_eq!(first_entries[0].content, "First project fact.");
    let user_entries = db
        .list_memory_entries(&MemoryScope::user(), None, None, 10, 0)
        .unwrap();
    assert_eq!(user_entries.len(), 1);

    // A session reads its own project scope and the user scope, never another
    // project's.
    let session = crate::sessions::create_session(
        &db,
        Some("Session".into()),
        None,
        None,
        None,
        Some(first.clone()),
    )
    .unwrap();
    let scopes = db
        .learned_memory_scopes_for_session(&session.id)
        .unwrap()
        .unwrap();
    assert_eq!(scopes.len(), 2);
    assert_eq!(
        scopes[0].key.as_deref(),
        Some(first_scope.key.as_deref().unwrap())
    );
    assert_eq!(scopes[1].kind, SCOPE_USER);
    let hits = db
        .search_memory_entries(SearchMemoryRequest {
            scopes: &scopes,
            query: "fact",
            kinds: &[],
            limit: 8,
            record_use: false,
        })
        .unwrap();
    let contents: Vec<&str> = hits.iter().map(|entry| entry.content.as_str()).collect();
    assert!(contents.contains(&"First project fact."));
    assert!(contents.contains(&"User wide fact."));
    assert!(!contents.contains(&"Second project fact."));

    // The index for one project sees the same two scopes.
    let index = db.learned_memory_index(&first).unwrap();
    assert_eq!(index.entries.len(), 2);
    assert!(db.learned_memory_index(&second).unwrap().entries.len() == 2);
    assert!(db
        .learned_memory_scopes_for_session("missing")
        .unwrap()
        .is_none());
}

#[test]
fn an_isolated_worktree_session_keeps_the_main_project_scope() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(&dir);
    let main = project_dir(&dir, "main");
    let worktree = project_dir(&dir, "main-worktree");
    // The isolated session's row points at the main project; the worktree path is
    // never a project of its own (ADR 0329).
    let session = crate::sessions::create_session(
        &db,
        Some("Isolated".into()),
        None,
        None,
        None,
        Some(main.clone()),
    )
    .unwrap();
    let scope = db
        .learned_memory_scopes_for_session(&session.id)
        .unwrap()
        .unwrap()
        .remove(0);
    assert_eq!(
        scope.key.as_deref(),
        Some(
            db.learned_memory_scope_for_path(&main)
                .unwrap()
                .key
                .as_deref()
                .unwrap()
        )
    );
    assert_ne!(
        scope.key.as_deref(),
        Some(
            db.learned_memory_scope_for_path(&worktree)
                .unwrap()
                .key
                .as_deref()
                .unwrap()
        )
    );
}

#[test]
fn search_can_filter_by_kind_and_records_use_only_when_asked() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(&dir);
    let project = project_dir(&dir, "app");
    let scope = db.learned_memory_scope_for_path(&project).unwrap();
    created(
        db.create_memory_entry(request(
            &scope,
            KIND_FACT,
            "The host is written in Rust.",
            ORIGIN_USER_UI,
        ))
        .unwrap(),
    );
    created(
        db.create_memory_entry(request(
            &scope,
            KIND_REFERENCE,
            "See the Rust runbook.",
            ORIGIN_USER_UI,
        ))
        .unwrap(),
    );

    let all = db
        .search_memory_entries(SearchMemoryRequest {
            scopes: std::slice::from_ref(&scope),
            query: "rust",
            kinds: &[],
            limit: 8,
            record_use: false,
        })
        .unwrap();
    assert_eq!(all.len(), 2);
    assert!(all
        .iter()
        .all(|entry| entry.use_count == 0 && entry.last_used_at.is_none()));

    let facts = db
        .search_memory_entries(SearchMemoryRequest {
            scopes: std::slice::from_ref(&scope),
            query: "rust",
            kinds: &[KIND_FACT.to_string()],
            limit: 8,
            record_use: true,
        })
        .unwrap();
    assert_eq!(facts.len(), 1);
    assert_eq!(facts[0].kind, KIND_FACT);
    assert_eq!(facts[0].use_count, 1);
    assert!(facts[0].last_used_at.is_some());
    let untouched = db
        .list_memory_entries(&scope, None, Some(KIND_REFERENCE), 10, 0)
        .unwrap();
    assert_eq!(untouched[0].use_count, 0);
}

#[test]
fn the_session_start_index_is_ordered_and_budgeted() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(&dir);
    let project = project_dir(&dir, "app");
    let scope = db.learned_memory_scope_for_path(&project).unwrap();

    // One explicit entry, then enough extracted ones to overflow the line budget.
    created(
        db.create_memory_entry(request(
            &scope,
            KIND_FACT,
            "Explicit first.",
            ORIGIN_EXPLICIT,
        ))
        .unwrap(),
    );
    for index in 0..50 {
        let mut write = request(
            &scope,
            KIND_FACT,
            &format!("Extracted entry number {index}."),
            ORIGIN_EXTRACTED,
        );
        write.status = STATUS_SUGGESTED.to_string();
        created(db.create_memory_entry(write).unwrap());
    }
    // Suggestions are not part of the index.
    let index = db.learned_memory_index(&project).unwrap();
    assert_eq!(index.entries.len(), 1);
    assert_eq!(index.omitted_count, 0);

    // Extraction only ever proposes, so the active entries it produced are the
    // accepted suggestions.
    for number in 0..50 {
        let mut write = request(
            &scope,
            KIND_FACT,
            &format!("Accepted extracted entry {number}."),
            ORIGIN_EXTRACTED,
        );
        write.status = STATUS_SUGGESTED.to_string();
        let entry = created(db.create_memory_entry(write).unwrap());
        assert!(matches!(
            db.decide_memory_suggestion(&entry.id, true).unwrap(),
            SuggestionOutcome::Accepted(_)
        ));
    }
    let index = db.learned_memory_index(&project).unwrap();
    assert_eq!(index.entries.len(), 40);
    assert_eq!(index.omitted_count, 11);
    assert_eq!(index.entries[0].content, "Explicit first.");
    assert!(index.bytes <= super::model::INDEX_MAX_BYTES);
    // Deterministic: the same data returns the same lines.
    let again = db.learned_memory_index(&project).unwrap();
    assert_eq!(
        index
            .entries
            .iter()
            .map(|entry| entry.id.clone())
            .collect::<Vec<_>>(),
        again
            .entries
            .iter()
            .map(|entry| entry.id.clone())
            .collect::<Vec<_>>()
    );

    // Long entries stop at the byte budget instead of the line budget.
    let long = project_dir(&dir, "long");
    let long_scope = db.learned_memory_scope_for_path(&long).unwrap();
    for number in 0..10 {
        created(
            db.create_memory_entry(request(
                &long_scope,
                KIND_FACT,
                &format!("{number}{}", "z".repeat(900)),
                ORIGIN_USER_UI,
            ))
            .unwrap(),
        );
    }
    let index = db.learned_memory_index(&long).unwrap();
    assert!(index.bytes <= super::model::INDEX_MAX_BYTES);
    assert!(index.entries.len() < 10);
    assert_eq!(index.entries.len() as i64 + index.omitted_count, 10);
}

// ---- lifecycle -------------------------------------------------------------

#[test]
fn removing_a_project_deletes_its_learned_memory() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(&dir);
    let project = project_dir(&dir, "app");
    let scope = db.learned_memory_scope_for_path(&project).unwrap();
    let session = session_with_message(&db, &project, "u1", "user");
    let mut write = request(
        &scope,
        KIND_PREFERENCE,
        "Prefers terse replies.",
        ORIGIN_EXPLICIT,
    );
    write.source_session_id = Some(session.clone());
    write.source_message_ids = vec!["u1".to_string()];
    let entry = created(db.create_memory_entry(write).unwrap());
    db.delete_memory_entry(&entry.id).unwrap();
    db.set_memory_session_excluded(&session, true).unwrap();
    created(
        db.create_memory_entry(request(
            &MemoryScope::user(),
            KIND_FACT,
            "User wide.",
            ORIGIN_USER_UI,
        ))
        .unwrap(),
    );

    db.delete_project_learned_memory(&project).unwrap();
    for table in [
        "memory_entries",
        "memory_tombstones",
        "memory_session_state",
    ] {
        let count: i64 = db
            .conn()
            .query_row(
                &format!("SELECT COUNT(*) FROM {table} WHERE scope_key = ?1"),
                params![scope.key.as_deref()],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 0, "{table} must drop the removed project's rows");
    }
    // Another scope is untouched.
    assert_eq!(
        db.list_memory_entries(&MemoryScope::user(), None, None, 10, 0)
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn upgrading_legacy_roots_into_a_group_rekeys_learned_memory() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(&dir);
    let first = project_dir(&dir, "first");
    let second = project_dir(&dir, "second");
    let first_scope = db.learned_memory_scope_for_path(&first).unwrap();
    let second_scope = db.learned_memory_scope_for_path(&second).unwrap();

    let shared = "Prefers terse replies.";
    let first_entry = created(
        db.create_memory_entry(request(&first_scope, KIND_FACT, shared, ORIGIN_USER_UI))
            .unwrap(),
    );
    let second_entry = created(
        db.create_memory_entry(request(&second_scope, KIND_FACT, shared, ORIGIN_USER_UI))
            .unwrap(),
    );
    // A tombstone and a session state row that must follow their root.
    let gone = created(
        db.create_memory_entry(request(
            &first_scope,
            KIND_FACT,
            "Deleted fact.",
            ORIGIN_USER_UI,
        ))
        .unwrap(),
    );
    db.delete_memory_entry(&gone.id).unwrap();
    let session = session_with_message(&db, &first, "u1", "user");
    db.set_memory_session_excluded(&session, true).unwrap();

    let legacy = db.project_group_for_path(&first).unwrap().unwrap();
    assert!(legacy.legacy);
    let group = db
        .update_project_group(&legacy.id, "Group", &[first.clone(), second.clone()], None)
        .unwrap();
    assert!(!group.legacy);

    // Both path scopes are empty and the group owns the surviving entry, without
    // the duplicate the two roots shared. The forgotten entry is gone: deleting
    // erases the row, so only its tombstone crosses over.
    let group_entries = db
        .list_memory_entries(&MemoryScope::project(group.id.clone()), None, None, 10, 0)
        .unwrap();
    assert_eq!(group_entries.len(), 1);
    assert_eq!(
        group_entries
            .iter()
            .filter(|entry| entry.content == shared)
            .count(),
        1
    );
    assert!(group_entries
        .iter()
        .any(|entry| entry.id == first_entry.id || entry.id == second_entry.id));
    assert!(db
        .list_memory_entries(&first_scope, None, None, 10, 0)
        .unwrap()
        .is_empty());
    assert!(db
        .list_memory_entries(&second_scope, None, None, 10, 0)
        .unwrap()
        .is_empty());
    let tombstones: i64 = db
        .conn()
        .query_row(
            "SELECT COUNT(*) FROM memory_tombstones WHERE scope_key = ?1",
            params![group.id.as_str()],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(tombstones, 1);
    let state = db.memory_session_state(&session).unwrap().unwrap();
    assert_eq!(state.scope_key.as_deref(), Some(group.id.as_str()));

    // A later session on either root resolves to the group.
    let later = crate::sessions::create_session(
        &db,
        Some("Later".into()),
        None,
        None,
        None,
        Some(second.clone()),
    )
    .unwrap();
    let scope = db
        .learned_memory_scopes_for_session(&later.id)
        .unwrap()
        .unwrap()
        .remove(0);
    assert_eq!(scope.key.as_deref(), Some(group.id.as_str()));
}

/// A project that is already saved keeps its learned memory when it is put into
/// a new group, exactly as the legacy upgrade path does.
#[test]
fn an_existing_project_joining_a_new_group_keeps_its_learned_memory() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(&dir);
    let project = project_dir(&dir, "solo");
    let scope = db.learned_memory_scope_for_path(&project).unwrap();
    created(
        db.create_memory_entry(request(&scope, KIND_FACT, "Host is Rust.", ORIGIN_USER_UI))
            .unwrap(),
    );
    let gone = created(
        db.create_memory_entry(request(
            &scope,
            KIND_FACT,
            "Deploys on Fridays.",
            ORIGIN_USER_UI,
        ))
        .unwrap(),
    );
    db.delete_memory_entry(&gone.id).unwrap();
    let session = session_with_message(&db, &project, "u1", "user");
    db.set_memory_session_excluded(&session, true).unwrap();

    let group = db
        .create_project_group("Group", std::slice::from_ref(&project))
        .unwrap();
    let group_scope = MemoryScope::project(group.id.clone());
    let entries = db
        .list_memory_entries(&group_scope, None, None, 10, 0)
        .unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].content, "Host is Rust.");
    // The tombstone moved with the entry, so a deleted fact cannot come back.
    assert_eq!(
        rejection_of(
            &db.create_memory_entry(request(
                &group_scope,
                KIND_FACT,
                "Deploys on Fridays.",
                ORIGIN_USER_UI,
            ))
            .unwrap()
        )
        .code,
        REJECT_TOMBSTONED
    );
    // Nothing is left behind on the old path scope.
    assert!(db
        .list_memory_entries(&scope, None, None, 10, 0)
        .unwrap()
        .is_empty());
    let leftovers: i64 = db
        .conn()
        .query_row(
            "SELECT (SELECT COUNT(*) FROM memory_tombstones WHERE scope_key = ?1)
                  + (SELECT COUNT(*) FROM memory_session_state WHERE scope_key = ?1)",
            params![project],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(leftovers, 0);
    let state = db.memory_session_state(&session).unwrap().unwrap();
    assert_eq!(state.scope_key.as_deref(), Some(group.id.as_str()));
}

/// Adding an independent folder to a stored group moves that folder's learned
/// memory and tombstones with it.
#[test]
fn adding_an_independent_root_to_a_stored_group_moves_its_learned_memory() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(&dir);
    let first = project_dir(&dir, "first");
    let second = project_dir(&dir, "second");
    let group = db
        .create_project_group("Group", std::slice::from_ref(&first))
        .unwrap();
    let second_scope = db.learned_memory_scope_for_path(&second).unwrap();
    created(
        db.create_memory_entry(request(
            &second_scope,
            KIND_FACT,
            "Second project fact.",
            ORIGIN_USER_UI,
        ))
        .unwrap(),
    );
    let gone = created(
        db.create_memory_entry(request(
            &second_scope,
            KIND_FACT,
            "Deploys on Fridays.",
            ORIGIN_USER_UI,
        ))
        .unwrap(),
    );
    db.delete_memory_entry(&gone.id).unwrap();

    let group = db
        .update_project_group(&group.id, "Group", &[first.clone(), second.clone()], None)
        .unwrap();
    let group_scope = MemoryScope::project(group.id.clone());
    let entries = db
        .list_memory_entries(&group_scope, None, None, 10, 0)
        .unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].content, "Second project fact.");
    assert_eq!(
        rejection_of(
            &db.create_memory_entry(request(
                &group_scope,
                KIND_FACT,
                "Deploys on Fridays.",
                ORIGIN_USER_UI,
            ))
            .unwrap()
        )
        .code,
        REJECT_TOMBSTONED
    );
    assert!(db
        .list_memory_entries(&second_scope, None, None, 10, 0)
        .unwrap()
        .is_empty());
    let tombstones: i64 = db
        .conn()
        .query_row(
            "SELECT COUNT(*) FROM memory_tombstones WHERE scope_key = ?1",
            params![second],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(tombstones, 0);
    // The group resolves the added root to itself from now on.
    assert_eq!(
        db.learned_memory_scope_for_path(&second)
            .unwrap()
            .key
            .as_deref(),
        Some(group.id.as_str())
    );
}

/// Two roots that forgot the same content from different evidence must end up
/// with one tombstone that still blocks both citations.
#[test]
fn upgrading_roots_merges_tombstone_source_messages() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(&dir);
    let first = project_dir(&dir, "first");
    let second = project_dir(&dir, "second");
    let first_scope = db.learned_memory_scope_for_path(&first).unwrap();
    let second_scope = db.learned_memory_scope_for_path(&second).unwrap();
    let first_session = session_with_message(&db, &first, "a1", "user");
    let second_session = session_with_message(&db, &second, "b1", "user");

    for (scope, session_id, message_id) in [
        (&first_scope, &first_session, "a1"),
        (&second_scope, &second_session, "b1"),
    ] {
        let mut write = request(scope, KIND_FACT, "Deploys on Fridays.", ORIGIN_USER_UI);
        write.source_session_id = Some(session_id.clone());
        write.source_message_ids = vec![message_id.to_string()];
        let entry = created(db.create_memory_entry(write).unwrap());
        db.delete_memory_entry(&entry.id).unwrap();
    }

    let legacy = db.project_group_for_path(&first).unwrap().unwrap();
    let group = db
        .update_project_group(&legacy.id, "Group", &[first.clone(), second.clone()], None)
        .unwrap();
    let group_scope = MemoryScope::project(group.id.clone());
    let (count, ids): (i64, String) = db
        .conn()
        .query_row(
            "SELECT COUNT(*), MAX(source_message_ids) FROM memory_tombstones WHERE scope_key = ?1",
            params![group.id.as_str()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(count, 1, "one fingerprint keeps one tombstone");
    let ids = tombstones::parse_ids(&ids);
    assert!(
        ids.contains(&"a1".to_string()) && ids.contains(&"b1".to_string()),
        "both roots' evidence survives the merge: {ids:?}"
    );

    // Citing either root's evidence is still blocked.
    let mut restated = request(
        &group_scope,
        KIND_FACT,
        "Deploys on Fridays.",
        ORIGIN_USER_UI,
    );
    restated.source_message_ids = vec!["b1".to_string()];
    assert_eq!(
        rejection_of(&db.create_memory_entry(restated).unwrap()).code,
        REJECT_TOMBSTONED
    );
}

#[test]
fn removing_a_root_keeps_the_group_memory_and_deleting_the_group_removes_it() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(&dir);
    let first = project_dir(&dir, "first");
    let second = project_dir(&dir, "second");
    let group = db
        .create_project_group("Group", &[first.clone(), second.clone()])
        .unwrap();
    let group_scope = db.learned_memory_scope_for_path(&first).unwrap();
    assert_eq!(group_scope.key.as_deref(), Some(group.id.as_str()));
    created(
        db.create_memory_entry(request(
            &group_scope,
            KIND_FACT,
            "Group fact.",
            ORIGIN_USER_UI,
        ))
        .unwrap(),
    );

    db.remove_project_from_group(&group.id, &second).unwrap();
    assert_eq!(
        db.list_memory_entries(&group_scope, None, None, 10, 0)
            .unwrap()
            .len(),
        1
    );
    // Removing the root project itself keeps the group's memory too.
    db.delete_project_learned_memory(&second).unwrap();
    assert_eq!(
        db.list_memory_entries(&group_scope, None, None, 10, 0)
            .unwrap()
            .len(),
        1
    );

    db.delete_project_group_record(&group.id).unwrap();
    assert!(db
        .list_memory_entries(&group_scope, None, None, 10, 0)
        .unwrap()
        .is_empty());
    // The project rows survive, so the paths fall back to their legacy
    // projection with no group record behind it.
    assert!(db.project_group_for_path(&first).unwrap().unwrap().legacy);
}

// ---- extraction state ------------------------------------------------------

#[test]
fn extraction_lease_has_one_owner_and_the_cursor_only_moves_forward() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(&dir);
    let project = project_dir(&dir, "app");
    let session = session_with_message(&db, &project, "u1", "user");
    let scope = db.learned_memory_scope_for_path(&project).unwrap();

    let claimed = db
        .claim_memory_extraction(&session, "run-a", EXTRACTION_LEASE_MS)
        .unwrap()
        .unwrap();
    assert_eq!(claimed.scope_key.as_deref(), scope.key.as_deref());
    assert_eq!(claimed.cursor_seq, 0);
    // A second trigger while the lease is held is a no-op.
    assert!(db
        .claim_memory_extraction(&session, "run-b", EXTRACTION_LEASE_MS)
        .unwrap()
        .is_none());
    // A non-owner cannot advance the cursor or record a failure.
    assert!(db
        .complete_memory_extraction(&session, "run-b", 7)
        .unwrap()
        .is_none());
    assert!(db
        .fail_memory_extraction(&session, "run-b", "MODEL_ERROR")
        .unwrap()
        .is_none());

    let completed = db
        .complete_memory_extraction(&session, "run-a", 7)
        .unwrap()
        .unwrap();
    assert_eq!(completed.cursor_seq, 7);
    assert_eq!(completed.attempts, 0);
    // A later run cannot rewind the cursor.
    let next = db
        .claim_memory_extraction(&session, "run-a2", EXTRACTION_LEASE_MS)
        .unwrap()
        .unwrap();
    assert_eq!(next.cursor_seq, 7);
    let replayed = db
        .complete_memory_extraction(&session, "run-a2", 3)
        .unwrap()
        .unwrap();
    assert_eq!(replayed.cursor_seq, 7);

    let failed = db
        .claim_memory_extraction(&session, "run-c", EXTRACTION_LEASE_MS)
        .unwrap()
        .unwrap();
    assert_eq!(failed.cursor_seq, 7);
    let failed = db
        .fail_memory_extraction(&session, "run-c", "MODEL_ERROR")
        .unwrap()
        .unwrap();
    assert_eq!(failed.attempts, 1);
    assert_eq!(failed.last_error.as_deref(), Some("MODEL_ERROR"));
    assert!(failed.lease_owner.is_none());
    // The cursor survived the failure, so the range is retried.
    assert_eq!(failed.cursor_seq, 7);

    // An excluded session is never claimed, and re-including it works again.
    db.set_memory_session_excluded(&session, true).unwrap();
    assert!(db
        .claim_memory_extraction(&session, "run-d", EXTRACTION_LEASE_MS)
        .unwrap()
        .is_none());
    db.set_memory_session_excluded(&session, false).unwrap();
    assert!(db
        .claim_memory_extraction(&session, "run-d", EXTRACTION_LEASE_MS)
        .unwrap()
        .is_some());
}

#[test]
fn extraction_state_is_removed_with_its_session() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(&dir);
    let project = project_dir(&dir, "app");
    let session = session_with_message(&db, &project, "u1", "user");
    db.claim_memory_extraction(&session, "run-a", EXTRACTION_LEASE_MS)
        .unwrap();
    crate::sessions::delete_session(&db, &session).unwrap();
    let count: i64 = db
        .conn()
        .query_row("SELECT COUNT(*) FROM memory_session_state", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(count, 0);
}

#[test]
fn fingerprint_ignores_case_width_and_spacing() {
    let plain = tombstones::fingerprint(KIND_FACT, "Prefers terse replies");
    assert_eq!(
        plain,
        tombstones::fingerprint(KIND_FACT, "  prefers   TERSE   replies ")
    );
    // Fullwidth forms fold onto their ASCII equivalents (NFKC).
    assert_eq!(
        tombstones::fingerprint(KIND_FACT, "terse replies"),
        tombstones::fingerprint(
            KIND_FACT,
            "\u{FF54}\u{FF45}\u{FF52}\u{FF53}\u{FF45} replies"
        )
    );
    assert_ne!(
        plain,
        tombstones::fingerprint(KIND_REFERENCE, "Prefers terse replies")
    );
}
