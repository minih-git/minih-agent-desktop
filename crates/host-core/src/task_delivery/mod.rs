//! The completion card's gate, and the fixed steps that land a task's work
//! (employee mode 0.5 slice 4b).
//!
//! Two rules shape this module:
//!
//! - **The gate is a table, and a mistake in it is a refusal.** Every row of
//!   `gate_for` is one fact the person would otherwise have to check by hand
//!   (no PR, no CI result, a red check, a conflict, a review that is not done).
//!   Anything that cannot be read is "cannot merge", never "probably fine": a
//!   green button that fails after the click is worse than a grey one that says
//!   why.
//! - **The host performs the merge, not a model.** Merging asks the employee to
//!   run six irreversible git commands; in `ask` mode each of them would raise a
//!   permission card, which contradicts the click that authorized it, and an
//!   irreversible act must not depend on a model remembering the order. So the
//!   steps live here, in a fixed list, and each one records that it ran
//!   (`tasks.delivery_json`) so a retry continues where the last attempt stopped
use std::path::{Path, PathBuf};

use anyhow::{anyhow, Result};
use serde::Serialize;
use serde_json::{json, Value};

use crate::db::{ms_to_ts, now_ms, ts_to_ms, Database};
use crate::session_worktrees::git::GitRunner;
use crate::session_worktrees::lifecycle::{self, SharedState};
use crate::session_worktrees::merge;
use crate::session_worktrees::registry::{self, WorktreeRow};
use crate::task_workspace::DeliveryMode;
use crate::tasks::{self, Task};

mod gate;
mod steps;

use gate::read_pr;
pub use gate::{gate_for, gate_unreadable, CheckSummary, Gate, GhCli, GhRunner};
use steps::{merge_local, merge_pr};

// ---- what the card shows ----------------------------------------------------

/// One commit of the task's own work, as the completion card lists it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeCommit {
    pub sha: String,
    pub subject: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Changes {
    pub commits: Vec<ChangeCommit>,
    pub files: usize,
    /// True when the list was cut: the card then says "and N more".
    pub truncated: bool,
}

/// How many commits the card lists before it stops.
pub const MAX_CARD_COMMITS: usize = 20;

/// The tokens and the money one task's turns cost, when the ledger has them.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskUsage {
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub turns: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost_usd: Option<f64>,
}

