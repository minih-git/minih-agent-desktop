//! Slice 6 domain tests: hiring, team norms, and the two reads that make a task
//! run as its role.
//!
//! They live in their own file because they are one change: the crew narrowed to
//! the steward, the norms row, the employee of a task, and the job a roster row
//! names. `bots.rs` keeps only the code.

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

/// The empty database is the fresh install: one employee, the dispatcher.
///
/// The failure this replaces: the old `seedDefaults` created four rows, so
/// "give me the defaults" hired three people the person never asked for.
#[test]
fn seeding_an_empty_host_creates_only_the_super_agent() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();

    let seeded = bots::seed_defaults(&db).unwrap();
    let created = seeded["created"].as_array().unwrap();
    assert_eq!(created.len(), 1, "only the steward is created: {seeded}");
    assert_eq!(created[0]["name"], json!(bots::STEWARD_DEFAULT_NAME));
    assert_eq!(created[0]["definition"], json!("steward"));
    assert_eq!(seeded["skipped"], json!([]));

    let rows = employees(&db);
    assert_eq!(rows.len(), 1, "one employee exists: {rows:?}");
    assert!(rows[0].2.contains("\"steward\""));
}

/// A host that already has employees keeps every one of them, unchanged.
///
/// This is the hard rule of slice 6: hiring replaces the fixed crew, and nothing
/// that already exists may be renamed, edited or removed by it. The comparison is
/// of the stored profile bytes, so a "helpful" rewrite would fail here too.
#[test]
fn seeding_leaves_an_existing_crew_untouched() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
    employee(&db, bots::STEWARD_DEFAULT_NAME, Some("steward"));
    employee(&db, "Router 后端", None);
    employee(&db, "Desktop 前端", None);
    employee(&db, "调研与文档", None);
    let before = employees(&db);
    assert_eq!(before.len(), 4);

    let seeded = bots::seed_defaults(&db).unwrap();
    assert_eq!(seeded["created"], json!([]), "nothing is created: {seeded}");
    assert_eq!(
        seeded["skipped"],
        json!([{ "name": bots::STEWARD_DEFAULT_NAME, "reason": "exists" }]),
    );

    let after = employees(&db);
    assert_eq!(after, before, "every existing employee is byte-identical");
}

/// A person who renamed or dismissed the steward is not overridden either: the
/// lookup is by the name only the steward has, and a dismissed one is a `user`
/// session, so seeding creates one dispatcher rather than resurrecting theirs.
#[test]
fn seeding_does_not_resurrect_a_dismissed_employee() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
    let id = employee(&db, "Router 后端", None);
    bots::dismiss(&db, &json!({ "sessionId": id })).unwrap();

    let seeded = bots::seed_defaults(&db).unwrap();
    assert_eq!(seeded["created"].as_array().unwrap().len(), 1);
    let rows = employees(&db);
    assert_eq!(rows.len(), 1, "the dismissed one stays a conversation");
}

/// A renamed steward is still the steward.
///
/// #254 made the name the person's own, and the first version of this lookup went
/// by name — so renaming the dispatcher to «阿福» and clicking "enable Super
/// Agent" hired a second one, and the roster then hid both (it never offers a
/// `steward` as a candidate). The crew's identity is the definition, never a name.
#[test]
fn renaming_the_steward_does_not_hire_a_second_one() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
    let seeded = bots::seed_defaults(&db).unwrap();
    let steward = seeded["created"][0]["sessionId"]
        .as_str()
        .unwrap()
        .to_owned();

    bots::update(
        &db,
        &json!({ "sessionId": steward, "profile": { "name": "阿福" } }),
    )
    .unwrap();
    let renamed = employees(&db);
    assert_eq!(renamed.len(), 1);
    assert!(
        renamed[0].2.contains("\"阿福\""),
        "the name is the person's"
    );

    let again = bots::seed_defaults(&db).unwrap();
    assert_eq!(
        again["created"],
        json!([]),
        "a rename is not a missing steward"
    );
    assert_eq!(
        again["skipped"],
        json!([{ "name": "阿福", "reason": "exists" }]),
        "the reply names the employee the person actually has",
    );
    let rows = employees(&db);
    assert_eq!(rows.len(), 1, "no second dispatcher: {rows:?}");
    let stewards = rows
        .iter()
        .filter(|row| row.2.contains("\"definition\":\"steward\""))
        .count();
    assert_eq!(stewards, 1);
}

/// A dismissed steward is gone, so enabling it again creates one.
///
/// Dismissing flips the role back to `user` and clears the profile, which is why
/// this is *not* the malformed-row case: nothing in the crew claims the role.
#[test]
fn a_dismissed_steward_is_created_again() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
    let first = bots::seed_defaults(&db).unwrap()["created"][0]["sessionId"]
        .as_str()
        .unwrap()
        .to_owned();
    bots::dismiss(&db, &json!({ "sessionId": first })).unwrap();
    assert!(
        employees(&db).is_empty(),
        "nothing claims the role any more"
    );

    let again = bots::seed_defaults(&db).unwrap();
    assert_eq!(again["created"].as_array().unwrap().len(), 1);
    assert_eq!(again["created"][0]["definition"], json!("steward"));
    assert_ne!(again["created"][0]["sessionId"], json!(first));
    assert_eq!(employees(&db).len(), 1);
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

/// The steward picks by job, so the roster has to name it.
#[test]
fn the_roster_names_each_employees_job() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
    let steward = employee(&db, bots::STEWARD_DEFAULT_NAME, Some("steward"));
    let reviewer = employee(&db, "审查员", Some("code-reviewer"));
    let plain = employee(&db, "小工", None);

    let roster = bots::roster(&db, &json!({ "sessionId": steward })).unwrap();
    let rows = roster["employees"].as_array().unwrap();
    assert_eq!(rows.len(), 2, "the steward never lists herself");
    let of = |id: &str| {
        rows.iter()
            .find(|row| row["sessionId"] == json!(id))
            .cloned()
            .expect("employee is on the roster")
    };
    assert_eq!(of(&reviewer)["definition"], json!("code-reviewer"));
    assert_eq!(of(&plain)["definition"], Value::Null);
}
