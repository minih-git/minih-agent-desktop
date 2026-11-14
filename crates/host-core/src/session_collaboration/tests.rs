use super::*;

fn session(db: &Database, title: &str) -> String {
    sessions::create_session_with_options(
        db,
        sessions::SessionCreateOptions {
            title: Some(title.into()),
            mode: Some("agent".into()),
            permission_mode: Some("ask".into()),
            ..Default::default()
        },
    )
    .unwrap()
    .id
}

fn send(db: &Database, source: &str, target: &str, key: &str) -> Message {
    send_record(
        db,
        &json!({"sourceSessionId":source,"pluginId":"pi.session-orchestrator",
        "content":"Review the change","idempotencyKey":key,"notifyOnCompletion":true}),
        target,
        "task",
    )
    .unwrap()
}

fn ui(role: &str, content: &str) -> sessions::UiMessage {
    serde_json::from_value(
        json!({"id":Uuid::new_v4().to_string(),"role":role,"content":content,
        "createdAt":ms_to_ts(now_ms())}),
    )
    .unwrap()
}

fn turn_count(db: &Database, session_id: &str) -> i64 {
    db.conn()
        .query_row(
            "SELECT COUNT(*) FROM turns WHERE session_id=?1",
            params![session_id],
            |row| row.get(0),
        )
        .unwrap()
}

#[test]
fn sessions_are_reused_and_send_is_idempotent() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
    let parent = session(&db, "Parent");
    let child = session(&db, "Existing conversation");
    let first = send(&db, &parent, &child, "one");
    assert_eq!(first.remaining_hops, 32);
    assert_eq!(send(&db, &parent, &child, "one").id, first.id);
    assert_eq!(
        send(&db, &child, &parent, "reply").target_session_id,
        parent
    );
    let mismatch = send_record(
        &db,
        &json!({"sourceSessionId":parent,"pluginId":"pi.session-orchestrator",
        "content":"different","idempotencyKey":"one"}),
        &child,
        "task",
    )
    .unwrap_err();
    assert!(mismatch.to_string().starts_with("IDEMPOTENCY_CONFLICT"));
    let count: i64 = db
        .conn()
        .query_row("SELECT COUNT(*) FROM sessions", [], |row| row.get(0))
        .unwrap();
    assert_eq!(count, 2);
}

#[test]
fn stored_communication_budgets_are_not_refilled() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
    let parent = session(&db, "Parent");
    let child = session(&db, "Child");
    let original = send(&db, &parent, &child, "legacy");
    // Simulate a delivery persisted before the default budget increased.
    db.conn()
        .execute(
            "UPDATE session_collaboration_messages SET remaining_hops=8 WHERE id=?1",
            params![original.id],
        )
        .unwrap();
    let turn = begin_turn(&db, &child, &original.id, None, None).unwrap();
    let response = handle(
        &db,
        "session.collaboration.send",
        &json!({"sourceSessionId":child,"sourceTurnId":turn,
            "sessionId":parent,"pluginId":"pi.session-orchestrator",
            "content":"Continue the existing chain","idempotencyKey":"legacy-next",
            "notifyOnCompletion":false}),
    )
    .unwrap();
    let next = get(&db, response["message"]["id"].as_str().unwrap())
        .unwrap()
        .unwrap();
    assert_eq!(next.remaining_hops, 7);
    assert_eq!(get(&db, &original.id).unwrap().unwrap().remaining_hops, 8);

    sessions::end_turn(&db, &turn, "completed", None, None, false).unwrap();
    let receipt = settle_turn(&db, &turn).unwrap().unwrap();
    assert_eq!(receipt.remaining_hops, 7);
}

