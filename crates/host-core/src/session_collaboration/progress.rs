//! Task progress on a ledger delivery: the frozen Mandate, the monotonic report
//! sequence, and the derived stage (ADR bot-sessions-and-steward).
//!
//! Three rules keep this small and safe:
//!
//! - the Mandate is written once, with the delivery, and is never updated;
//! - `report_seq` only moves forward, so a duplicated or late report is
//!   ignorable instead of moving a task backwards;
//! - the stage is written by the same statement that accepts a report, and it
//!   never replaces the delivery `status`, which still answers "did the turn
//!   finish".

use super::repository;
use crate::db::{ms_to_ts, now_ms, Database};
use anyhow::{anyhow, Result};
use rusqlite::params;
use serde_json::{json, Value};

/// Upper bound on an encoded Mandate as this host accepts it. The shared codec
/// owns the authoritative limit (32 KiB); this only stops an unbounded string
/// from reaching the database at all.
pub const MAX_MANDATE_CHARS: usize = 32 * 1_024;

/// Derived stage of one delivery. Only the `person/*` rows disturb the person.
pub const STAGES: [&str; 7] = [
    "person/answer",
    "person/accept",
    "blocked",
    "failed",
    "queued",
    "waiting",
    "working",
];

/// Six-value worker report (dsh `Report`); `dropped` is a clean end.
pub const REPORTS: [&str; 6] = [
    "progress", "waiting", "ready", "blocked", "failed", "dropped",
];

pub fn is_valid_stage(stage: &str) -> bool {
    STAGES.contains(&stage)
}

pub fn is_valid_report(report: &str) -> bool {
    REPORTS.contains(&report)
}

/// The permission a confirmed card asks for.
///
/// `validate_mandate` has already refused anything else, so this only extracts
/// the value the ledger needs to narrow the delivery's ceiling with.
pub fn mandate_permission_mode(encoded: &str) -> Result<String> {
    let value: Value = serde_json::from_str(encoded)
        .map_err(|_| anyhow!("INVALID_ARGUMENT: mandate is not valid JSON"))?;
    value
        .get("permissionMode")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| anyhow!("INVALID_ARGUMENT: mandate.permissionMode required"))
}

/// Refuse a prohibited permission mode; `inherit` is not meaningful on a card.
pub fn validate_mandate(encoded: &str) -> Result<()> {
    if encoded.chars().count() > MAX_MANDATE_CHARS {
        return Err(anyhow!(
            "LIMIT_EXCEEDED: an encoded mandate may not exceed {MAX_MANDATE_CHARS} characters"
        ));
    }
    let value: Value = serde_json::from_str(encoded)
        .map_err(|_| anyhow!("INVALID_ARGUMENT: mandate is not valid JSON"))?;
    let mode = value
        .get("permissionMode")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("INVALID_ARGUMENT: mandate.permissionMode required"))?;
    if !matches!(mode, "auto" | "accept-edits" | "ask") {
        return Err(anyhow!(
            "INVALID_ARGUMENT: mandate.permissionMode must be auto, accept-edits, or ask"
        ));
    }
    Ok(())
}

