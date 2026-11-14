//! Relay between roles: a chain of steps where each one continues the branch the
//! step before it left behind (employee mode 0.5 slice 7).
//!
//! git decides the shape of this feature. A branch cannot be checked out in two
//! worktrees at once, so "one feature branch, several steps" cannot mean two
//! employees working the same branch: it means the second step starts its own
//! branch from the *end* of the first one's. Only the last step of a chain is
//! merged, and it merges the whole chain, because every step's commits are on
//! its successor's branch by construction.
//!
//! Two rules shape this module:
//!
//! - **A handoff is a person's decision, recorded once.** The step that finished
//!   has a completion card whose button is 接受并交给下一棒, and that click is
//!   what writes `relay_handoff_at` and makes the next step dispatchable. Nothing
//!   hands work on by itself, and repeating the click changes nothing.
//! - **An abandoned step strands its successor.** If a step is archived without
//!   handing off, the step behind it becomes `orphaned` in the same transaction:
//!   waiting for a step that will never finish is worse than being told, and the
//!   card then offers "start from main" as the person's own decision.

use crate::db::{ms_to_ts, now_ms, Database};
use crate::session_collaboration::repository::{self, Message};
use crate::tasks;
use anyhow::{anyhow, Result};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};

/// The one stage a handoff may be taken from: the step is finished and the
/// person is looking at its completion card.
pub const HANDOFF_STAGE: &str = "person/accept";

