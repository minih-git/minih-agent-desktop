//! Tasks under an employee (ADR bot-sessions-and-steward §7).
//!
//! Employee mode 0.5 separates the employee from the work it does. The employee
//! row stays a durable container with a profile; every piece of work is a
//! **task**: its own session (so its own transcript, project and workspace),
//! owned by the employee it belongs to, with one origin, one stage, and one
//! archive stamp.
//!
//! Two rules shape this module:
//!
//! - **A task session is created by inheriting, never by copying.** It takes the
//!   employee's project, model, thinking level and permission mode through the
//!   same [`spawn_session`] the plugin's worker `spawn` uses, and it never takes
//!   the employee's identity: `role = 'task'`, no profile.
//! - **A stage is written by the host only, in one function.** It starts at the
//!   ADR's queued value and moves on facts the host owns: a turn of the task's
//!   own session beginning or ending (`turn_began`, `turn_ended`), a structured
//!   request opening or closing (`waiting_open`, `waiting_close`), a `TaskReport`
//!   saying the work is stuck (`report_blocked`), and a delivery's own report
//!   (`sync_stage`). Every one of them goes through `move_stage`. Nothing else —
//!   not a client, not a model — writes a stage or the reason beside it.
//!
//! Archiving is one timestamp in two places: `tasks.archived_at` and the same
//! value on its session, written in one transaction, so a task never leaves the
//! sidebar while its session still looks active. Archiving twice returns the
//! first timestamp instead of an error, because a second click is not a mistake
//! the person should have to understand.

use crate::db::{ms_to_ts, now_ms, Database};
use crate::session_collaboration::{spawn_session, string, SpawnRequest};
use crate::sessions;
use anyhow::{anyhow, Result};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use uuid::Uuid;

/// The stage every task starts in: nobody is holding it yet.
const INITIAL_STAGE: &str = "queued";

/// How many tasks one employee may hold open at once. A bound, not a workflow:
/// an employee with more than this is not tracking its work.
pub const MAX_OPEN_TASKS_PER_EMPLOYEE: i64 = 200;

/// The stages a task may be in; the same seven the ledger stores.
pub const STAGES: [&str; 7] = [
    "person/answer",
    "person/accept",
    "blocked",
    "failed",
    "queued",
    "waiting",
    "working",
];

pub fn is_valid_stage(stage: &str) -> bool {
    STAGES.contains(&stage)
}

/// One stored task, in the shape the desktop reads.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub employee_session_id: String,
    pub session_id: String,
    pub title: String,
    pub origin: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_path: Option<String>,
    /// The branch the task asked for (`repo.ref` on a card); `workspace_branch`
    /// is the one it actually got. The header shows the real one once it exists.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    /// The branch the task's worktree was created on, once it is ready.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_branch: Option<String>,
    pub stage: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delivery_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_utterance: Option<String>,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub archived_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest_progress: Option<String>,
    /// The short identifier a task header shows: the first block of its id.
    pub short_id: String,
    /// `none`, `preparing`, `ready`, or `failed` (employee mode 0.5 slice 2).
    pub workspace_status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_error: Option<String>,
    /// The ref the workspace branch was created from, e.g.
    /// `refs/remotes/origin/main`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_ref: Option<String>,
    /// True when `base_ref` was fetched from the project's remote.
    pub base_remote: bool,
    /// `pr`, `local`, or `none`: how this task's work will be delivered.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delivery_mode: Option<String>,
    /// The status of the ledger delivery bound to this task, when it has one.
    ///
    /// Read from the same row the host settles, never copied: `interrupted` is
    /// the startup fence's mark on the delivery, and it is the only answer to
    /// "did the application stop while this was running" (ADR 0239). A restart
    /// writes a new delivery, so this value cannot go stale.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delivery_status: Option<String>,
    /// When that delivery last moved: the only timestamp a "just finished"
    /// question can be answered with, because a task row has no `updated_at`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delivery_updated_at: Option<String>,
    /// The requests this task's session is waiting on right now, newest last.
    ///
    /// It is what `person/answer` means, in the employee's own structured
    /// words: a question with its options, or the tool a permission was asked
    /// for. Nothing here is inferred from prose, so a task that merely
    /// *mentions* a question is not waiting on the person.
    pub waiting: Vec<TaskWaiting>,
    /// Why the task is stuck, as the `TaskReport` that reported it wrote it:
    /// where it is stuck, what it already tried, and what it suggests.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocker: Option<Value>,
    /// How many times this task's stage has moved.
    ///
    /// A notice is exactly-once per change because it is keyed by this number,
    /// not by a delivery: a directly dispatched task has no delivery, and a
    /// task keeps its stage across several turns.
    pub stage_seq: i64,
}