fn usage_of(db: &Database, session_id: &str) -> Result<TaskUsage> {
    let (input, output, cost, turns): (i64, i64, f64, i64) = db.conn().query_row(
        "SELECT COALESCE(SUM(input_tokens), 0), COALESCE(SUM(output_tokens), 0),
                COALESCE(SUM(COALESCE(json_extract(usage_json, '$.cost.total'), 0.0)), 0.0),
                COUNT(*)
           FROM turns WHERE session_id = ?1",
        rusqlite::params![session_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    )?;
    Ok(TaskUsage {
        input_tokens: input,
        output_tokens: output,
        turns,
        // A ledger with no reported cost must not print `$0.00`: the card says
        // nothing rather than something false.
        cost_usd: (cost > 0.0).then_some(cost),
    })
}

/// How long the task took: from its creation to the last turn that ended.
fn elapsed_ms_of(db: &Database, task: &Task) -> i64 {
    let started = ts_to_ms(&task.created_at);
    let ended: Option<i64> = db
        .conn()
        .query_row(
            "SELECT MAX(ended_at) FROM turns WHERE session_id = ?1",
            rusqlite::params![task.session_id],
            |row| row.get(0),
        )
        .ok()
        .flatten();
    ended.unwrap_or_else(now_ms).saturating_sub(started).max(0)
}

/// What the host itself can prove about a task's work: the commits on its
/// branch that its owner branch does not have, and how many files changed.
async fn changes_of(git: &GitRunner, row: &WorktreeRow) -> Option<Changes> {
    if !Path::new(&row.path).is_dir() {
        return None;
    }
    let preview = merge::preview(git, row).await.ok()?;
    Some(Changes {
        commits: preview
            .commits
            .iter()
            .take(MAX_CARD_COMMITS)
            .map(|commit| ChangeCommit {
                sha: commit.sha.chars().take(8).collect(),
                subject: commit.subject.clone(),
            })
            .collect(),
        files: preview.files.len(),
        truncated: preview.commits.len() > MAX_CARD_COMMITS,
    })
}

// ---- the task's delivery target ---------------------------------------------

pub(super) struct Target {
    pub(super) task: Task,
    pub(super) row: WorktreeRow,
    pub(super) project: PathBuf,
    pub(super) mode: DeliveryMode,
    pub(super) base_branch: String,
}

pub(super) async fn target_of(state: &SharedState, task_id: &str) -> Result<Target> {
    let (task, row) = {
        let st = state.lock().await;
        let task = tasks::get_task(&st.db, task_id)?.ok_or_else(|| anyhow!("NOT_FOUND: task"))?;
        if task.archived_at.is_some() {
            return Err(anyhow!("CONFLICT: this task is archived"));
        }
        let rows = registry::for_session(&st.db, &task.session_id)?;
        let row = rows
            .into_iter()
            .find(|row| row.delegation_id.is_none())
            .ok_or_else(|| anyhow!("CONFLICT: this task has no workspace to deliver from"))?;
        (task, row)
    };
    let project = task
        .project_path
        .clone()
        .map(PathBuf::from)
        .ok_or_else(|| anyhow!("CONFLICT: this task has no repository"))?;
    let mode = task
        .delivery_mode
        .as_deref()
        .and_then(DeliveryMode::parse)
        .unwrap_or(DeliveryMode::Local);
    Ok(Target {
        base_branch: row.owner_branch.clone(),
        task,
        row,
        project,
        mode,
    })
}

// ---- check ------------------------------------------------------------------

/// `task.delivery.check`: can this task be merged, and if not, why not.
///
/// One call answers the whole card: the verdict, the PR link, the CI summary,
/// and the host-computed part (commits, files, how long it took, what it cost).
/// The renderer asks again only when the person clicks 刷新 — never on a timer,
/// because a poll loop is a cost the person did not ask for.
pub async fn check(
    state: &SharedState,
    git: &GitRunner,
    gh: &dyn GhRunner,
    task_id: &str,
) -> Result<Value> {
    let target = target_of(state, task_id).await?;
    let (gate, pr_url) = match target.mode {
        DeliveryMode::None => (Gate::refuse("no-project", None), None),
        DeliveryMode::Pr => match read_pr(gh, &target.project, &target.row.branch).await {
            Ok(facts) => (
                gate_for(facts.as_ref()),
                facts.as_ref().and_then(|facts| facts.url.clone()),
            ),
            Err(message) => (gate_unreadable(&message), None),
        },
        DeliveryMode::Local => local_gate(state, git, &target).await,
    };
    let changes = changes_of(git, &target.row).await;
    let (elapsed_ms, usage) = {
        let st = state.lock().await;
        let elapsed = elapsed_ms_of(&st.db, &target.task);
        let usage = usage_of(&st.db, &target.task.session_id)?;
        (elapsed, usage)
    };
    Ok(json!({
        "canMerge": gate.can_merge,
        "reason": gate.reason,
        "reasonDetail": gate.reason_detail,
        "prUrl": pr_url,
        "checks": match target.mode {
            DeliveryMode::Pr => read_check_summary(gh, &target.project, &target.row.branch).await,
            _ => Value::Null,
        },
        "changes": changes,
        "elapsedMs": elapsed_ms,
        "usage": usage,
    }))
}

async fn read_check_summary(gh: &dyn GhRunner, project: &Path, branch: &str) -> Value {
    // A second read is acceptable here: it is one call per card, and its failure
    // is simply "no summary", never a different verdict.
    match read_pr(gh, project, branch).await {
        Ok(Some(facts)) => {
            let rollup = facts.status_check_rollup.unwrap_or_default();
            json!(CheckSummary::of(&rollup))
        }
        _ => Value::Null,
    }
}

async fn local_gate(
    state: &SharedState,
    git: &GitRunner,
    target: &Target,
) -> (Gate, Option<String>) {
    match lifecycle::preview_session(state, git, &target.task.session_id).await {
        Ok(preview) => {
            if preview.conflict {
                return (Gate::refuse("conflict-local", None), None);
            }
            if preview.is_empty() {
                return (Gate::refuse("nothing-to-merge", None), None);
            }
            (Gate::allow(), None)
        }
        Err(error) => (Gate::refuse("preview-failed", Some(error.message)), None),
    }
}

// ---- the delivery record ----------------------------------------------------

/// One fixed step and what happened to it.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StepState {
    pub name: String,
    /// `done` or `failed`; a step that never ran is not stored at all.
    pub status: String,
    pub at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// `tasks.delivery_json`: the whole attempt, so a retry knows where it stopped.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryState {
    pub mode: String,
    #[serde(default)]
    pub steps: Vec<StepState>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archived_at: Option<String>,
}

impl DeliveryState {
    /// Whether this attempt got as far as publishing the work.
    ///
    /// It is the one question that decides whether a retry may resume at all: a
    /// record that never reached this point describes preconditions that have to
    /// be re-checked, not work that can be skipped.
    pub(super) fn published(&self) -> bool {
        self.steps
            .iter()
            .any(|step| step.status == "done" && PUBLISH_STEPS.contains(&step.name.as_str()))
    }

    fn done(&self, step: &str) -> bool {
        self.steps
            .iter()
            .any(|entry| entry.name == step && entry.status == "done")
    }

    fn record(&mut self, name: &str, status: &str, detail: Option<String>) {
        self.steps.retain(|entry| entry.name != name);
        self.steps.push(StepState {
            name: name.to_string(),
            status: status.to_string(),
            at: ms_to_ts(now_ms()),
            detail,
        });
    }
}

