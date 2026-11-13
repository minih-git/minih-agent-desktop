//! The waiting channel, the blocked card's own words, and the one stage writer
//! (employee mode 0.5 slice 4a).
//!
//! Split out of [`crate::tasks`] once it grew past the repository's Rust module
//! budget: the task row's CRUD stays there, and everything that *moves* a task
//! lives here. The domain is one: a stage is written from facts the host owns
//! (a turn beginning or ending, a report, a request opening or closing), and
//! every one of those paths goes through [`move_stage`].

use crate::db::{ms_to_ts, now_ms, Database};
use crate::tasks::{get_task, is_valid_stage, short_id};
use anyhow::{anyhow, Result};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};

// ---- the waiting channel and the one stage writer ---------------------------

/// One request a task session is blocked on, as the host stores it.
///
/// The fields are the *structured* facts every surface renders: a question with
/// its options, or the tool a permission was asked for. Nothing here is inferred
/// from prose, so a task that merely mentions a question in its reply is not
/// waiting on the person.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskWaiting {
    pub request_id: String,
    /// `ask` for a question, `permission` for a tool waiting for approval.
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub question: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub options: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub opened_at: String,
}

/// How many open requests one task may hold. A bound, not a workflow: a task
/// asking nine questions at once is confusing the person, so the newest eight
/// are the ones kept.
pub const MAX_WAITING_REQUESTS: usize = 8;
const MAX_WAITING_QUESTION_CHARS: usize = 500;
const MAX_WAITING_OPTIONS: usize = 4;
const MAX_WAITING_OPTION_CHARS: usize = 160;
const MAX_BLOCKER_FIELD_CHARS: usize = 600;

/// The blocker a person's own stop leaves behind. A reason, not an explanation:
/// nobody is woken for it.
const STOPPED_BLOCKER: &str = r#"{"reason":"stopped"}"#;

/// A stage value and the sequence number that identifies exactly this change.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StageMove {
    pub task_id: String,
    pub stage: String,
    pub seq: i64,
}

/// What a stage write does to one of the JSON columns that live beside it.
#[derive(Clone, Copy)]
enum Column<'a> {
    /// Leave the stored value alone.
    Keep,
    /// Nothing is stuck / nothing is waiting.
    Clear,
    Set(&'a str),
}

fn required_text<'a>(input: &'a Value, key: &str, limit: usize) -> Result<&'a str> {
    let value = input
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow!("INVALID_ARGUMENT: {key} required"))?;
    if value.chars().count() > limit {
        return Err(anyhow!("LIMIT_EXCEEDED: {key} too long"));
    }
    Ok(value)
}

/// Bound a string the host keeps without refusing the whole report over one long
/// sentence: a person reading a blocked card needs the beginning, not an error.
fn bounded(input: &Value, key: &str, limit: usize) -> Option<String> {
    let text = input.get(key).and_then(Value::as_str)?.trim();
    if text.is_empty() {
        return None;
    }
    let chars: Vec<char> = text.chars().collect();
    Some(if chars.len() <= limit {
        text.to_owned()
    } else {
        format!("{}…", chars[..limit].iter().collect::<String>().trim_end())
    })
}

fn bounded_options(input: &Value) -> Vec<String> {
    let Some(options) = input.get("options").and_then(Value::as_array) else {
        return Vec::new();
    };
    options
        .iter()
        .filter_map(|option| {
            let label = match option {
                Value::String(text) => text.clone(),
                other => other.get("label").and_then(Value::as_str)?.to_owned(),
            };
            let label = label.trim();
            if label.is_empty() {
                return None;
            }
            let chars: Vec<char> = label.chars().collect();
            Some(if chars.len() <= MAX_WAITING_OPTION_CHARS {
                label.to_owned()
            } else {
                format!(
                    "{}…",
                    chars[..MAX_WAITING_OPTION_CHARS]
                        .iter()
                        .collect::<String>()
                        .trim_end()
                )
            })
        })
        .take(MAX_WAITING_OPTIONS)
        .collect()
}

