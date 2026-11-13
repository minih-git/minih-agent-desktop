//! `task.restart`: start a task again after the startup fence interrupted it
//! (employee mode 0.5 slice 3, the sixth defect).
//!
//! ADR 0239's fence is unchanged: nothing is replayed because the application
//! restarted. What was missing is that the interruption was invisible — the task
//! kept the stage it had, nobody was told, and its session looked idle. Two
//! pieces fix that:
//!
//! - `settlement::recover` wakes the task's steward with stage `interrupted`
//!   (see `notices`), and `tasks.delivery_status` makes the task readable as
//!   interrupted everywhere without a new stage value;
//! - this module is the person's way back: clicking "重新开工" writes a **new**
//!   delivery carrying the same mandate from the same sender, re-points the task
//!   at it, and leaves it `queued` for the ordinary dispatch to start.
//!
//! Restarting is one click per interruption. The new delivery's idempotency key
//! names the old one, so a double click returns the delivery the first click
//! wrote instead of running the work twice.

use super::repository::{self, Message};
use crate::db::{ms_to_ts, now_ms, Database};
use crate::tasks;
use anyhow::{anyhow, Result};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use uuid::Uuid;

pub fn restart(db: &Database, input: &Value) -> Result<Value> {
    let task_id = super::string(input, "taskId", 256)?.to_owned();
    let tx = db.conn().unchecked_transaction()?;
    let (task_session, delivery, archived): (String, Option<String>, Option<i64>) = tx
        .query_row(
            "SELECT session_id, delivery_id, archived_at FROM tasks WHERE id=?1",
            params![task_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?
        .ok_or_else(|| anyhow!("NOT_FOUND: task"))?;
    if archived.is_some() {
        return Err(anyhow!("CONFLICT: this task is archived"));
    }
    let delivery_id = delivery.ok_or_else(|| anyhow!("CONFLICT: this task was never dispatched"))?;
    let previous: Option<(String, String, Option<String>, String, i64, String, String)> = tx
        .query_row(
            "SELECT source_session_id, plugin_id, mandate_json, permission_ceiling,
                    remaining_hops, status, idempotency_key
               FROM session_collaboration_messages WHERE id=?1",
            params![delivery_id],
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
    let Some((source, plugin, mandate, ceiling, hops, status, key_of)) = previous else {
        return Err(anyhow!("CONFLICT: the delivery bound to this task is gone"));
    };
    // A queued delivery this very operation wrote is the first click's answer:
    // returning it is what makes a double click one restart instead of two runs.
    if status == "queued" && key_of.starts_with("task-restart:") {
        tx.commit()?;
        return Ok(json!({
            "task": tasks::get_task(db, &task_id)?,
            "delivery": repository::get(db, &delivery_id)?,
        }));
    }
    // Only the fence's interruption is restartable. A running delivery would be
    // started twice, and a finished one would redo work the person already has.
    if status != "interrupted" {
        return Err(anyhow!(
            "CONFLICT: only an interrupted task can be started again, not one that is {status}"
        ));
    }
    let key = format!("task-restart:{task_id}:{delivery_id}");
    let restarted = match repository::existing(db, &plugin, &source, &key)? {
        Some(existing) => existing,
        None => {
            let at = ms_to_ts(now_ms());
            let goal = mandate
                .as_deref()
                .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
                .and_then(|value| {
                    value
                        .get("goal")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                })
                .unwrap_or_else(|| "Resume the interrupted task".into());
            let message = Message {
                id: Uuid::new_v4().to_string(),
                plugin_id: plugin,
                source_title: repository::title(db, &source)?,
                source_session_id: source,
                target_title: repository::title(db, &task_session)?,
                target_session_id: task_session,
                kind: "task".into(),
                content: goal,
                status: "queued".into(),
                notify_on_completion: true,
                turn_id: None,
                reply_to_message_id: Some(delivery_id.clone()),
                result: None,
                error: None,
                created_at: at.clone(),
                updated_at: at,
                // The same authorization, the same budget, the same ceiling: a
                // restart is not a new decision, it is the same one resumed.
                remaining_hops: hops,
                permission_ceiling: ceiling,
                mandate_json: mandate,
                stage: None,
                report_seq: 0,
            };
            repository::insert_on(&tx, &message, &key)?;
            tx.execute(
                "UPDATE tasks SET delivery_id=?2, stage='queued' WHERE id=?1",
                params![task_id, message.id],
            )?;
            message
        }
    };
    tx.commit()?;
    Ok(json!({
        "task": tasks::get_task(db, &task_id)?,
        "delivery": restarted,
    }))
}