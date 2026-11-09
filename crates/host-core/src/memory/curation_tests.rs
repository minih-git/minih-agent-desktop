//! Automatic-curation tests (ADR learned-memory-consolidation §4-§5).
//!
//! Each guardrail has its own case, because a rule that only lives in a prompt
//! is a rule a model can ignore: the cap, the user's quiet window, the
//! "never reword what the user typed" rule, tombstones, the revision check, and
//! the four undo paths.

use rusqlite::params;

use super::curation::*;
use super::model::*;
use super::repository::*;
use super::tombstones;
use crate::db::Database;

fn open(dir: &tempfile::TempDir) -> Database {
    Database::open(&dir.path().join("pi.sqlite")).unwrap()
}

fn scope(dir: &tempfile::TempDir, db: &Database, name: &str) -> MemoryScope {
    let path = dir.path().join(name);
    std::fs::create_dir_all(&path).unwrap();
    db.learned_memory_scope_for_path(path.to_str().unwrap())
        .unwrap()
}

fn make(
    db: &Database,
    scope: &MemoryScope,
    kind: &str,
    content: &str,
    origin: &str,
) -> MemoryEntryRecord {
    match db
        .create_memory_entry(CreateMemoryRequest {
            scope: scope.clone(),
            kind: kind.to_string(),
            content: content.to_string(),
            rationale: Some("observed".into()),
            origin: origin.to_string(),
            evidence: if origin == ORIGIN_EXTRACTED {
                EVIDENCE_INFERRED.to_string()
            } else {
                EVIDENCE_USER_STATED.to_string()
            },
            status: if origin == ORIGIN_EXTRACTED {
                STATUS_SUGGESTED.to_string()
            } else {
                STATUS_ACTIVE.to_string()
            },
            source_session_id: None,
            source_message_ids: Vec::new(),
            override_tombstone: false,
        })
        .unwrap()
    {
        CreateMemoryOutcome::Created(entry) => *entry,
        CreateMemoryOutcome::Duplicate(entry) => *entry,
        CreateMemoryOutcome::Rejected(rejection) => panic!("write refused: {}", rejection.code),
    }
}

fn entry(db: &Database, id: &str) -> MemoryEntryRecord {
    db.conn()
        .query_row(
            "SELECT id, scope_kind, scope_key, kind, content, rationale, status, origin, evidence,
                    source_session_id, source_message_ids, fingerprint, revision, superseded_by,
                    created_at, updated_at, last_used_at, use_count
               FROM memory_entries WHERE id = ?1",
            params![id],
            |row| {
                let raw: String = row.get(10)?;
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
                    source_message_ids: tombstones::parse_ids(&raw),
                    fingerprint: row.get(11)?,
                    revision: row.get(12)?,
                    superseded_by: row.get(13)?,
                    created_at: row.get(14)?,
                    updated_at: row.get(15)?,
                    last_used_at: row.get(16)?,
                    use_count: row.get(17)?,
                })
            },
        )
        .unwrap()
}

fn count(db: &Database, sql: &str) -> i64 {
    db.conn().query_row(sql, [], |row| row.get(0)).unwrap()
}

fn op(kind: &str, targets: &[&MemoryEntryRecord], content: Option<&str>) -> CurationOpRequest {
    CurationOpRequest {
        op: kind.to_string(),
        target_ids: targets.iter().map(|entry| entry.id.clone()).collect(),
        target_revisions: targets.iter().map(|entry| entry.revision).collect(),
        content: content.map(str::to_string),
        reason: Some("two notes say the same thing".into()),
        kind: None,
    }
}

/// Age a note past the user's quiet window: curation leaves a note touched in
/// the last 30 days alone, so a test that wants one curated has to say so.
fn age(db: &Database, note: &MemoryEntryRecord, days: i64) -> MemoryEntryRecord {
    let older = crate::db::now_ms() - days * 24 * 3600 * 1000;
    db.conn()
        .execute(
            "UPDATE memory_entries SET created_at = ?1, updated_at = ?1 WHERE id = ?2",
            params![older, note.id],
        )
        .unwrap();
    entry(db, &note.id)
}

