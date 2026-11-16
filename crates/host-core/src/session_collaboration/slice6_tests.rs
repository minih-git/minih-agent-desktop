//! Slice 6 domain tests: hiring, team norms, and the two reads that make a task
//! run as its role.
//!
//! They live in their own file because they are one change: hiring, the norms
//! row, and the employee of a task. `bots.rs` keeps only the code.

use crate::db::Database;
use crate::session_collaboration::{bots, norms};
use crate::sessions;
use serde_json::{json, Value};

fn employee(db: &Database, name: &str, definition: Option<&str>) -> String {
    let mut profile = json!({
        "name": name,
        "duty": format!("{name} does its job"),
        "permissionMode": "ask",
        "mustAsk": [],
        "observe": true,
    });
    if let Some(definition) = definition {
        profile["definition"] = json!(definition);
    }
    bots::create(
        db,
        &json!({ "profile": profile, "projectPath": Value::Null }),
    )
    .unwrap()["session"]["id"]
        .as_str()
        .unwrap()
        .to_owned()
}

fn employees(db: &Database) -> Vec<(String, String, String)> {
    let mut statement = db
        .conn()
        .prepare("SELECT id, title, bot_profile_json FROM sessions WHERE role='bot' ORDER BY id")
        .unwrap();
    statement
        .query_map([], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get::<_, Option<String>>(2)?.unwrap_or_default(),
            ))
        })
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap()
}

/// A fresh host has no employees at all: hiring is the only way one appears.
///
/// The failure this replaces: the old `seedDefaults` created a built-in
/// dispatcher on first use, so a person who never hired anybody still had an
/// employee the host had made up for them.
#[test]
fn a_fresh_host_starts_with_no_employees() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
    assert!(
        employees(&db).is_empty(),
        "nothing is hired behind the person's back"
    );
}

/// Hiring writes exactly the profile the form carried, and nothing else.
#[test]
fn hiring_creates_the_employee_the_form_names() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();

    let hired = employee(&db, "审查员", Some("code-reviewer"));
    let rows = employees(&db);
    assert_eq!(rows.len(), 1, "one hire, one employee: {rows:?}");
    assert_eq!(rows[0].0, hired);
    assert_eq!(rows[0].1, "审查员");
    assert!(rows[0].2.contains("\"code-reviewer\""));
    assert!(rows[0].2.contains("审查员 does its job"));
}

/// Dismissing an employee gives the conversation back: the transcript and the
/// memory stay, only the role and the profile go.
#[test]
fn dismissing_an_employee_keeps_the_conversation() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
    let id = employee(&db, "Router 后端", None);
    bots::dismiss(&db, &json!({ "sessionId": id })).unwrap();

    assert!(employees(&db).is_empty(), "the role is gone");
    let (role, profile): (String, Option<String>) = db
        .conn()
        .query_row(
            "SELECT role, bot_profile_json FROM sessions WHERE id = ?1",
            rusqlite::params![id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(role, "user");
    assert!(profile.is_none());
}

#[test]
fn team_norms_round_trip_and_clear() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();

    let empty = norms::get(&db).unwrap();
    assert_eq!(empty["norms"]["communication"], json!(""));
    assert_eq!(empty["norms"]["version"], json!(norms::NORMS_VERSION));

    let saved = norms::set(
        &db,
        &json!({
            "norms": {
                "communication": "  用中文汇报，先给结论  ",
                "scope": "不要重排没改过的文件",
                "delivery": "改动要带测试",
            }
        }),
    )
    .unwrap();
    assert_eq!(
        saved["norms"]["communication"],
        json!("用中文汇报，先给结论")
    );
    assert_eq!(
        norms::get(&db).unwrap()["norms"]["delivery"],
        json!("改动要带测试"),
    );

    // Blanking every section is "no norms", stored as absence rather than three
    // empty strings: the next read must not look like a written rule set.
    norms::set(
        &db,
        &json!({ "norms": { "communication": " ", "scope": "", "delivery": "" } }),
    )
    .unwrap();
    assert_eq!(
        norms::get(&db).unwrap()["norms"]["communication"],
        json!("")
    );
    let stored: Option<Value> = db.kv_get("team", "norms").unwrap();
    assert!(stored.is_none(), "cleared norms leave no row");
}

#[test]
fn team_norms_refuse_what_they_cannot_inject() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();

    let too_long = "字".repeat(norms::MAX_SECTION_CHARS + 1);
    let error = norms::set(&db, &json!({ "norms": { "communication": too_long } }))
        .unwrap_err()
        .to_string();
    assert!(error.contains("LIMIT_EXCEEDED"), "{error}");

    // Three sections that are each legal but together exceed the budget.
    let per_section = "字".repeat(norms::MAX_SECTION_CHARS);
    let error = norms::set(
        &db,
        &json!({
            "norms": {
                "communication": per_section,
                "scope": per_section,
                "delivery": per_section,
            }
        }),
    )
    .unwrap_err()
    .to_string();
    assert!(error.contains("LIMIT_EXCEEDED"), "{error}");

    // Nothing was stored by either refused write.
    assert_eq!(norms::get(&db).unwrap()["norms"]["scope"], json!(""));
}

/// A task session's role is the employee's, so this read is what Main needs
/// before a task can run as it.
#[test]
fn a_task_session_answers_with_its_employee() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
    let reviewer = employee(&db, "审查员", Some("code-reviewer"));
    let created = crate::tasks::create(
        &db,
        &json!({
            "employeeSessionId": reviewer,
            "title": "看看这个改动",
            "origin": "direct",
        }),
    )
    .unwrap();
    let task_session = created["task"]["sessionId"].as_str().unwrap();

    let answer = bots::for_task_session(&db, &json!({ "sessionId": task_session })).unwrap();
    assert_eq!(answer["employee"]["sessionId"], json!(reviewer));
    assert_eq!(
        answer["employee"]["profile"]["definition"],
        json!("code-reviewer")
    );

    // A session that is not a task's own answers `null` rather than inventing an
    // employee, so Main applies no persona instead of somebody else's.
    let ordinary =
        sessions::create_session(&db, Some("Chat".into()), None, None, None, None).unwrap();
    let none = bots::for_task_session(&db, &json!({ "sessionId": ordinary.id })).unwrap();
    assert_eq!(none["employee"], Value::Null);
}