#[test]
fn projections_expose_readable_model_names_and_session_discovery_links() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
    let parent = session(&db, "Parent");
    let child = session(&db, "Linked child");
    db.conn()
        .execute(
            "INSERT INTO providers(id,name,created_at,updated_at) VALUES(?1,?2,?3,?3)",
            params!["provider-id", "Readable Provider", now_ms()],
        )
        .unwrap();
    db.conn()
        .execute(
            "INSERT INTO models(provider_id,model_id,display_name,updated_at) VALUES(?1,?2,?3,?4)",
            params!["provider-id", "model-id", "Readable Model", now_ms()],
        )
        .unwrap();
    db.conn()
        .execute(
            "UPDATE sessions SET provider_id=?1,model_id=?2 WHERE id=?3",
            params!["provider-id", "model-id", child],
        )
        .unwrap();
    db.conn()
        .execute(
            "INSERT INTO session_collaboration_links(session_id,created_by_session_id,plugin_id,created_at)
             VALUES(?1,?2,?3,?4)",
            params![child, parent, "pi.session-orchestrator", now_ms()],
        )
        .unwrap();

    let child_summary = handle(
        &db,
        "session.collaboration.status",
        &json!({"sessionId":child}),
    )
    .unwrap();
    assert_eq!(child_summary["providerName"], "Readable Provider");
    assert_eq!(child_summary["modelName"], "Readable Model");
    assert_eq!(child_summary["createdBySession"]["sessionId"], parent);

    let parent_summary = handle(
        &db,
        "session.collaboration.status",
        &json!({"sessionId":parent}),
    )
    .unwrap();
    assert_eq!(parent_summary["createdSessions"][0]["sessionId"], child);
    assert_eq!(parent_summary["createdSessions"][0]["available"], true);

    let listed = handle(&db, "session.collaboration.list", &json!({})).unwrap();
    let sessions = listed["sessions"].as_array().unwrap();
    assert!(sessions.iter().any(|entry| entry["sessionId"] == parent));
    assert!(sessions.iter().any(|entry| entry["sessionId"] == child));
    assert_eq!(
        sessions
            .iter()
            .find(|entry| entry["sessionId"] == child)
            .unwrap()["providerName"],
        "Readable Provider"
    );
}

#[test]
fn turn_bound_result_and_callback_are_durable_and_exactly_once() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("pi.sqlite");
    let db = Database::open(&path).unwrap();
    let parent = session(&db, "Parent");
    let child = session(&db, "Child");
    let message = send(&db, &parent, &child, "one");
    let turn = begin_turn(&db, &child, &message.id, None, None).unwrap();
    assert!(begin_turn(&db, &child, &message.id, None, None).is_err());
    sessions::append_message(&db, &child, &ui("user", &message.content), Some(&turn)).unwrap();
    sessions::append_message(
        &db,
        &child,
        &ui("assistant", "Authoritative final result"),
        Some(&turn),
    )
    .unwrap();
    assert!(settle_turn(&db, &turn).unwrap().is_none());
    sessions::end_turn(&db, &turn, "completed", None, None, false).unwrap();
    let receipt = settle_turn(&db, &turn).unwrap().unwrap();
    assert_eq!(settle_turn(&db, &turn).unwrap().unwrap().id, receipt.id);
    assert_eq!(
        receipt.reply_to_message_id.as_deref(),
        Some(message.id.as_str())
    );
    assert!(!receipt.notify_on_completion);
    assert_eq!(message.remaining_hops, 32);
    assert_eq!(receipt.remaining_hops, 31);
    let result = handle(
        &db,
        "session.collaboration.result",
        &json!({"sessionId":child,"messageId":message.id}),
    )
    .unwrap();
    assert_eq!(result["ready"], true);
    assert_eq!(result["message"]["result"], "Authoritative final result");
    drop(db);
    let db = Database::open(&path).unwrap();
    let detail = sessions::get_session(&db, &child).unwrap().unwrap();
    assert_eq!(
        detail.messages[0].session_message.as_ref().unwrap()["sourceSessionId"],
        parent
    );
    assert_eq!(get(&db, &message.id).unwrap().unwrap().status, "completed");
    assert_eq!(
        get(&db, &receipt.id).unwrap().unwrap().status,
        "interrupted"
    );
}

#[test]
fn failed_turn_does_not_promote_intermediate_output() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
    let parent = session(&db, "Parent");
    let child = session(&db, "Child");
    let message = send(&db, &parent, &child, "one");
    let turn = begin_turn(&db, &child, &message.id, None, None).unwrap();
    sessions::append_message(
        &db,
        &child,
        &ui("assistant", "I will investigate"),
        Some(&turn),
    )
    .unwrap();
    sessions::end_turn(&db, &turn, "error", Some("PROVIDER_FAILED"), None, false).unwrap();
    settle_turn(&db, &turn).unwrap();
    let failed = get(&db, &message.id).unwrap().unwrap();
    assert_eq!(failed.status, "failed");
    assert!(failed.result.is_none());
    assert_eq!(failed.error.as_deref(), Some("PROVIDER_FAILED"));
}

