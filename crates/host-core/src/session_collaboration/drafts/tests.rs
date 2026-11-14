use super::*;
use crate::sessions;

fn database() -> Database {
    let dir = tempfile::tempdir().unwrap();
    Database::open(&dir.path().join("pi.sqlite")).unwrap()
}

fn session(db: &Database, title: &str, role: Option<&str>, mode: &str) -> String {
    sessions::create_session_with_options(
        db,
        sessions::SessionCreateOptions {
            title: Some(title.into()),
            mode: Some("agent".into()),
            permission_mode: Some(mode.into()),
            role: role.map(str::to_owned),
            bot_profile_json: role.map(|_| {
                format!(r#"{{"name":"{title}","permissionMode":"{mode}","observe":false}}"#)
            }),
            ..Default::default()
        },
    )
    .unwrap()
    .id
}

fn card(mode: &str) -> Value {
    json!({
        "goal": "Fix the login timeout",
        "criteria": [{"id": "c1", "text": "A failing repro exists"}],
        "boundaries": ["Do not touch billing"],
        "permissionMode": mode,
        "mustAsk": ["push"],
        "risk": "medium"
    })
}

fn propose_card(db: &Database, steward: &str, target: &str, mode: &str) -> Draft {
    let result = super::propose(
        db,
        &json!({
            "sessionId": steward,
            "targetSessionId": target,
            "sourceUtterance": "登录超时今天修掉",
            "card": card(mode),
        }),
    )
    .unwrap();
    serde_json::from_value(result["draft"].clone()).unwrap()
}

fn confirm_request<'a>(draft: &'a Draft, key: &'a str) -> ConfirmRequest<'a> {
    ConfirmRequest {
        draft_id: &draft.id,
        card_hash: &draft.card_hash,
        confirmed_by: CONFIRMED_BY_USER,
        host_id: Some("mac-mini"),
        device_id: None,
        policy_version: "steward-1",
        notify_on_completion: false,
        idempotency_key: key,
        project_path: None,
    }
}

#[test]
fn a_draft_is_persisted_with_its_hash_target_and_utterance() {
    let db = database();
    let steward = session(&db, "Steward", None, "auto");
    let worker = session(&db, "小爪", Some("bot"), "accept-edits");
    let draft = propose_card(&db, &steward, &worker, "accept-edits");
    assert_eq!(draft.status, "proposed");
    assert_eq!(draft.target_session_id, worker);
    assert_eq!(draft.source_utterance, "登录超时今天修掉");
    assert_eq!(draft.card_hash.len(), 64);
    assert!(draft.confirmed_by.is_none());
    // The stored card is the normalized one, so the hash a UI shows matches.
    assert_eq!(card_hash(&draft.card), draft.card_hash);
}

#[test]
fn the_hash_is_stable_across_key_order() {
    let left = json!({"a": 1, "b": [2, 3]});
    let right = json!({"b": [2, 3], "a": 1});
    assert_eq!(card_hash(&left), card_hash(&right));
    assert_ne!(card_hash(&left), card_hash(&json!({"a": 1, "b": [3, 2]})));
}

#[test]
fn proposing_the_same_card_twice_is_one_draft() {
    let db = database();
    let steward = session(&db, "Steward", None, "auto");
    let worker = session(&db, "小爪", Some("bot"), "accept-edits");
    let first = propose_card(&db, &steward, &worker, "accept-edits");
    let again = super::propose(
        &db,
        &json!({
            "sessionId": steward,
            "targetSessionId": worker,
            "sourceUtterance": "登录超时今天修掉",
            "card": card("accept-edits"),
        }),
    )
    .unwrap();
    assert_eq!(again["created"], json!(false));
    assert_eq!(again["draft"]["id"], json!(first.id));
    assert_eq!(list(&db, &steward).unwrap().len(), 1);
}

#[test]
fn a_card_must_target_an_employee_and_not_its_own_session() {
    let db = database();
    let steward = session(&db, "Steward", None, "auto");
    let plain = session(&db, "Just a chat", None, "auto");
    for target in [steward.clone(), plain] {
        let error = super::propose(
            &db,
            &json!({
                "sessionId": steward,
                "targetSessionId": target,
                "sourceUtterance": "x",
                "card": card("ask"),
            }),
        )
        .unwrap_err();
        assert!(error.to_string().contains("INVALID_ARGUMENT"), "{error}");
    }
}

/// A card with nobody on it is allowed and cannot start: the person picks the
/// employee from the dropdown first (employee mode 0.5 slice 3).
#[test]
fn a_card_without_an_employee_waits_for_the_person_to_pick_one() {
    let db = database();
    let steward = session(&db, "Steward", None, "auto");
    let proposed = super::propose(
        &db,
        &json!({
            "sessionId": steward,
            "sourceUtterance": "把 Desktop 的 E2E 修一下",
            "card": card("accept-edits"),
        }),
    )
    .unwrap();
    let draft = proposed["draft"].clone();
    assert_eq!(draft["targetSessionId"], json!(""));
    assert_eq!(draft["status"], json!("proposed"));
    // Policy never starts a card with no employee.
    assert_eq!(
        auto_start_refusal(&db, "", &draft["card"]).unwrap(),
        Some("target-not-an-employee")
    );
    // A click cannot either, and says why.
    let refused = super::confirm(
        &db,
        ConfirmRequest {
            draft_id: draft["id"].as_str().unwrap(),
            card_hash: draft["cardHash"].as_str().unwrap(),
            confirmed_by: CONFIRMED_BY_USER,
            host_id: Some("mac-mini"),
            device_id: None,
            policy_version: "steward-1",
            notify_on_completion: true,
            idempotency_key: "click-without-employee",
            project_path: None,
        },
    )
    .unwrap_err();
    assert!(refused.to_string().contains("CONFLICT"), "{refused}");
    // Picking one in the dropdown is what makes it startable.
    let employee = session(&db, "小爪", Some("bot"), "accept-edits");
    let picked = super::reassign(
        &db,
        &json!({"draftId": draft["id"].as_str().unwrap(), "targetSessionId": employee}),
    )
    .unwrap();
    assert_eq!(picked["draft"]["targetSessionId"], json!(employee));
    assert_eq!(picked["draft"]["status"], json!("proposed"));
}

#[test]
fn confirming_with_a_stale_hash_is_refused_after_a_revise() {
    let db = database();
    let steward = session(&db, "Steward", None, "auto");
    let worker = session(&db, "小爪", Some("bot"), "accept-edits");
    let draft = propose_card(&db, &steward, &worker, "accept-edits");
    let stale = draft.card_hash.clone();

    // The person's screen is now out of date: the card was revised.
    super::revise(
        &db,
        &json!({
            "draftId": draft.id,
            "card": {
                "goal": "Fix the login timeout AND the retry loop",
                "criteria": [{"id": "c1", "text": "Both are fixed"}],
                "permissionMode": "auto",
                "mustAsk": [],
                "risk": "high"
            },
        }),
    )
    .unwrap();

    let error = super::confirm(
        &db,
        ConfirmRequest {
            draft_id: &draft.id,
            card_hash: &stale,
            ..confirm_request(&draft, "stale")
        },
    )
    .unwrap_err();
    assert!(error.to_string().contains("CONFLICT"), "{error}");
    // Nothing was dispatched and the draft is still open.
    let after = get(&db, &draft.id).unwrap().unwrap();
    assert_eq!(after.status, "proposed");
    assert!(after.delivery_id.is_none());
    let deliveries: i64 = db
        .conn()
        .query_row(
            "SELECT COUNT(*) FROM session_collaboration_messages",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(deliveries, 0);
}

#[test]
fn confirming_freezes_the_card_and_dispatches_it() {
    let db = database();
    let steward = session(&db, "Steward", None, "auto");
    let worker = session(&db, "小爪", Some("bot"), "accept-edits");
    let draft = propose_card(&db, &steward, &worker, "accept-edits");
    let confirmed = super::confirm(&db, confirm_request(&draft, "confirm-1")).unwrap();

    let after = get(&db, &draft.id).unwrap().unwrap();
    assert_eq!(after.status, "confirmed");
    assert_eq!(after.confirmed_by.as_deref(), Some(CONFIRMED_BY_USER));
    assert!(after.confirmed_at.is_some());
    let delivery_id = after.delivery_id.clone().unwrap();
    assert_eq!(confirmed["delivery"]["id"], json!(delivery_id));

    // The delivery carries the frozen card, and its ceiling is the narrower of
    // sender and card — here the sender is wider, so the card wins.
    let message = crate::session_collaboration::get(&db, &delivery_id)
        .unwrap()
        .unwrap();
    // Employee mode 0.5: the work landed in the task created for it, not in the
    // employee's own transcript, and the task names this delivery.
    let task = crate::tasks::get_task(&db, confirmed["task"]["id"].as_str().unwrap())
        .unwrap()
        .unwrap();
    assert_eq!(task.employee_session_id, worker);
    assert_eq!(task.origin, "steward");
    assert_eq!(task.delivery_id.as_deref(), Some(delivery_id.as_str()));
    assert_eq!(task.stage, "queued");
    assert_eq!(message.target_session_id, task.session_id);
    assert_eq!(message.permission_ceiling, "accept-edits");
    assert!(message
        .mandate_json
        .as_deref()
        .is_some_and(|raw| raw.contains("\"taskId\"")));
}

#[test]
fn a_confirmation_is_atomic_when_the_delivery_cannot_be_written() {
    let db = database();
    let steward = session(&db, "Steward", None, "auto");
    let worker = session(&db, "小爪", Some("bot"), "accept-edits");
    let draft = propose_card(&db, &steward, &worker, "accept-edits");
    // The employee stops being an Agent session while the card waits, so the
    // delivery is refused on the way in. Its *mode* can no longer cause this: a
    // card is now narrowed to the employee, so a wider employee only narrows
    // what the card grants (review S2).
    db.conn()
        .execute(
            "UPDATE sessions SET mode='chat' WHERE id=?1",
            params![worker],
        )
        .unwrap();
    let error = super::confirm(&db, confirm_request(&draft, "confirm-2")).unwrap_err();
    assert!(error.to_string().contains("PERMISSION_DENIED"), "{error}");
    // The draft must not be marked confirmed: no half-state exists.
    let after = get(&db, &draft.id).unwrap().unwrap();
    assert_eq!(after.status, "proposed");
    assert!(after.delivery_id.is_none());
}

#[test]
fn a_confirmed_card_cannot_be_confirmed_again_or_revised_or_dropped() {
    let db = database();
    let steward = session(&db, "Steward", None, "auto");
    let worker = session(&db, "小爪", Some("bot"), "accept-edits");
    let draft = propose_card(&db, &steward, &worker, "accept-edits");
    super::confirm(&db, confirm_request(&draft, "confirm-3")).unwrap();

    assert!(super::confirm(&db, confirm_request(&draft, "confirm-4")).is_err());
    assert!(super::revise(&db, &json!({"draftId": draft.id, "card": card("auto")}),).is_err());
    assert!(super::drop(&db, &json!({"draftId": draft.id})).is_err());
}

#[test]
fn revise_changes_an_open_card_and_the_hash_with_it() {
    let db = database();
    let steward = session(&db, "Steward", None, "auto");
    let worker = session(&db, "小爪", Some("bot"), "accept-edits");
    let draft = propose_card(&db, &steward, &worker, "accept-edits");
    let revised = super::revise(&db, &json!({"draftId": draft.id, "card": card("ask")})).unwrap();
    assert_ne!(revised["draft"]["cardHash"], json!(draft.card_hash));
    assert_eq!(revised["draft"]["card"]["permissionMode"], json!("ask"));
}

#[test]
fn dropping_a_card_keeps_it_out_of_reach() {
    let db = database();
    let steward = session(&db, "Steward", None, "auto");
    let worker = session(&db, "小爪", Some("bot"), "accept-edits");
    let draft = propose_card(&db, &steward, &worker, "accept-edits");
    super::drop(&db, &json!({"draftId": draft.id})).unwrap();
    assert!(super::confirm(&db, confirm_request(&draft, "dropped")).is_err());
    assert_eq!(get(&db, &draft.id).unwrap().unwrap().status, "dropped");
}

#[test]
fn drafts_are_bounded_per_session_and_evict_the_oldest_open_one() {
    let db = database();
    let steward = session(&db, "Steward", None, "auto");
    let worker = session(&db, "小爪", Some("bot"), "accept-edits");
    let mut ids = Vec::new();
    for index in 0..(MAX_DRAFTS_PER_SESSION + 2) {
        let result = super::propose(
            &db,
            &json!({
                "sessionId": steward,
                "targetSessionId": worker,
                "sourceUtterance": "原话",
                "card": {
                    "goal": format!("task {index}"),
                    "criteria": [{"id": "c1", "text": "done"}],
                    "permissionMode": "ask",
                    "risk": "low"
                },
            }),
        )
        .unwrap();
        ids.push(result["draft"]["id"].as_str().unwrap().to_string());
    }
    assert_eq!(
        list(&db, &steward).unwrap().len() as i64,
        MAX_DRAFTS_PER_SESSION
    );
    // The oldest are the ones that went.
    assert!(get(&db, &ids[0]).unwrap().is_none());
    assert!(get(&db, &ids[1]).unwrap().is_none());
    assert!(get(&db, ids.last().unwrap()).unwrap().is_some());
}

fn bot(db: &Database, title: &str, mode: &str, observe: bool) -> String {
    sessions::create_session_with_options(
        db,
        sessions::SessionCreateOptions {
            title: Some(title.into()),
            mode: Some("agent".into()),
            permission_mode: Some(mode.into()),
            role: Some("bot".into()),
            bot_profile_json: Some(
                json!({
                    "name": title,
                    "permissionMode": mode,
                    "observe": observe,
                })
                .to_string(),
            ),
            ..Default::default()
        },
    )
    .unwrap()
    .id
}

/// The auto-start rule is the host's decision from stored facts, so every
/// condition is exercised on both sides.
///
/// The `auto` mode is the *widest* the product has — it runs Write/Edit and Bash
/// without asking — so a mode is never evidence that a card only reads: the
/// card has to say `readOnly: true`, and that label itself requires `ask`
/// (employee mode 0.5 slice 3, review S1).
#[test]
fn auto_start_needs_an_observing_off_employee_and_a_card_that_says_read_only() {
    let db = database();
    let wide = bot(&db, "Wide", "accept-edits", false);
    let observing = bot(&db, "Observing", "accept-edits", true);
    let plain = session(&db, "Just a chat", None, "auto");

    // A card that says it only reads starts by itself (the person's rule is
    // "read-only starts, changing waits"). Every card carries the three nobody
    // can switch off and nothing else.
    let mut read_only = card("ask");
    read_only["readOnly"] = json!(true);
    read_only["mustAsk"] = json!(["deploy", "delete", "spend"]);
    assert_eq!(auto_start_refusal(&db, &wide, &read_only).unwrap(), None);

    // The mode alone is not a claim: `auto` may write files, so a card without
    // the flag waits for a click.
    let mut undeclared = card("auto");
    undeclared["mustAsk"] = json!(["deploy", "delete", "spend"]);
    assert_eq!(
        auto_start_refusal(&db, &wide, &undeclared).unwrap(),
        Some("card-not-read-only")
    );
    // A card that changes files waits for a click, whatever it asks for.
    assert_eq!(
        auto_start_refusal(&db, &wide, &card("accept-edits")).unwrap(),
        Some("card-not-read-only")
    );
    assert_eq!(
        auto_start_refusal(&db, &wide, &card("ask")).unwrap(),
        Some("card-not-read-only")
    );
    // An observing employee never auto-starts.
    assert_eq!(
        auto_start_refusal(&db, &observing, &read_only).unwrap(),
        Some("employee-observing")
    );
    // A target that is not an employee never auto-starts.
    assert_eq!(
        auto_start_refusal(&db, &plain, &read_only).unwrap(),
        Some("target-not-an-employee")
    );
    // A read-only card that also asked for a gate beyond the three nobody can
    // switch off waits like the rest.
    let mut gated = read_only.clone();
    gated["mustAsk"] = json!(["push", "deploy", "delete", "spend"]);
    assert_eq!(
        auto_start_refusal(&db, &wide, &gated).unwrap(),
        Some("card-asks-before-acting")
    );
}

#[test]
fn an_observing_bot_still_receives_a_card_a_person_confirms() {
    let db = database();
    let steward = session(&db, "Steward", None, "auto");
    let observing = bot(&db, "观察中", "accept-edits", true);
    let draft = propose_card(&db, &steward, &observing, "accept-edits");
    // Policy declines...
    assert_eq!(
        auto_start_refusal(&db, &observing, &draft.card).unwrap(),
        Some("employee-observing")
    );
    // ...and a person's click is still enough.
    super::confirm(&db, confirm_request(&draft, "click")).unwrap();
    assert_eq!(get(&db, &draft.id).unwrap().unwrap().status, "confirmed");
}

#[test]
fn the_employee_surface_lists_status_and_keeps_the_conversation_on_dismiss() {
    let db = database();
    // Slice 6: the host creates one employee by itself, the steward. Every other
    // job is hired, so the worker here is created the way a person's click does.
    let seeded = crate::session_collaboration::bots::seed_defaults(&db).unwrap();
    assert_eq!(seeded["created"].as_array().unwrap().len(), 1);
    let listed = crate::session_collaboration::bots::list(&db).unwrap();
    let bots = listed["bots"].as_array().unwrap();
    assert_eq!(bots.len(), 1);
    let steward = bots
        .iter()
        .find(|bot| bot["profile"]["definition"] == json!("steward"))
        .unwrap();
    assert_eq!(steward["profile"]["observe"], json!(false));
    // The default name is only a default; every label reads this value.
    assert_eq!(
        steward["profile"]["name"],
        json!(crate::session_collaboration::bots::STEWARD_DEFAULT_NAME)
    );
    assert_eq!(
        steward["title"],
        json!(crate::session_collaboration::bots::STEWARD_DEFAULT_NAME)
    );
    assert_eq!(steward["status"], json!({"kind": "idle"}));

    // A hired worker begins observing until the person turns it on.
    let worker = bot(&db, "工人", "ask", true);
    let listed = crate::session_collaboration::bots::list(&db).unwrap();
    let bots = listed["bots"].as_array().unwrap();
    assert_eq!(bots.len(), 2);
    for bot in bots
        .iter()
        .filter(|bot| bot["profile"]["definition"] != json!("steward"))
    {
        assert_eq!(bot["profile"]["observe"], json!(true));
    }

    // A delivery's stage becomes the dot.
    let steward_id = steward["sessionId"].as_str().unwrap().to_string();
    let draft = propose_card(&db, &steward_id, &worker, "ask");
    super::confirm(&db, confirm_request(&draft, "surface")).unwrap();
    let after = crate::session_collaboration::bots::list(&db).unwrap();
    let row = after["bots"]
        .as_array()
        .unwrap()
        .iter()
        .find(|bot| bot["sessionId"] == json!(worker))
        .unwrap();
    // Employee mode 0.5: the dot is derived from the tasks the employee holds,
    // so a confirmed card that has not started yet reads as queued — the same
    // reading the sidebar and the workbench take from the same rows.
    assert_eq!(row["status"], json!({"kind": "stage", "stage": "queued"}));
    assert_eq!(row["openTaskCount"], json!(1));
    let tasks = crate::tasks::list(&db, &json!({ "employeeSessionId": worker })).unwrap();
    assert_eq!(
        tasks["tasks"][0]["stage"],
        json!("queued"),
        "the employee's work is the task, and it is queued"
    );

    // Dismissing flips the role back and keeps the session.
    crate::session_collaboration::bots::dismiss(&db, &json!({"sessionId": worker})).unwrap();
    assert_eq!(
        sessions::session_role(&db, &worker).unwrap().as_deref(),
        Some("user")
    );
    assert!(crate::sessions::session_summary(&db, &worker)
        .unwrap()
        .is_some());
    // Seeding again sees the steward it already has: nothing is created, and the
    // dismissed worker is not resurrected — a dismiss is a decision.
    let again = crate::session_collaboration::bots::seed_defaults(&db).unwrap();
    assert_eq!(again["created"], json!([]));
    assert_eq!(again["skipped"].as_array().unwrap().len(), 1);
    let restored = crate::session_collaboration::bots::list(&db).unwrap();
    assert_eq!(restored["bots"].as_array().unwrap().len(), 1);
}

/// A confirmed card whose turn was never started is offered again.
///
/// Confirming only writes the ledger row, so an app that closed between confirm
/// and start used to leave the work queued forever. The row is claimed before a
/// turn runs, so it holds a `turn_id` afterwards and a second pass must not
/// offer it again.
#[test]
fn a_confirmed_card_is_pending_dispatch_until_a_turn_claims_it() {
    let db = database();
    let steward = session(&db, "Steward", None, "auto");
    let worker = session(&db, "小爪", Some("bot"), "accept-edits");
    let draft = propose_card(&db, &steward, &worker, "accept-edits");
    let confirmed = super::confirm(&db, confirm_request(&draft, "confirm-once")).unwrap();
    let delivery_id = confirmed["delivery"]["id"].as_str().unwrap().to_string();

    let pending = crate::session_collaboration::repository::pending_dispatch(&db).unwrap();
    assert_eq!(
        pending.iter().filter(|row| row.id == delivery_id).count(),
        1,
        "the confirmed delivery waits for a turn"
    );

    // A claim writes the turn id and leaves `queued`. The turn is claimed by the
    // session the delivery now targets, which is the task's own session.
    let task_session = confirmed["task"]["sessionId"].as_str().unwrap().to_string();
    crate::session_collaboration::settlement::begin_turn(
        &db,
        &task_session,
        &delivery_id,
        None,
        None,
    )
    .unwrap();
    let after = crate::session_collaboration::repository::pending_dispatch(&db).unwrap();
    assert!(
        after.iter().all(|row| row.id != delivery_id),
        "a delivery that already has a turn is never offered again"
    );
}

/// The steward's notice is a delivered message, not work.
///
/// It must not sit in the ledger looking like a task that never ran, and it must
/// never be picked up as something to start.
#[test]
fn the_steward_notice_is_terminal_and_never_dispatchable() {
    let db = database();
    let steward = session(&db, "Steward", None, "auto");
    let worker = session(&db, "小爪", Some("bot"), "accept-edits");
    let draft = propose_card(&db, &steward, &worker, "accept-edits");
    super::confirm(&db, confirm_request(&draft, "confirm-notice")).unwrap();

    let notice = crate::session_collaboration::repository::recent(&db, &steward, 20)
        .unwrap()
        .into_iter()
        .find(|row| row.content.contains("confirmed by"))
        .expect("the steward receives a notice");
    assert_eq!(
        notice.status, "completed",
        "the notice is already delivered"
    );
    assert_eq!(notice.kind, "message");
    let pending = crate::session_collaboration::repository::pending_dispatch(&db).unwrap();
    assert!(
        pending.iter().all(|row| row.id != notice.id),
        "a notice is never picked up as work to start"
    );
}

/// A person's click is the authorization (employee mode 0.5 slice 3, review
/// S2). The task runs at the *narrower* of the card and the employee; the
/// steward's own mode is not part of it.
///
/// Before this rule the steward's `ask` was part of the minimum, so every
/// employee the person had opened up to `accept-edits` was unreachable: the
/// confirmation was refused as `PERMISSION_DENIED: target permission mode
/// exceeds the sending session's authorization`.
#[test]
fn a_click_starts_the_task_at_the_narrower_of_the_card_and_the_employee() {
    let db = database();
    let steward = session(&db, "Steward", None, "ask");
    let employee = bot(&db, "界面", "accept-edits", false);
    let draft = propose_card(&db, &steward, &employee, "accept-edits");
    let confirmed = super::confirm(&db, confirm_request(&draft, "click-wide")).unwrap();
    let task_session = confirmed["task"]["sessionId"].as_str().unwrap();
    assert_eq!(
        sessions::session_permission_mode(&db, task_session)
            .unwrap()
            .as_deref(),
        Some("accept-edits"),
        "the task runs at the mode the click authorized"
    );
    // Queued, not refused: the work can start a turn.
    assert_eq!(confirmed["delivery"]["status"], json!("queued"));
    assert_eq!(
        confirmed["delivery"]["permissionCeiling"],
        json!("accept-edits")
    );
}

/// A card asking for more than the employee may do runs at the employee's mode,
/// and says so on the card the person reads.
#[test]
fn a_card_wider_than_the_employee_runs_at_the_employees_mode() {
    let db = database();
    let steward = session(&db, "Steward", None, "auto");
    let employee = bot(&db, "界面", "accept-edits", false);
    let draft = propose_card(&db, &steward, &employee, "auto");
    assert_eq!(
        draft.card["permissionMode"],
        json!("accept-edits"),
        "the stored card carries the mode that will run"
    );
    let confirmed = super::confirm(&db, confirm_request(&draft, "click-wide-card")).unwrap();
    let task_session = confirmed["task"]["sessionId"].as_str().unwrap();
    assert_eq!(
        sessions::session_permission_mode(&db, task_session)
            .unwrap()
            .as_deref(),
        Some("accept-edits")
    );
    assert_eq!(
        confirmed["delivery"]["permissionCeiling"],
        json!("accept-edits")
    );
}

/// Reassigning re-narrows against the new employee only: the steward's mode
/// still does not take part (review S2).
#[test]
fn reassigning_a_card_narrows_it_to_the_new_employees_mode() {
    let db = database();
    // The steward hands work out at `ask`; the employees run it.
    let steward = session(&db, "Steward", None, "ask");
    let first = bot(&db, "界面", "accept-edits", false);
    let second = bot(&db, "后端", "accept-edits", false);
    let narrow = bot(&db, "文档", "ask", false);
    let draft = propose_card(&db, &steward, &first, "accept-edits");
    // An employee at the same mode does not narrow it: the steward's `ask` was
    // never the card's ceiling.
    let moved = super::reassign(
        &db,
        &json!({"draftId": &draft.id, "targetSessionId": second}),
    )
    .unwrap();
    assert_eq!(
        moved["draft"]["card"]["permissionMode"],
        json!("accept-edits"),
        "the new employee's mode, not the steward's"
    );
    // A narrower employee does, and the task it starts runs at that mode.
    let moved = super::reassign(
        &db,
        &json!({"draftId": &draft.id, "targetSessionId": narrow}),
    )
    .unwrap();
    assert_eq!(moved["draft"]["card"]["permissionMode"], json!("ask"));
    let moved = serde_json::from_value::<Draft>(moved["draft"].clone()).unwrap();
    let confirmed = super::confirm(&db, confirm_request(&moved, "click-narrow")).unwrap();
    let task_session = confirmed["task"]["sessionId"].as_str().unwrap();
    assert_eq!(
        sessions::session_permission_mode(&db, task_session)
            .unwrap()
            .as_deref(),
        Some("ask")
    );
    assert_eq!(confirmed["delivery"]["permissionCeiling"], json!("ask"));
}

/// A card that says it only reads may be started by the host — at `ask`, which
/// is the only mode the label allows (review S1).
#[test]
fn a_read_only_card_starts_at_ask() {
    let db = database();
    let steward = session(&db, "Steward", None, "auto");
    let employee = bot(&db, "Router 后端", "accept-edits", false);
    let mut card = card("ask");
    card["readOnly"] = json!(true);
    card["mustAsk"] = json!(["deploy", "delete", "spend"]);
    let proposed = super::propose(
        &db,
        &json!({
            "sessionId": steward,
            "targetSessionId": employee,
            "sourceUtterance": "调研 Router 网关的超时配置",
            "card": card,
        }),
    )
    .unwrap();
    let draft: Draft = serde_json::from_value(proposed["draft"].clone()).unwrap();
    // The host's own policy allows this one, and only because it says so.
    assert_eq!(
        auto_start_refusal(&db, &employee, &draft.card).unwrap(),
        None
    );
    let confirmed = super::confirm(
        &db,
        ConfirmRequest {
            confirmed_by: CONFIRMED_BY_POLICY,
            ..confirm_request(&draft, "policy-read-only")
        },
    )
    .unwrap();
    let task_session = confirmed["task"]["sessionId"].as_str().unwrap();
    assert_eq!(
        sessions::session_permission_mode(&db, task_session)
            .unwrap()
            .as_deref(),
        Some("ask"),
        "a task nobody looked at asks before it acts"
    );
    assert_eq!(confirmed["delivery"]["permissionCeiling"], json!("ask"));
    assert_eq!(
        confirmed["delivery"]["mandate"]["permissionMode"],
        json!("ask")
    );
}

/// The backstop: even if a caller reaches `confirm` with `confirmedBy: policy`
/// for a card the auto-start rule would refuse, the task is clamped to `ask`.
/// This is what stops a wrong rule — now or later — from becoming authority
/// nobody granted (review S1).
#[test]
fn a_policy_confirmation_never_runs_wider_than_ask() {
    let db = database();
    let steward = session(&db, "Steward", None, "auto");
    let employee = bot(&db, "界面", "accept-edits", false);
    let draft = propose_card(&db, &steward, &employee, "auto");
    // The rule refuses this card, so nothing would normally confirm it.
    assert_eq!(
        auto_start_refusal(&db, &employee, &draft.card).unwrap(),
        Some("card-not-read-only")
    );
    let confirmed = super::confirm(
        &db,
        ConfirmRequest {
            confirmed_by: CONFIRMED_BY_POLICY,
            ..confirm_request(&draft, "policy-wide")
        },
    )
    .unwrap();
    let task_session = confirmed["task"]["sessionId"].as_str().unwrap();
    assert_eq!(
        sessions::session_permission_mode(&db, task_session)
            .unwrap()
            .as_deref(),
        Some("ask"),
        "the clamp is on the task session, whatever the card said"
    );
    assert_eq!(
        confirmed["delivery"]["mandate"]["permissionMode"],
        json!("ask"),
        "the ledger records the mode that runs"
    );
    assert_eq!(confirmed["delivery"]["permissionCeiling"], json!("ask"));
}

/// The label and the mode cannot disagree: read-only work asks before acting,
/// and the host refuses the combination rather than reinterpreting it.
#[test]
fn a_read_only_card_must_ask_before_acting() {
    let db = database();
    let steward = session(&db, "Steward", None, "auto");
    let employee = bot(&db, "界面", "accept-edits", false);
    let mut impossible = card("auto");
    impossible["readOnly"] = json!(true);
    let refused = super::propose(
        &db,
        &json!({
            "sessionId": steward,
            "targetSessionId": employee,
            "sourceUtterance": "调研一下",
            "card": impossible,
        }),
    )
    .unwrap_err();
    assert!(
        refused.to_string().contains("INVALID_ARGUMENT"),
        "{refused}"
    );
    // The same rule on the revise path: a proposed card cannot be edited into it
    // either.
    let draft = propose_card(&db, &steward, &employee, "accept-edits");
    let mut impossible = card("auto");
    impossible["readOnly"] = json!(true);
    let refused =
        super::revise(&db, &json!({"draftId": draft.id, "card": impossible})).unwrap_err();
    assert!(
        refused.to_string().contains("INVALID_ARGUMENT"),
        "{refused}"
    );
    // And a `readOnly` that is not a boolean is refused, not coerced.
    let mut malformed = card("ask");
    malformed["readOnly"] = json!("yes");
    let refused = super::propose(
        &db,
        &json!({
            "sessionId": steward,
            "targetSessionId": employee,
            "sourceUtterance": "调研一下",
            "card": malformed,
        }),
    )
    .unwrap_err();
    assert!(
        refused.to_string().contains("INVALID_ARGUMENT"),
        "{refused}"
    );
}

/// Renaming the steward keeps the two places the name is stored in step.
///
/// The profile name is what every surface shows, and the session title is the
/// same label: a rename that changed one and not the other would show two names
/// for one employee. Nothing else about the employee changes, because a rename
/// is only a rename.
#[test]
fn renaming_the_steward_keeps_its_title_and_profile_name_in_step() {
    let db = database();
    crate::session_collaboration::bots::seed_defaults(&db).unwrap();
    let listed = crate::session_collaboration::bots::list(&db).unwrap();
    let steward = listed["bots"]
        .as_array()
        .unwrap()
        .iter()
        .find(|bot| bot["profile"]["definition"] == json!("steward"))
        .cloned()
        .unwrap();
    let id = steward["sessionId"].as_str().unwrap().to_string();
    let updated = crate::session_collaboration::bots::update(
        &db,
        &json!({"sessionId": id, "profile": {"name": "阿福"}}),
    )
    .unwrap();
    assert_eq!(updated["session"]["title"], json!("阿福"));
    let after = crate::session_collaboration::bots::list(&db).unwrap();
    let renamed = after["bots"]
        .as_array()
        .unwrap()
        .iter()
        .find(|bot| bot["sessionId"] == json!(id))
        .cloned()
        .unwrap();
    assert_eq!(renamed["profile"]["name"], json!("阿福"));
    assert_eq!(renamed["profile"]["definition"], json!("steward"));
    assert_eq!(renamed["profile"]["permissionMode"], json!("ask"));
    assert_eq!(renamed["profile"]["observe"], json!(false));
}