/// The open task whose session this is, if the session is a task's own.
fn open_task_for_session(conn: &rusqlite::Connection, session_id: &str) -> Result<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT id FROM tasks WHERE session_id=?1 AND archived_at IS NULL",
            params![session_id],
            |row| row.get(0),
        )
        .optional()?)
}

/// The tasks that could be holding an open request, for a close that named only
/// the request id.
fn waiting_candidates(conn: &rusqlite::Connection) -> Result<Vec<String>> {
    let mut statement = conn
        .prepare("SELECT id FROM tasks WHERE waiting_json IS NOT NULL AND archived_at IS NULL")?;
    let mapped = statement.query_map([], |row| row.get::<_, String>(0))?;
    Ok(mapped.collect::<rusqlite::Result<Vec<_>>>()?)
}

fn read_waiting(conn: &rusqlite::Connection, task_id: &str) -> Result<Vec<TaskWaiting>> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT waiting_json FROM tasks WHERE id=?1",
            params![task_id],
            |row| row.get(0),
        )
        .optional()?
        .flatten();
    Ok(raw
        .as_deref()
        .and_then(|encoded| serde_json::from_str(encoded).ok())
        .unwrap_or_default())
}

/// **The one place a task stage is written.**
///
/// Every stage change goes through here: a turn of the task's own session
/// beginning or ending, a delivery's structured report, a request opening or
/// closing, and a `TaskReport` saying the work is stuck. Four rules make that
/// safe to rely on:
///
/// - **The host writes it.** No model and no client names a stage on a task;
///   they report a fact (a turn began, a question is open, the work is stuck)
///   and this function derives the stage from it.
/// - **A repeated write is not a change.** The stage the task already holds
///   leaves `stage_seq` alone, so no second notice can be written for it.
/// - **The columns beside the stage still move**, because a question can open
///   and close while the stage itself stays `person/answer`.
/// - **A change is announced once**, under the key (task, stage, `stage_seq`),
///   in this same transaction; `silent` exists only for the person's own stop.
fn move_stage(
    db: &Database,
    conn: &rusqlite::Connection,
    task_id: &str,
    stage: Option<&str>,
    blocker: Column<'_>,
    waiting: Column<'_>,
    silent: bool,
) -> Result<Option<StageMove>> {
    if let Some(stage) = stage {
        if !is_valid_stage(stage) {
            return Err(anyhow!("INVALID_ARGUMENT: unknown task stage '{stage}'"));
        }
    }
    let current: Option<(String, i64, Option<String>, Option<String>)> = conn
        .query_row(
            "SELECT stage, stage_seq, blocker_json, waiting_json FROM tasks
              WHERE id=?1 AND archived_at IS NULL",
            params![task_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()?;
    let Some((stored, seq, blocker_now, waiting_now)) = current else {
        return Ok(None);
    };
    let resolve = |column: Column<'_>, stored: Option<String>| match column {
        Column::Keep => stored,
        Column::Clear => None,
        Column::Set(value) => Some(value.to_owned()),
    };
    let next_stage = stage.unwrap_or(&stored).to_owned();
    let changed = next_stage != stored;
    let next_seq = if changed { seq + 1 } else { seq };
    conn.execute(
        "UPDATE tasks SET stage=?2, stage_seq=?3, blocker_json=?4, waiting_json=?5 WHERE id=?1",
        params![
            task_id,
            next_stage,
            next_seq,
            resolve(blocker, blocker_now),
            resolve(waiting, waiting_now)
        ],
    )?;
    if !changed {
        return Ok(None);
    }
    if !silent {
        crate::session_collaboration::notices::stage_change(
            db,
            conn,
            task_id,
            &next_stage,
            next_seq,
        )?;
    }
    Ok(Some(StageMove {
        task_id: task_id.to_owned(),
        stage: next_stage,
        seq: next_seq,
    }))
}

/// A turn of the task's own session began: the work is running.
///
/// A new turn only starts after the previous one ended, so whatever the task was
/// waiting on is gone by construction — the requests are closed here as well as
/// by their own handler, because a request whose answer never arrived must not
/// keep a task in `person/answer` for ever.
pub fn turn_began(
    db: &Database,
    conn: &rusqlite::Connection,
    session_id: &str,
) -> Result<Option<StageMove>> {
    let Some(task_id) = open_task_for_session(conn, session_id)? else {
        return Ok(None);
    };
    move_stage(
        db,
        conn,
        &task_id,
        Some("working"),
        Column::Clear,
        Column::Clear,
        false,
    )
}

/// A turn of the task's own session ended, with the status the runtime settled.
///
/// This is what makes a directly dispatched task follow its turns instead of
/// sitting at `queued` for ever: it depends on no delivery, no worker report and
/// no settlement arriving.
pub fn turn_ended(
    db: &Database,
    conn: &rusqlite::Connection,
    session_id: &str,
    status: &str,
    error_code: Option<&str>,
) -> Result<Option<StageMove>> {
    let Some(task_id) = open_task_for_session(conn, session_id)? else {
        return Ok(None);
    };
    let blocker_now: Option<String> = conn
        .query_row(
            "SELECT blocker_json FROM tasks WHERE id=?1",
            params![task_id],
            |row| row.get(0),
        )
        .optional()?
        .flatten();
    // A report written during this turn is the truth about this turn, so
    // settlement must not overwrite it with "finished, waiting for acceptance".
    let reported_stuck = blocker_now.is_some();
    let stopped = status == "aborted";
    // A failed turn keeps the code the runtime settled, so the blocked card can
    // say what failed instead of showing an empty explanation.
    let failure = json!({
        "reason": "error",
        "code": error_code.unwrap_or(""),
    })
    .to_string();
    let (stage, blocker) = if stopped {
        // A person's stop is neither the machine's failure nor news: the task is
        // stuck until somebody decides, and nobody is woken for it.
        ("blocked", Column::Set(STOPPED_BLOCKER))
    } else if status == "error" {
        ("failed", Column::Set(&failure))
    } else if reported_stuck {
        ("blocked", Column::Keep)
    } else {
        ("person/accept", Column::Clear)
    };
    move_stage(
        db,
        conn,
        &task_id,
        Some(stage),
        blocker,
        Column::Clear,
        stopped,
    )
}

/// Close every open request of every task.
///
/// The sidecar restarted, so the requests it was holding do not exist any more:
/// a `waiting_json` that survived the restart would show the person a question
/// nobody can answer. The stage is left alone — the startup fence decides what an
/// interrupted task says.
pub fn clear_waiting(conn: &rusqlite::Connection) -> Result<usize> {
    Ok(conn.execute(
        "UPDATE tasks SET waiting_json=NULL WHERE waiting_json IS NOT NULL",
        [],
    )?)
}

/// The blocker a restart leaves behind: nothing is running, and nothing will.
const INTERRUPTED_BLOCKER: &str = r#"{"reason":"interrupted"}"#;

/// The startup fence's second half: a task whose turn is gone is stuck.
///
/// The first half aborts every `running` turn row and marks the deliveries
/// `interrupted`; neither of those goes through `end_turn_settling`, so a task
/// that was `working` or waiting for an answer kept that stage and looked alive
/// on every surface after a restart. It is not: the sidecar that held the turn is
/// gone, and so is every request the task was waiting on.
///
/// So: every open task whose stage says "in flight" and whose own session has no
/// running turn becomes `blocked` with `reason: "interrupted"`. Three rules:
///
/// - **Silent.** A task a steward dispatched was already announced once by
///   `delivery_interrupted`, and a directly dispatched task wakes nobody ever;
///   announcing here would be a second message about one interruption.
/// - **Only stages that claim work is happening.** `person/accept`, `failed` and
///   an already `blocked` task are not claims about a live turn.
/// - **Only tasks with no running turn.** A task whose turn really is running is
///   left alone, so a database opened by a second process cannot freeze live work.
///
/// Returns how many tasks moved.
pub fn recover_interrupted(db: &Database, conn: &rusqlite::Connection) -> Result<usize> {
    let stuck: Vec<String> = {
        let mut statement = conn.prepare(
            "SELECT t.id FROM tasks t
              WHERE t.archived_at IS NULL
                AND t.stage IN ('working', 'person/answer')
                AND NOT EXISTS (SELECT 1 FROM turns u
                                 WHERE u.session_id = t.session_id AND u.status = 'running')",
        )?;
        let mapped = statement.query_map([], |row| row.get::<_, String>(0))?;
        mapped.collect::<rusqlite::Result<Vec<_>>>()?
    };
    let mut moved = 0;
    for task_id in stuck {
        let changed = move_stage(
            db,
            conn,
            &task_id,
            Some("blocked"),
            Column::Set(INTERRUPTED_BLOCKER),
            Column::Clear,
            true,
        )?;
        if changed.is_some() {
            moved += 1;
        }
    }
    Ok(moved)
}

/// Move the stage of the task bound to a delivery, if there is one.
///
/// Called from the same transaction that accepts a report or settles a turn, so
/// a task can never show a stage the ledger does not have. A delivery with no
/// task is the ordinary case (a worker, a plain message) and does nothing.
///
/// Returns the move when the stage actually changed: a repeated write of the
/// stage the task already holds is not a change, and only a change may wake the
/// steward (`session_collaboration::notices`).
pub fn sync_stage(
    db: &Database,
    conn: &rusqlite::Connection,
    delivery_id: &str,
    stage: &str,
) -> Result<Option<StageMove>> {
    if !is_valid_stage(stage) {
        return Err(anyhow!("INVALID_ARGUMENT: unknown task stage '{stage}'"));
    }
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
    move_stage(
        db,
        conn,
        &task,
        Some(stage),
        Column::Keep,
        Column::Keep,
        false,
    )
}

/// `task.waiting.open`: a task session is blocked on one structured request.
///
/// The entry is what the four surfaces render, so it is stored, not re-read from
/// the transcript: the question and its options come from the AskTool call, and
/// a permission request brings the tool and the reason it gave.
pub fn waiting_open(db: &Database, input: &Value) -> Result<Value> {
    let session_id = required_text(input, "sessionId", 256)?;
    let request_id = required_text(input, "requestId", 256)?;
    let kind = required_text(input, "kind", 32)?;
    if kind != "ask" && kind != "permission" {
        return Err(anyhow!(
            "INVALID_ARGUMENT: kind must be ask or permission, got '{kind}'"
        ));
    }
    let tx = db.conn().unchecked_transaction()?;
    let Some(task_id) = open_task_for_session(&tx, session_id)? else {
        // A request in an ordinary conversation is not a task's problem.
        return Ok(json!({ "opened": false, "reason": "not a task session" }));
    };
    let mut waiting = read_waiting(&tx, &task_id)?;
    if waiting.iter().any(|entry| entry.request_id == request_id) {
        return Ok(json!({
            "opened": false,
            "reason": "already open",
            "task": get_task(db, &task_id)?,
        }));
    }
    waiting.push(TaskWaiting {
        request_id: request_id.to_owned(),
        kind: kind.to_owned(),
        question: bounded(input, "question", MAX_WAITING_QUESTION_CHARS),
        options: bounded_options(input),
        tool_name: bounded(input, "toolName", 160),
        reason: bounded(input, "reason", 300),
        opened_at: ms_to_ts(now_ms()),
    });
    // The newest questions are the ones still worth answering; the bound keeps
    // the column small, not the person in the dark.
    let overflow = waiting.len().saturating_sub(MAX_WAITING_REQUESTS);
    let waiting: Vec<TaskWaiting> = waiting.into_iter().skip(overflow).collect();
    let encoded = serde_json::to_string(&waiting)?;
    move_stage(
        db,
        &tx,
        &task_id,
        Some("person/answer"),
        Column::Keep,
        Column::Set(&encoded),
        false,
    )?;
    tx.commit()?;
    Ok(json!({
        "opened": true,
        "waiting": waiting,
        "task": get_task(db, &task_id)?,
    }))
}

/// `task.waiting.close`: one request is no longer open, whichever surface
/// answered it.
///
/// The request is named by its own id, so a resolution handler that only knows
/// the id does not have to remember which session it came from — and answering
/// from the phone, the task session or the steward's dock closes the same entry.
pub fn waiting_close(db: &Database, input: &Value) -> Result<Value> {
    let request_id = required_text(input, "requestId", 256)?;
    let session_id = input
        .get("sessionId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let tx = db.conn().unchecked_transaction()?;
    let task_id = match session_id {
        Some(session_id) => open_task_for_session(&tx, session_id)?,
        None => {
            let candidates = waiting_candidates(&tx)?;
            let mut found = None;
            for candidate in candidates {
                if read_waiting(&tx, &candidate)?
                    .iter()
                    .any(|entry| entry.request_id == request_id)
                {
                    found = Some(candidate);
                    break;
                }
            }
            found
        }
    };
    let Some(task_id) = task_id else {
        return Ok(json!({ "closed": false, "reason": "not a task session" }));
    };
    let waiting = read_waiting(&tx, &task_id)?;
    let before = waiting.len();
    let waiting: Vec<TaskWaiting> = waiting
        .into_iter()
        .filter(|entry| entry.request_id != request_id)
        .collect();
    if waiting.len() == before {
        return Ok(json!({ "closed": false, "reason": "not open" }));
    }
    // Nothing is waiting any more: a turn that is still running is working
    // again, and a turn that already ended keeps the stage its end wrote.
    let session_of_task: String = tx.query_row(
        "SELECT session_id FROM tasks WHERE id=?1",
        params![task_id],
        |row| row.get(0),
    )?;
    let running: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM turns WHERE session_id=?1 AND status='running')",
        params![session_of_task],
        |row| row.get(0),
    )?;
    let encoded = if waiting.is_empty() {
        None
    } else {
        Some(serde_json::to_string(&waiting)?)
    };
    let column = match encoded.as_deref() {
        Some(value) => Column::Set(value),
        None => Column::Clear,
    };
    let stage = if running && encoded.is_none() {
        Some("working")
    } else {
        None
    };
    // Closing is not news: the person already acted, and the steward was told
    // when the question opened.
    move_stage(db, &tx, &task_id, stage, Column::Keep, column, true)?;
    tx.commit()?;
    Ok(json!({
        "closed": true,
        "waiting": waiting,
        "task": get_task(db, &task_id)?,
    }))
}