#[test]
fn provenance_cannot_be_forged_or_stripped_and_permissions_are_rechecked() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
    let parent = session(&db, "Parent");
    let child = session(&db, "Child");
    let message = send(&db, &parent, &child, "one");
    db.conn()
        .execute(
            "UPDATE sessions SET permission_mode='auto' WHERE id=?1",
            params![child],
        )
        .unwrap();
    assert!(begin_turn(&db, &child, &message.id, None, None)
        .unwrap_err()
        .to_string()
        .starts_with("PERMISSION_DENIED"));
    db.conn()
        .execute(
            "UPDATE sessions SET permission_mode='ask' WHERE id=?1",
            params![child],
        )
        .unwrap();
    let turn = begin_turn(&db, &child, &message.id, None, None).unwrap();
    assert!(sessions::append_message(&db, &child, &ui("user", "forged"), Some(&turn)).is_err());
    sessions::append_message(&db, &child, &ui("user", &message.content), Some(&turn)).unwrap();
    let mut detail = sessions::get_session(&db, &child).unwrap().unwrap();
    detail.messages[0].session_message = None;
    assert!(sessions::replace_messages(&db, &child, &detail.messages).is_err());
}

#[test]
fn steering_input_persists_without_inheriting_delivery_origin() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
    let parent = session(&db, "Parent");
    let child = session(&db, "Child");
    let message = send(&db, &parent, &child, "one");
    let turn = begin_turn(&db, &child, &message.id, None, None).unwrap();

    // The delivery user row still receives host-derived origin.
    sessions::append_message(&db, &child, &ui("user", &message.content), Some(&turn)).unwrap();

    // Additional human input into the delivery turn keeps its human origin: it
    // must not be rejected as a delivery mismatch, must not inherit the
    // delivery's agent origin, and must drop a client-supplied origin.
    let mut steering = ui("user", "also update the docs");
    steering.steering = Some(true);
    steering.session_message = Some(json!({"messageId":"forged","kind":"task"}));
    sessions::append_message(&db, &child, &steering, Some(&turn)).unwrap();

    let detail = sessions::get_session(&db, &child).unwrap().unwrap();
    let delivery_row = detail
        .messages
        .iter()
        .find(|m| m.content == message.content)
        .expect("delivery user persisted");
    assert!(delivery_row.session_message.is_some());
    let appended = detail
        .messages
        .iter()
        .find(|m| m.id == steering.id)
        .expect("steering message persisted");
    assert_eq!(appended.content, "also update the docs");
    assert!(appended.session_message.is_none());

    // Steering must still target the delivery's session.
    let mut wrong = ui("user", "steer into another session");
    wrong.steering = Some(true);
    assert!(sessions::append_message(&db, &parent, &wrong, Some(&turn))
        .unwrap_err()
        .to_string()
        .starts_with("PERMISSION_DENIED"));
}

#[test]
fn queued_cancellation_keeps_the_session_and_notifies_once() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
    let parent = session(&db, "Parent");
    let child = session(&db, "Child");
    let message = send(&db, &parent, &child, "one");
    let input = json!({"sessionId":child,"messageId":message.id,"pluginId":message.plugin_id,"sourceSessionId":parent});
    handle(&db, "session.collaboration.cancel", &input).unwrap();
    handle(&db, "session.collaboration.cancel", &input).unwrap();
    assert_eq!(get(&db, &message.id).unwrap().unwrap().status, "cancelled");
    assert_eq!(
        repository::pending_callbacks(&db, Some(&parent))
            .unwrap()
            .len(),
        1
    );
    assert!(sessions::get_session(&db, &child).unwrap().is_some());
}

#[test]
fn schema_v15_upgrade_preserves_sessions_and_adds_the_ledger() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("pi.sqlite");
    let id;
    {
        let db = Database::open(&path).unwrap();
        id = session(&db, "Existing user session");
        db.conn()
            .execute_batch(
                "DROP TABLE session_collaboration_messages; DROP TABLE session_collaboration_links;
            ALTER TABLE turn_queue DROP COLUMN session_message_id; PRAGMA user_version=15;",
            )
            .unwrap();
    }
    let db = Database::open(&path).unwrap();
    assert_eq!(
        sessions::get_session(&db, &id)
            .unwrap()
            .unwrap()
            .summary
            .title,
        "Existing user session"
    );
    // A v15 file walks every later step in the same launch, so it lands on the
    // current version rather than the one this migration happens to produce.
    assert_eq!(
        db.conn()
            .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
            .unwrap(),
        crate::db::SCHEMA_VERSION
    );
    assert!(crate::db::migration_backup_path(&path, 15).exists());
    assert!(repository::pending_callbacks(&db, None).unwrap().is_empty());
}

