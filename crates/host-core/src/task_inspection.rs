//! The hourly inspection: a deterministic check of what the person is waiting on
//! (employee mode 0.5 slice 5).
//!
//! Progress is silent. A task that is moving says nothing, costs nothing, and
//! wakes nobody — that is the whole point of checking here instead of asking a
//! model every hour. Only four conditions are abnormal, and each has a
//! threshold the person would recognise as "this has been too long":
//!
//! | condition | when | threshold |
//! | --- | --- | --- |
//! | `answer-wait` | the task is in `person/answer` | 2 hours |
//! | `accept-wait` | the task is in `person/accept` and not accepted | 24 hours |
//! | `stuck` | the task is `blocked`, `failed`, or its delivery was interrupted | 4 hours |
//! | `running-long` | a turn of the task's own session has been running | 3 hours |
//!
//! Time is measured from the moment the *current* stage was written
//! (`tasks.stage_changed_at`). A row from before that column existed has none,
//! and an unknown age is not an anomaly: the inspection says nothing rather than
//! guessing that a task has been stuck since the beginning of time.
//!
//! Two bounds keep the notices calm: one `(task, condition)` reminds at most once
//! per 24 hours, and one run writes at most one ledger notice carrying every new
//! anomaly. The steward is woken once with a list, not once per task.

use anyhow::Result;
use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use serde_json::{json, Value};

use crate::db::{ms_to_ts, ts_to_ms, Database};
use crate::session_collaboration::notices;

/// `person/answer` held this long is "the person is not here".
pub const ANSWER_WAIT_MS: i64 = 2 * 60 * 60 * 1000;
/// `person/accept` held this long is "the work is done and nobody looked".
pub const ACCEPT_WAIT_MS: i64 = 24 * 60 * 60 * 1000;
/// `blocked`, `failed`, or an interrupted delivery held this long is stuck.
pub const STUCK_MS: i64 = 4 * 60 * 60 * 1000;
/// One turn running this long is not a long task, it is a stall.
pub const RUNNING_TOO_LONG_MS: i64 = 3 * 60 * 60 * 1000;
/// The same (task, condition) is not repeated inside this window.
pub const REMIND_AFTER_MS: i64 = 24 * 60 * 60 * 1000;

/// Where the reminder stamps live. Device-local on purpose: the inspection is a
/// Main-side timer, so the record of "already told" belongs to this machine.
const KV_NS: &str = "task_inspection";

/// One anomaly, as the notice and the RPC carry it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectionFinding {
    pub task_id: String,
    pub short_id: String,
    pub title: String,
    pub employee_session_id: String,
    pub employee_name: String,
    /// The task's own session, so a notification can be suppressed while the
    /// person is already reading it.
    pub session_id: String,
    pub stage: String,
    /// `answer-wait`, `accept-wait`, `stuck`, or `running-long`.
    pub condition: &'static str,
    /// How long it has been in this state, in milliseconds.
    pub waited_ms: i64,
    /// True for a task the person started themselves: still worth reporting, but
    /// the steward is told not to intervene in it.
    pub direct: bool,
}

struct Candidate {
    task_id: String,
    title: String,
    session_id: String,
    employee: String,
    origin: String,
    stage: String,
    stage_changed_at: Option<i64>,
    accepted_at: Option<i64>,
    delivery_status: Option<String>,
    delivery_updated_at: Option<String>,
}