// ---- guardrails ------------------------------------------------------------

#[test]
fn merge_archives_its_targets_with_a_successor_link() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(&dir);
    let scope = scope(&dir, &db, "app");
    let first = age(
        &db,
        &make(
            &db,
            &scope,
            KIND_FACT,
            "The gateway port is 8787.",
            ORIGIN_USER_UI,
        ),
        40,
    );
    let second = age(
        &db,
        &make(
            &db,
            &scope,
            KIND_FACT,
            "Gateway listens on port 8787.",
            ORIGIN_USER_UI,
        ),
        40,
    );
    let third = age(
        &db,
        &make(
            &db,
            &scope,
            KIND_FACT,
            "Port 8787 serves the gateway.",
            ORIGIN_USER_UI,
        ),
        40,
    );

    let report = db
        .apply_memory_curation(
            &scope,
            &[op(
                CURATION_OP_MERGE,
                &[&first, &second, &third],
                Some("The gateway listens on port 8787."),
            )],
            None,
        )
        .unwrap();
    assert_eq!(report.applied, 1);
    assert_eq!(report.outcomes[0].result, CURATION_APPLIED);

    let archived = entry(&db, &first.id);
    assert_eq!(archived.status, STATUS_ARCHIVED);
    let successor = archived
        .superseded_by
        .expect("the target points at its merge");
    let merged = entry(&db, &successor);
    assert_eq!(merged.status, STATUS_ACTIVE);
    assert_eq!(merged.content, "The gateway listens on port 8787.");
    assert_eq!(merged.origin, ORIGIN_USER_UI);
    // One batch, three archives plus the new note.
    let rows: i64 = count(
        &db,
        "SELECT COUNT(*) FROM memory_revisions WHERE op IN ('merge_new','merge_archive')",
    );
    assert_eq!(rows, 4);
}

#[test]
fn automatic_changes_never_write_a_tombstone() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(&dir);
    let scope = scope(&dir, &db, "app");
    let first = age(
        &db,
        &make(&db, &scope, KIND_FACT, "Deploys on Friday.", ORIGIN_USER_UI),
        40,
    );
    let second = age(
        &db,
        &make(
            &db,
            &scope,
            KIND_FACT,
            "Deploys every Friday.",
            ORIGIN_USER_UI,
        ),
        40,
    );

    db.apply_memory_curation(
        &scope,
        &[op(CURATION_OP_REPLACE, &[&first, &second], None)],
        None,
    )
    .unwrap();
    assert_eq!(count(&db, "SELECT COUNT(*) FROM memory_tombstones"), 0);
}

#[test]
fn the_cap_stops_a_pass_at_a_fifth_of_the_scope() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(&dir);
    let scope = scope(&dir, &db, "app");
    // Five active notes: a fifth of five is one, so one item may land.
    let mut notes = Vec::new();
    for index in 0..5 {
        let note = make(
            &db,
            &scope,
            KIND_FACT,
            &format!("Fact number {index}."),
            ORIGIN_USER_UI,
        );
        notes.push(age(&db, &note, 40));
    }
    let ops: Vec<CurationOpRequest> = notes
        .iter()
        .map(|note| CurationOpRequest {
            op: CURATION_OP_REWORD.to_string(),
            target_ids: vec![note.id.clone()],
            target_revisions: vec![note.revision],
            content: Some("A better wording.".into()),
            reason: None,
            kind: None,
        })
        .collect();
    // Rewording what the user wrote is refused anyway, so drive the cap with a
    // kind the host would otherwise accept.
    for note in &notes {
        db.conn()
            .execute(
                "UPDATE memory_entries SET origin = ?1 WHERE id = ?2",
                params![ORIGIN_EXTRACTED, note.id],
            )
            .unwrap();
    }
    let report = db.apply_memory_curation(&scope, &ops, None).unwrap();
    assert_eq!(report.cap, 1);
    assert_eq!(report.applied, 1);
    assert!(report.capped);
    assert_eq!(report.outcomes[1].result, CURATION_CAPPED);
    let changed: i64 = count(
        &db,
        "SELECT COUNT(*) FROM memory_entries WHERE content = 'A better wording.'",
    );
    assert_eq!(changed, 1);
}