#[test]
fn deleted_creator_keeps_its_reference_and_reports_it_unavailable() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
    let parent = session(&db, "Parent");
    let child = session(&db, "Child");
    let soft_parent = session(&db, "Soft parent");
    let soft_child = session(&db, "Soft child");
    for (linked, creator) in [(&child, &parent), (&soft_child, &soft_parent)] {
        db.conn()
            .execute(
                "INSERT INTO session_collaboration_links(session_id,created_by_session_id,plugin_id,created_at)
                 VALUES(?1,?2,?3,?4)",
                params![linked, creator, "pi.session-orchestrator", now_ms()],
            )
            .unwrap();
    }
    assert!(sessions::delete_session(&db, &parent).unwrap());
    db.conn()
        .execute(
            "UPDATE sessions SET deleted_at=?1 WHERE id=?2",
            params![now_ms(), soft_parent],
        )
        .unwrap();

    let removed = handle(
        &db,
        "session.collaboration.status",
        &json!({"sessionId":child}),
    )
    .unwrap();
    assert_eq!(removed["createdBySession"]["sessionId"], parent);
    // Without the session row the title falls back to the referenced id.
    assert_eq!(removed["createdBySession"]["title"], parent);
    assert_eq!(removed["createdBySession"]["available"], false);

    let soft_removed = handle(
        &db,
        "session.collaboration.status",
        &json!({"sessionId":soft_child}),
    )
    .unwrap();
    assert_eq!(soft_removed["createdBySession"]["sessionId"], soft_parent);
    assert_eq!(soft_removed["createdBySession"]["title"], "Soft parent");
    assert_eq!(soft_removed["createdBySession"]["available"], false);
}

#[test]
fn deleted_message_source_survives_the_ledger_and_reports_an_unavailable_peer() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
    let parent = session(&db, "Parent");
    let child = session(&db, "Child");
    let message = send(&db, &parent, &child, "one");
    assert!(sessions::delete_session(&db, &parent).unwrap());
    // source_session_id has no foreign key, so the delivered row survives.
    assert_eq!(get(&db, &message.id).unwrap().unwrap().status, "queued");

    let summary = handle(
        &db,
        "session.collaboration.status",
        &json!({"sessionId":child}),
    )
    .unwrap();
    assert_eq!(summary["currentTask"]["senderSession"]["sessionId"], parent);
    assert_eq!(summary["currentTask"]["senderSession"]["available"], false);
    assert_eq!(summary["recentExchanges"][0]["peer"]["sessionId"], parent);
    assert_eq!(summary["recentExchanges"][0]["peer"]["available"], false);
}

#[test]
fn begin_turn_twice_reports_conflict_without_a_second_turn() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
    let parent = session(&db, "Parent");
    let child = session(&db, "Child");
    let message = send(&db, &parent, &child, "one");
    let turn = begin_turn(&db, &child, &message.id, None, None).unwrap();
    let conflict = begin_turn(&db, &child, &message.id, None, None).unwrap_err();
    assert_eq!(
        conflict.to_string(),
        "CONFLICT: session message already claimed or settled"
    );
    assert_eq!(get(&db, &message.id).unwrap().unwrap().turn_id, Some(turn));
    assert_eq!(turn_count(&db, &child), 1);
}

#[test]
fn a_claim_that_loses_the_race_returns_conflict_and_rolls_back() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
    let parent = session(&db, "Parent");
    let child = session(&db, "Child");
    let message = send(&db, &parent, &child, "one");
    // Simulates another actor settling the queued message between the read at
    // the start of begin_turn and its conditional claim.
    db.conn()
        .execute_batch(
            "CREATE TRIGGER settle_during_claim AFTER INSERT ON turns
             BEGIN
               UPDATE session_collaboration_messages SET status='cancelled'
               WHERE target_session_id=NEW.session_id AND status='queued';
             END;",
        )
        .unwrap();
    let conflict = begin_turn(&db, &child, &message.id, None, None).unwrap_err();
    assert!(conflict.to_string().starts_with("CONFLICT"));
    // The claim changed no row, so the transaction rolled back completely.
    assert_eq!(turn_count(&db, &child), 0);
    assert_eq!(get(&db, &message.id).unwrap().unwrap().status, "queued");
}