const SELECT: &str = "SELECT t.id, t.employee_session_id, t.session_id, t.title, t.origin,
    p.path, t.branch, t.workspace_branch, t.stage, t.delivery_id, t.source_utterance,
    t.created_at, t.archived_at,
    (SELECT substr(m.text, 1, 200) FROM messages m
      WHERE m.session_id = t.session_id AND m.role = 'assistant'
        AND m.text IS NOT NULL AND trim(m.text) != ''
      ORDER BY m.seq DESC LIMIT 1),
    t.workspace_status, t.workspace_error, t.base_ref, t.base_remote, t.delivery_mode,
    (SELECT m.status FROM session_collaboration_messages m WHERE m.id = t.delivery_id),
    (SELECT m.updated_at FROM session_collaboration_messages m WHERE m.id = t.delivery_id),
    t.waiting_json, t.blocker_json, t.stage_seq
 FROM tasks t LEFT JOIN projects p ON p.id = t.project_id";

fn row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Task> {
    let id: String = row.get(0)?;
    Ok(Task {
        short_id: short_id(&id),
        id,
        employee_session_id: row.get(1)?,
        session_id: row.get(2)?,
        title: row.get(3)?,
        origin: row.get(4)?,
        project_path: row.get(5)?,
        branch: row.get(6)?,
        workspace_branch: row.get(7)?,
        stage: row.get(8)?,
        delivery_id: row.get(9)?,
        source_utterance: row.get(10)?,
        created_at: ms_to_ts(row.get(11)?),
        archived_at: row.get::<_, Option<i64>>(12)?.map(ms_to_ts),
        latest_progress: row.get(13)?,
        workspace_status: row.get(14)?,
        workspace_error: row.get(15)?,
        base_ref: row.get(16)?,
        base_remote: row.get::<_, i64>(17)? != 0,
        delivery_mode: row.get(18)?,
        delivery_status: row.get(19)?,
        delivery_updated_at: row.get::<_, Option<i64>>(20)?.map(ms_to_ts),
        // Both JSON columns are written by the host alone, so a value that does
        // not parse is not one a person can act on: the row stays readable and
        // the surface simply has nothing to show.
        waiting: row
            .get::<_, Option<String>>(21)?
            .as_deref()
            .and_then(|encoded| serde_json::from_str(encoded).ok())
            .unwrap_or_default(),
        blocker: row
            .get::<_, Option<String>>(22)?
            .as_deref()
            .and_then(|encoded| serde_json::from_str(encoded).ok()),
        stage_seq: row.get(23)?,
    })
}

/// The part of a task id a person can quote. Ids are UUIDs, so the first block
/// is unique enough to name a task in a header and short enough to read.
pub fn short_id(id: &str) -> String {
    id.split('-').next().unwrap_or(id).chars().take(6).collect()
}

pub fn get_task(db: &Database, task_id: &str) -> Result<Option<Task>> {
    Ok(db
        .conn()
        .prepare_cached(&format!("{SELECT} WHERE t.id=?1"))?
        .query_row(params![task_id], row)
        .optional()?)
}

fn optional_text(input: &Value, key: &str, limit: usize) -> Result<Option<String>> {
    match input.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                return Ok(None);
            }
            if trimmed.chars().count() > limit {
                return Err(anyhow!("LIMIT_EXCEEDED: {key} too long"));
            }
            Ok(Some(trimmed.to_owned()))
        }
        Some(_) => Err(anyhow!("INVALID_ARGUMENT: {key} must be a string")),
    }
}

/// Everything a create needs.
pub struct CreateRequest<'a> {
    pub employee_session_id: &'a str,
    pub title: &'a str,
    pub origin: &'a str,
    pub project_path: Option<String>,
    pub branch: Option<String>,
    pub source_utterance: Option<String>,
    pub delivery_id: Option<String>,
    /// The permission mode this task runs at.
    ///
    /// Absent means "the employee's own", which is what a task the person
    /// created straight in the workbench wants. A confirmed card passes the
    /// mode its click authorized, so the task session is *created* at that mode
    /// instead of inheriting one that would then be refused on dispatch
    /// (employee mode 0.5 slice 3, review S2).
    pub permission_mode: Option<&'a str>,
}