#[test]
fn a_note_the_user_touched_recently_is_left_alone() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(&dir);
    let scope = scope(&dir, &db, "app");
    // The newer note replaces the older one; the older is the target a pass may
    // put away, and it is outside the quiet window.
    let old = age(
        &db,
        &make(&db, &scope, KIND_FACT, "Old note.", ORIGIN_USER_UI),
        40,
    );
    let fresh = make(&db, &scope, KIND_FACT, "Just written.", ORIGIN_USER_UI);

    let report = db
        .apply_memory_curation(
            &scope,
            &[op(CURATION_OP_REPLACE, &[&fresh, &old], None)],
            None,
        )
        .unwrap();
    assert_eq!(report.outcomes[0].result, CURATION_APPLIED);
    assert_eq!(entry(&db, &old.id).status, STATUS_ARCHIVED);
    assert_eq!(entry(&db, &fresh.id).status, STATUS_ACTIVE);
}

#[test]
fn a_pass_leaves_a_note_the_user_just_edited_alone() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(&dir);
    let scope = scope(&dir, &db, "app");
    let edited = age(
        &db,
        &make(&db, &scope, KIND_FACT, "Written long ago.", ORIGIN_USER_UI),
        40,
    );
    let successor = make(&db, &scope, KIND_FACT, "Written just now.", ORIGIN_USER_UI);
    // The user rewrites the old note today.
    db.update_memory_entry(UpdateMemoryRequest {
        id: edited.id.clone(),
        revision: edited.revision,
        content: Some("Rewritten today.".into()),
        rationale: None,
        kind: None,
        scope: None,
    })
    .unwrap();
    let edited = entry(&db, &edited.id);

    let report = db
        .apply_memory_curation(
            &scope,
            &[op(CURATION_OP_REPLACE, &[&successor, &edited], None)],
            None,
        )
        .unwrap();
    assert_eq!(report.outcomes[0].result, CURATION_USER_EDITED);
    assert_eq!(entry(&db, &edited.id).status, STATUS_ACTIVE);
    assert_eq!(entry(&db, &successor.id).status, STATUS_ACTIVE);
}

#[test]
fn a_note_the_user_wrote_is_never_rewritten() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(&dir);
    let scope = scope(&dir, &db, "app");
    let mine = age(
        &db,
        &make(
            &db,
            &scope,
            KIND_FACT,
            "Our gateway listens on 8787.",
            ORIGIN_EXPLICIT,
        ),
        40,
    );

    let report = db
        .apply_memory_curation(
            &scope,
            &[op(CURATION_OP_REWORD, &[&mine], Some("Gateway: 8787."))],
            None,
        )
        .unwrap();
    assert_eq!(report.outcomes[0].result, CURATION_EXPLICIT_REWORD);
    assert_eq!(entry(&db, &mine.id).content, "Our gateway listens on 8787.");
}

#[test]
fn a_reword_bumps_the_revision_of_an_extracted_note() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(&dir);
    let scope = scope(&dir, &db, "app");
    let extracted = make(
        &db,
        &scope,
        KIND_FACT,
        "the gateway runs on port 8787",
        ORIGIN_EXTRACTED,
    );
    let extracted = age(&db, &extracted, 40);
    db.activate_memory_suggestions(&scope, std::slice::from_ref(&extracted.id), None)
        .unwrap();
    // Activation stamps `updated_at`, so the note is the user's (a pass did it)
    // or nobody's; `set` it back outside the quiet window to make it eligible.
    let active = age(&db, &entry(&db, &extracted.id), 40);
    let report = db
        .apply_memory_curation(
            &scope,
            &[op(
                CURATION_OP_REWORD,
                &[&active],
                Some("The gateway runs on port 8787."),
            )],
            None,
        )
        .unwrap();
    assert_eq!(report.outcomes[0].result, CURATION_APPLIED);
    let rewritten = entry(&db, &active.id);
    assert_eq!(rewritten.content, "The gateway runs on port 8787.");
    assert_eq!(rewritten.revision, active.revision + 1);
    assert_eq!(rewritten.origin, ORIGIN_EXTRACTED);
}