fn task_id_of(input: &Value) -> Result<String> {
    input
        .get("taskId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| anyhow!("INVALID_ARGUMENT: taskId required"))
}

/// The steps that follow this one, in chain order, newest last.
fn successors(db: &Database, task_id: &str) -> Result<Vec<(String, Option<String>, String)>> {
    let mut statement = db.conn().prepare_cached(
        "SELECT id, relay_state, COALESCE(delivery_id, '') FROM tasks
          WHERE relay_parent_task_id=?1 AND archived_at IS NULL
          ORDER BY created_at ASC",
    )?;
    let rows = statement.query_map(params![task_id], |row| {
        Ok((row.get(0)?, row.get(1)?, row.get(2)?))
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// `task.relay.handoff`: accept this step's work and unlock the step after it.
///
/// One transaction, four writes, and every one of them is a fact the next click
/// depends on: `accepted_at` (the work is acceptable), `relay_handoff_at` (this
/// step is done and its branch is the next one's base), `relay_state='ready'` on
/// the waiting step, and the deliveries Main has to dispatch.
///
/// Idempotent: a second click keeps the first timestamp and returns the same
/// deliveries, because a handoff that already happened is not an error the person
/// should have to understand. A step with no successor notes the handoff and
/// unlocks nothing — a card confirmed afterwards sees `relay_handoff_at` and
/// starts at once instead of waiting forever.
pub fn handoff(db: &Database, input: &Value) -> Result<Value> {
    let task_id = task_id_of(input)?;
    let tx = db.conn().unchecked_transaction()?;
    let existing: Option<(String, Option<i64>, Option<i64>, Option<i64>)> = tx
        .query_row(
            "SELECT stage, archived_at, accepted_at, relay_handoff_at FROM tasks WHERE id=?1",
            params![task_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()?;
    let Some((stage, archived_at, accepted_at, handoff_at)) = existing else {
        return Err(anyhow!("NOT_FOUND: task"));
    };
    if archived_at.is_some() {
        return Err(anyhow!("CONFLICT: this task is archived"));
    }
    // A handoff says two things at once — the work is acceptable, and the next
    // step may build on it — so it is only offered where both are true. A repeat
    // of a handoff is allowed from wherever the task sits now.
    if handoff_at.is_none() && stage != HANDOFF_STAGE {
        return Err(anyhow!(
            "CONFLICT: only a finished step can be handed on; this one is {stage}"
        ));
    }
    let now = now_ms();
    if handoff_at.is_none() {
        tx.execute(
            "UPDATE tasks SET relay_handoff_at=?2, accepted_at=COALESCE(accepted_at, ?2)
              WHERE id=?1",
            params![task_id, now],
        )?;
    }
    if accepted_at.is_none() {
        tx.execute(
            "UPDATE tasks SET accepted_at=?2 WHERE id=?1 AND accepted_at IS NULL",
            params![task_id, now],
        )?;
    }
    let mut deliveries: Vec<Message> = Vec::new();
    let mut unlocked: Vec<Value> = Vec::new();
    for (successor_id, relay_state, delivery_id) in successors(db, &task_id)? {
        if relay_state.as_deref() == Some("orphaned") {
            // Already told this step lost its predecessor; a handoff cannot
            // undo that, and the person's own choice is the only way back.
            continue;
        }
        if relay_state.as_deref() == Some("waiting") {
            tx.execute(
                "UPDATE tasks SET relay_state='ready' WHERE id=?1 AND relay_state='waiting'",
                params![successor_id],
            )?;
        }
        if !delivery_id.is_empty() {
            if let Some(message) = repository::get(db, &delivery_id)? {
                unlocked.push(json!({ "taskId": successor_id, "deliveryId": delivery_id }));
                deliveries.push(message);
            }
        }
    }
    tx.commit()?;
    // The stored timestamp, not this call's clock: a repeated click reports when
    // the handoff *happened*, which is the only value a retry can compare.
    Ok(json!({
        "task": tasks::get_task(db, &task_id)?,
        "handedOffAt": ms_to_ts(handoff_at.unwrap_or(now)),
        "unlocked": unlocked,
        "deliveries": deliveries,
    }))
}

/// `task.relay.detach`: start an orphaned step from `main` instead.
///
/// The only way out of `orphaned`, and it is the person's click: the edge to the
/// abandoned step is removed, the blocker it left behind is cleared, and the
/// workspace is prepared again from the project's own `main`. Nothing here
/// chooses that automatically — a step that silently restarted from `main` would
/// deliver a change nobody asked for on a branch whose premise was dropped.
pub fn detach(db: &Database, input: &Value) -> Result<Value> {
    let task_id = task_id_of(input)?;
    let tx = db.conn().unchecked_transaction()?;
    let existing: Option<(String, Option<String>)> = tx
        .query_row(
            "SELECT stage, blocker_json FROM tasks WHERE id=?1 AND archived_at IS NULL",
            params![task_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((stage, blocker_json)) = existing else {
        return Err(anyhow!("NOT_FOUND: task"));
    };
    // Two ways a step loses its predecessor — the previous step was abandoned,
    // or its branch is gone — and the answer to both is the same question, so
    // both offer the same two buttons.
    let reason = blocker_json
        .as_deref()
        .and_then(|encoded| serde_json::from_str::<Value>(encoded).ok())
        .and_then(|blocker| blocker["reason"].as_str().map(str::to_owned))
        .unwrap_or_default();
    if reason != "relay-orphaned" && reason != "relay-base" {
        return Err(anyhow!(
            "CONFLICT: only a step whose predecessor cannot be continued can be restarted from `main`"
        ));
    }
    if stage != "blocked" {
        return Err(anyhow!(
            "CONFLICT: this step is {stage}, not blocked; there is nothing to restart"
        ));
    }
    tx.execute(
        "UPDATE tasks SET relay_parent_task_id=NULL, relay_state=NULL WHERE id=?1",
        params![task_id],
    )?;
    unblock(db, &tx, &task_id)?;
    let delivery_id: String = tx.query_row(
        "SELECT COALESCE(delivery_id, '') FROM tasks WHERE id=?1",
        params![task_id],
        |row| row.get(0),
    )?;
    tx.commit()?;
    // Only a delivery that never started may be dispatched again: one that
    // already holds a turn is running or finished, and starting it twice would
    // run the work twice.
    let deliveries: Vec<Message> = if delivery_id.is_empty() {
        Vec::new()
    } else {
        repository::get(db, &delivery_id)?
            .filter(|message| message.status == "queued" && message.turn_id.is_none())
            .into_iter()
            .collect()
    };
    Ok(json!({
        "task": tasks::get_task(db, &task_id)?,
        "deliveries": deliveries,
    }))
}

/// Orphan the steps that were waiting for `task_id`, when it leaves without
/// handing off.
///
/// Called from `tasks::archive`, inside the archiving transaction: "abandoned"
/// and "the step behind it is stuck" are one fact, and a state where only the
/// first is stored would leave the second waiting forever.
pub fn orphan_successors(
    db: &Database,
    conn: &rusqlite::Connection,
    task_id: &str,
) -> Result<usize> {
    let handoff: Option<Option<i64>> = conn
        .query_row(
            "SELECT relay_handoff_at FROM tasks WHERE id=?1",
            params![task_id],
            |row| row.get(0),
        )
        .optional()?;
    // Handed off already: the step behind this one owns its own branch now.
    if handoff.flatten().is_some() {
        return Ok(0);
    }
    let waiting: Vec<String> = {
        let mut statement = conn.prepare(
            "SELECT id FROM tasks
              WHERE relay_parent_task_id=?1 AND archived_at IS NULL AND relay_state='waiting'",
        )?;
        let listed = statement
            .query_map(params![task_id], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        listed
    };
    let parent_short = tasks::short_id(task_id);
    for successor in &waiting {
        conn.execute(
            "UPDATE tasks SET relay_state='orphaned' WHERE id=?1 AND relay_state='waiting'",
            params![successor],
        )?;
        block_orphaned(db, conn, successor, &parent_short, false)?;
    }
    Ok(waiting.len())
}
#[cfg(test)]
#[path = "task_relay_tests.rs"]
mod tests;

// ---- the stages a relay step can land in ------------------------------------
//
// One writer: `task_stage::move_stage`. These three are the relay's own
// transitions, and they live here because they are about a chain — a step that
// lost its predecessor, a step that was abandoned, and a step a person starts
// from `main` — and not about the stage vocabulary itself.

use crate::task_stage::{self, Column, StageMove};
use rusqlite::Connection;

/// The stage a relay step lands in when the step before it was abandoned.
///
/// The blocker names the step that was lost, because the person's next choice is
/// about that step: start this one from `main` instead, or drop it. `silent` is
/// true when the host writes it from the card's own confirmation, which the
/// person is already looking at.
pub fn block_orphaned(
    db: &Database,
    conn: &Connection,
    task_id: &str,
    parent_short: &str,
    silent: bool,
) -> Result<Option<StageMove>> {
    let parent: String = parent_short
        .chars()
        .take(task_stage::MAX_BLOCKER_FIELD_CHARS)
        .collect();
    let blocker = json!({ "reason": "relay-orphaned", "parent": parent }).to_string();
    task_stage::move_stage(
        db,
        conn,
        task_id,
        Some("blocked"),
        Column::Set(&blocker),
        Column::Keep,
        silent,
    )
}

/// The stage a step lands in when the branch it should continue is gone.
///
/// A step whose predecessor's branch no longer exists has nothing to build on.
/// It stops instead of quietly starting from `main`: the change the chain was for
/// would be delivered from a base nobody chose.
pub fn block_base(
    db: &Database,
    conn: &Connection,
    task_id: &str,
    parent_short: &str,
    detail: &str,
) -> Result<Option<StageMove>> {
    let parent: String = parent_short
        .chars()
        .take(task_stage::MAX_BLOCKER_FIELD_CHARS)
        .collect();
    let detail: String = detail
        .chars()
        .take(task_stage::MAX_BLOCKER_FIELD_CHARS)
        .collect();
    let blocker = json!({ "reason": "relay-base", "parent": parent, "detail": detail }).to_string();
    task_stage::move_stage(
        db,
        conn,
        task_id,
        Some("blocked"),
        Column::Set(&blocker),
        Column::Keep,
        false,
    )
}

/// The stage a step returns to when the person starts it from `main` instead of
/// from the step that cannot be continued.
///
/// Back to `queued`: nobody is holding it yet, and the host is about to open its
/// workspace and dispatch it. The blocker goes away in the same write, so the
/// blocked card cannot outlive the decision it described.
pub fn unblock(db: &Database, conn: &Connection, task_id: &str) -> Result<Option<StageMove>> {
    task_stage::move_stage(
        db,
        conn,
        task_id,
        Some("queued"),
        Column::Clear,
        Column::Keep,
        false,
    )
}
