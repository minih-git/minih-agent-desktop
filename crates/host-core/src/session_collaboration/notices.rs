//! Stage-change notices to the steward (employee mode 0.5 slice 3, slice 4a).
//!
//! The steward must speak when a task it dispatched stops making progress on its
//! own: it failed, it is blocked, it is waiting for an answer, or the startup
//! fence interrupted it. A task that is merely working says nothing.
//!
//! Three rules shape this module:
//!
//! - **Exactly one notice per stage change.** The notice is written in the same
//!   transaction that moved the stage, and only when the stage actually moved,
//!   under an idempotency key of (task, stage, `stage_seq`). A repeated write of
//!   the same stage therefore finds the key already used and adds nothing, and a
//!   restart that re-runs the fence cannot duplicate it. The key names the *task*
//!   rather than a delivery, because a task the person started directly has no
//!   delivery and a task keeps its stage across several turns.
//! - **A directly dispatched task never wakes the steward.** The person typed
//!   that request into the employee's own workbench, so the steward knows about
//!   it from the briefing and does not interfere. Only `origin = steward` — work
//!   a confirmed card dispatched — produces a notice.
//! - **The question travels with the notice.** `person/answer` carries the
//!   question the task is waiting on, taken from the request's own structured
//!   fields: the steward relays what the employee asked instead of guessing from
//!   the transcript.
//!
//! The notice is a `kind = stage` ledger row addressed to the steward, not the
//! `completion` receipt: a receipt reports "the turn finished", and every one of
//! these stages means the turn did *not* finish the work. Main starts a turn for
//! it through the same `pendingDispatch` drain every other queued delivery uses.

use super::{drafts::CARD_DELIVERY_OWNER, permissions, repository::Message};
use crate::db::{ms_to_ts, now_ms, Database};
use anyhow::Result;
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use uuid::Uuid;

/// The stages that wake the steward.
///
/// `person/accept` (finished work) already reaches her through the delivery's
/// completion receipt, and `queued` / `waiting` / `working` are not news. A
/// person's own stop is not news either: it leaves the task `blocked` with
/// `reason: "stopped"`, and the caller writes that move silently.
pub fn wakes_steward(stage: &str) -> bool {
    matches!(
        stage,
        "failed" | "blocked" | "person/answer" | "interrupted"
    )
}

/// The structured facts one task row has for a notice: its title, its own
/// session, its employee, who started it, the delivery that authorized it, and
/// the two JSON columns that hold its own words.
type TaskFacts = (
    String,
    String,
    String,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
);

/// Write one stage notice for `task_id`, if that task deserves one.
///
/// Returns the new message id when a notice was written, so a caller can log it.
/// Nothing is written for a task the person dispatched directly, a stage that
/// does not wake the steward, or a stage that was already announced.
pub(crate) fn stage_change(
    db: &Database,
    conn: &rusqlite::Connection,
    task_id: &str,
    stage: &str,
    seq: i64,
) -> Result<Option<String>> {
    notice(db, conn, task_id, stage, seq, "")
}

/// Announce that a delivery the startup fence interrupted belongs to a task.
///
/// The fence is not a stage: the task keeps whatever stage it had, and
/// `delivery_status = interrupted` is what a surface reads. The notice still has
/// to be exactly-once, and the same interruption can be re-examined on every
/// start, so its key names the delivery it came from.
pub(crate) fn delivery_interrupted(
    db: &Database,
    conn: &rusqlite::Connection,
    delivery_id: &str,
) -> Result<Option<String>> {
    let task: Option<String> = conn
        .query_row(
            "SELECT id FROM tasks WHERE delivery_id=?1 AND archived_at IS NULL",
            params![delivery_id],
            |row| row.get(0),
        )
        .optional()?;
    let Some(task) = task else {
        return Ok(None);
    };
    notice(db, conn, &task, "interrupted", 0, delivery_id)
}