#[test]
fn a_merge_cannot_resurrect_a_forgotten_note() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(&dir);
    let scope = scope(&dir, &db, "app");
    let first = age(
        &db,
        &make(&db, &scope, KIND_FACT, "Deploys on Friday.", ORIGIN_USER_UI),
        40,
    );
    let second = age(
        &db,
        &make(
            &db,
            &scope,
            KIND_FACT,
            "Deploys every Friday.",
            ORIGIN_USER_UI,
        ),
        40,
    );
    // The user forgot exactly the sentence a merge would produce.
    tombstones::write(
        db.conn(),
        &scope,
        &tombstones::fingerprint(KIND_FACT, "Weekly deploy is on Friday."),
        None,
        &[],
        crate::db::now_ms(),
    )
    .unwrap();

    let report = db
        .apply_memory_curation(
            &scope,
            &[op(
                CURATION_OP_MERGE,
                &[&first, &second],
                Some("Weekly deploy is on Friday."),
            )],
            None,
        )
        .unwrap();
    assert_eq!(report.outcomes[0].result, REJECT_TOMBSTONED);
    assert_eq!(
        count(
            &db,
            "SELECT COUNT(*) FROM memory_entries WHERE status = 'active'"
        ),
        2
    );
}

#[test]
fn a_merge_result_still_passes_the_write_rules() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(&dir);
    let scope = scope(&dir, &db, "app");
    let first = age(
        &db,
        &make(&db, &scope, KIND_FACT, "Deploys on Friday.", ORIGIN_USER_UI),
        40,
    );
    let second = age(
        &db,
        &make(
            &db,
            &scope,
            KIND_FACT,
            "Deploys every Friday.",
            ORIGIN_USER_UI,
        ),
        40,
    );
    let token = format!("sk-{}", "a".repeat(32));
    let report = db
        .apply_memory_curation(
            &scope,
            &[op(
                CURATION_OP_MERGE,
                &[&first, &second],
                Some(&format!("deploy key {token}")),
            )],
            None,
        )
        .unwrap();
    assert_eq!(report.outcomes[0].result, REJECT_CREDENTIAL_DETECTED);
    assert_eq!(
        count(
            &db,
            "SELECT COUNT(*) FROM memory_entries WHERE status = 'active'"
        ),
        2
    );
}

#[test]
fn a_stale_target_voids_the_whole_item() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(&dir);
    let scope = scope(&dir, &db, "app");
    let first = age(
        &db,
        &make(&db, &scope, KIND_FACT, "Deploys on Friday.", ORIGIN_USER_UI),
        40,
    );
    let second = age(
        &db,
        &make(
            &db,
            &scope,
            KIND_FACT,
            "Deploys every Friday.",
            ORIGIN_USER_UI,
        ),
        40,
    );
    // The user edits one target after the pass read it.
    db.update_memory_entry(UpdateMemoryRequest {
        id: second.id.clone(),
        revision: second.revision,
        content: Some("Deploys on the last Friday of the month.".into()),
        rationale: None,
        kind: None,
        scope: None,
    })
    .unwrap();

    let report = db
        .apply_memory_curation(
            &scope,
            &[op(
                CURATION_OP_MERGE,
                &[&first, &second],
                Some("Deploys on Friday."),
            )],
            None,
        )
        .unwrap();
    assert_eq!(report.outcomes[0].result, CURATION_STALE);
    assert_eq!(report.applied, 0);
    assert_eq!(entry(&db, &first.id).status, STATUS_ACTIVE);
    assert_eq!(entry(&db, &second.id).status, STATUS_ACTIVE);
    assert_eq!(count(&db, "SELECT COUNT(*) FROM memory_revisions"), 0);
}

// ---- undo ------------------------------------------------------------------

