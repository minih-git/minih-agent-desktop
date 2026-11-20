//! The rules the plugin task surface owns, checked against a real database.
//!
//! Everything starts at [`crate::plugin_tasks`] — the data layer Electron Main
//! calls through `pluginTasks.*` — so the checks cover the real path: the
//! transaction, the quotas read inside it, the redacted ledger, and the inbox
//! row the host writes for the person.

use rusqlite::params;
use serde_json::{json, Value};

use crate::db::Database;
use crate::plugin_tasks::*;
use crate::tasks;

fn database() -> (tempfile::TempDir, Database) {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
    (dir, db)
}

/// An employee with the profile the hire form writes.
fn employee(db: &Database, name: &str, mode: &str, duty: Option<&str>) -> String {
    let mut profile = json!({
        "name": name,
        "permissionMode": mode,
        "mustAsk": [],
        "observe": false,
    });
    if let Some(duty) = duty {
        profile["duty"] = json!(duty);
    }
    crate::sessions::create_session_with_options(
        db,
        crate::sessions::SessionCreateOptions {
            title: Some(name.into()),
            mode: Some("agent".into()),
            permission_mode: Some(mode.into()),
            role: Some("bot".into()),
            bot_profile_json: Some(profile.to_string()),
            ..Default::default()
        },
    )
    .unwrap()
    .id
}

const PROMPT: &str = "Read the flaky test and say why it fails";

fn task(db: &Database, plugin: &str, employee_id: &str, title: &str) -> Created {
    with_ceiling(db, plugin, None, employee_id, title, None)
}

fn with_ceiling(
    db: &Database,
    plugin: &str,
    ceiling: Option<&str>,
    employee_id: &str,
    title: &str,
    requested: Option<&str>,
) -> Created {
    let grant = Grant::new(plugin, ceiling).unwrap();
    crate::plugin_tasks::create(
        db,
        &grant,
        CreateRequest {
            employee_id,
            title,
            prompt: PROMPT,
            project_id: None,
            max_permission: requested,
        },
    )
    .unwrap()
}

fn refused(
    db: &Database,
    plugin: &str,
    employee_id: &str,
    prompt: &str,
    requested: Option<&str>,
) -> String {
    let grant = Grant::new(plugin, None).unwrap();
    crate::plugin_tasks::create(
        db,
        &grant,
        CreateRequest {
            employee_id,
            title: "Fix the login timeout",
            prompt,
            project_id: None,
            max_permission: requested,
        },
    )
    .unwrap_err()
    .to_string()
}

fn audit_count(db: &Database, kind: &str) -> i64 {
    db.conn()
        .query_row(
            "SELECT COUNT(*) FROM audit_log WHERE kind = ?1",
            params![kind],
            |row| row.get(0),
        )
        .unwrap()
}

fn task_count(db: &Database) -> i64 {
    db.conn()
        .query_row("SELECT COUNT(*) FROM tasks", [], |row| row.get(0))
        .unwrap()
}

