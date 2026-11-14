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
    /// When the person accepted this work, if they did.
    ///
    /// Accepting is not archiving: the task stays open, its completion card
    /// stays reachable so the merge can still be done later, and this stamp is
    /// what takes it out of the sidebar's "waiting for you" count.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub accepted_at: Option<String>,
    /// What the employee delivered, as `TaskReport { status: "ready" }` wrote
    /// it: a summary, one line per acceptance criterion with ✓/✗, and the
    /// leftovers. Absent means the employee ended the turn without a report,
    /// and the card then shows only what the host itself can prove.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<crate::task_stage::TaskResult>,
    /// The fixed steps the host ran to land this work, and where they stopped.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delivery: Option<crate::task_delivery::DeliveryState>,
    /// The batch the card that created this task belonged to, when the steward
    /// proposed several cards in one turn. Read from the draft, never copied:
    /// one sentence split into three tasks is one batch by construction.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub batch_id: Option<String>,
    /// The task this one continues from, when it is one step of a relay
    /// (employee mode 0.5 slice 7).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub relay_parent_task_id: Option<String>,
    /// `waiting`, `ready` or `orphaned`; absent for a task in no chain.
    ///
    /// `waiting` means the step before this one is still running, so the host
    /// has not started this task and will not start it on its own. `ready` means
    /// it handed off and this step may run. `orphaned` means the step before it
    /// was abandoned without handing off, which is a blocked card and a person's
    /// decision, never an automatic fallback to `main`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub relay_state: Option<String>,
    /// When this task handed its work to the next step.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub relay_handoff_at: Option<String>,
    /// This task's position in its chain, 1-based, and the chain's length. A
    /// task in no chain is step 1 of 1, which is what makes the task session's
    /// "step k of n" rule a single expression rather than a special case.
    pub relay_step: usize,
    pub relay_total: usize,
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
    t.waiting_json, t.blocker_json, t.stage_seq,
    t.accepted_at, t.result_json, t.delivery_json,
    (SELECT d.batch_id FROM task_card_drafts d WHERE d.delivery_id = t.delivery_id),
    t.relay_parent_task_id, t.relay_state, t.relay_handoff_at
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
        accepted_at: row.get::<_, Option<i64>>(24)?.map(ms_to_ts),
        // Written by the host alone, so a value that does not parse is not one
        // a person can act on: the card then shows what the host can prove.
        result: row
            .get::<_, Option<String>>(25)?
            .as_deref()
            .and_then(|encoded| serde_json::from_str(encoded).ok()),
        delivery: row
            .get::<_, Option<String>>(26)?
            .as_deref()
            .and_then(|encoded| serde_json::from_str(encoded).ok()),
        batch_id: row.get(27)?,
        relay_parent_task_id: row.get(28)?,
        relay_state: row.get(29)?,
        relay_handoff_at: row.get::<_, Option<i64>>(30)?.map(ms_to_ts),
        // Filled by `with_relay_positions`, which needs the other rows of the
        // list: a task read on its own cannot know where its chain ends.
        relay_step: 1,
        relay_total: 1,
    })
}

/// The steps of one relay chain, first to last (employee mode 0.5 slice 7).
///
/// The chain is read from the `relay_parent_task_id` links rather than from a
/// stored list, because a link is one fact and a list is a second copy of it.
/// [`with_relay_positions`] fills in the two derived numbers.
fn relay_links(db: &Database) -> Result<std::collections::HashMap<String, Option<String>>> {
    let mut statement = db
        .conn()
        .prepare_cached("SELECT id, relay_parent_task_id FROM tasks")?;
    let links = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
        })?
        .collect::<rusqlite::Result<std::collections::HashMap<_, _>>>()?;
    Ok(links)
}

/// Bound for walking links, so a corrupted link pair cannot spin forever.
const RELAY_WALK_LIMIT: usize = 16;

/// Fill in each task's `relay_step` and `relay_total` from the chain it is in.
///
/// One extra read for the whole list, and none at all when no task is in a
/// chain — which is every task that existed before this slice.
fn with_relay_positions(db: &Database, tasks: &mut [Task]) -> Result<()> {
    if tasks.iter().all(|task| task.relay_parent_task_id.is_none()) {
        return Ok(());
    }
    let links = relay_links(db)?;
    // Exactly one follower per step is enforced when a card is proposed, so a
    // parent has at most one child here.
    let mut child_of: std::collections::HashMap<&str, &str> = std::collections::HashMap::new();
    for (id, parent) in &links {
        if let Some(parent) = parent.as_deref() {
            child_of.entry(parent).or_insert(id.as_str());
        }
    }
    for task in tasks.iter_mut() {
        let mut step = 1;
        let mut cursor = task.relay_parent_task_id.clone();
        let mut walked = 0;
        while let Some(parent) = cursor {
            walked += 1;
            if walked > RELAY_WALK_LIMIT {
                break;
            }
            step += 1;
            cursor = links.get(&parent).cloned().flatten();
        }
        let mut total = step;
        let mut child = child_of.get(task.id.as_str()).copied();
        let mut walked = 0;
        while let Some(next) = child {
            walked += 1;
            if walked > RELAY_WALK_LIMIT {
                break;
            }
            total += 1;
            child = child_of.get(next).copied();
        }
        task.relay_step = step;
        task.relay_total = total;
    }
    Ok(())
}