#[test]
fn undoing_a_merge_restores_the_targets_and_rejects_the_set() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(&dir);
    let scope = scope(&dir, &db, "app");
    let first = age(
        &db,
        &make(&db, &scope, KIND_FACT, "Deploys on Friday.", ORIGIN_USER_UI),
        40,
    );
    let second = age(
        &db,
        &make(
            &db,
            &scope,
            KIND_FACT,
            "Weekly deploys happen on Friday.",
            ORIGIN_USER_UI,
        ),
        40,
    );
    let report = db
        .apply_memory_curation(
            &scope,
            &[op(
                CURATION_OP_MERGE,
                &[&first, &second],
                Some("Every weekly deploy happens on Friday."),
            )],
            None,
        )
        .unwrap();
    let merged_id = entry(&db, &first.id)
        .superseded_by
        .expect("the merged note is linked");

    assert_eq!(
        db.undo_memory_curation(&report.batch_id).unwrap(),
        CurationUndoReport::Undone { undone: 3 }
    );
    let restored = entry(&db, &first.id);
    assert_eq!(restored.status, STATUS_ACTIVE);
    assert!(restored.superseded_by.is_none());
    assert_eq!(entry(&db, &second.id).status, STATUS_ACTIVE);
    assert_eq!(entry(&db, &merged_id).status, STATUS_ARCHIVED);
    // The set is remembered, so the same merge is not proposed again.
    let again = db
        .apply_memory_curation(
            &scope,
            &[op(
                CURATION_OP_MERGE,
                &[&restored, &entry(&db, &second.id)],
                Some("Every weekly deploy happens on Friday."),
            )],
            None,
        )
        .unwrap();
    // Both notes are back and untouched, so nothing shields them; the refused
    // set is what stops the same merge from being proposed again.
    assert_eq!(again.outcomes[0].result, CURATION_ALREADY_DONE);
}

#[test]
fn undoing_a_replace_restores_the_old_note() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(&dir);
    let scope = scope(&dir, &db, "app");
    let old = age(
        &db,
        &make(
            &db,
            &scope,
            KIND_FACT,
            "Deliver after the metadata check.",
            ORIGIN_USER_UI,
        ),
        40,
    );
    let new = make(
        &db,
        &scope,
        KIND_FACT,
        "Deliver after a full download check.",
        ORIGIN_USER_UI,
    );
    let report = db
        .apply_memory_curation(
            &scope,
            &[op(CURATION_OP_REPLACE, &[&old, &new], None)],
            None,
        )
        .unwrap();
    assert_eq!(report.outcomes[0].result, CURATION_APPLIED);
    assert_eq!(entry(&db, &old.id).status, STATUS_ARCHIVED);
    assert_eq!(
        entry(&db, &old.id).superseded_by.as_deref(),
        Some(new.id.as_str())
    );

    db.undo_memory_curation(&report.batch_id).unwrap();
    let restored = entry(&db, &old.id);
    assert_eq!(restored.status, STATUS_ACTIVE);
    assert!(restored.superseded_by.is_none());
    assert_eq!(entry(&db, &new.id).status, STATUS_ACTIVE);
}

#[test]
fn undoing_a_reword_puts_the_original_wording_back() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(&dir);
    let scope = scope(&dir, &db, "app");
    let note = make(&db, &scope, KIND_FACT, "gateway on 8787", ORIGIN_EXTRACTED);
    let note = age(&db, &note, 40);
    db.activate_memory_suggestions(&scope, std::slice::from_ref(&note.id), None)
        .unwrap();
    let active = entry(&db, &note.id);
    let report = db
        .apply_memory_curation(
            &scope,
            &[op(
                CURATION_OP_REWORD,
                &[&active],
                Some("The gateway listens on port 8787."),
            )],
            None,
        )
        .unwrap();
    db.undo_memory_curation(&report.batch_id).unwrap();
    let restored = entry(&db, &note.id);
    assert_eq!(restored.content, "gateway on 8787");
    assert_eq!(
        restored.fingerprint,
        tombstones::fingerprint(KIND_FACT, "gateway on 8787")
    );
}