// ---- Employee mode 0.5 slice 3: the steward's roster, wake-ups, restarts ----

/// One employee, with the profile a card can be dispatched to.
fn employee(db: &Database, name: &str, definition: Option<&str>, observe: bool) -> String {
    let mut profile = json!({
        "name": name,
        "duty": format!("{name} duty"),
        "permissionMode": "accept-edits",
        "mustAsk": [],
        "observe": observe,
    });
    if let Some(definition) = definition {
        profile["definition"] = json!(definition);
    }
    sessions::create_session_with_options(
        db,
        sessions::SessionCreateOptions {
            title: Some(name.into()),
            mode: Some("agent".into()),
            permission_mode: Some("accept-edits".into()),
            role: Some("bot".into()),
            bot_profile_json: Some(profile.to_string()),
            ..Default::default()
        },
    )
    .unwrap()
    .id
}

/// A steward-dispatched task: a delivery carrying a mandate, a task row, and the
/// delivery re-pointed at the task's own session — exactly what a confirmed card
/// produces.
fn dispatched_task(db: &Database, steward: &str, employee: &str, origin: &str) -> (String, String) {
    let mandate = json!({
        "version": 1,
        "taskId": Uuid::new_v4().to_string(),
        "goal": "Fix the login timeout",
        "criteria": [{"id": "c1", "text": "A failing repro exists"}],
        "boundaries": [],
        "permissionMode": "accept-edits",
        "mustAsk": ["deploy", "delete", "spend"],
        "risk": "low",
        "requestedBy": {"kind": "user", "hostId": "mac-mini"},
        "sourceUtterance": "登录超时今天修掉",
        "createdAt": ms_to_ts(now_ms()),
        "policyVersion": "steward-1",
    })
    .to_string();
    let delivery = send_record(
        db,
        &json!({
            "sourceSessionId": steward,
            "pluginId": "builtin:session-messaging",
            "content": "Fix the login timeout",
            "idempotencyKey": format!("card-{}", Uuid::new_v4()),
            "notifyOnCompletion": true,
            "mandate": mandate,
        }),
        employee,
        "task",
    )
    .unwrap();
    let created = crate::tasks::create(
        db,
        &json!({
            "employeeSessionId": employee,
            "title": "Fix the login timeout",
            "origin": origin,
            "deliveryId": delivery.id,
        }),
    )
    .unwrap();
    let task_id = created["task"]["id"].as_str().unwrap().to_string();
    let task_session = created["task"]["sessionId"].as_str().unwrap().to_string();
    db.conn()
        .execute(
            "UPDATE session_collaboration_messages SET target_session_id=?2 WHERE id=?1",
            params![delivery.id, task_session],
        )
        .unwrap();
    (task_id, delivery.id)
}

/// Every stage notice addressed to the steward, whether or not it is still
/// queued (Main claims it as soon as it starts a turn).
fn all_stage_notices(db: &Database, steward: &str) -> Vec<Message> {
    let mut statement = db
        .conn()
        .prepare_cached(&format!(
            "{} WHERE target_session_id=?1 AND kind='stage' ORDER BY created_at, rowid",
            repository::SELECT
        ))
        .unwrap();
    statement
        .query_map(params![steward], repository::row)
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap()
}