/// Create a task and its session, atomically.
///
/// The session is created through [`spawn_session`], so it takes the
/// employee's configuration exactly as a worker takes its parent's, and the
/// task row records what only this task knows: who started it, which delivery
/// authorized it, and where it works.
///
/// A `steward` task always names the delivery that carried the confirmed card;
/// a `direct` task never does, because a person typing into the workbench did
/// not dispatch anything through the ledger.
pub fn create_in(
    db: &Database,
    conn: &rusqlite::Connection,
    request: CreateRequest<'_>,
) -> Result<Task> {
    if request.origin != "steward" && request.origin != "direct" {
        return Err(anyhow!(
            "INVALID_ARGUMENT: origin must be steward or direct, got '{}'",
            request.origin
        ));
    }
    let title = request.title.trim();
    if title.is_empty() {
        return Err(anyhow!("INVALID_ARGUMENT: title required"));
    }
    if title.chars().count() > 200 {
        return Err(anyhow!("LIMIT_EXCEEDED: title too long"));
    }
    let employee_role = sessions::session_role(db, request.employee_session_id)?;
    if employee_role.as_deref() != Some("bot") {
        return Err(anyhow!(
            "INVALID_ARGUMENT: a task belongs to an employee session"
        ));
    }
    let open: i64 = conn.query_row(
        "SELECT COUNT(*) FROM tasks WHERE employee_session_id=?1 AND archived_at IS NULL",
        params![request.employee_session_id],
        |row| row.get(0),
    )?;
    if open >= MAX_OPEN_TASKS_PER_EMPLOYEE {
        return Err(anyhow!(
            "LIMIT_EXCEEDED: this employee already holds {open} open tasks"
        ));
    }
    // The repository is what the task works in. A named project wins; otherwise
    // the employee's own project is the default, because that is the repository
    // the employee was hired to read.
    let project_path = match request.project_path.as_deref() {
        Some(path) => Some(path.to_owned()),
        None => match employee_project_id(db, request.employee_session_id)? {
            Some(id) => db.project_path(id)?,
            None => None,
        },
    };
    // The task's project reaches the session, not only the task row: the runtime
    // launches the turn in the *session's* workspace, so a project recorded on
    // the task alone would make the person's choice display-only.
    let task_session = spawn_session(
        db,
        SpawnRequest {
            source: request.employee_session_id,
            title: title.to_owned(),
            // An explicit model binding is the employee's; a task does not
            // re-select one.
            provider_id: None,
            model_id: None,
            role: Some("task".into()),
            project_path,
            permission_mode: request.permission_mode.map(str::to_owned),
        },
    )?;
    conn.execute(
        "UPDATE sessions SET owner_session_id=?2 WHERE id=?1",
        params![task_session.id, request.employee_session_id],
    )?;
    // Read the project back off the session rather than keeping a second copy:
    // `tasks.project_id` and `sessions.project_id` are then the same value by
    // construction, and the task's repository has one source of truth.
    let project_id: Option<i64> = conn.query_row(
        "SELECT project_id FROM sessions WHERE id=?1",
        params![task_session.id],
        |row| row.get(0),
    )?;
    let id = Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO tasks
         (id, employee_session_id, session_id, title, origin, project_id, branch,
          stage, delivery_id, source_utterance, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
            id,
            request.employee_session_id,
            task_session.id,
            title,
            request.origin,
            project_id,
            request.branch,
            INITIAL_STAGE,
            request.delivery_id,
            request.source_utterance,
            now_ms()
        ],
    )?;
    get_task(db, &id)?
        .ok_or_else(|| anyhow!("NOT_STORED: the task was written but cannot be read back"))
}

pub(crate) fn employee_project_id(db: &Database, employee_session_id: &str) -> Result<Option<i64>> {
    Ok(db
        .conn()
        .prepare_cached("SELECT project_id FROM sessions WHERE id=?1")?
        .query_row(params![employee_session_id], |row| row.get(0))
        .optional()?
        .flatten())
}

