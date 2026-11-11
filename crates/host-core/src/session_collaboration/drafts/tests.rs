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
    assert_eq!(message.target_session_id, worker);
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
    // The worker's mode is raised past the card, so the delivery is refused.
    db.conn()
        .execute(
            "UPDATE sessions SET permission_mode='auto' WHERE id=?1",
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
#[test]
fn auto_start_needs_an_observing_off_employee_and_a_narrow_card() {
    let db = database();
    let wide = bot(&db, "Wide", "accept-edits", false);
    let observing = bot(&db, "Observing", "accept-edits", true);
    let plain = session(&db, "Just a chat", None, "auto");

    // All three conditions hold.
    assert_eq!(
        auto_start_refusal(&db, &wide, &card("accept-edits")).unwrap(),
        None
    );
    assert_eq!(auto_start_refusal(&db, &wide, &card("ask")).unwrap(), None);

    // An `auto` card always waits for a click.
    assert_eq!(
        auto_start_refusal(&db, &wide, &card("auto")).unwrap(),
        Some("card-too-wide")
    );
    // An observing employee never auto-starts.
    assert_eq!(
        auto_start_refusal(&db, &observing, &card("ask")).unwrap(),
        Some("employee-observing")
    );
    // A target that is not an employee never auto-starts.
    assert_eq!(
        auto_start_refusal(&db, &plain, &card("ask")).unwrap(),
        Some("target-not-an-employee")
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
    let seeded = crate::session_collaboration::bots::seed_defaults(&db).unwrap();
    assert_eq!(seeded["created"].as_array().unwrap().len(), 4);
    // The steward may start work by itself; the others begin observing.
    let listed = crate::session_collaboration::bots::list(&db).unwrap();
    let bots = listed["bots"].as_array().unwrap();
    assert_eq!(bots.len(), 4);
    let steward = bots
        .iter()
        .find(|bot| bot["profile"]["definition"] == json!("steward"))
        .unwrap();
    assert_eq!(steward["profile"]["observe"], json!(false));
    assert_eq!(steward["status"], json!({"kind": "idle"}));
    for bot in bots
        .iter()
        .filter(|bot| bot["profile"]["definition"] != json!("steward"))
    {
        assert_eq!(bot["profile"]["observe"], json!(true));
    }

    // A delivery's stage becomes the dot.
    let worker = bots
        .iter()
        .find(|bot| bot["profile"]["definition"] != json!("steward"))
        .unwrap()["sessionId"]
        .as_str()
        .unwrap()
        .to_string();
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
    // No report yet, so the dot reports the queued delivery, not a stage.
    assert_eq!(row["status"], json!({"kind": "stage", "stage": "queued"}));

    // Dismissing flips the role back and keeps the session.
    crate::session_collaboration::bots::dismiss(&db, &json!({"sessionId": worker})).unwrap();
    assert_eq!(
        sessions::session_role(&db, &worker).unwrap().as_deref(),
        Some("user")
    );
    assert!(crate::sessions::session_summary(&db, &worker)
        .unwrap()
        .is_some());
    // Seeding again restores only the dismissed employee: the crew is
    // identified by profile name, so the three that stayed are not duplicated.
    let again = crate::session_collaboration::bots::seed_defaults(&db).unwrap();
    assert_eq!(again["created"].as_array().unwrap().len(), 1);
    assert_eq!(again["skipped"].as_array().unwrap().len(), 3);
    let restored = crate::session_collaboration::bots::list(&db).unwrap();
    assert_eq!(restored["bots"].as_array().unwrap().len(), 4);
}