/// `task.report`: the task says it is stuck, in its own structured words.
///
/// The stage becomes `blocked` in the same transaction, and the turn that
/// reported it leaves it there: settlement reads the blocker and keeps the
/// stage, so a report cannot be turned into "finished, waiting for acceptance".
pub fn report_blocked(db: &Database, input: &Value) -> Result<Value> {
    let session_id = required_text(input, "sessionId", 256)?;
    let status = required_text(input, "status", 32)?;
    if status != "blocked" {
        return Err(anyhow!(
            "INVALID_ARGUMENT: status must be blocked, got '{status}'"
        ));
    }
    let where_ = required_text(input, "where", MAX_BLOCKER_FIELD_CHARS)?.to_owned();
    let tried = required_text(input, "tried", MAX_BLOCKER_FIELD_CHARS)?.to_owned();
    let suggestion = required_text(input, "suggestion", MAX_BLOCKER_FIELD_CHARS)?.to_owned();
    let tx = db.conn().unchecked_transaction()?;
    let Some(task_id) = open_task_for_session(&tx, session_id)? else {
        return Err(anyhow!(
            "INVALID_ARGUMENT: task.report needs a task session"
        ));
    };
    let blocker = json!({
        "status": "blocked",
        "where": where_,
        "tried": tried,
        "suggestion": suggestion,
        "reportedAt": ms_to_ts(now_ms()),
    })
    .to_string();
    move_stage(
        db,
        &tx,
        &task_id,
        Some("blocked"),
        Column::Set(&blocker),
        Column::Keep,
        false,
    )?;
    tx.commit()?;
    Ok(json!({
        "task": get_task(db, &task_id)?,
        "blocker": serde_json::from_str::<Value>(&blocker).unwrap_or(Value::Null),
    }))
}
/// The steward a card can be proposed on when the caller did not name one.
fn default_steward(db: &Database) -> Result<Option<String>> {
    Ok(db
        .conn()
        .query_row(
            "SELECT id FROM sessions
              WHERE role='bot' AND deleted_at IS NULL
                AND json_extract(bot_profile_json, '$.definition') = 'steward'
              ORDER BY created_at LIMIT 1",
            [],
            |row| row.get(0),
        )
        .optional()?)
}