/// The roster offers employees with the facts a choice needs, and never the
/// secretary or the caller.
#[test]
fn the_roster_offers_employees_but_never_the_secretary() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
    let seeded = handle(&db, "bot.seedDefaults", &json!({})).unwrap();
    let created = seeded["created"].as_array().unwrap();
    let steward = created
        .iter()
        .find(|item| item["definition"] == json!("steward"))
        .unwrap()["sessionId"]
        .as_str()
        .unwrap()
        .to_string();
    // Slice 6: the crew is hired, not seeded. One worker with a repository and a
    // task waiting on the person, and one read-only researcher with neither.
    let backend = employee(&db, "Router 后端", None, false);
    let researcher = employee(&db, "研究员", Some("explorer"), false);
    let repo = dir.path().join("router");
    std::fs::create_dir_all(&repo).unwrap();
    handle(
        &db,
        "bot.update",
        &json!({"sessionId": backend, "profile": {"observe": false}, "projectPath": repo.to_string_lossy()}),
    )
    .unwrap();
    let task = crate::tasks::create(
        &db,
        &json!({"employeeSessionId": backend, "title": "补单测", "origin": "direct"}),
    )
    .unwrap();
    let task_id = task["task"]["id"].as_str().unwrap();
    db.conn()
        .execute(
            "UPDATE tasks SET stage='person/answer' WHERE id=?1",
            params![task_id],
        )
        .unwrap();

    let roster = handle(&db, "bot.roster", &json!({"sessionId": steward})).unwrap();
    let employees = roster["employees"].as_array().unwrap();
    assert_eq!(
        employees.len(),
        2,
        "the hired crew minus the secretary"
    );
    assert!(
        employees
            .iter()
            .all(|entry| entry["sessionId"] != json!(steward)),
        "the secretary is never a candidate for her own card"
    );
    let backend_row = employees
        .iter()
        .find(|entry| entry["sessionId"] == json!(backend))
        .unwrap();
    assert_eq!(backend_row["name"], json!("Router 后端"));
    assert_eq!(backend_row["duty"], json!("Router 后端 duty"));
    assert_eq!(backend_row["permissionMode"], json!("accept-edits"));
    assert_eq!(backend_row["observe"], json!(false));
    assert_eq!(backend_row["openTaskCount"], json!(1));
    assert_eq!(backend_row["waitingCount"], json!(1));
    assert_eq!(backend_row["idle"], json!(false));
    assert_eq!(backend_row["repos"], json!([]), "reserved for later");
    assert!(backend_row["projectPath"].is_string());
    // Slice 6: the row names the job, so the steward can tell a reviewer from a
    // coder; an employee hired under no definition says so honestly.
    assert_eq!(backend_row["definition"], Value::Null);
    let others = employees
        .iter()
        .find(|entry| entry["sessionId"] == json!(researcher))
        .unwrap();
    assert_eq!(others["definition"], json!("explorer"));
    assert_eq!(others["idle"], json!(true));
    assert_eq!(others["openTaskCount"], json!(0));
}

/// A stage the person or the steward has to react to wakes the steward exactly
/// once; a task the person dispatched directly never does.
#[test]
fn a_stage_change_wakes_the_steward_once_and_a_direct_task_never_does() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
    let steward = employee(&db, "秘书", Some("steward"), false);
    let worker = employee(&db, "Router 后端", None, false);
    let (task_id, delivery) = dispatched_task(&db, &steward, &worker, "steward");

    // Working is not news.
    progress::report(&db, &delivery, 1, "progress", "working").unwrap();
    assert!(all_stage_notices(&db, &steward).is_empty());

    // Blocked is.
    progress::report(&db, &delivery, 2, "blocked", "blocked").unwrap();
    let notices = all_stage_notices(&db, &steward);
    assert_eq!(notices.len(), 1, "one stage change, one notice");
    let notice = &notices[0];
    assert_eq!(notice.kind, "stage");
    assert_eq!(notice.status, "queued");
    let payload: Value = serde_json::from_str(&notice.content).unwrap();
    assert_eq!(payload["taskId"], json!(task_id));
    assert_eq!(payload["stage"], json!("blocked"));
    assert_eq!(payload["employee"], json!("Router 后端"));
    // It is work for Main to start, so the drain sees it.
    assert!(repository::pending_dispatch(&db)
        .unwrap()
        .iter()
        .any(|message| message.id == notice.id));

    // The same stage again is not a change: no second notice.
    progress::report(&db, &delivery, 3, "blocked", "blocked").unwrap();
    assert_eq!(all_stage_notices(&db, &steward).len(), 1);
    // And the notice is idempotent on its own key, even if it is written again.
    assert_eq!(
        notices::stage_change(&db, db.conn(), &delivery, "blocked", 2).unwrap(),
        None
    );

    // Waiting for an answer is a change too.
    progress::report(&db, &delivery, 4, "waiting", "person/answer").unwrap();
    assert_eq!(all_stage_notices(&db, &steward).len(), 2);

    // A task the person typed into the workbench tells nobody: she knows about
    // it from the briefing and does not interfere.
    let direct = crate::tasks::create(
        &db,
        &json!({"employeeSessionId": worker, "title": "自己派活", "origin": "direct"}),
    )
    .unwrap();
    let direct_delivery = send_record(
        &db,
        &json!({"sourceSessionId": worker, "pluginId": "builtin:session-messaging",
                "content": "自己派活", "idempotencyKey": "direct-1", "notifyOnCompletion": false}),
        direct["task"]["sessionId"].as_str().unwrap(),
        "task",
    )
    .unwrap();
    db.conn()
        .execute(
            "UPDATE tasks SET delivery_id=?2 WHERE id=?1",
            params![direct["task"]["id"].as_str().unwrap(), direct_delivery.id],
        )
        .unwrap();
    progress::report(&db, &direct_delivery.id, 1, "failed", "failed").unwrap();
    assert_eq!(
        all_stage_notices(&db, &steward).len(),
        2,
        "a directly dispatched task does not wake the steward"
    );
}