/// The whole chain a task belongs to, first step to last, including the task.
///
/// Read for the completion card, the handoff, and the cleanup after the last
/// step merges: all three need "every step of this chain", not just its ends.
pub fn relay_chain(db: &Database, task_id: &str) -> Result<Vec<Task>> {
    let links = relay_links(db)?;
    let child_of: std::collections::HashMap<&str, &str> = links
        .iter()
        .filter_map(|(id, parent)| parent.as_deref().map(|parent| (parent, id.as_str())))
        .collect();
    // Walk back to the head of the chain, then forward through every step.
    let mut head = task_id.to_string();
    let mut walked = 0;
    while let Some(Some(parent)) = links.get(&head) {
        walked += 1;
        if walked > RELAY_WALK_LIMIT {
            break;
        }
        head = parent.clone();
    }
    let mut chain = Vec::new();
    let mut cursor = Some(head);
    while let Some(id) = cursor {
        let Some(task) = get_task(db, &id)? else {
            break;
        };
        cursor = child_of
            .get(task.id.as_str())
            .map(|next| (*next).to_string());
        chain.push(task);
        if chain.len() > RELAY_WALK_LIMIT {
            break;
        }
    }
    with_relay_positions(db, &mut chain)?;
    Ok(chain)
}

/// Whether a task is followed by another step, i.e. it is not the last of its
/// chain. Only the last step may be merged.
pub fn relay_has_successor(db: &Database, task_id: &str) -> Result<bool> {
    Ok(db
        .conn()
        .prepare_cached("SELECT EXISTS(SELECT 1 FROM tasks WHERE relay_parent_task_id=?1)")?
        .query_row(params![task_id], |row| row.get(0))?)
}

/// The part of a task id a person can quote. Ids are UUIDs, so the first block
/// is unique enough to name a task in a header and short enough to read.
pub fn short_id(id: &str) -> String {
    id.split('-').next().unwrap_or(id).chars().take(6).collect()
}

pub fn get_task(db: &Database, task_id: &str) -> Result<Option<Task>> {
    let mut found = db
        .conn()
        .prepare_cached(&format!("{SELECT} WHERE t.id=?1"))?
        .query_row(params![task_id], row)
        .optional()?;
    if let Some(task) = found.as_mut() {
        with_relay_positions(db, std::slice::from_mut(task))?;
    }
    Ok(found)
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
    /// The task this one continues from, when the confirmed card declared one
    /// (employee mode 0.5 slice 7). Read from the parent task by `confirm`, so
    /// the edge is one fact rather than a copy of the draft's.
    pub relay_parent_task_id: Option<&'a str>,
    /// `waiting`, `ready` or `orphaned` for a relay step; absent otherwise.
    pub relay_state: Option<&'a str>,
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
          stage, delivery_id, source_utterance, created_at,
          relay_parent_task_id, relay_state)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
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
            now_ms(),
            request.relay_parent_task_id,
            request.relay_state
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
    let mut tasks = rows.collect::<rusqlite::Result<Vec<_>>>()?;
    with_relay_positions(db, &mut tasks)?;
    Ok(tasks)
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
            .find(|task| {
                // An accepted task is not something the person still has to act
                // on: they already did (employee mode 0.5 slice 4b). Counting it
                // kept the employee's dot orange after the one click that ended
                // the wait, while its own row already read 「已接受，待合并」.
                if task.accepted_at.is_some() && task.stage == "person/accept" {
                    return false;
                }
                wanted.contains(&task.stage.as_str())
            })
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
            // own mode: there is no card here to narrow it, and no chain: a relay
            // is declared by a card that names the card it follows.
            permission_mode: None,
            relay_parent_task_id: None,
            relay_state: None,
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
    // The task's own session, when the caller already has the session and not
    // the task: Main reads the briefing's relay position this way, and asking
    // for one row by session is cheaper than listing a board and searching it.
    let session = input.get("sessionId").and_then(Value::as_str);
    let include_archived = input
        .get("includeArchived")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let since = input.get("since").and_then(Value::as_i64);
    let mut statement = db.conn().prepare_cached(&format!(
        "{SELECT}
         WHERE (?1 IS NULL OR t.employee_session_id=?1)
           AND (?4 IS NULL OR t.session_id=?4)
           AND (?2 OR t.archived_at IS NULL)
           AND (?3 IS NULL OR t.created_at >= ?3)
         ORDER BY t.created_at DESC, t.rowid DESC
         LIMIT 500"
    ))?;
    let tasks = statement
        .query_map(params![employee, include_archived, since, session], row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut tasks = tasks;
    with_relay_positions(db, &mut tasks)?;
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
            // The archive owes one extraction of what this task taught the
            // employee, in the same transaction that ends the task (0.5 slice 5).
            // Every archive path — this button, the merge cleanup, an abandoned
            // blocked card — therefore owes exactly one, and a restart between
            // the stamp and the run resumes it instead of losing it.
            crate::memory::stamp_pending_tx(&tx, task_id)?;
            // A step of a relay that leaves without handing off strands the step
            // behind it, in this same transaction (employee mode 0.5 slice 7):
            // "abandoned" and "the next step is stuck" are one fact, and storing
            // only the first would leave the second waiting forever.
            crate::task_relay::orphan_successors(db, &tx, task_id)?;
            at
        }
    };
    tx.commit()?;
    Ok(json!({
        "task": get_task(db, task_id)?,
        "archivedAt": ms_to_ts(stamped),
    }))
}

// The waiting channel moved to its own module when this file passed the module
// budget; the names stay here so a caller reads `tasks::turn_ended`.
pub use crate::task_stage::{
    accept, clear_waiting, reassign, recover_interrupted, report, report_blocked, sync_stage,
    turn_began, turn_ended, waiting_close, waiting_open, TaskWaiting,
};
