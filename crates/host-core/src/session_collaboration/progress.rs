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
    tx.execute(
        "UPDATE session_collaboration_messages
         SET report_seq=?2, stage=?3, updated_at=?4
         WHERE id=?1 AND report_seq < ?2",
        params![message_id, seq, stage, now_ms()],
    )?;
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
