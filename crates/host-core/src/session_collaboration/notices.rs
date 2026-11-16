//! Stage notices for the person (employee mode 0.5 slice 3, slice 4a, slice 5).
//!
//! A task that stops making progress on its own — it failed, it is blocked, or
//! the startup fence interrupted it — has to reach the person, and the surface
//! that shows it is the notification center (`crate::notifications`), not a
//! conversation: the inbox already carries one row per settled turn and one per
//! pending prompt, and it is the one list a person checks for "something of mine
//! needs me". A task that is merely working says nothing.
//!
//! Three rules shape this module:
//!
//! - **Exactly one notice per stage change.** The notice is written in the same
//!   transaction that moved the stage, and only when the stage actually moved,
//!   under a key of (task, stage, `stage_seq`). The key lands in the inbox's
//!   own unique `request_id` slot, so a repeated write of the same stage
//!   collides instead of adding a second row, and a restart that re-runs the
//!   fence cannot duplicate one. The key names the *task* rather than a
//!   delivery, because a task keeps its stage across several turns.
//! - **The audience is the person.** Nothing here reads `tasks.origin`, a
//!   delivery or a sender: a task the person started directly and one a
//!   historical card dispatched are the same thing to the person who owns both.
//! - **The row is a pointer.** The inbox's `task.failed` rows carry the task's
//!   own session and an `error_code` naming what happened; the question, the
//!   blocker and the report stay in `tasks` and the transcript, where the cards
//!   read them. That is the shape the inbox already gives a settled turn, and it
//!   keeps one kind family instead of a second vocabulary nobody renders.

use anyhow::Result;
use rusqlite::{params, OptionalExtension};

/// The stages that reach the person.
///
/// `person/accept` (finished work) is covered by the turn's own
/// `task.completed` row, `person/answer` by the `prompt.*` row the renderer
/// records for the request itself, and `queued` / `waiting` / `working` are not
/// news. A person's own stop is not news either: it leaves the task `blocked`
/// with `reason: "stopped"`, and the caller writes that move silently.
pub fn wakes_person(stage: &str) -> bool {
    matches!(stage, "failed" | "blocked" | "interrupted")
}

/// The `error_code` an inbox row carries for a stage.
///
/// It is what the notification center has instead of a prose line, so the codes
/// are one vocabulary with `tasks.stage`: a reader that knows the stages needs
/// no second mapping table.
fn stage_code(stage: &str) -> &'static str {
    match stage {
        "failed" => "TASK_FAILED",
        "blocked" => "TASK_BLOCKED",
        "interrupted" => "TASK_INTERRUPTED",
        _ => "TASK_STAGE",
    }
}

/// Write one stage notice for `task_id`, if that task deserves one.
///
/// Returns the new notification id when a notice was written, so a caller can
/// log it. Nothing is written for a stage that does not reach the person, a
/// task that is gone, or a stage that was already announced.
pub(crate) fn stage_change(
    conn: &rusqlite::Connection,
    task_id: &str,
    stage: &str,
    seq: i64,
) -> Result<Option<String>> {
    notice(conn, task_id, stage, seq, "")
}

/// Announce that a delivery the startup fence interrupted belongs to a task.
///
/// The fence is not a stage: the task keeps whatever stage it had, and
/// `delivery_status = interrupted` is what a surface reads. The notice still has
/// to be exactly-once, and the same interruption can be re-examined on every
/// start, so its key names the delivery it came from.
pub(crate) fn delivery_interrupted(
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
    notice(conn, &task, "interrupted", 0, delivery_id)
}

/// The one notice writer both entry points share.
fn notice(
    conn: &rusqlite::Connection,
    task_id: &str,
    stage: &str,
    seq: i64,
    nonce: &str,
) -> Result<Option<String>> {
    if !wakes_person(stage) {
        return Ok(None);
    }
    // The task's own session is where the person looks when they act on the
    // notice: it holds the transcript, the question, and the completion card.
    let task_session: Option<String> = conn
        .query_row(
            "SELECT session_id FROM tasks WHERE id = ?1 AND archived_at IS NULL",
            params![task_id],
            |row| row.get(0),
        )
        .optional()?;
    let Some(task_session) = task_session else {
        return Ok(None);
    };
    // A failure the session's own turn already reported is in the inbox: the
    // terminal `task.failed` row carries that turn's error code, and a second
    // row about the same failure would be noise.
    if stage == "failed" && turn_failure_already_in_inbox(conn, &task_session)? {
        return Ok(None);
    }
    let key = if nonce.is_empty() {
        format!("task-stage:{task_id}:{stage}:{seq}")
    } else {
        format!("task-stage:{task_id}:{stage}:{seq}:{nonce}")
    };
    Ok(
        crate::notifications::insert_for_task_alert(conn, &task_session, &key, stage_code(stage))?
            .map(|notification| notification.id),
    )
}

/// Whether the inbox already says this session's turn failed.
///
/// A turn that ends in `error` writes its own `task.failed` row, carrying the
/// turn's error code. The stage alert for the same failure would say the same
/// thing twice about one event, so it is skipped when that row is there. A
/// stage that nobody's turn reported (a delivery's report, a test's settlement)
/// has no such row and is announced normally.
fn turn_failure_already_in_inbox(conn: &rusqlite::Connection, session_id: &str) -> Result<bool> {
    Ok(conn.query_row(
        "SELECT EXISTS(
           SELECT 1 FROM notifications n JOIN turns t ON t.id = n.turn_id
            WHERE n.session_id = ?1 AND n.kind = 'task.failed' AND t.status = 'error')",
        params![session_id],
        |row| row.get(0),
    )?)
}

/// One inbox row per stuck task, from the hourly inspection (employee mode 0.5
/// slice 5).
///
/// The inspection is a *deterministic* host check: it calls no model and writes
/// nothing while every task is making progress. Each anomaly it found becomes
/// one row, because an inbox row is a pointer at a session and a batch spans
/// many: the person gets one entry per task they have to act on, and `batch`
/// (the run's millisecond stamp) makes a retried run idempotent.
///
/// Direct tasks are included here — unlike a stage notice, nothing about this
/// path ever asked whose dispatch it was — and `error_code` carries the
/// condition, so the card can say whether the work is waiting for an answer,
/// waiting to be accepted, or stuck.
pub(crate) fn inspection(
    conn: &rusqlite::Connection,
    findings: &[crate::task_inspection::InspectionFinding],
    batch: i64,
) -> Result<usize> {
    let mut written = 0;
    for finding in findings {
        let key = format!(
            "task-inspection:{}:{}:{batch}",
            finding.task_id, finding.condition
        );
        if crate::notifications::insert_for_task_alert(
            conn,
            &finding.session_id,
            &key,
            condition_code(finding.condition),
        )?
        .is_some()
        {
            written += 1;
        }
    }
    Ok(written)
}

/// The `error_code` one inspection condition is stored under.
fn condition_code(condition: &str) -> &'static str {
    match condition {
        "answer-wait" => "TASK_ANSWER_WAIT",
        "accept-wait" => "TASK_ACCEPT_WAIT",
        "stuck" => "TASK_STUCK",
        "running-long" => "TASK_RUNNING_LONG",
        _ => "TASK_INSPECTION",
    }
}