fn notification_row(db: &Database, id: &str) -> (String, Option<String>, Option<String>, String) {
    db.conn()
        .query_row(
            "SELECT kind, session_id, plugin_id, title FROM notifications WHERE id = ?1",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .unwrap()
}

// ---- creation ---------------------------------------------------------------

/// The row says who started it, in the same transaction, and the origin keeps
/// its own two values.
#[test]
fn a_created_task_is_direct_and_names_the_plugin_that_started_it() {
    let (_dir, db) = database();
    let owner = employee(&db, "Router 后端", "accept-edits", None);
    let created = task(&db, "acme.ci", &owner, "Fix the login timeout");

    let (origin, plugin_id, source): (String, Option<String>, Option<String>) = db
        .conn()
        .query_row(
            "SELECT origin, plugin_id, source_utterance FROM tasks WHERE id = ?1",
            params![created.task.id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(origin, "direct");
    assert_eq!(plugin_id.as_deref(), Some("acme.ci"));
    // The prompt is the caller's to deliver; the ledger keeps no plugin prose.
    assert_eq!(source, None);
    assert_eq!(created.task.employee_session_id, owner);
    assert_eq!(created.task.stage, "queued");
    assert_eq!(created.permission_mode, "accept-edits");
    // The mode the row recorded is the mode its session runs at.
    assert_eq!(
        crate::sessions::session_permission_mode(&db, &created.task.session_id)
            .unwrap()
            .as_deref(),
        Some("accept-edits")
    );
    assert_eq!(audit_count(&db, AUDIT_CREATED), 1);
    // The announcement is returned as the inbox's own row, not a copy of it.
    assert_eq!(
        notification_row(&db, &created.notification.id).0,
        "plugin.alert"
    );
}

/// The person is told once, by the host, with a structured body and an
/// explicit session link — and the row is not a conversation row, so the bell's
/// per-session merge cannot hide it.
#[test]
fn creating_a_task_announces_it_with_a_structured_localizable_body() {
    let (_dir, db) = database();
    let owner = employee(&db, "Router 后端", "accept-edits", Some("Fix the router"));
    let created = task(&db, "acme.ci", &owner, "Fix the login timeout");

    let (kind, session_id, plugin_id, title) = notification_row(&db, &created.notification.id);
    assert_eq!(kind, "plugin.alert");
    assert_eq!(session_id, None, "a plugin row is not a conversation row");
    assert_eq!(plugin_id.as_deref(), Some("acme.ci"));
    assert_eq!(title, "Fix the login timeout");

    // The returned object is the stored row, field for field.
    assert_eq!(created.notification.kind, "plugin.alert");
    assert_eq!(created.notification.session_id, None);
    assert_eq!(created.notification.read_at, None);
    let link_json = created.notification.link_json.clone().unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&link_json).unwrap(),
        json!({ "session": created.task.session_id })
    );
    let body: Value = serde_json::from_str(created.notification.body.as_deref().unwrap()).unwrap();
    assert_eq!(body["schema"], json!(NOTIFICATION_BODY_SCHEMA));
    assert_eq!(body["version"], json!(NOTIFICATION_BODY_VERSION));
    assert_eq!(body["i18n"]["key"], json!(NOTIFICATION_I18N_KEY));
    assert_eq!(body["i18n"]["params"]["employeeName"], json!("Router 后端"));
    assert_eq!(
        body["i18n"]["params"]["taskTitle"],
        json!("Fix the login timeout")
    );
    assert_eq!(
        body["i18n"]["params"]["permissionMode"],
        json!("accept-edits")
    );
    assert_eq!(body["taskId"], json!(created.task.id));
    assert_eq!(body["sessionId"], json!(created.task.session_id));
    assert_eq!(body["pluginId"], json!("acme.ci"));
    assert_eq!(
        created.notification.dedupe_key.as_deref(),
        Some(format!("{NOTIFICATION_DEDUPE_PREFIX}{}", created.task.id).as_str())
    );
    // The body is a document, not prose: the task's own words live in `title`.
    assert!(!body.to_string().contains(PROMPT));
}

/// The announcement is the host's own row: it spends none of the plugin's
/// `notify.center` budget, which is counted from `plugin_notification_delivered`
/// audit records.
#[test]
fn the_announcement_bypasses_the_plugin_notification_quota() {
    let (_dir, db) = database();
    let owner = employee(&db, "Router 后端", "accept-edits", None);
    // The plugin has already spent its whole hour of ordinary notifications.
    for _ in 0..60 {
        crate::audit::append(
            &db,
            "plugin_notification_delivered",
            None,
            json!({ "pluginId": "acme.ci", "kind": "plugin.alert" }),
        )
        .unwrap();
    }
    let created = task(&db, "acme.ci", &owner, "Fix the login timeout");
    let (kind, ..) = notification_row(&db, &created.notification.id);
    assert_eq!(kind, "plugin.alert");
    assert_eq!(
        audit_count(&db, "plugin_notification_delivered"),
        60,
        "the host writes no delivery evidence for its own row"
    );
}

/// The prompt is the caller's to deliver: it is checked and dropped, never
/// stored, and a prompt nobody could hand over is refused before a row exists.
#[test]
fn a_prompt_is_checked_and_never_stored() {
    let (_dir, db) = database();
    let owner = employee(&db, "Router 后端", "accept-edits", None);

    assert!(refused(&db, "acme.ci", &owner, "   ", None).starts_with("INVALID_ARGUMENT:"));
    let too_long = "x".repeat(MAX_PROMPT_CHARS + 1);
    assert!(refused(&db, "acme.ci", &owner, &too_long, None).starts_with("LIMIT_EXCEEDED:"));
    assert_eq!(task_count(&db), 0, "a refused prompt writes nothing");

    // The longest accepted prompt still leaves no trace in the row.
    let longest = "y".repeat(MAX_PROMPT_CHARS);
    let grant = Grant::new("acme.ci", None).unwrap();
    let created = crate::plugin_tasks::create(
        &db,
        &grant,
        CreateRequest {
            employee_id: &owner,
            title: "Long brief",
            prompt: &longest,
            project_id: None,
            max_permission: None,
        },
    )
    .unwrap();
    let stored: String = db
        .conn()
        .query_row(
            "SELECT COALESCE(source_utterance, '') FROM tasks WHERE id = ?1",
            params![created.task.id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(stored, "");
}

/// A named repository must exist; a typo is not "the employee's own project".
#[test]
fn a_project_that_does_not_exist_is_refused() {
    let (_dir, db) = database();
    let owner = employee(&db, "Router 后端", "accept-edits", None);
    let grant = Grant::new("acme.ci", None).unwrap();
    let error = crate::plugin_tasks::create(
        &db,
        &grant,
        CreateRequest {
            employee_id: &owner,
            title: "Fix the login timeout",
            prompt: PROMPT,
            project_id: Some(9_999),
            max_permission: None,
        },
    )
    .unwrap_err()
    .to_string();
    assert!(error.starts_with("NOT_FOUND:"), "got {error}");
    assert_eq!(task_count(&db), 0);
}

/// An employee id that is not an employee is `NOT_FOUND`, whatever it names.
#[test]
fn only_a_hired_employee_can_own_a_plugin_task() {
    let (_dir, db) = database();
    let plain = crate::sessions::create_session_with_options(
        &db,
        crate::sessions::SessionCreateOptions {
            title: Some("Just a conversation".into()),
            ..Default::default()
        },
    )
    .unwrap()
    .id;
    let grant = Grant::new("acme.ci", None).unwrap();
    for employee_id in ["no-such-session".to_string(), plain] {
        let error = crate::plugin_tasks::create(
            &db,
            &grant,
            CreateRequest {
                employee_id: &employee_id,
                title: "Fix the login timeout",
                prompt: PROMPT,
                project_id: None,
                max_permission: None,
            },
        )
        .unwrap_err()
        .to_string();
        assert!(error.starts_with("NOT_FOUND:"), "got {error}");
    }
    assert_eq!(task_count(&db), 0);
}

// ---- the permission ceiling -------------------------------------------------

#[test]
fn the_effective_mode_is_the_narrowest_of_the_four_ceilings() {
    let asked = Grant::new("acme.ci", Some("ask")).unwrap();
    let wide = Grant::new("acme.ci", None).unwrap();

    // No request, no manifest ceiling, a wide employee: the default, never
    // the employee's own mode.
    assert_eq!(
        effective_permission(None, &wide, "auto").unwrap(),
        "accept-edits"
    );
    // The manifest's own ceiling narrows it.
    assert_eq!(
        effective_permission(None, &asked, "accept-edits").unwrap(),
        "ask"
    );
    // The employee's mode narrows it too.
    assert_eq!(effective_permission(None, &wide, "ask").unwrap(), "ask");
    // An explicit request can only narrow.
    assert_eq!(
        effective_permission(Some("ask"), &wide, "accept-edits").unwrap(),
        "ask"
    );
    // `auto` is never an effective mode, whatever the manifest allows.
    assert_eq!(
        effective_permission(None, &Grant::new("acme.ci", Some("auto")).unwrap(), "auto").unwrap(),
        HOST_PERMISSION_CEILING
    );
}

#[test]
fn asking_for_auto_is_refused_rather_than_clamped() {
    let (_dir, db) = database();
    let owner = employee(&db, "Router 后端", "accept-edits", None);
    let grant = Grant::new("acme.ci", Some("auto")).unwrap();
    let refused = crate::plugin_tasks::create(
        &db,
        &grant,
        CreateRequest {
            employee_id: &owner,
            title: "Fix the login timeout",
            prompt: "Do it",
            project_id: None,
            max_permission: Some("auto"),
        },
    );
    let error = refused.expect_err("auto is not grantable");
    assert!(
        error.to_string().starts_with("PERMISSION_DENIED:"),
        "got {error}"
    );
    // Nothing was written, and nothing was announced.
    assert_eq!(task_count(&db), 0);
    let notifications: i64 = db
        .conn()
        .query_row("SELECT COUNT(*) FROM notifications", [], |row| row.get(0))
        .unwrap();
    assert_eq!(notifications, 0);
    // A mode no host knows is refused too, on either side of the call.
    assert!(Grant::new("acme.ci", Some("wide-open")).is_err());
    let error = crate::plugin_tasks::create(
        &db,
        &grant,
        CreateRequest {
            employee_id: &owner,
            title: "Fix the login timeout",
            prompt: "Do it",
            project_id: None,
            max_permission: Some("wide-open"),
        },
    )
    .unwrap_err()
    .to_string();
    assert!(error.starts_with("INVALID_ARGUMENT:"), "got {error}");
}

/// The employee's own mode narrows the task's session, not only its row.
#[test]
fn a_cautious_employee_makes_a_cautious_task() {
    let (_dir, db) = database();
    let owner = employee(&db, "Docs", "ask", None);
    let created = with_ceiling(
        &db,
        "acme.ci",
        Some("accept-edits"),
        &owner,
        "Fix the login timeout",
        None,
    );
    assert_eq!(created.permission_mode, "ask");
    assert_eq!(
        crate::sessions::session_permission_mode(&db, &created.task.session_id)
            .unwrap()
            .as_deref(),
        Some("ask")
    );
}

// ---- ownership --------------------------------------------------------------

#[test]
fn a_task_belongs_to_the_plugin_that_created_it_and_to_nobody_else() {
    let (_dir, db) = database();
    let owner = employee(&db, "Router 后端", "accept-edits", None);
    let mine = task(&db, "acme.ci", &owner, "Fix the login timeout");
    let theirs = task(&db, "acme.deploy", &owner, "Ship the release");

    let row = get(&db, "acme.ci", &mine.task.id).unwrap();
    assert_eq!(row["taskId"], json!(mine.task.id));
    assert_eq!(row["pluginId"], json!("acme.ci"));
    assert_eq!(row["sessionId"], json!(mine.task.session_id));
    assert_eq!(row["employeeId"], json!(owner));
    // Another plugin's task is absent, not forbidden: the surface may not be
    // used to learn that somebody else's work exists.
    let error = get(&db, "acme.ci", &theirs.task.id).unwrap_err();
    assert!(error.to_string().starts_with("NOT_FOUND:"), "got {error}");
    // A task a person started belongs to no plugin at all.
    let person = tasks::create(
        &db,
        &json!({
            "employeeSessionId": owner,
            "title": "Typed by hand",
            "origin": "direct",
        }),
    )
    .unwrap();
    let person_id = person["task"]["id"].as_str().unwrap();
    assert!(get(&db, "acme.ci", person_id)
        .unwrap_err()
        .to_string()
        .starts_with("NOT_FOUND:"));
    assert_eq!(owner_of(&db, person_id), json!({ "pluginId": null }));
    assert_eq!(
        owner_of(&db, &mine.task.id),
        json!({ "pluginId": "acme.ci" })
    );
    assert!(crate::plugin_tasks::owner(&db, "no-such-task")
        .unwrap_err()
        .to_string()
        .starts_with("NOT_FOUND:"));
}

fn owner_of(db: &Database, task_id: &str) -> Value {
    crate::plugin_tasks::owner(db, task_id).unwrap()
}

#[test]
fn send_and_stop_address_only_an_open_task_of_the_caller() {
    let (_dir, db) = database();
    let owner = employee(&db, "Router 后端", "accept-edits", None);
    let mine = task(&db, "acme.ci", &owner, "Fix the login timeout");
    let theirs = task(&db, "acme.deploy", &owner, "Ship the release");

    let target = owned_open_task(&db, "acme.ci", &mine.task.id).unwrap();
    assert_eq!(target.session_id, mine.task.session_id);
    assert_eq!(target.employee_id, owner);
    assert!(owned_open_task(&db, "acme.ci", &theirs.task.id)
        .unwrap_err()
        .to_string()
        .starts_with("NOT_FOUND:"));

    // Archived work is over: the plugin owns it, and that is the whole answer.
    tasks::archive(&db, &json!({ "taskId": mine.task.id })).unwrap();
    assert!(owned_open_task(&db, "acme.ci", &mine.task.id)
        .unwrap_err()
        .to_string()
        .starts_with("CONFLICT:"));
}

// ---- quotas -----------------------------------------------------------------

#[test]
fn a_plugin_may_hold_ten_open_tasks_and_no_more() {
    let (_dir, db) = database();
    let owner = employee(&db, "Router 后端", "accept-edits", None);
    for index in 0..MAX_OPEN_TASKS_PER_PLUGIN {
        task(&db, "acme.ci", &owner, &format!("Task {index}"));
    }
    let grant = Grant::new("acme.ci", None).unwrap();
    let refused = crate::plugin_tasks::create(
        &db,
        &grant,
        CreateRequest {
            employee_id: &owner,
            title: "One too many",
            prompt: "Do it",
            project_id: None,
            max_permission: None,
        },
    );
    let error = refused.expect_err("the eleventh open task is refused");
    assert!(
        error.to_string().starts_with("LIMIT_EXCEEDED:"),
        "got {error}"
    );
    // Another plugin's budget is its own.
    task(&db, "acme.deploy", &owner, "Somebody else's work");
    assert_eq!(task_count(&db), MAX_OPEN_TASKS_PER_PLUGIN + 1);
}

/// The hourly budget is counted from the audit log, so archiving a task cannot
/// refill it: the twentieth create of the hour is the last one, even with no
/// open task left.
#[test]
fn the_hourly_budget_does_not_reset_when_tasks_are_archived() {
    let (_dir, db) = database();
    let owner = employee(&db, "Router 后端", "accept-edits", None);
    for index in 0..HOURLY_CREATE_LIMIT {
        let created = task(&db, "acme.ci", &owner, &format!("Task {index}"));
        // Archived straight away, so the open-task quota never fires and the
        // hourly budget is the only thing that can refuse the next call.
        tasks::archive(&db, &json!({ "taskId": created.task.id })).unwrap();
    }
    let grant = Grant::new("acme.ci", None).unwrap();
    let refused = crate::plugin_tasks::create(
        &db,
        &grant,
        CreateRequest {
            employee_id: &owner,
            title: "One past the hour",
            prompt: "Do it",
            project_id: None,
            max_permission: None,
        },
    );
    let error = refused.expect_err("the twenty-first task of the hour is refused");
    assert!(
        error.to_string().starts_with("RATE_LIMITED:"),
        "got {error}"
    );
    assert_eq!(audit_count(&db, AUDIT_CREATED), HOURLY_CREATE_LIMIT);
    // Another plugin's hour is its own.
    task(&db, "acme.deploy", &owner, "Somebody else's work");
}

// ---- reads ------------------------------------------------------------------

/// The ledger is what a task *is*: no prompt, no waiting question, no report —
/// exactly the fields the plugin SDK's summary declares.
#[test]
fn the_ledger_is_redacted_and_pages_by_cursor() {
    let (_dir, db) = database();
    let owner = employee(&db, "Router 后端", "accept-edits", None);
    for index in 0..3 {
        task(&db, "acme.ci", &owner, &format!("Task {index}"));
    }
    let first = list(
        &db,
        LedgerQuery {
            limit: Some(2),
            cursor: None,
        },
    )
    .unwrap();
    assert_eq!(first["tasks"].as_array().unwrap().len(), 2);
    let row = &first["tasks"][0];
    assert!(row["taskId"].is_string());
    assert!(row["sessionId"].is_string());
    assert_eq!(row["employeeId"], json!(owner));
    assert!(row["createdAt"].is_i64());
    assert_eq!(row["origin"], json!("direct"));
    assert_eq!(row["pluginId"], json!("acme.ci"));
    let mut keys: Vec<&str> = row
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        [
            "archivedAt",
            "createdAt",
            "employeeId",
            "origin",
            "pluginId",
            "projectId",
            "sessionId",
            "stage",
            "taskId",
            "title",
        ],
        "the row is the declared summary and nothing else"
    );
    // Nothing the person or the caller wrote is anywhere in the page.
    assert!(!first.to_string().contains(PROMPT));
    let cursor = first["nextCursor"].as_str().unwrap().to_string();
    let second = list(
        &db,
        LedgerQuery {
            limit: Some(2),
            cursor: Some(&cursor),
        },
    )
    .unwrap();
    assert_eq!(second["tasks"].as_array().unwrap().len(), 1);
    assert_eq!(second["nextCursor"], json!(null));
    assert_ne!(second["tasks"][0]["taskId"], first["tasks"][0]["taskId"]);
    // A cursor the host did not write is refused rather than guessed.
    assert!(list(
        &db,
        LedgerQuery {
            limit: None,
            cursor: Some("nonsense"),
        }
    )
    .unwrap_err()
    .to_string()
    .starts_with("INVALID_ARGUMENT:"));
    // A page size beyond the cap is clamped instead of honoured.
    let clamped = list(
        &db,
        LedgerQuery {
            limit: Some(LIST_MAX_LIMIT * 10),
            cursor: None,
        },
    )
    .unwrap();
    assert_eq!(clamped["tasks"].as_array().unwrap().len(), 3);
}

/// The roster is a shape, not a transcript: counts, a duty, a mode, and no
/// prompt anywhere.
#[test]
fn the_roster_counts_work_without_repeating_a_single_prompt() {
    let (_dir, db) = database();
    let owner = employee(&db, "Router 后端", "accept-edits", Some("Fix the router"));
    let quiet = employee(&db, "Docs", "ask", None);
    let created = task(&db, "acme.ci", &owner, "Fix the login timeout");

    let roster = roster(&db, None).unwrap();
    let rows = roster["employees"].as_array().unwrap();
    let router = rows
        .iter()
        .find(|row| row["employeeId"] == json!(owner))
        .unwrap();
    assert_eq!(router["name"], json!("Router 后端"));
    assert_eq!(router["duty"], json!("Fix the router"));
    assert_eq!(router["permissionMode"], json!("accept-edits"));
    assert_eq!(router["openTasks"], json!(1));
    assert_eq!(router["busy"], json!(true), "a queued task is work in hand");
    assert_eq!(router["waitingOnYou"], json!(0));
    let docs = rows
        .iter()
        .find(|row| row["employeeId"] == json!(quiet))
        .unwrap();
    assert_eq!(docs["permissionMode"], json!("ask"));
    assert_eq!(docs["openTasks"], json!(0));
    assert_eq!(docs["busy"], json!(false));
    assert!(
        docs.get("duty").is_none(),
        "an employee with no duty has no duty field"
    );
    // Nothing a person asked or answered is in the projection.
    let encoded = roster.to_string();
    for leaked in [PROMPT, "Fix the login timeout", created.task.id.as_str()] {
        assert!(!encoded.contains(leaked), "{leaked} leaked into the roster");
    }
}

/// The roster honours the caller's page size instead of returning the whole
/// team, and clamps a nonsense one.
#[test]
fn the_roster_honours_the_limit_the_caller_asks_for() {
    let (_dir, db) = database();
    for name in ["Router 后端", "Docs", "Release"] {
        employee(&db, name, "accept-edits", None);
    }
    let paged = roster(&db, Some(2)).unwrap();
    assert_eq!(paged["employees"].as_array().unwrap().len(), 2);
    let clamped = roster(&db, Some(0)).unwrap();
    assert_eq!(clamped["employees"].as_array().unwrap().len(), 1);
    let all = roster(&db, Some(LIST_MAX_LIMIT)).unwrap();
    assert_eq!(all["employees"].as_array().unwrap().len(), 3);
}

/// An employee's waiting count needs the person's attention until they act:
/// the stage says so, and an accepted card is no longer their turn.
#[test]
fn waiting_on_you_counts_the_stages_a_person_has_to_act_on() {
    let (_dir, db) = database();
    let owner = employee(&db, "Router 后端", "accept-edits", None);
    let created = task(&db, "acme.ci", &owner, "Fix the login timeout");
    assert_eq!(
        roster(&db, None).unwrap()["employees"][0]["waitingOnYou"],
        json!(0)
    );

    tasks::waiting_open(
        &db,
        &json!({
            "sessionId": created.task.session_id,
            "requestId": "req-1",
            "kind": "ask",
            "question": "Which login?",
        }),
    )
    .unwrap();
    let waiting = roster(&db, None).unwrap();
    assert_eq!(waiting["employees"][0]["waitingOnYou"], json!(1));
    // A task waiting on the person is not "busy" — the ball is theirs.
    assert_eq!(waiting["employees"][0]["busy"], json!(false));
    assert!(!waiting.to_string().contains("Which login?"));

    tasks::waiting_close(&db, &json!({ "requestId": "req-1" })).unwrap();
    tasks::report(
        &db,
        &json!({
            "sessionId": created.task.session_id,
            "status": "ready",
            "summary": "Done",
            "criteria": [],
            "leftovers": [],
        }),
    )
    .unwrap();
    assert_eq!(
        roster(&db, None).unwrap()["employees"][0]["waitingOnYou"],
        json!(1)
    );

    crate::task_stage::turn_ended(&db, db.conn(), &created.task.session_id, "completed", None)
        .unwrap();
    tasks::accept(&db, &json!({ "taskId": created.task.id })).unwrap();
    assert_eq!(
        roster(&db, None).unwrap()["employees"][0]["waitingOnYou"],
        json!(0),
        "an accepted card is not the person's turn"
    );
}

#[test]
fn task_notification_links_require_matching_owner_and_session() {
    let (_dir, db) = database();
    let owner = employee(&db, "Engineer", "accept-edits", None);
    let created = task(&db, "acme.ci", &owner, "Task");
    let key = format!("{NOTIFICATION_DEDUPE_PREFIX}{}", created.task.id);
    db.conn().execute(
        "INSERT INTO notifications (id, kind, plugin_id, title, link_json, dedupe_key, created_at) VALUES ('forged', 'plugin.alert', 'other.plugin', 'Fake', ?1, ?2, ?3)",
        rusqlite::params![json!({"session": "other-session"}).to_string(), key, crate::db::now_ms()],
    ).unwrap();
    let (rows, _) = crate::notifications::list(&db, false, 20).unwrap();
    let real = rows
        .iter()
        .find(|row| row.id == created.notification.id)
        .unwrap();
    assert!(real
        .dedupe_key
        .as_deref()
        .unwrap()
        .starts_with(NOTIFICATION_DEDUPE_PREFIX));
    assert!(real.link_json.is_some());
    let forged = rows.iter().find(|row| row.id == "forged").unwrap();
    assert!(forged.dedupe_key.is_none());
    assert!(forged.link_json.is_none());
    db.conn()
        .execute(
            "UPDATE notifications SET link_json=?1 WHERE id=?2",
            rusqlite::params![
                json!({"session":"other-session"}).to_string(),
                created.notification.id
            ],
        )
        .unwrap();
    let (rows, _) = crate::notifications::list(&db, false, 20).unwrap();
    let altered = rows
        .iter()
        .find(|row| row.id == created.notification.id)
        .unwrap();
    assert!(altered.dedupe_key.is_none());
    assert!(altered.link_json.is_none());
}
