//! The employee scope: who reads it, and what it looks like at session start
//! (employee mode 0.5 slice 5).
//!
//! The rule the tests protect is one line of the ADR: a *task* reads the lessons
//! of the employee that owns it, and nothing else does. An employee container or
//! the steward reading them would put yesterday's work into the conversation the
//! person is having right now, as if the employee had said it.

use rusqlite::params;

use super::model::*;
use super::repository::*;
use super::tests::{open, project_dir, request};
use crate::db::Database;
/// A session row with an explicit role, which is what decides the scopes.
fn session(db: &Database, id: &str, role: &str, owner: Option<&str>, project: Option<&str>) {
    // The project row is what a session's project scope is derived from.
    if let Some(path) = project {
        db.conn()
            .execute(
                "INSERT OR IGNORE INTO projects (path, name, created_at, last_opened_at)
                 VALUES (?1, 'repo', 1, 1)",
                params![path],
            )
            .unwrap();
    }
    let project_id: Option<i64> = project.and_then(|path| {
        db.conn()
            .query_row(
                "SELECT id FROM projects WHERE path = ?1",
                params![path],
                |row| row.get(0),
            )
            .ok()
    });
    db.conn()
        .execute(
            "INSERT INTO sessions (id, title, role, owner_session_id, project_id, created_at, updated_at)
             VALUES (?1, ?1, ?2, ?3, ?4, 1, 1)",
            params![id, role, owner, project_id],
        )
        .unwrap();
}

fn lesson(db: &Database, employee: &str, content: &str) {
    // `inferred` is what extraction writes for a lesson, and it needs no cited
    // user message: the source is the employee's own task, not the person.
    let outcome = db
        .create_memory_entry(CreateMemoryRequest {
            scope: MemoryScope::bot(employee),
            kind: "fact".to_string(),
            content: content.to_string(),
            rationale: None,
            origin: ORIGIN_EXTRACTED.to_string(),
            evidence: EVIDENCE_INFERRED.to_string(),
            status: STATUS_ACTIVE.to_string(),
            source_session_id: None,
            source_message_ids: Vec::new(),
            override_tombstone: false,
        })
        .unwrap();
    assert!(
        matches!(outcome, CreateMemoryOutcome::Created(_)),
        "the lesson was not stored"
    );
}

fn kinds(scopes: &[MemoryScope]) -> Vec<(String, String)> {
    scopes
        .iter()
        .map(|scope| (scope.kind.to_string(), scope.stored_key().to_string()))
        .collect()
}

#[test]
fn a_task_session_reads_its_employee_lessons_and_no_other_session_does() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(&dir);
    let project = project_dir(&dir, "repo");
    session(&db, "employee-1", "bot", None, Some(&project));
    session(&db, "steward", "bot", None, Some(&project));
    session(&db, "task-1", "task", Some("employee-1"), Some(&project));
    session(
        &db,
        "task-of-steward",
        "task",
        Some("steward"),
        Some(&project),
    );
    session(&db, "chat", "user", None, Some(&project));

    let task = kinds(
        &db.learned_memory_scopes_for_session("task-1")
            .unwrap()
            .unwrap(),
    );
    assert_eq!(task.first().unwrap().0, SCOPE_BOT);
    assert_eq!(task.first().unwrap().1, "employee-1");
    // The project and user scopes are still there, after the lessons.
    assert_eq!(task.len(), 3);
    assert_eq!(task[2].0, SCOPE_USER);

    // The employee container itself, the person's own conversation, and a task
    // that belongs to another employee never read `employee-1`.
    for session_id in ["employee-1", "chat"] {
        let scopes = kinds(
            &db.learned_memory_scopes_for_session(session_id)
                .unwrap()
                .unwrap(),
        );
        assert!(
            scopes.iter().all(|(kind, _)| kind != SCOPE_BOT),
            "{session_id} must not read an employee scope: {scopes:?}"
        );
    }
    // Another employee's task reads that employee, not this one.
    let other = kinds(
        &db.learned_memory_scopes_for_session("task-of-steward")
            .unwrap()
            .unwrap(),
    );
    assert_eq!(other.first().unwrap().1, "steward");
    // An unknown session is not a scope list.
    assert!(db
        .learned_memory_scopes_for_session("missing")
        .unwrap()
        .is_none());
}

#[test]
fn the_session_index_keeps_lessons_out_of_the_dated_notes() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(&dir);
    let project = project_dir(&dir, "repo");
    session(&db, "employee-1", "bot", None, Some(&project));
    session(&db, "task-1", "task", Some("employee-1"), Some(&project));
    session(&db, "chat", "user", None, Some(&project));

    db.create_memory_entry(request(
        &db.learned_memory_scope_for_path(&project).unwrap(),
        "fact",
        "the gate runs cargo fmt first",
        ORIGIN_USER_UI,
    ))
    .unwrap();
    db.create_memory_entry(request(
        &MemoryScope::user(),
        "fact",
        "reply in Chinese",
        ORIGIN_USER_UI,
    ))
    .unwrap();
    lesson(&db, "employee-1", "the migration test needs a v38 fixture");

    let index = db
        .learned_memory_index_for_session("task-1")
        .unwrap()
        .unwrap();
    let contents: Vec<&str> = index
        .entries
        .iter()
        .map(|entry| entry.content.as_str())
        .collect();
    assert!(contents.contains(&"the gate runs cargo fmt first"));
    assert!(contents.contains(&"reply in Chinese"));
    assert!(!contents.contains(&"the migration test needs a v38 fixture"));
    assert_eq!(index.lessons.len(), 1);
    assert_eq!(
        index.lessons[0].content,
        "the migration test needs a v38 fixture"
    );
    assert_eq!(index.lessons[0].scope_kind, SCOPE_BOT);

    // The person's own conversation gets the same dated notes and no lessons.
    let plain = db
        .learned_memory_index_for_session("chat")
        .unwrap()
        .unwrap();
    assert_eq!(plain.entries.len(), 2);
    assert!(plain.lessons.is_empty());

    // An employee's lessons are searchable from its task, and not from the
    // person's own conversation (the recall tool passes the session id).
    let task_hits = db
        .search_memory_entries(SearchMemoryRequest {
            scopes: &db
                .learned_memory_scopes_for_session("task-1")
                .unwrap()
                .unwrap(),
            query: "fixture",
            kinds: &[],
            limit: 10,
            record_use: false,
        })
        .unwrap();
    assert_eq!(task_hits.len(), 1);
    assert_eq!(task_hits[0].scope_kind, SCOPE_BOT);
    let plain_hits = db
        .search_memory_entries(SearchMemoryRequest {
            scopes: &db
                .learned_memory_scopes_for_session("chat")
                .unwrap()
                .unwrap(),
            query: "fixture",
            kinds: &[],
            limit: 10,
            record_use: false,
        })
        .unwrap();
    assert!(plain_hits.is_empty());
}