/// Attach a Mandate to a queued delivery that does not have one yet.
///
/// Only a delivery that has not started may receive it, and only once: a
/// confirmed authorization is immutable, so replacing it is a conflict, not an
/// update. The `permission_ceiling` stays the one the ledger recorded at send
/// time; a card can only narrow what the delivery already had.
pub fn set_mandate(db: &Database, message_id: &str, encoded: &str) -> Result<Value> {
    validate_mandate(encoded)?;
    let tx = db.conn().unchecked_transaction()?;
    let current: Option<(String, Option<String>)> = tx
        .query_row(
            "SELECT status, mandate_json FROM session_collaboration_messages WHERE id=?1",
            params![message_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .ok();
    let Some((status, existing)) = current else {
        return Err(anyhow!("NOT_FOUND: session message"));
    };
    if status != "queued" {
        return Err(anyhow!(
            "CONFLICT: a mandate can only be attached before the delivery starts"
        ));
    }
    if let Some(existing) = existing {
        if existing == encoded {
            // The same card again is idempotent; a different one is not.
            let message = repository::get(db, message_id)?;
            tx.commit()?;
            return Ok(json!({"message": message}));
        }
        return Err(anyhow!(
            "CONFLICT: this delivery already has a different mandate"
        ));
    }
    tx.execute(
        "UPDATE session_collaboration_messages SET mandate_json=?2, updated_at=?3 WHERE id=?1",
        params![message_id, encoded, now_ms()],
    )?;
    tx.commit()?;
    Ok(json!({"message": repository::get(db, message_id)?}))
}

/// Record one structured report and move the delivery's stage.
///
/// `seq` is the worker's own counter. A value that is not greater than the
/// stored one is accepted as a no-op so a retried or reordered report cannot
/// regress the stage or the sequence. The returned value says whether the
/// report advanced the delivery, so a caller can skip a notification it would
/// otherwise duplicate.
pub fn report(
    db: &Database,
    message_id: &str,
    seq: i64,
    report: &str,
    stage: &str,
) -> Result<Value> {
    if !is_valid_report(report) {
        return Err(anyhow!("INVALID_ARGUMENT: unknown task report '{report}'"));
    }
    if !is_valid_stage(stage) {
        return Err(anyhow!("INVALID_ARGUMENT: unknown task stage '{stage}'"));
    }
    if seq < 1 {
        return Err(anyhow!("INVALID_ARGUMENT: report seq must be positive"));
    }
    let tx = db.conn().unchecked_transaction()?;
    let existing: Option<i64> = tx
        .query_row(
            "SELECT report_seq FROM session_collaboration_messages WHERE id=?1",
            params![message_id],
            |row| row.get(0),
        )
        .ok();
    let Some(stored) = existing else {
        return Err(anyhow!("NOT_FOUND: session message"));
    };
    if seq <= stored {
        tx.commit()?;
        return Ok(json!({
            "applied": false,
            "reportSeq": stored,
            "message": repository::get(db, message_id)?,
        }));
    }
    let applied = tx.execute(
        "UPDATE session_collaboration_messages
         SET report_seq=?2, stage=?3, updated_at=?4
         WHERE id=?1 AND report_seq < ?2",
        params![message_id, seq, stage, now_ms()],
    )?;
    // A task bound to this delivery moves with it, in the same transaction: the
    // task list must never disagree with the ledger about who is holding the
    // work.
    if applied > 0 {
        crate::tasks::sync_stage(&tx, message_id, stage)?;
    }
    tx.commit()?;
    Ok(json!({
        "applied": true,
        "reportSeq": seq,
        "stage": stage,
        "report": report,
        "needsPerson": stage.starts_with("person/"),
        "observedAt": ms_to_ts(now_ms()),
        "message": repository::get(db, message_id)?,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sessions;
    use serde_json::json;

    fn database() -> Database {
        let dir = tempfile::tempdir().unwrap();
        Database::open(&dir.path().join("pi.sqlite")).unwrap()
    }

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

    fn deliver(db: &Database, source: &str, target: &str) -> String {
        super::super::send_record(
            db,
            &json!({"sourceSessionId":source,"pluginId":"pi.session-orchestrator",
            "content":"Fix the login timeout","idempotencyKey":"one","notifyOnCompletion":false}),
            target,
            "task",
        )
        .unwrap()
        .id
    }

    fn card(task: &str) -> String {
        json!({
            "version": 1,
            "taskId": task,
            "goal": "Fix the login timeout",
            "criteria": [{"id": "c1", "text": "A failing repro exists"}],
            "boundaries": ["Do not touch billing"],
            "permissionMode": "accept-edits",
            "mustAsk": ["push"],
            "risk": "medium",
            "requestedBy": {"kind": "user", "hostId": "mac-mini"},
            "sourceUtterance": "登录超时今天修掉",
            "createdAt": "2026-11-10T09:00:00.000Z",
            "policyVersion": "steward-1"
        })
        .to_string()
    }

    /// The card travels *with* the delivery: one insert, one transaction, so an
    /// authorized delivery is never briefly an unauthorized one.
    #[test]
    fn a_delivery_can_carry_its_mandate_from_the_start() {
        let db = database();
        let sender = session(&db, "Steward");
        let worker = session(&db, "小爪");
        let message = super::super::send_record(
            &db,
            &json!({
                "sourceSessionId": sender,
                "pluginId": "builtin:session-messaging",
                "content": "Fix the login timeout",
                "idempotencyKey": "carried",
                "notifyOnCompletion": false,
                "mandate": card("task-7"),
            }),
            &worker,
            "task",
        )
        .unwrap();
        assert!(message
            .mandate_json
            .as_deref()
            .is_some_and(|raw| raw.contains("task-7")));
        // It arrives confirmed, so a second attach is a conflict, not an edit.
        let error = set_mandate(&db, &message.id, &card("task-8")).unwrap_err();
        assert!(error.to_string().contains("CONFLICT"));
    }

    #[test]
    fn a_delivery_refuses_an_invalid_carried_mandate() {
        let db = database();
        let sender = session(&db, "Steward");
        let worker = session(&db, "小爪");
        let error = super::super::send_record(
            &db,
            &json!({
                "sourceSessionId": sender,
                "pluginId": "builtin:session-messaging",
                "content": "Do it",
                "idempotencyKey": "bad",
                "mandate": {"version": 1, "permissionMode": "inherit"},
            }),
            &worker,
            "task",
        )
        .unwrap_err();
        assert!(error.to_string().contains("INVALID_ARGUMENT"));
        // Nothing was written: a refused card cannot leave a half-authorized row.
        let count: i64 = db
            .conn()
            .query_row(
                "SELECT COUNT(*) FROM session_collaboration_messages",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 0);
    }

    fn with_mode(card_json: &str, mode: &str) -> String {
        let mut value: Value = serde_json::from_str(card_json).unwrap();
        value["permissionMode"] = json!(mode);
        value.to_string()
    }

    /// The card's own permission has to reach execution. A steward running
    /// under `auto` that proposes an `ask` card must not dispatch it into an
    /// `auto` employee, because that would silently ignore what the person
    /// chose when they confirmed "ask me each step".
    #[test]
    fn a_narrow_card_is_refused_for_a_wider_employee() {
        let db = database();
        let sender = sessions::create_session_with_options(
            &db,
            sessions::SessionCreateOptions {
                title: Some("Steward".into()),
                mode: Some("agent".into()),
                permission_mode: Some("auto".into()),
                ..Default::default()
            },
        )
        .unwrap()
        .id;
        let worker = sessions::create_session_with_options(
            &db,
            sessions::SessionCreateOptions {
                title: Some("小爪".into()),
                mode: Some("agent".into()),
                permission_mode: Some("auto".into()),
                ..Default::default()
            },
        )
        .unwrap()
        .id;
        let error = super::super::send_record(
            &db,
            &json!({
                "sourceSessionId": sender,
                "pluginId": "builtin:session-messaging",
                "content": "Fix the login timeout",
                "idempotencyKey": "narrow-card",
                "mandate": with_mode(&card("task-1"), "ask"),
            }),
            &worker,
            "task",
        )
        .unwrap_err();
        assert!(
            error.to_string().contains("PERMISSION_DENIED"),
            "expected a refusal, got: {error}"
        );
        // The refusal leaves no row: a rejected task is not a queued one.
        let count: i64 = db
            .conn()
            .query_row(
                "SELECT COUNT(*) FROM session_collaboration_messages",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 0);
    }

    /// The other direction: a card wider than its sender cannot widen the
    /// delivery, because the ceiling is the minimum of the two.
    #[test]
    fn a_wider_card_does_not_widen_the_delivery() {
        let db = database();
        let sender = sessions::create_session_with_options(
            &db,
            sessions::SessionCreateOptions {
                title: Some("Steward".into()),
                mode: Some("agent".into()),
                permission_mode: Some("accept-edits".into()),
                ..Default::default()
            },
        )
        .unwrap()
        .id;
        let worker = sessions::create_session_with_options(
            &db,
            sessions::SessionCreateOptions {
                title: Some("小爪".into()),
                mode: Some("agent".into()),
                permission_mode: Some("accept-edits".into()),
                ..Default::default()
            },
        )
        .unwrap()
        .id;
        let message = super::super::send_record(
            &db,
            &json!({
                "sourceSessionId": sender,
                "pluginId": "builtin:session-messaging",
                "content": "Fix the login timeout",
                "idempotencyKey": "wide-card",
                "mandate": with_mode(&card("task-2"), "auto"),
            }),
            &worker,
            "task",
        )
        .unwrap();
        assert_eq!(message.permission_ceiling, "accept-edits");
        // And the confirmed card is still recorded as the person wrote it.
        assert!(message
            .mandate_json
            .as_deref()
            .is_some_and(|raw| raw.contains("\"auto\"")));
    }

    /// No card, no narrowing: every existing sender behaves exactly as before.
    #[test]
    fn a_delivery_without_a_card_keeps_the_sender_ceiling() {
        let db = database();
        let sender = sessions::create_session_with_options(
            &db,
            sessions::SessionCreateOptions {
                title: Some("Parent".into()),
                mode: Some("agent".into()),
                permission_mode: Some("auto".into()),
                ..Default::default()
            },
        )
        .unwrap()
        .id;
        let worker = sessions::create_session_with_options(
            &db,
            sessions::SessionCreateOptions {
                title: Some("Worker".into()),
                mode: Some("agent".into()),
                permission_mode: Some("auto".into()),
                ..Default::default()
            },
        )
        .unwrap()
        .id;
        let message = deliver(&db, &sender, &worker);
        let stored = repository::get(&db, &message).unwrap().unwrap();
        assert_eq!(stored.permission_ceiling, "auto");
        assert!(stored.mandate_json.is_none());
    }

    fn steward_session(db: &Database, title: &str) -> String {
        sessions::create_session_with_options(
            db,
            sessions::SessionCreateOptions {
                title: Some(title.into()),
                mode: Some("agent".into()),
                permission_mode: Some("auto".into()),
                ..Default::default()
            },
        )
        .unwrap()
        .id
    }

    fn bot_session(db: &Database, title: &str) -> String {
        sessions::create_session_with_options(
            db,
            sessions::SessionCreateOptions {
                title: Some(title.into()),
                mode: Some("agent".into()),
                permission_mode: Some("accept-edits".into()),
                role: Some("bot".into()),
                bot_profile_json: Some(
                    json!({"name": title, "permissionMode": "accept-edits", "observe": false})
                        .to_string(),
                ),
                ..Default::default()
            },
        )
        .unwrap()
        .id
    }

    fn send(
        db: &Database,
        source: &str,
        target: &str,
        extra: Value,
        key: &str,
    ) -> Result<crate::session_collaboration::Message> {
        let mut payload = json!({
            "sourceSessionId": source,
            "pluginId": "builtin:session-messaging",
            "content": "Fix the login timeout",
            "idempotencyKey": key,
            "notifyOnCompletion": false,
        });
        for (name, value) in extra.as_object().into_iter().flatten() {
            payload[name] = value.clone();
        }
        super::super::send_record(db, &payload, target, "task")
    }

    /// A steward could otherwise skip the card and hand work to an employee as
    /// if it were a casual conversation.
    #[test]
    fn a_bare_delivery_to_a_bot_is_refused() {
        let db = database();
        let steward = steward_session(&db, "Steward");
        let worker = bot_session(&db, "小爪");
        let error = send(&db, &steward, &worker, json!({}), "bare").unwrap_err();
        assert!(error.to_string().contains("MANDATE_REQUIRED"), "{error}");
        let count: i64 = db
            .conn()
            .query_row(
                "SELECT COUNT(*) FROM session_collaboration_messages",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn a_follow_up_may_name_the_open_task_it_continues() {
        let db = database();
        let steward = steward_session(&db, "Steward");
        let worker = bot_session(&db, "小爪");
        let first = send(
            &db,
            &steward,
            &worker,
            json!({"mandate": card("task-9")}),
            "first",
        )
        .unwrap();
        // The task is open, so a follow-up that names it is authorized.
        let follow = send(
            &db,
            &steward,
            &worker,
            json!({"taskId": "task-9"}),
            "follow",
        )
        .unwrap();
        assert_eq!(follow.target_session_id, worker);
        // A task that was never dispatched here is not an authorization.
        let error = send(
            &db,
            &steward,
            &worker,
            json!({"taskId": "task-404"}),
            "wrong",
        )
        .unwrap_err();
        assert!(error.to_string().contains("MANDATE_REQUIRED"), "{error}");
        // And the same id stops working once the task is over.
        db.conn()
            .execute(
                "UPDATE session_collaboration_messages SET status='completed' WHERE id=?1",
                params![first.id],
            )
            .unwrap();
        let error = send(&db, &steward, &worker, json!({"taskId": "task-9"}), "after").unwrap_err();
        assert!(error.to_string().contains("MANDATE_REQUIRED"), "{error}");
    }

    #[test]
    fn an_ordinary_conversation_still_needs_no_card() {
        let db = database();
        let sender = session(&db, "Parent");
        let plain = session(&db, "Conversation");
        let message = send(&db, &sender, &plain, json!({}), "plain").unwrap();
        assert!(message.mandate_json.is_none());
        assert_eq!(message.permission_ceiling, "ask");
    }

    #[test]
    fn a_mandate_is_attached_once_and_never_rewritten() {
        let db = database();
        let sender = session(&db, "Steward");
        let worker = session(&db, "小爪");
        let delivery = deliver(&db, &sender, &worker);
        set_mandate(&db, &delivery, &card("task-1")).unwrap();
        // The same card is idempotent; a different one is a conflict.
        set_mandate(&db, &delivery, &card("task-1")).unwrap();
        let error = set_mandate(&db, &delivery, &card("task-2")).unwrap_err();
        assert!(error.to_string().contains("CONFLICT"));
        let message = repository::get(&db, &delivery).unwrap().unwrap();
        assert!(message.mandate_json.unwrap().contains("task-1"));
    }

    #[test]
    fn a_mandate_cannot_be_attached_after_the_delivery_started() {
        let db = database();
        let sender = session(&db, "Steward");
        let worker = session(&db, "小爪");
        let delivery = deliver(&db, &sender, &worker);
        let turn = super::super::begin_turn(&db, &worker, &delivery, None, None).unwrap();
        assert!(!turn.is_empty());
        let error = set_mandate(&db, &delivery, &card("task-1")).unwrap_err();
        assert!(error.to_string().contains("CONFLICT"));
    }

    #[test]
    fn a_mandate_needs_a_concrete_permission_mode() {
        let db = database();
        let sender = session(&db, "Steward");
        let worker = session(&db, "小爪");
        let delivery = deliver(&db, &sender, &worker);
        let mut value: Value = serde_json::from_str(&card("task-1")).unwrap();
        value["permissionMode"] = json!("inherit");
        let error = set_mandate(&db, &delivery, &value.to_string()).unwrap_err();
        assert!(error.to_string().contains("INVALID_ARGUMENT"));
        assert!(set_mandate(&db, &delivery, "{").is_err());
        assert!(repository::get(&db, &delivery)
            .unwrap()
            .unwrap()
            .mandate_json
            .is_none());
    }

    #[test]
    fn reports_advance_the_sequence_and_stage_only_forward() {
        let db = database();
        let sender = session(&db, "Steward");
        let worker = session(&db, "小爪");
        let delivery = deliver(&db, &sender, &worker);
        let first = report(&db, &delivery, 1, "progress", "working").unwrap();
        assert_eq!(first["applied"], true);
        assert_eq!(first["needsPerson"], false);
        // A duplicated sequence is accepted as a no-op.
        let duplicate = report(&db, &delivery, 1, "progress", "blocked").unwrap();
        assert_eq!(duplicate["applied"], false);
        let message = repository::get(&db, &delivery).unwrap().unwrap();
        assert_eq!(message.stage.as_deref(), Some("working"));
        assert_eq!(message.report_seq, 1);
        // A later report that arrives before an earlier one still wins, and the
        // late arrival that follows it is ignored rather than moving back.
        assert_eq!(
            report(&db, &delivery, 5, "progress", "blocked").unwrap()["applied"],
            true
        );
        let late = report(&db, &delivery, 3, "progress", "working").unwrap();
        assert_eq!(late["applied"], false);
        let message = repository::get(&db, &delivery).unwrap().unwrap();
        assert_eq!(message.stage.as_deref(), Some("blocked"));
        assert_eq!(message.report_seq, 5);
        let waiting = report(&db, &delivery, 6, "waiting", "person/answer").unwrap();
        assert_eq!(waiting["applied"], true);
        // The delivery status is untouched: the stage answers a different
        // question and must not be read as "did it finish".
        let message = repository::get(&db, &delivery).unwrap().unwrap();
        assert_eq!(message.status, "queued");
        assert_eq!(message.stage.as_deref(), Some("person/answer"));
        assert_eq!(message.report_seq, 6);
    }

    #[test]
    fn a_report_refuses_an_unknown_vocabulary_and_a_missing_delivery() {
        let db = database();
        let sender = session(&db, "Steward");
        let worker = session(&db, "小爪");
        let delivery = deliver(&db, &sender, &worker);
        assert!(report(&db, &delivery, 1, "done", "working").is_err());
        assert!(report(&db, &delivery, 1, "progress", "person/waiting").is_err());
        assert!(report(&db, &delivery, 0, "progress", "working").is_err());
        assert!(report(&db, "missing", 1, "progress", "working").is_err());
    }

    #[test]
    fn the_stage_survives_a_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pi.sqlite");
        let db = Database::open(&path).unwrap();
        let sender = session(&db, "Steward");
        let worker = session(&db, "小爪");
        let delivery = deliver(&db, &sender, &worker);
        set_mandate(&db, &delivery, &card("task-1")).unwrap();
        report(&db, &delivery, 1, "ready", "person/accept").unwrap();
        drop(db);

        let db = Database::open(&path).unwrap();
        let message = repository::get(&db, &delivery).unwrap().unwrap();
        assert_eq!(message.stage.as_deref(), Some("person/accept"));
        assert_eq!(message.report_seq, 1);
        assert!(message.mandate_json.is_some());
    }
}