/// The startup fence marks an interrupted delivery and tells the steward, and
/// the person's restart writes one new delivery from the same mandate.
#[test]
fn an_interrupted_task_is_announced_and_starts_again_once() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
    let steward = employee(&db, "秘书", Some("steward"), false);
    let worker = employee(&db, "Router 后端", None, false);
    let (task_id, delivery) = dispatched_task(&db, &steward, &worker, "steward");
    // A turn was running when the application stopped.
    db.conn()
        .execute(
            "UPDATE session_collaboration_messages SET status='running' WHERE id=?1",
            params![delivery],
        )
        .unwrap();

    recover(&db).unwrap();
    assert_eq!(get(&db, &delivery).unwrap().unwrap().status, "interrupted");
    let task = crate::tasks::get_task(&db, &task_id).unwrap().unwrap();
    assert_eq!(task.delivery_status.as_deref(), Some("interrupted"));
    let notices = all_stage_notices(&db, &steward);
    assert_eq!(notices.len(), 1);
    let payload: Value = serde_json::from_str(&notices[0].content).unwrap();
    assert_eq!(payload["stage"], json!("interrupted"));
    // A second fence (another restart) adds nothing.
    recover(&db).unwrap();
    assert_eq!(all_stage_notices(&db, &steward).len(), 1);

    // The person clicks "重新开工".
    let restarted = handle_task(&db, "task.restart", &json!({"taskId": task_id})).unwrap();
    let new_delivery = restarted["delivery"]["id"].as_str().unwrap().to_string();
    assert_ne!(new_delivery, delivery);
    assert_eq!(restarted["delivery"]["status"], json!("queued"));
    assert_eq!(
        restarted["delivery"]["targetSessionId"],
        json!(task.session_id)
    );
    assert_eq!(restarted["task"]["deliveryId"], json!(new_delivery));
    assert_eq!(restarted["task"]["stage"], json!("queued"));
    // Still the same authorization.
    assert!(restarted["delivery"]["mandate"]["taskId"].is_string());
    // A second click is the same restart, not a second run.
    let again = handle_task(&db, "task.restart", &json!({"taskId": task_id})).unwrap();
    assert_eq!(again["delivery"]["id"], json!(new_delivery));
    // Once the restarted work is running, there is nothing left to restart.
    db.conn()
        .execute(
            "UPDATE session_collaboration_messages SET status='running' WHERE id=?1",
            params![new_delivery],
        )
        .unwrap();
    let refused = handle_task(&db, "task.restart", &json!({"taskId": task_id})).unwrap_err();
    assert!(refused.to_string().contains("CONFLICT"), "{refused}");
}