#[test]
fn undoing_an_activation_erases_the_note_and_blocks_its_evidence() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(&dir);
    let scope = scope(&dir, &db, "app");
    let note = make(&db, &scope, KIND_FACT, "Learned fact.", ORIGIN_EXTRACTED);
    let report = db
        .activate_memory_suggestions(&scope, std::slice::from_ref(&note.id), None)
        .unwrap();
    assert_eq!(report.activated, vec![note.id.clone()]);

    db.undo_memory_curation(&report.batch_id).unwrap();
    assert_eq!(count(&db, "SELECT COUNT(*) FROM memory_entries"), 0);
    // The user's own decision, so it may write the tombstone that keeps the
    // same evidence from proposing the note again.
    assert_eq!(count(&db, "SELECT COUNT(*) FROM memory_tombstones"), 1);
}

#[test]
fn an_undo_conflicts_when_the_note_moved_since_the_pass() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(&dir);
    let scope = scope(&dir, &db, "app");
    let old = age(
        &db,
        &make(
            &db,
            &scope,
            KIND_FACT,
            "Deliver after the metadata check.",
            ORIGIN_USER_UI,
        ),
        40,
    );
    let new = make(
        &db,
        &scope,
        KIND_FACT,
        "Deliver after a full download check.",
        ORIGIN_USER_UI,
    );
    let report = db
        .apply_memory_curation(
            &scope,
            &[op(CURATION_OP_REPLACE, &[&old, &new], None)],
            None,
        )
        .unwrap();
    // The user edits the archived note afterwards.
    db.set_memory_entry_status(&old.id, STATUS_ACTIVE).unwrap();

    assert_eq!(
        db.undo_memory_curation(&report.batch_id).unwrap(),
        CurationUndoReport::Conflict
    );
    // Nothing changed by the refused undo.
    assert_eq!(entry(&db, &old.id).status, STATUS_ACTIVE);
    assert_eq!(
        count(&db, "SELECT COUNT(*) FROM memory_curation_rejections"),
        0
    );
}

#[test]
fn a_repeated_undo_reports_already_undone() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(&dir);
    let scope = scope(&dir, &db, "app");
    let note = make(&db, &scope, KIND_FACT, "Learned fact.", ORIGIN_EXTRACTED);
    let report = db
        .activate_memory_suggestions(&scope, std::slice::from_ref(&note.id), None)
        .unwrap();
    db.undo_memory_curation(&report.batch_id).unwrap();
    assert_eq!(
        db.undo_memory_curation(&report.batch_id).unwrap(),
        CurationUndoReport::AlreadyUndone
    );
}

// ---- activation and dirty scopes -------------------------------------------

#[test]
fn a_backlog_of_suggestions_activates_in_batches() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(&dir);
    let scope = scope(&dir, &db, "app");
    let mut ids = Vec::new();
    for index in 0..7 {
        let note = make(
            &db,
            &scope,
            KIND_FACT,
            &format!("Learned fact {index}."),
            ORIGIN_EXTRACTED,
        );
        ids.push(note.id);
    }
    let first = db.activate_memory_suggestions(&scope, &ids, None).unwrap();
    // The cap is twenty percent of the scope's active notes, at least one.
    assert_eq!(first.cap, 1);
    assert_eq!(first.activated.len(), 1);
    assert!(first.capped);
    let second = db.activate_memory_suggestions(&scope, &ids, None).unwrap();
    assert_eq!(second.activated.len(), 1);
    assert_ne!(first.activated, second.activated);
}

#[test]
fn an_activation_only_touches_extracted_suggestions() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(&dir);
    let scope = scope(&dir, &db, "app");
    let mine = make(
        &db,
        &scope,
        KIND_FACT,
        "A note the user wrote.",
        ORIGIN_USER_UI,
    );
    let report = db
        .activate_memory_suggestions(&scope, std::slice::from_ref(&mine.id), None)
        .unwrap();
    assert!(report.activated.is_empty());
    assert_eq!(entry(&db, &mine.id).status, STATUS_ACTIVE);
}