/// The open tasks of one employee, newest first.
pub fn employee_tasks(db: &Database, employee_session_id: &str) -> Result<Vec<Task>> {
    let mut statement = db.conn().prepare_cached(&format!(
        "{SELECT} WHERE t.employee_session_id=?1 AND t.archived_at IS NULL
         ORDER BY t.created_at DESC, t.rowid DESC"
    ))?;
    let rows = statement.query_map(params![employee_session_id], row)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// What an employee's dot reports, given the tasks it holds.
///
/// The dot answers "is it doing something", so waiting on the person wins over
/// being busy, being busy wins over everything else, and no open task means
/// idle. It is the same rule the sidebar and the workbench apply; keeping it in
/// one place is what stops them disagreeing.
pub fn task_status_point(tasks: &[Task]) -> Value {
    let stage_of = |wanted: &[&str]| {
        tasks
            .iter()
            .find(|task| wanted.contains(&task.stage.as_str()))
            .map(|task| task.stage.clone())
    };
    // "Waiting on the person" is not only the two `person/*` stages (employee
    // mode 0.5 slice 4a): a task that is blocked or failed is equally something
    // the person has to act on, so the dot says so. Counting only `person/*`
    // left a stuck task looking like a busy one.
    if let Some(stage) = stage_of(&["person/answer", "person/accept", "blocked", "failed"]) {
        return json!({ "kind": "stage", "stage": stage });
    }
    if let Some(stage) = stage_of(&["working", "queued", "waiting"]) {
        return json!({ "kind": "stage", "stage": stage });
    }
    json!({ "kind": "idle" })
}

/// `task.create`. One transaction: the session, the task row, and the link the
/// archive will later use.
pub fn create(db: &Database, input: &Value) -> Result<Value> {
    let employee = string(input, "employeeSessionId", 256)?.to_owned();
    let title = string(input, "title", 200)?.to_owned();
    let origin = string(input, "origin", 16)?.to_owned();
    let tx = db.conn().unchecked_transaction()?;
    let task = create_in(
        db,
        &tx,
        CreateRequest {
            employee_session_id: &employee,
            title: &title,
            origin: &origin,
            project_path: optional_text(input, "projectPath", 4_096)?,
            branch: optional_text(input, "branch", 255)?,
            source_utterance: optional_text(input, "sourceUtterance", 4_096)?,
            delivery_id: optional_text(input, "deliveryId", 256)?,
            // A task the person creates in the workbench runs at the employee's
            // own mode: there is no card here to narrow it.
            permission_mode: None,
        },
    )?;
    tx.commit()?;
    Ok(json!({
        "task": task,
        "session": sessions::session_summary(db, &task.session_id)?,
    }))
}

/// `task.list`: the tasks of one employee, or of everyone.
///
/// `includeArchived` is what the sidebar's "history (N)" is built from, and
/// `since` bounds it by creation time so a long-lived employee does not return
/// its whole history on every refresh.
pub fn list(db: &Database, input: &Value) -> Result<Value> {
    let employee = input.get("employeeSessionId").and_then(Value::as_str);
    let include_archived = input
        .get("includeArchived")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let since = input.get("since").and_then(Value::as_i64);
    let mut statement = db.conn().prepare_cached(&format!(
        "{SELECT}
         WHERE (?1 IS NULL OR t.employee_session_id=?1)
           AND (?2 OR t.archived_at IS NULL)
           AND (?3 IS NULL OR t.created_at >= ?3)
         ORDER BY t.created_at DESC, t.rowid DESC
         LIMIT 500"
    ))?;
    let tasks = statement
        .query_map(params![employee, include_archived, since], row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(json!({ "tasks": tasks }))
}

pub fn detail(db: &Database, input: &Value) -> Result<Value> {
    let task_id = string(input, "taskId", 256)?;
    let task = get_task(db, task_id)?.ok_or_else(|| anyhow!("NOT_FOUND: task"))?;
    Ok(json!({ "task": task }))
}

/// `task.archive`: the task and its session leave the sidebar together.
///
/// Repeated archiving keeps the first timestamp. A task that already left the
/// open list is not an error the second time somebody clicks; it is the same
/// answer.
pub fn archive(db: &Database, input: &Value) -> Result<Value> {
    let task_id = string(input, "taskId", 256)?;
    let tx = db.conn().unchecked_transaction()?;
    let existing: Option<(Option<i64>, String)> = tx
        .query_row(
            "SELECT archived_at, session_id FROM tasks WHERE id=?1",
            params![task_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((archived_at, session_id)) = existing else {
        return Err(anyhow!("NOT_FOUND: task"));
    };
    let stamped = match archived_at {
        Some(at) => at,
        None => {
            let at = now_ms();
            tx.execute(
                "UPDATE tasks SET archived_at=?2 WHERE id=?1 AND archived_at IS NULL",
                params![task_id, at],
            )?;
            tx.execute(
                "UPDATE sessions SET archived_at=?2, updated_at=?2 WHERE id=?1",
                params![session_id, at],
            )?;
            at
        }
    };
    tx.commit()?;
    Ok(json!({
        "task": get_task(db, task_id)?,
        "archivedAt": ms_to_ts(stamped),
    }))
}

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
#[cfg(test)]
mod tests {
    use super::*;
    use crate::session_collaboration::repository;
    use serde_json::json;

    /// The ledger write `spawn` uses, reached through the same module so the
    /// test does not need a plugin round trip to create one delivery.
    fn send_record_for_test(
        db: &Database,
        input: &Value,
        target: &str,
        kind: &str,
    ) -> Result<crate::session_collaboration::Message> {
        crate::session_collaboration::dispatch_send_for_test(db, input, target, kind)
    }

    fn database() -> (tempfile::TempDir, Database) {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
        (dir, db)
    }

    fn employee(db: &Database, name: &str) -> String {
        crate::sessions::create_session_with_options(
            db,
            crate::sessions::SessionCreateOptions {
                title: Some(name.into()),
                mode: Some("agent".into()),
                permission_mode: Some("accept-edits".into()),
                thinking_level: Some("high".into()),
                role: Some("bot".into()),
                bot_profile_json: Some(
                    json!({
                        "name": name,
                        "permissionMode": "accept-edits",
                        "mustAsk": [],
                        "observe": false
                    })
                    .to_string(),
                ),
                ..Default::default()
            },
        )
        .unwrap()
        .id
    }

    /// The inheritance rule, checked on the row a task session actually gets.
    #[test]
    fn a_task_session_inherits_the_employees_configuration_but_not_its_identity() {
        let (dir, db) = database();
        let repo = dir.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_path = repo.to_string_lossy().to_string();
        let owner = crate::sessions::create_session_with_options(
            &db,
            crate::sessions::SessionCreateOptions {
                title: Some("Router 后端".into()),
                mode: Some("agent".into()),
                permission_mode: Some("accept-edits".into()),
                thinking_level: Some("high".into()),
                project_path: Some(repo_path.clone()),
                role: Some("bot".into()),
                bot_profile_json: Some(
                    json!({"name": "Router 后端", "permissionMode": "accept-edits", "observe": false})
                        .to_string(),
                ),
                ..Default::default()
            },
        )
        .unwrap()
        .id;
        let created = create(
            &db,
            &json!({
                "employeeSessionId": owner,
                "title": "Fix the login timeout",
                "origin": "direct",
            }),
        )
        .unwrap();
        let session = &created["session"];
        assert_eq!(session["role"], json!("task"));
        assert_eq!(session["permissionMode"], json!("accept-edits"));
        assert_eq!(session["thinkingLevel"], json!("high"));
        // A project path is stored canonical, so a temporary directory on macOS
        // comes back as `/private/var/...`.
        assert_eq!(
            session["projectPath"].as_str().unwrap(),
            std::fs::canonicalize(&repo_path).unwrap().to_string_lossy()
        );
        assert!(session["botProfile"].is_null(), "a task is not an employee");
        let task = &created["task"];
        assert_eq!(task["employeeSessionId"], json!(owner));
        assert_eq!(task["origin"], json!("direct"));
        assert_eq!(task["stage"], json!("queued"));
        assert_eq!(task["projectPath"], session["projectPath"]);
        // The session points back at its employee, which is what an archive
        // and a later "show me this employee's work" read.
        let session_owner: Option<String> = db
            .conn()
            .query_row(
                "SELECT owner_session_id FROM sessions WHERE id=?1",
                params![task["sessionId"].as_str().unwrap()],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(session_owner.as_deref(), Some(owner.as_str()));
    }

    /// The repository a task was given is the one its session runs in.
    ///
    /// The runtime launches a turn in the *session's* workspace, so a project
    /// recorded only on the task row made the person's choice display-only: the
    /// employee kept working in its own repository (#B2).
    #[test]
    fn a_task_session_runs_in_the_project_the_task_was_given() {
        let (dir, db) = database();
        let own = dir.path().join("desktop");
        let other = dir.path().join("router");
        std::fs::create_dir_all(&own).unwrap();
        std::fs::create_dir_all(&other).unwrap();
        let own_path = std::fs::canonicalize(&own)
            .unwrap()
            .to_string_lossy()
            .to_string();
        let other_path = std::fs::canonicalize(&other)
            .unwrap()
            .to_string_lossy()
            .to_string();
        let owner = crate::sessions::create_session_with_options(
            &db,
            crate::sessions::SessionCreateOptions {
                title: Some("后端".into()),
                mode: Some("agent".into()),
                project_path: Some(own_path.clone()),
                role: Some("bot".into()),
                bot_profile_json: Some(
                    json!({"name": "后端", "permissionMode": "ask", "observe": false}).to_string(),
                ),
                ..Default::default()
            },
        )
        .unwrap()
        .id;
        let created = create(
            &db,
            &json!({
                "employeeSessionId": owner,
                "title": "补 remote_gateway 单测",
                "origin": "direct",
                "projectPath": other_path,
            }),
        )
        .unwrap();

        // The session is what the runtime reads, and it is what the person sees.
        assert_eq!(created["session"]["projectPath"], json!(other_path));
        assert_eq!(created["task"]["projectPath"], json!(other_path));
        // The employee keeps its own repository: a task's project is the task's,
        // not a change to the employee's profile.
        let employee_project: Option<String> = db
            .conn()
            .query_row(
                "SELECT p.path FROM sessions s LEFT JOIN projects p ON p.id = s.project_id
                 WHERE s.id = ?1",
                params![owner],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(employee_project.as_deref(), Some(own_path.as_str()));
        // One source of truth: the two rows cannot disagree.
        let (task_project, session_project): (Option<i64>, Option<i64>) = db
            .conn()
            .query_row(
                "SELECT t.project_id, s.project_id FROM tasks t
                 JOIN sessions s ON s.id = t.session_id WHERE t.id = ?1",
                params![created["task"]["id"].as_str().unwrap()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert!(task_project.is_some());
        assert_eq!(task_project, session_project);
    }

    #[test]
    fn a_task_needs_an_employee_and_a_known_origin() {
        let (_dir, db) = database();
        let chat = crate::sessions::create_session_with_options(
            &db,
            crate::sessions::SessionCreateOptions {
                title: Some("Chat".into()),
                mode: Some("agent".into()),
                ..Default::default()
            },
        )
        .unwrap()
        .id;
        let error = create(
            &db,
            &json!({"employeeSessionId": chat, "title": "X", "origin": "direct"}),
        )
        .unwrap_err();
        assert!(error.to_string().contains("INVALID_ARGUMENT"), "{error}");
        let owner = employee(&db, "小爪");
        let error = create(
            &db,
            &json!({"employeeSessionId": owner, "title": "X", "origin": "somebody"}),
        )
        .unwrap_err();
        assert!(error.to_string().contains("INVALID_ARGUMENT"), "{error}");
        // Neither refusal left a task or a stray session behind.
        let tasks = list(&db, &json!({})).unwrap();
        assert_eq!(tasks["tasks"], json!([]));
        let sessions = crate::sessions::list_sessions(&db).unwrap();
        assert_eq!(sessions.len(), 2);
    }

    #[test]
    fn archiving_moves_the_task_and_its_session_and_is_idempotent() {
        let (_dir, db) = database();
        let owner = employee(&db, "小爪");
        let created = create(
            &db,
            &json!({"employeeSessionId": owner, "title": "Fix it", "origin": "direct"}),
        )
        .unwrap();
        let id = created["task"]["id"].as_str().unwrap().to_string();
        let session_id = created["task"]["sessionId"].as_str().unwrap().to_string();
        assert_eq!(
            list(&db, &json!({})).unwrap()["tasks"]
                .as_array()
                .unwrap()
                .len(),
            1
        );

        let first = archive(&db, &json!({"taskId": id})).unwrap();
        assert!(first["task"]["archivedAt"].is_string());
        assert_eq!(list(&db, &json!({})).unwrap()["tasks"], json!([]));
        let with_history = list(&db, &json!({"includeArchived": true})).unwrap();
        assert_eq!(with_history["tasks"].as_array().unwrap().len(), 1);
        let archived_session: Option<i64> = db
            .conn()
            .query_row(
                "SELECT archived_at FROM sessions WHERE id=?1",
                params![session_id],
                |row| row.get(0),
            )
            .unwrap();
        assert!(
            archived_session.is_some(),
            "the session leaves with its task"
        );

        // A second click is the same answer, not an error.
        let second = archive(&db, &json!({"taskId": id})).unwrap();
        assert_eq!(second["archivedAt"], first["archivedAt"]);
        assert!(archive(&db, &json!({"taskId": "missing"})).is_err());
    }

    /// A ledger report moves the task bound to that delivery and nothing else.
    #[test]
    fn a_report_on_the_bound_delivery_moves_the_task_stage() {
        let (_dir, db) = database();
        let owner = employee(&db, "小爪");
        let sender = crate::sessions::create_session_with_options(
            &db,
            crate::sessions::SessionCreateOptions {
                title: Some("Steward".into()),
                mode: Some("agent".into()),
                permission_mode: Some("auto".into()),
                ..Default::default()
            },
        )
        .unwrap()
        .id;
        // The task session is the delivery's target, which is what a confirmed
        // card does: the work runs where the task is, not in the employee.
        let task_session = crate::sessions::create_session_with_options(
            &db,
            crate::sessions::SessionCreateOptions {
                title: Some("Fix the login timeout".into()),
                mode: Some("agent".into()),
                permission_mode: Some("accept-edits".into()),
                role: Some("task".into()),
                ..Default::default()
            },
        )
        .unwrap()
        .id;
        let delivery = send_record_for_test(
            &db,
            &json!({
                "sourceSessionId": sender,
                "pluginId": "builtin:session-messaging",
                "content": "Fix the login timeout",
                "idempotencyKey": "one",
                "notifyOnCompletion": false,
            }),
            &task_session,
            "task",
        )
        .unwrap();
        // A task row for that session, written directly so the test controls
        // which session the delivery targets.
        db.conn()
            .execute(
                "INSERT INTO tasks (id, employee_session_id, session_id, title, origin,
                  stage, delivery_id, created_at)
                 VALUES ('task-1', ?1, ?2, 'Fix the login timeout', 'steward', 'queued', ?3, 1)",
                params![owner, task_session, delivery.id],
            )
            .unwrap();
        let created = json!({"task": {"sessionId": task_session}});
        let id = "task-1".to_string();

        crate::session_collaboration::progress::report(&db, &delivery.id, 1, "progress", "working")
            .unwrap();
        assert_eq!(get_task(&db, &id).unwrap().unwrap().stage, "working");
        crate::session_collaboration::progress::report(
            &db,
            &delivery.id,
            2,
            "waiting",
            "person/answer",
        )
        .unwrap();
        assert_eq!(get_task(&db, &id).unwrap().unwrap().stage, "person/answer");

        // Settlement records the machine's own outcome.
        let task_session = created["task"]["sessionId"].as_str().unwrap().to_string();
        let turn =
            crate::session_collaboration::begin_turn(&db, &task_session, &delivery.id, None, None)
                .unwrap();
        db.conn()
            .execute(
                "UPDATE turns SET status='completed' WHERE id=?1",
                params![turn],
            )
            .unwrap();
        crate::session_collaboration::settle_turn(&db, &turn).unwrap();
        assert_eq!(get_task(&db, &id).unwrap().unwrap().stage, "person/accept");
    }

    /// A delivery that belongs to no task writes nothing, and payment of the
    /// stage vocabulary is refused rather than stored.
    #[test]
    fn a_report_without_a_task_is_harmless_and_an_unknown_stage_is_refused() {
        let (_dir, db) = database();
        let owner = employee(&db, "小爪");
        create(
            &db,
            &json!({"employeeSessionId": owner, "title": "Fix it", "origin": "direct"}),
        )
        .unwrap();
        sync_stage(&db, db.conn(), "no-such-delivery", "working").unwrap();
        assert!(sync_stage(&db, db.conn(), "no-such-delivery", "person/waiting").is_err());
        let tasks = list(&db, &json!({})).unwrap();
        assert_eq!(tasks["tasks"][0]["stage"], json!("queued"));
    }

    /// The task a confirmed card creates is the delivery's target, so the work
    /// reaches the task and not the employee's own transcript — and the card's
    /// `repo.origin`, which is a git remote, never becomes a project row.
    #[test]
    fn a_confirmed_card_dispatches_into_a_new_task_of_that_employee() {
        let (dir, db) = database();
        let repo = dir.path().join("desktop");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_path = std::fs::canonicalize(&repo)
            .unwrap()
            .to_string_lossy()
            .to_string();
        let projects_before: i64 = db
            .conn()
            .query_row("SELECT COUNT(*) FROM projects", [], |row| row.get(0))
            .unwrap();
        let steward = crate::sessions::create_session_with_options(
            &db,
            crate::sessions::SessionCreateOptions {
                title: Some("Steward".into()),
                mode: Some("agent".into()),
                permission_mode: Some("auto".into()),
                ..Default::default()
            },
        )
        .unwrap()
        .id;
        // The employee is bound to one repository, which is the project its work
        // runs in: a card names a remote, not a folder.
        let owner = crate::sessions::create_session_with_options(
            &db,
            crate::sessions::SessionCreateOptions {
                title: Some("小爪".into()),
                mode: Some("agent".into()),
                permission_mode: Some("accept-edits".into()),
                project_path: Some(repo_path.clone()),
                role: Some("bot".into()),
                bot_profile_json: Some(
                    json!({"name": "小爪", "permissionMode": "accept-edits", "observe": false})
                        .to_string(),
                ),
                ..Default::default()
            },
        )
        .unwrap()
        .id;
        let card = json!({
            "goal": "Fix the login timeout",
            "criteria": [{"id": "c1", "text": "A failing repro exists"}],
            "boundaries": [],
            "permissionMode": "accept-edits",
            "mustAsk": [],
            "risk": "low",
            "repo": {"origin": "github.com/minih-git/minih-agent-desktop", "ref": "fix/login"},
        });
        let proposed = crate::session_collaboration::drafts::propose(
            &db,
            &json!({
                "sessionId": steward,
                "targetSessionId": owner,
                "sourceUtterance": "登录超时今天修掉",
                "card": card,
            }),
        )
        .unwrap();
        let draft_id = proposed["draft"]["id"].as_str().unwrap().to_string();
        let hash = proposed["draft"]["cardHash"].as_str().unwrap().to_string();
        let confirmed = crate::session_collaboration::drafts::confirm(
            &db,
            crate::session_collaboration::drafts::ConfirmRequest {
                draft_id: &draft_id,
                card_hash: &hash,
                confirmed_by: crate::session_collaboration::drafts::CONFIRMED_BY_USER,
                host_id: Some("mac-mini"),
                device_id: None,
                policy_version: "steward-1",
                notify_on_completion: true,
                idempotency_key: "confirm-1",
                project_path: None,
            },
        )
        .unwrap();
        let task = &confirmed["task"];
        assert_eq!(task["origin"], json!("steward"));
        assert_eq!(task["employeeSessionId"], json!(owner));
        // The card's `repo.ref` is the branch the person confirmed.
        assert_eq!(task["branch"], json!("fix/login"));
        assert_eq!(task["sourceUtterance"], json!("登录超时今天修掉"));
        // `repo.origin` is `host/owner/name`, so it must not create a project:
        // before this was fixed it produced a phantom row in the person's list.
        let projects_after: i64 = db
            .conn()
            .query_row("SELECT COUNT(*) FROM projects", [], |row| row.get(0))
            .unwrap();
        assert_eq!(
            projects_after,
            projects_before + 1,
            "only the employee's own repository is a project"
        );
        let phantom: i64 = db
            .conn()
            .query_row(
                "SELECT COUNT(*) FROM projects WHERE path LIKE 'github.com%'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(phantom, 0, "a git remote was stored as a project path");
        // The task works in the employee's project, and its session says so —
        // the session's project is what the runtime launches the turn in.
        assert_eq!(task["projectPath"], json!(repo_path));
        let session_project: Option<String> = db
            .conn()
            .query_row(
                "SELECT p.path FROM sessions s LEFT JOIN projects p ON p.id = s.project_id
                 WHERE s.id = ?1",
                params![task["sessionId"].as_str().unwrap()],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(session_project.as_deref(), Some(repo_path.as_str()));
        let delivery = repository::get(&db, confirmed["delivery"]["id"].as_str().unwrap())
            .unwrap()
            .unwrap();
        assert_eq!(delivery.target_session_id, task["sessionId"]);
        assert!(
            delivery
                .mandate_json
                .as_deref()
                .is_some_and(|raw| raw.contains("Fix the login timeout")),
            "the confirmed card travels with the delivery"
        );
    }
}
