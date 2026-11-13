//! Stage-change notices to the steward (employee mode 0.5 slice 3).
//!
//! The steward must speak when a task it dispatched stops making progress on its
//! own: it failed, it is blocked, it is waiting for an answer, or the startup
//! fence interrupted it. A task that is merely working says nothing.
//!
//! Two rules shape this module:
//!
//! - **Exactly one notice per stage change.** The notice is written in the same
//!   transaction that moved the stage, and only when the stage actually moved,
//!   under an idempotency key of (task, delivery, stage, report sequence). A
//!   repeated write of the same stage therefore finds the key already used and
//!   adds nothing, and a restart that re-runs the fence cannot duplicate it.
//! - **A directly dispatched task never wakes the steward.** The person typed
//!   that request into the employee's own workbench, so the steward knows about
//!   it from the briefing and does not interfere. Only `origin = steward` — work
//!   a confirmed card dispatched — produces a notice.
//!
//! The notice is a `kind = stage` ledger row addressed to the steward, not the
//! `completion` receipt: a receipt reports "the turn finished", and every one of
//! these stages means the turn did *not* finish the work. Main starts a turn for
//! it through the same `pendingDispatch` drain every other queued delivery uses.

use super::{drafts::CARD_DELIVERY_OWNER, permissions, repository::Message};
use crate::db::{ms_to_ts, now_ms, Database};
use anyhow::Result;
use rusqlite::{params, OptionalExtension};
use serde_json::json;
use uuid::Uuid;

/// The stages that wake the steward.
///
/// `person/accept` (finished work) already reaches her through the delivery's
/// completion receipt, and `queued` / `waiting` / `working` are not news.
pub fn wakes_steward(stage: &str) -> bool {
    matches!(
        stage,
        "failed" | "blocked" | "person/answer" | "interrupted"
    )
}

/// Write one stage notice for the task bound to `delivery_id`, if there is one.
///
/// Returns the new message id when a notice was written, so a caller can log it.
/// Nothing is written for a delivery that belongs to no task, a task the person
/// dispatched directly, a stage that does not wake the steward, or a stage that
/// was already announced.
pub(super) fn stage_change(
    db: &Database,
    conn: &rusqlite::Connection,
    delivery_id: &str,
    stage: &str,
    seq: i64,
) -> Result<Option<String>> {
    if !wakes_steward(stage) {
        return Ok(None);
    }
    let task = conn
        .query_row(
            "SELECT t.id, t.title, t.session_id, t.employee_session_id, t.origin
             FROM tasks t WHERE t.delivery_id = ?1 AND t.archived_at IS NULL",
            params![delivery_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                ))
            },
        )
        .optional()?;
    let Some((task_id, title, task_session, employee, origin)) = task else {
        return Ok(None);
    };
    if origin != "steward" {
        return Ok(None);
    }
    // The sender of the delivery is the steward the card came from; a sender
    // that has since been dismissed leaves no one to tell, and the person still
    // sees the stage in the task itself.
    let sender = conn
        .query_row(
            "SELECT m.source_session_id, m.remaining_hops
             FROM session_collaboration_messages m
             JOIN sessions s ON s.id = m.source_session_id AND s.deleted_at IS NULL
             WHERE m.id = ?1",
            params![delivery_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
        )
        .optional()?;
    let Some((steward, hops)) = sender else {
        return Ok(None);
    };
    if steward == task_session {
        return Ok(None);
    }
    let key = format!("task-stage:{task_id}:{delivery_id}:{stage}:{seq}");
    let exists: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM session_collaboration_messages
          WHERE plugin_id = ?1 AND source_session_id = ?2 AND idempotency_key = ?3)",
        params![CARD_DELIVERY_OWNER, task_session, key],
        |row| row.get(0),
    )?;
    if exists {
        return Ok(None);
    }
    let employee_name: Option<String> = conn
        .query_row(
            "SELECT json_extract(bot_profile_json, '$.name') FROM sessions WHERE id = ?1",
            params![employee],
            |row| row.get(0),
        )
        .optional()?
        .flatten();
    // Why it stopped, in the employee's own words: the report a person has to
    // answer is only useful if they can read the question.
    let reason: Option<String> = conn
        .query_row(
            "SELECT substr(text, 1, 600) FROM messages
              WHERE session_id = ?1 AND role = 'assistant'
                AND text IS NOT NULL AND trim(text) <> ''
              ORDER BY seq DESC LIMIT 1",
            params![task_session],
            |row| row.get(0),
        )
        .optional()?
        .flatten();
    let content = json!({
        "taskId": task_id,
        "shortId": crate::tasks::short_id(&task_id),
        "taskTitle": title,
        "employeeSessionId": employee,
        "employee": employee_name.unwrap_or_else(|| "the employee".into()),
        "taskSessionId": task_session,
        "deliveryId": delivery_id,
        "stage": stage,
        "seq": seq,
        "reason": reason,
    })
    .to_string();
    let at = ms_to_ts(now_ms());
    let message = Message {
        id: Uuid::new_v4().to_string(),
        plugin_id: CARD_DELIVERY_OWNER.into(),
        source_session_id: task_session.clone(),
        source_title: title.clone(),
        target_session_id: steward.clone(),
        target_title: super::repository::title(db, &steward)?,
        kind: "stage".into(),
        content,
        // Queued, because it is work for the steward: Main starts a turn for
        // every queued delivery with no turn yet.
        status: "queued".into(),
        notify_on_completion: false,
        turn_id: None,
        reply_to_message_id: Some(delivery_id.to_owned()),
        result: None,
        error: None,
        created_at: at.clone(),
        updated_at: at,
        remaining_hops: hops.saturating_sub(1),
        // A notice asks for nothing; it must be dispatchable whatever the
        // steward's own permission mode is, so the ceiling is that mode rather
        // than the narrowest card's.
        permission_ceiling: permissions::effective_mode(db, &steward)?,
        mandate_json: None,
        stage: None,
        report_seq: 0,
    };
    super::repository::insert_on(conn, &message, &key)?;
    Ok(Some(message.id))
}