/// The pull-request path, in the order the design fixes. A retry resumes at the
/// first step that is not `done`.
pub const PR_STEPS: [&str; 9] = [
    "read-pr",
    "gate",
    "head",
    "land",
    "push-main",
    "push-remotes",
    "verify-merged",
    "delete-branches",
    "cleanup",
];

/// The local path (ADR 0329): preview, merge into the project, clean up.
pub const LOCAL_STEPS: [&str; 3] = ["preview", "merge", "cleanup"];

/// The step whose success means the work left this machine (or, for `local`,
/// reached the project's own branch). Everything before it is a *precondition*,
/// and a precondition is never resumable: see [`load_state`].
pub(super) const PUBLISH_STEPS: [&str; 2] = ["push-main", "merge"];

/// Index of the publishing step in one delivery's fixed list.
pub(super) fn published_index(steps: &[&str]) -> usize {
    steps
        .iter()
        .position(|step| PUBLISH_STEPS.contains(step))
        .unwrap_or(0)
}

pub(super) async fn load_state(
    state: &SharedState,
    task_id: &str,
    mode: DeliveryMode,
) -> Result<DeliveryState> {
    let st = state.lock().await;
    let raw: Option<String> = st
        .db
        .conn()
        .query_row(
            "SELECT delivery_json FROM tasks WHERE id = ?1",
            rusqlite::params![task_id],
            |row| row.get(0),
        )
        .ok()
        .flatten();
    Ok(raw
        .as_deref()
        .and_then(|encoded| serde_json::from_str(encoded).ok())
        .filter(|stored: &DeliveryState| stored.mode == mode.as_str())
        // **Only a published attempt is resumable.** `read-pr`, `gate`, `head`
        // and `land` (and `local`'s `preview`) are preconditions, not work: the
        // pull request's head, its CI and its conflicts can all change between
        // two attempts, so a retry that skipped them could merge a commit whose
        // checks were never seen. A record that never published is therefore
        // thrown away and every precondition runs again; one that did publish
        // keeps its record so the remaining pushes are not repeated.
        .filter(|stored: &DeliveryState| stored.published())
        .unwrap_or_else(|| DeliveryState {
            mode: mode.as_str().to_string(),
            ..DeliveryState::default()
        }))
}

pub(super) async fn store_state(
    state: &SharedState,
    task_id: &str,
    record: &DeliveryState,
) -> Result<()> {
    let st = state.lock().await;
    st.db.conn().execute(
        "UPDATE tasks SET delivery_json = ?2 WHERE id = ?1",
        rusqlite::params![task_id, serde_json::to_string(record)?],
    )?;
    Ok(())
}

/// Turn a failed step into the blocked card: the task stops being "finished and
/// waiting", and the card says which step stopped and why.
pub(super) async fn stop_with_card(
    state: &SharedState,
    task_id: &str,
    step: Stop,
) -> Result<Value> {
    let task = {
        let st = state.lock().await;
        crate::task_stage::block_delivery(&st.db, task_id, step.step, &step.message)?;
        tasks::get_task(&st.db, task_id)?
    };
    Ok(json!({
        "merged": false,
        "task": task,
        "failedStep": step.step,
        "detail": step.message,
        "published": step.published,
    }))
}

#[derive(Debug)]
pub(super) struct Stop {
    step: &'static str,
    message: String,
    /// True when the work already left this machine, so the card says
    /// "already merged, X is not aligned" instead of "nothing happened".
    published: bool,
}

impl Stop {
    pub(super) fn new(step: &'static str, message: impl Into<String>, published: bool) -> Self {
        Self {
            step,
            message: message.into(),
            published,
        }
    }

    pub(super) fn of(
        step: &'static str,
        error: crate::session_worktrees::WorktreeError,
        published: bool,
    ) -> Self {
        Self::new(
            step,
            format!("{}: {}", error.code, error.message),
            published,
        )
    }
}

/// `task.delivery.merge`: accept the work and land it, by the fixed steps.
///
/// The click that reaches here **is** the confirmation, so nothing raises a
/// permission card: the host runs the same commands its own worktree code
/// already runs, with hooks disabled and no prompts. Every step is recorded
/// before the next one starts, so a failure leaves a resumable record rather
/// than an unknown position.
pub async fn merge(
    state: &SharedState,
    git: &GitRunner,
    gh: &dyn GhRunner,
    task_id: &str,
) -> Result<Value> {
    let target = target_of(state, task_id).await?;
    // Accepting is implied: the button says "accept and merge", so the task is
    // accepted whether or not the merge lands.
    {
        let st = state.lock().await;
        crate::task_stage::accept(&st.db, &json!({ "taskId": task_id }))?;
    }
    match target.mode {
        DeliveryMode::None => Ok(json!({
            "merged": false,
            "task": { "id": target.task.id },
            "failedStep": Value::Null,
            "detail": "no-project",
            "published": false,
        })),
        DeliveryMode::Pr => merge_pr(state, git, gh, &target).await,
        DeliveryMode::Local => merge_local(state, git, &target).await,
    }
}