/// The one notice writer both entry points share.
fn notice(
    db: &Database,
    conn: &rusqlite::Connection,
    task_id: &str,
    stage: &str,
    seq: i64,
    nonce: &str,
) -> Result<Option<String>> {
    if !wakes_steward(stage) {
        return Ok(None);
    }
    let task: Option<TaskFacts> = conn
        .query_row(
            "SELECT t.title, t.session_id, t.employee_session_id, t.origin, t.delivery_id,
                    t.waiting_json, t.blocker_json
             FROM tasks t WHERE t.id = ?1 AND t.archived_at IS NULL",
            params![task_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                ))
            },
        )
        .optional()?;
    let Some((title, task_session, employee, origin, delivery, waiting_json, blocker_json)) = task
    else {
        return Ok(None);
    };
    if origin != "steward" {
        return Ok(None);
    }
    // The delivery a confirmed card wrote is what names the steward: it is the
    // only row that records who handed this work over.
    let Some(delivery) = delivery else {
        return Ok(None);
    };
    // A sender that has since been dismissed leaves no one to tell, and the
    // person still sees the stage in the task itself.
    let sender = conn
        .query_row(
            "SELECT m.source_session_id, m.remaining_hops
             FROM session_collaboration_messages m
             JOIN sessions s ON s.id = m.source_session_id AND s.deleted_at IS NULL
             WHERE m.id = ?1",
            params![delivery],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
        )
        .optional()?;
    let Some((steward, hops)) = sender else {
        return Ok(None);
    };
    if steward == task_session {
        return Ok(None);
    }
    let key = if nonce.is_empty() {
        format!("task-stage:{task_id}:{stage}:{seq}")
    } else {
        format!("task-stage:{task_id}:{stage}:{seq}:{nonce}")
    };
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
    let waiting: Vec<crate::tasks::TaskWaiting> = waiting_json
        .as_deref()
        .and_then(|raw| serde_json::from_str(raw).ok())
        .unwrap_or_default();
    let question = waiting
        .iter()
        .find_map(|entry| entry.question.clone())
        .or_else(|| {
            waiting
                .iter()
                .find_map(|entry| entry.tool_name.clone())
                .map(|tool| format!("{tool} needs approval"))
        });
    let blocker: Option<Value> = blocker_json
        .as_deref()
        .and_then(|raw| serde_json::from_str(raw).ok());
    // Why it stopped, in the employee's own words. The two structured sources
    // come first: the question a person has to answer, and the report a stuck
    // task wrote. The transcript is only the fallback for a stage that has
    // neither (a failure, an interrupted turn).
    let reason: Option<String> = question.clone().or_else(|| {
        blocker
            .as_ref()
            .and_then(|value| value.get("where").and_then(Value::as_str))
            .map(str::to_owned)
    });
    let reason = match reason {
        Some(reason) => Some(reason),
        None => conn
            .query_row(
                "SELECT substr(text, 1, 600) FROM messages
                  WHERE session_id = ?1 AND role = 'assistant'
                    AND text IS NOT NULL AND trim(text) <> ''
                  ORDER BY seq DESC LIMIT 1",
                params![task_session],
                |row| row.get(0),
            )
            .optional()?
            .flatten(),
    };
    let content = json!({
        "taskId": task_id,
        "shortId": crate::tasks::short_id(task_id),
        "taskTitle": title,
        "employeeSessionId": employee,
        "employee": employee_name.unwrap_or_else(|| "the employee".into()),
        "taskSessionId": task_session,
        "deliveryId": delivery,
        "stage": stage,
        "seq": seq,
        "reason": reason,
        "question": question,
        "blocker": blocker,
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
        reply_to_message_id: Some(delivery.clone()),
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

/// One merged inspection notice for the steward (employee mode 0.5 slice 5).
///
/// The hourly inspection is a *deterministic* host check: it calls no model and
/// writes nothing while every task is making progress. When at least one task has
/// been stuck for longer than its threshold, this writes exactly one ledger row
/// of `kind = 'stage'` carrying every new anomaly, because waking the steward
/// once with a list is calmer and cheaper than waking her once per task.
///
/// `batch` is the millisecond stamp shared by every anomaly in this batch and the
/// idempotency suffix, so a retried inspection cannot duplicate the notice it
/// already wrote. Direct tasks are included here — unlike a stage notice — and
/// marked `direct: true`: the person still has to hear about a task they started
/// themselves, and the prompt tells the steward to report those without
/// intervening.
pub(crate) fn inspection(
    db: &Database,
    conn: &rusqlite::Connection,
    entries: &Value,
    batch: i64,
) -> Result<Option<String>> {
    let steward: Option<String> = conn
        .query_row(
            "SELECT id FROM sessions
              WHERE role = 'bot' AND deleted_at IS NULL
                AND json_extract(bot_profile_json, '$.definition') = 'steward'
              ORDER BY updated_at DESC LIMIT 1",
            [],
            |row| row.get(0),
        )
        .optional()?;
    // No steward means nobody to tell; the person still sees the task itself.
    let Some(steward) = steward else {
        return Ok(None);
    };
    let key = format!("inspection:{steward}:{batch}");
    let exists: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM session_collaboration_messages
          WHERE plugin_id = ?1 AND source_session_id = ?2 AND idempotency_key = ?3)",
        params![CARD_DELIVERY_OWNER, steward, key],
        |row| row.get(0),
    )?;
    if exists {
        return Ok(None);
    }
    let content = json!({
        "reason": "inspection",
        "batch": batch,
        "entries": entries,
    })
    .to_string();
    let title = super::repository::title(db, &steward)?;
    let at = ms_to_ts(now_ms());
    let message = Message {
        id: Uuid::new_v4().to_string(),
        plugin_id: CARD_DELIVERY_OWNER.into(),
        source_session_id: steward.clone(),
        source_title: title.clone(),
        target_session_id: steward.clone(),
        target_title: title,
        kind: "stage".into(),
        content,
        // Queued like every other notice: Main starts the steward's turn.
        status: "queued".into(),
        notify_on_completion: false,
        turn_id: None,
        reply_to_message_id: None,
        result: None,
        error: None,
        created_at: at.clone(),
        updated_at: at,
        // A report asks for nothing, so it may never be relayed onward.
        remaining_hops: 1,
        permission_ceiling: permissions::effective_mode(db, &steward)?,
        mandate_json: None,
        stage: None,
        report_seq: 0,
    };
    super::repository::insert_on(conn, &message, &key)?;
    Ok(Some(message.id))
}