/// `task.reassign`: hand a stuck task's work to somebody else.
///
/// Reassigning is a **new dispatch**, so it goes through the same confirmation a
/// first dispatch does: a fresh card on the steward's own conversation, carrying
/// the original goal and nobody assigned — the person picks the employee and
/// clicks, and only that click authorizes the new work.
///
/// The original task is left exactly as it was. It is not archived: the person
/// still decides what happens to it, and a card nobody confirmed dispatches
/// nothing, so a reassignment that was reconsidered costs no cleanup.
pub fn reassign(db: &Database, input: &Value) -> Result<Value> {
    let task_id = required_text(input, "taskId", 256)?;
    let task = get_task(db, task_id)?.ok_or_else(|| anyhow!("NOT_FOUND: task"))?;
    if task.archived_at.is_some() {
        return Err(anyhow!("CONFLICT: this task is archived"));
    }
    let steward = match input
        .get("stewardSessionId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(steward) => steward.to_owned(),
        None => default_steward(db)?
            .ok_or_else(|| anyhow!("CONFLICT: no steward session is available to propose on"))?,
    };
    // The goal the new card carries: the card the task came from, else the words
    // the person used, else its title. Never a summary — a dispatcher needs the
    // original instruction, not one rendered again.
    let mandate_goal: Option<String> = match task.delivery_id.as_deref() {
        Some(delivery) => db
            .conn()
            .query_row(
                "SELECT mandate_json FROM session_collaboration_messages WHERE id=?1",
                params![delivery],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten()
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
            .and_then(|value| value.get("goal").and_then(Value::as_str).map(str::to_owned)),
        None => None,
    };
    let goal = mandate_goal
        .or_else(|| {
            task.source_utterance
                .clone()
                .filter(|value| !value.trim().is_empty())
        })
        .unwrap_or_else(|| task.title.clone());
    // The new work starts at the mode the old work ran at: nothing about the new
    // employee is known yet, and `propose` narrows the card to what the person
    // picks can do.
    let session_mode: String = db
        .conn()
        .query_row(
            "SELECT permission_mode FROM sessions WHERE id=?1",
            params![task.session_id],
            |row| row.get(0),
        )
        .optional()?
        .unwrap_or_else(|| "ask".to_owned());
    let permission_mode = match session_mode.as_str() {
        "accept-edits" | "auto" | "ask" => session_mode,
        _ => "ask".to_owned(),
    };
    // The one sentence the card carries. Main renders it in the person's own
    // language, because a stored row cannot be translated later.
    let reason = bounded(input, "reason", 300)
        .unwrap_or_else(|| format!("Reassigned from task #{}", short_id(task_id)));
    let proposed = crate::session_collaboration::drafts::propose(
        db,
        &json!({
            "sessionId": steward,
            "sourceUtterance": goal,
            "card": {
                "goal": goal,
                "criteria": [],
                "boundaries": [],
                "permissionMode": permission_mode,
                "mustAsk": [],
                "risk": "medium",
                "reason": reason,
            },
        }),
    )?;
    Ok(json!({
        "draft": proposed.get("draft").cloned().unwrap_or(Value::Null),
        "created": proposed.get("created").cloned().unwrap_or(Value::Bool(false)),
        "task": task,
    }))
}