/// Reassigning moves a proposed card, narrows it to the new employee's ceiling,
/// and leaves it for the person to start.
#[test]
fn reassigning_a_card_narrows_it_and_keeps_it_proposed() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
    let steward = employee(&db, "秘书", Some("steward"), false);
    let wide = employee(&db, "界面", None, false);
    let narrow = sessions::create_session_with_options(
        &db,
        sessions::SessionCreateOptions {
            title: Some("后端".into()),
            mode: Some("agent".into()),
            permission_mode: Some("ask".into()),
            role: Some("bot".into()),
            bot_profile_json: Some(
                json!({"name": "后端", "permissionMode": "ask", "observe": false}).to_string(),
            ),
            ..Default::default()
        },
    )
    .unwrap()
    .id;
    let proposed = handle(
        &db,
        "taskCard.propose",
        &json!({
            "sessionId": steward,
            "targetSessionId": wide,
            "sourceUtterance": "登录超时今天修掉",
            "card": {
                "goal": "Fix the login timeout",
                "criteria": [{"id": "c1", "text": "A failing repro exists"}],
                "permissionMode": "accept-edits",
                "mustAsk": [],
                "risk": "low",
                "reason": "页面与交互是它的活；你提到了 Desktop；它空闲",
            },
        }),
    )
    .unwrap();
    let draft_id = proposed["draft"]["id"].as_str().unwrap();
    let before = proposed["draft"]["cardHash"].as_str().unwrap().to_string();
    let reassigned = handle(
        &db,
        "taskCard.reassign",
        &json!({"draftId": draft_id, "targetSessionId": narrow}),
    )
    .unwrap();
    let draft = &reassigned["draft"];
    assert_eq!(draft["targetSessionId"], json!(narrow));
    assert_eq!(
        draft["status"],
        json!("proposed"),
        "the person still starts it"
    );
    // `ask` is narrower than `accept-edits`, so the card may only ask for `ask`.
    assert_eq!(draft["card"]["permissionMode"], json!("ask"));
    assert_ne!(
        draft["cardHash"],
        json!(before),
        "the card changed, so its hash did"
    );
    // The reason travels with the card.
    assert_eq!(
        draft["card"]["reason"],
        json!("页面与交互是它的活；你提到了 Desktop；它空闲")
    );
    // An employee with no repository cannot carry a card that names one.
    assert_eq!(
        reassigned["repoAvailable"],
        json!(true),
        "no repo on the card"
    );
    // Only a proposed card is reassignable.
    handle(&db, "taskCard.drop", &json!({"draftId": draft_id})).unwrap();
    let refused = handle(
        &db,
        "taskCard.reassign",
        &json!({"draftId": draft_id, "targetSessionId": wide}),
    )
    .unwrap_err();
    assert!(refused.to_string().contains("CONFLICT"), "{refused}");
}

/// A follow-up carries no new authority: it is checked against the task's own
/// authorization, never against the steward's mode (review S2).
///
/// Before this rule the ceiling was the sender's `ask`, so a steward could not
/// continue even the task she had just handed out at `accept-edits`: the send
/// was refused as `PERMISSION_DENIED: target permission mode exceeds the sending
/// session's authorization`.
#[test]
fn a_follow_up_is_checked_against_the_tasks_own_authorization() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
    let steward = sessions::create_session_with_options(
        &db,
        sessions::SessionCreateOptions {
            title: Some("秘书".into()),
            mode: Some("agent".into()),
            permission_mode: Some("ask".into()),
            ..Default::default()
        },
    )
    .unwrap()
    .id;
    let employee = employee(&db, "界面", None, false);
    let proposed = handle(
        &db,
        "taskCard.propose",
        &json!({
            "sessionId": steward,
            "targetSessionId": employee,
            "sourceUtterance": "任务列表加个筛选",
            "card": {
                "goal": "Add a filter to the task list",
                "criteria": [{"id": "c1", "text": "The list filters"}],
                "permissionMode": "accept-edits",
                "mustAsk": [],
                "risk": "low",
                "reason": "页面与交互是它的活；你提到了 Desktop",
            },
        }),
    )
    .unwrap();
    let confirmed = handle(
        &db,
        "taskCard.confirm",
        &json!({
            "draftId": proposed["draft"]["id"],
            "cardHash": proposed["draft"]["cardHash"],
            "confirmedBy": "user",
            "idempotencyKey": "confirm-follow-up",
        }),
    )
    .unwrap();
    let task_session = confirmed["task"]["sessionId"].as_str().unwrap().to_string();
    let task_id = confirmed["task"]["id"].as_str().unwrap().to_string();
    let sent = handle(
        &db,
        "session.collaboration.send",
        &json!({
            "sourceSessionId": steward,
            "pluginId": "builtin:session-messaging",
            "content": "Also handle the empty list",
            "kind": "task",
            "idempotencyKey": "follow-up",
            "sessionId": task_session,
            // The task this delivery continues: what authorizes it, and what
            // its ceiling is read from.
            "taskId": task_id,
        }),
    )
    .unwrap();
    assert_eq!(sent["message"]["targetSessionId"], json!(task_session));
    assert_eq!(
        sent["message"]["status"],
        json!("queued"),
        "the follow-up was delivered, not refused"
    );
    assert_eq!(
        sent["message"]["permissionCeiling"],
        json!("accept-edits"),
        "the task's own authorization, not the steward's"
    );
}