#[test]
fn a_write_marks_its_scope_dirty_and_a_pass_clears_it() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(&dir);
    let scope = scope(&dir, &db, "app");
    assert!(!db.memory_curation_dirty(&scope).unwrap());
    let first = make(&db, &scope, KIND_FACT, "Deploys on Friday.", ORIGIN_USER_UI);
    assert!(db.memory_curation_dirty(&scope).unwrap());
    assert!(db.dirty_memory_curation_scopes().unwrap().contains(&scope));

    let second = make(
        &db,
        &scope,
        KIND_FACT,
        "Deploys every Friday.",
        ORIGIN_USER_UI,
    );
    assert!(db
        .claim_memory_curation(&scope, "auto", "2026-11-10", CURATION_LEASE_MS)
        .unwrap());
    // One pass per local day.
    assert!(!db
        .claim_memory_curation(&scope, "auto", "2026-11-10", CURATION_LEASE_MS)
        .unwrap());
    assert_eq!(
        db.memory_curation_claim_refusal(&scope, "2026-11-10")
            .unwrap(),
        SKIP_ALREADY_RAN_TODAY
    );
    let input = match db.memory_curation_input(&scope).unwrap() {
        CurationInputOutcome::Input(input) => input,
        CurationInputOutcome::Skipped(reason) => panic!("expected input, got {reason}"),
    };
    assert_eq!(input.scope_kind, scope.kind);
    assert_eq!(input.cap, 1);
    assert!(!input.changed.is_empty());
    assert!(input
        .changed
        .iter()
        .chain(input.neighbours.iter())
        .chain(input.others.iter())
        .any(|item| item.id == first.id));
    db.complete_memory_curation(&scope, "auto", "2026-11-10")
        .unwrap();
    assert!(!db.memory_curation_dirty(&scope).unwrap());
    assert_eq!(entry(&db, &second.id).status, STATUS_ACTIVE);
    // A new change the next day makes the scope eligible again.
    make(
        &db,
        &scope,
        KIND_FACT,
        "Deploys every other Friday.",
        ORIGIN_USER_UI,
    );
    assert!(db
        .claim_memory_curation(&scope, "auto", "2026-11-11", CURATION_LEASE_MS)
        .unwrap());
}

#[test]
fn an_untouched_scope_has_nothing_to_curate() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(&dir);
    let scope = scope(&dir, &db, "app");
    match db.memory_curation_input(&scope).unwrap() {
        CurationInputOutcome::Skipped(reason) => assert_eq!(reason, SKIP_NOTHING_CHANGED),
        CurationInputOutcome::Input(_) => panic!("an untouched scope must not be curated"),
    }
}

#[test]
fn deleting_a_project_drops_its_curation_state() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(&dir);
    let scope = scope(&dir, &db, "app");
    make(&db, &scope, KIND_FACT, "Deploys on Friday.", ORIGIN_USER_UI);
    assert!(db.memory_curation_dirty(&scope).unwrap());
    db.delete_learned_memory_scope(&scope).unwrap();
    assert_eq!(count(&db, "SELECT COUNT(*) FROM memory_curation_state"), 0);
}

#[test]
fn the_curation_list_shows_a_batch_and_drops_it_once_undone() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(&dir);
    let scope = scope(&dir, &db, "app");
    let note = make(&db, &scope, KIND_FACT, "Learned fact.", ORIGIN_EXTRACTED);
    let report = db
        .activate_memory_suggestions(&scope, std::slice::from_ref(&note.id), None)
        .unwrap();
    let since = crate::db::now_ms() - 24 * 3600 * 1000;
    let rows = db.memory_curation_batches(&scope, since, 50).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].batch_id, report.batch_id);
    assert_eq!(rows[0].op, REVISION_ACTIVATE);
    assert_eq!(db.count_memory_curation_changes(&scope, since).unwrap(), 1);

    db.undo_memory_curation(&report.batch_id).unwrap();
    assert!(db
        .memory_curation_batches(&scope, since, 50)
        .unwrap()
        .is_empty());
    assert_eq!(db.count_memory_curation_changes(&scope, since).unwrap(), 0);
}