fn candidates(db: &Database) -> Result<Vec<Candidate>> {
    let mut statement = db.conn().prepare_cached(
        "SELECT t.id, t.title, t.session_id, t.employee_session_id, t.origin, t.stage,
                t.stage_changed_at, t.accepted_at, m.status, m.updated_at
           FROM tasks t
           LEFT JOIN session_collaboration_messages m ON m.id = t.delivery_id
          WHERE t.archived_at IS NULL
          ORDER BY t.created_at ASC",
    )?;
    let rows = statement
        .query_map([], |row| {
            Ok(Candidate {
                task_id: row.get(0)?,
                title: row.get(1)?,
                session_id: row.get(2)?,
                employee: row.get(3)?,
                origin: row.get(4)?,
                stage: row.get(5)?,
                stage_changed_at: row.get(6)?,
                accepted_at: row.get(7)?,
                delivery_status: row.get(8)?,
                delivery_updated_at: row.get(9)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// The oldest running turn of one session, as its start time.
fn running_since(db: &Database, session_id: &str) -> Result<Option<i64>> {
    Ok(db
        .conn()
        .query_row(
            "SELECT MIN(started_at) FROM turns WHERE session_id = ?1 AND status = 'running'",
            params![session_id],
            |row| row.get::<_, Option<i64>>(0),
        )
        .optional()?
        .flatten())
}

fn employee_name(db: &Database, employee: &str) -> Result<String> {
    let name: Option<String> = db
        .conn()
        .query_row(
            "SELECT json_extract(bot_profile_json, '$.name') FROM sessions WHERE id = ?1",
            params![employee],
            |row| row.get(0),
        )
        .optional()?
        .flatten();
    Ok(name.unwrap_or_else(|| "the employee".into()))
}

/// Whether this (task, condition) may be announced again.
fn may_remind(db: &Database, task_id: &str, condition: &str, now: i64) -> Result<bool> {
    let key = format!("{task_id}:{condition}");
    let stored: Option<Value> = db.kv_get(KV_NS, &key)?;
    let last = stored
        .as_ref()
        .and_then(|value| value.get("at"))
        .and_then(Value::as_i64);
    Ok(match last {
        Some(last) => now - last >= REMIND_AFTER_MS,
        None => true,
    })
}

fn record_reminder(db: &Database, task_id: &str, condition: &str, now: i64) -> Result<()> {
    let key = format!("{task_id}:{condition}");
    db.kv_set(
        KV_NS,
        &key,
        &json!({ "at": now, "task": task_id, "condition": condition }),
    )
}

/// Evaluate every open task and announce what is newly abnormal.
///
/// `now` is injected so a test can move the clock without waiting two hours. The
/// answer is a value: the caller decides whether to notify the system, and the
/// host never fails an inspection because one task's row was odd.
pub fn inspect(db: &Database, now: i64) -> Result<Value> {
    let mut findings: Vec<InspectionFinding> = Vec::new();
    for candidate in candidates(db)? {
        let mut push = |condition: &'static str, waited_ms: i64| -> Result<()> {
            if waited_ms <= 0 || !may_remind(db, &candidate.task_id, condition, now)? {
                return Ok(());
            }
            findings.push(InspectionFinding {
                task_id: candidate.task_id.clone(),
                short_id: crate::tasks::short_id(&candidate.task_id),
                title: candidate.title.clone(),
                employee_session_id: candidate.employee.clone(),
                employee_name: employee_name(db, &candidate.employee)?,
                session_id: candidate.session_id.clone(),
                stage: candidate.stage.clone(),
                condition,
                waited_ms,
                direct: candidate.origin != "steward",
            });
            Ok(())
        };
        let stage_age = candidate.stage_changed_at.map(|at| now - at);
        match candidate.stage.as_str() {
            "person/answer" => {
                if let Some(age) = stage_age {
                    if age >= ANSWER_WAIT_MS {
                        push("answer-wait", age)?;
                    }
                }
            }
            "person/accept" => {
                // Accepted work is not waiting on the person any more: the merge
                // is a later, deliberate step (0.5 slice 4b).
                if candidate.accepted_at.is_none() {
                    if let Some(age) = stage_age {
                        if age >= ACCEPT_WAIT_MS {
                            push("accept-wait", age)?;
                        }
                    }
                }
            }
            "blocked" | "failed" => {
                if let Some(age) = stage_age {
                    if age >= STUCK_MS {
                        push("stuck", age)?;
                    }
                }
            }
            _ => {}
        }
        // An interrupted delivery keeps its stage, so it is its own condition and
        // is aged from when the delivery last moved.
        if candidate.delivery_status.as_deref() == Some("interrupted") {
            if let Some(at) = candidate.delivery_updated_at.as_deref() {
                let age = now - ts_to_ms(at);
                if age >= STUCK_MS {
                    push("stuck", age)?;
                }
            }
        }
        if let Some(since) = running_since(db, &candidate.session_id)? {
            let age = now - since;
            if age >= RUNNING_TOO_LONG_MS {
                push("running-long", age)?;
            }
        }
    }

    if findings.is_empty() {
        return Ok(json!({ "findings": [], "notified": 0 }));
    }
    // One notice for the whole batch, and the batch stamp is its idempotency
    // suffix: the same run cannot announce itself twice.
    let batch = now;
    let entries = serde_json::to_value(&findings)?;
    let mut notified = 0;
    {
        let tx = db.conn().unchecked_transaction()?;
        let message = notices::inspection(db, &tx, &entries, batch)?;
        for finding in &findings {
            record_reminder(db, &finding.task_id, finding.condition, now)?;
        }
        tx.commit()?;
        if message.is_some() {
            notified = findings.len();
        }
    }
    let mut findings_value = serde_json::to_value(&findings)?;
    if let Some(items) = findings_value.as_array_mut() {
        for item in items {
            if let Some(object) = item.as_object_mut() {
                if let Some(waited) = object.get("waitedMs").and_then(Value::as_i64) {
                    object.insert("since".into(), json!(ms_to_ts(now - waited)));
                }
            }
        }
    }
    Ok(json!({
        "findings": findings_value,
        "notified": notified,
        "batch": batch,
    }))
}

#[cfg(test)]
#[path = "task_inspection_tests.rs"]
mod tests;
