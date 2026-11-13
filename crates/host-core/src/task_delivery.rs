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
//!   instead of repeating a push that already landed.

use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{anyhow, Result};
use async_trait::async_trait;
use serde::Serialize;
use serde_json::{json, Value};

use crate::db::{ms_to_ts, now_ms, ts_to_ms, Database};
use crate::session_worktrees::git::GitRunner;
use crate::session_worktrees::lifecycle::{self, SharedState};
use crate::session_worktrees::merge;
use crate::session_worktrees::registry::{self, WorktreeRow};
use crate::task_workspace::{self, DeliveryMode};
use crate::tasks::{self, Task};

// ---- reading a pull request -------------------------------------------------

/// One check on a PR, as `gh` reports it.
///
/// Two shapes share the array: a GitHub **CheckRun** (`name`/`status`/
/// `conclusion`) and a legacy **StatusContext** (`context`/`state`). Both are
/// read, because a repository that still reports one status per job would
/// otherwise look like it had no CI at all.
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckRun {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub context: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub conclusion: Option<String>,
    #[serde(default)]
    pub state: Option<String>,
}

impl CheckRun {
    fn label(&self) -> String {
        self.name
            .clone()
            .or_else(|| self.context.clone())
            .unwrap_or_default()
    }

    /// `passed`, `pending`, or `failed`.
    fn outcome(&self) -> &'static str {
        if let Some(conclusion) = self.conclusion.as_deref().filter(|v| !v.is_empty()) {
            return match conclusion {
                "SUCCESS" | "NEUTRAL" | "SKIPPED" => "passed",
                _ => "failed",
            };
        }
        if let Some(state) = self.state.as_deref().filter(|v| !v.is_empty()) {
            return match state {
                "SUCCESS" => "passed",
                "PENDING" | "EXPECTED" => "pending",
                _ => "failed",
            };
        }
        // A CheckRun that has not concluded yet: `status` is QUEUED, IN_PROGRESS,
        // or COMPLETED with no conclusion (which only happens on a re-run).
        match self.status.as_deref() {
            Some("COMPLETED") => "failed",
            _ => "pending",
        }
    }
}

/// The facts the gate is decided from, as `gh pr list --json` returns them.
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrFacts {
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub mergeable: Option<String>,
    #[serde(default)]
    pub review_decision: Option<String>,
    #[serde(default)]
    pub head_ref_oid: Option<String>,
    #[serde(default)]
    pub status_check_rollup: Option<Vec<CheckRun>>,
}

/// What the card shows about CI: how many checks, and which ones failed.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckSummary {
    pub total: usize,
    pub passed: usize,
    pub pending: usize,
    pub failed: Vec<String>,
}

impl CheckSummary {
    pub fn of(checks: &[CheckRun]) -> Self {
        let mut summary = CheckSummary::default();
        for check in checks {
            summary.total += 1;
            match check.outcome() {
                "passed" => summary.passed += 1,
                "pending" => summary.pending += 1,
                _ => summary.failed.push(check.label()),
            }
        }
        summary
    }
}

/// The fields asked of `gh`. One constant, so the reader and the tests cannot
/// disagree about what was requested.
pub const PR_FIELDS: &str = "state,mergeable,statusCheckRollup,reviewDecision,headRefOid,url";

/// How the host reads a pull request.
///
/// Injectable because the gate must be provable without a network, a login, or a
/// repository: the tests drive a scripted reader, and nothing in this module
/// ever prints what it returns — the credentials are `gh`'s own.
#[async_trait]
pub trait GhRunner: Send + Sync {
    /// Run `gh` in `dir` and return stdout; a non-zero exit is an error whose
    /// message is safe to show (never a token, never the environment).
    async fn run(&self, dir: &Path, args: &[&str]) -> Result<String, String>;
}

/// The real reader: `gh` from the login PATH, non-interactive, bounded.
pub struct GhCli {
    program: PathBuf,
    path_env: Option<String>,
    timeout: Duration,
}

impl Default for GhCli {
    fn default() -> Self {
        Self {
            program: PathBuf::from("gh"),
            // The same login PATH the git runner and the Bash tool use: a GUI
            // launch has neither `/usr/local/bin` nor the user's shell paths.
            path_env: crate::tools::shell::user_login_path().map(str::to_string),
            timeout: Duration::from_secs(60),
        }
    }
}

#[async_trait]
impl GhRunner for GhCli {
    async fn run(&self, dir: &Path, args: &[&str]) -> Result<String, String> {
        let mut command = tokio::process::Command::new(&self.program);
        command.current_dir(dir).args(args);
        command
            .env("GH_PROMPT_DISABLED", "1")
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("LC_ALL", "C")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        if let Some(path) = self.path_env.as_deref() {
            command.env("PATH", path);
        }
        let output = match tokio::time::timeout(self.timeout, command.output()).await {
            Ok(Ok(output)) => output,
            Ok(Err(error)) if error.kind() == std::io::ErrorKind::NotFound => {
                return Err("gh is not installed".to_string());
            }
            Ok(Err(error)) => return Err(format!("gh could not be started: {error}")),
            Err(_) => return Err("gh did not answer in time".to_string()),
        };
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let message = stderr.trim().lines().next().unwrap_or("gh failed");
            return Err(message.to_string());
        }
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    }
}

/// Read the open PR whose head is `branch`, if there is one.
async fn read_pr(
    gh: &dyn GhRunner,
    project: &Path,
    branch: &str,
) -> std::result::Result<Option<PrFacts>, String> {
    let output = gh
        .run(
            project,
            &[
                "pr", "list", "--head", branch, "--state", "open", "--json", PR_FIELDS, "--limit",
                "1",
            ],
        )
        .await?;
    let parsed: Vec<PrFacts> = serde_json::from_str(&output)
        .map_err(|error| format!("gh returned an unreadable answer: {error}"))?;
    Ok(parsed.into_iter().next())
}

/// The state `gh` reports for the branch's PR, whatever it is (`OPEN`,
/// `MERGED`, `CLOSED`), or `None` when there is no PR at all.
async fn read_pr_state(
    gh: &dyn GhRunner,
    project: &Path,
    branch: &str,
) -> std::result::Result<Option<String>, String> {
    let output = gh
        .run(
            project,
            &[
                "pr", "list", "--head", branch, "--state", "all", "--json", "state", "--limit", "1",
            ],
        )
        .await?;
    let parsed: Vec<Value> = serde_json::from_str(&output)
        .map_err(|error| format!("gh returned an unreadable answer: {error}"))?;
    Ok(parsed
        .first()
        .and_then(|entry| entry.get("state"))
        .and_then(Value::as_str)
        .map(str::to_owned))
}

// ---- the gate ---------------------------------------------------------------

/// The gate's verdict. `reason` is a stable code the renderer translates; the
/// detail is the one name a person needs (which check failed, which remote).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Gate {
    pub can_merge: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason_detail: Option<String>,
}

impl Gate {
    fn refuse(reason: &str, detail: Option<String>) -> Self {
        Gate {
            can_merge: false,
            reason: Some(reason.to_string()),
            reason_detail: detail,
        }
    }

    fn allow() -> Self {
        Gate {
            can_merge: true,
            reason: None,
            reason_detail: None,
        }
    }
}

/// **The table.** Every row of the design, in one pure function, in the order
/// the person reads them: is there a PR, did CI run, did it pass, will it merge,
/// was it reviewed.
///
/// A fact that could not be read is not a row here: it arrives as `Err` from
/// `read_pr` and is refused by [`gate_unreadable`], because "nobody could tell"
/// and "everything is fine" must never render the same button.
pub fn gate_for(facts: Option<&PrFacts>) -> Gate {
    let Some(facts) = facts else {
        return Gate::refuse("pr-missing", None);
    };
    let rollup = facts.status_check_rollup.as_deref().unwrap_or_default();
    if rollup.is_empty() {
        return Gate::refuse("ci-missing", None);
    }
    let checks = CheckSummary::of(rollup);
    if !checks.failed.is_empty() {
        return Gate::refuse("ci-failed", Some(checks.failed.join(", ")));
    }
    if checks.pending > 0 {
        return Gate::refuse("ci-running", Some(checks.pending.to_string()));
    }
    match facts.mergeable.as_deref().unwrap_or("") {
        "CONFLICTING" => return Gate::refuse("conflict", None),
        "UNKNOWN" => return Gate::refuse("mergeable-unknown", None),
        _ => {}
    }
    match facts.review_decision.as_deref().unwrap_or("") {
        "REVIEW_REQUIRED" => return Gate::refuse("review-required", None),
        "CHANGES_REQUESTED" => return Gate::refuse("review-required", None),
        // Empty and APPROVED both mean "nothing is blocking the merge here".
        _ => {}
    }
    Gate::allow()
}

pub fn gate_unreadable(message: &str) -> Gate {
    Gate::refuse("pr-unreadable", Some(message.to_string()))
}

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

struct Target {
    task: Task,
    row: WorktreeRow,
    project: PathBuf,
    mode: DeliveryMode,
    base_branch: String,
}

async fn target_of(state: &SharedState, task_id: &str) -> Result<Target> {
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

/// Steps that run **before** anything left this machine: a failure there never
/// says "already merged somewhere".
fn published_index(steps: &[&str]) -> usize {
    steps
        .iter()
        .position(|step| *step == "push-main" || *step == "merge")
        .unwrap_or(0)
}

async fn load_state(
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
        .unwrap_or_else(|| DeliveryState {
            mode: mode.as_str().to_string(),
            ..DeliveryState::default()
        }))
}

async fn store_state(state: &SharedState, task_id: &str, record: &DeliveryState) -> Result<()> {
    let st = state.lock().await;
    st.db.conn().execute(
        "UPDATE tasks SET delivery_json = ?2 WHERE id = ?1",
        rusqlite::params![task_id, serde_json::to_string(record)?],
    )?;
    Ok(())
}

/// Turn a failed step into the blocked card: the task stops being "finished and
/// waiting", and the card says which step stopped and why.
async fn stop_with_card(state: &SharedState, task_id: &str, step: Stop) -> Result<Value> {
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

struct Stop {
    step: &'static str,
    message: String,
    /// True when the work already left this machine, so the card says
    /// "already merged, X is not aligned" instead of "nothing happened".
    published: bool,
}

impl Stop {
    fn new(step: &'static str, message: impl Into<String>, published: bool) -> Self {
        Self {
            step,
            message: message.into(),
            published,
        }
    }

    fn of(
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

async fn merge_pr(
    state: &SharedState,
    git: &GitRunner,
    gh: &dyn GhRunner,
    target: &Target,
) -> Result<Value> {
    let task_id = target.task.id.clone();
    let mut record = load_state(state, &task_id, DeliveryMode::Pr).await?;
    let steps = &PR_STEPS;
    let cut = published_index(steps);

    // Every step is a closure over the facts it needs; the loop below is the
    // one place the order and the bookkeeping live, so no step can be skipped
    // and none can run twice.
    let mut facts: Option<PrFacts> = None;
    let mut pushed_to: Option<String> = None;

    for (index, name) in steps.iter().enumerate() {
        let name: &'static str = name;
        if record.done(name) {
            // A step that already ran still has to leave behind the facts the
            // remaining steps need on a retry.
            if name == "read-pr" || name == "gate" {
                if let Ok(Some(read)) = read_pr(gh, &target.project, &target.row.branch).await {
                    facts = Some(read);
                }
            }
            if name == "push-main" {
                pushed_to = Some(primary_remote(git, &target.project).await);
            }
            continue;
        }
        let published = index > cut;
        let outcome: std::result::Result<Option<String>, Stop> = match name {
            "read-pr" => match read_pr(gh, &target.project, &target.row.branch).await {
                Ok(read) => {
                    let detail = read
                        .as_ref()
                        .and_then(|facts| facts.url.clone())
                        .unwrap_or_default();
                    facts = read;
                    Ok(Some(detail))
                }
                Err(message) => Err(Stop::new(name, message, published)),
            },
            "gate" => match facts.as_ref().map(|found| gate_for(Some(found))) {
                Some(gate) if gate.can_merge => Ok(None),
                Some(gate) => {
                    let mut message = gate.reason.unwrap_or_else(|| "refused".to_string());
                    if let Some(detail) = gate.reason_detail {
                        message.push_str(&format!(": {detail}"));
                    }
                    Err(Stop::new(name, message, published))
                }
                None => Err(Stop::new(name, "pr-missing", published)),
            },
            "head" => head_step(git, target, facts.as_ref()).await.map(|_| None),
            "land" => land_step(git, target).await.map(|_| None),
            "push-main" => {
                let remotes = remotes_of(git, &target.project).await;
                let primary = primary_remote_of(&remotes);
                match push_main(git, target, primary.as_str()).await {
                    Ok(()) => {
                        pushed_to = Some(primary.clone());
                        Ok(Some(primary))
                    }
                    Err(stop) => Err(stop),
                }
            }
            "push-remotes" => {
                let remotes = remotes_of(git, &target.project).await;
                let primary = pushed_to
                    .clone()
                    .unwrap_or_else(|| primary_remote_of(&remotes));
                push_remotes(git, target, primary.as_str(), &remotes)
                    .await
                    .map(|_| None)
            }
            "verify-merged" => verify_merged(gh, git, target, facts.as_ref())
                .await
                .map(Some),
            "delete-branches" => {
                let remotes = remotes_of(git, &target.project).await;
                delete_remote_branches(git, target, &remotes)
                    .await
                    .map(|_| None)
            }
            "cleanup" => cleanup_step(state, git, target).await.map(|_| None),
            other => Err(Stop::new(
                "cleanup",
                format!("unknown step {other}"),
                published,
            )),
        };
        match outcome {
            Ok(detail) => {
                record.record(name, "done", detail.filter(|text| !text.is_empty()));
                store_state(state, &task_id, &record).await?;
            }
            Err(stop) => {
                record.record(name, "failed", Some(stop.message.clone()));
                store_state(state, &task_id, &record).await?;
                return stop_with_card(state, &task_id, stop).await;
            }
        }
    }
    record.finished_at = Some(ms_to_ts(now_ms()));
    store_state(state, &task_id, &record).await?;
    let task = {
        let st = state.lock().await;
        tasks::get_task(&st.db, &task_id)?
    };
    Ok(json!({
        "merged": true,
        "task": task,
        "failedStep": Value::Null,
        "detail": Value::Null,
        "published": true,
    }))
}

async fn merge_local(state: &SharedState, git: &GitRunner, target: &Target) -> Result<Value> {
    let task_id = target.task.id.clone();
    let mut record = load_state(state, &task_id, DeliveryMode::Local).await?;
    let steps = &LOCAL_STEPS;
    let cut = published_index(steps);
    for (index, name) in steps.iter().enumerate() {
        if record.done(name) {
            continue;
        }
        let published = index > cut;
        let outcome: std::result::Result<Option<String>, Stop> = match *name {
            "preview" => {
                match lifecycle::preview_session(state, git, &target.task.session_id).await {
                    Ok(preview) if preview.conflict => {
                        Err(Stop::new(name, "conflict-local", published))
                    }
                    Ok(preview) if preview.is_empty() => {
                        Err(Stop::new(name, "nothing-to-merge", published))
                    }
                    Ok(preview) => Ok(Some(format!("{} commit(s)", preview.commits.len()))),
                    Err(error) => Err(Stop::of(name, error, published)),
                }
            }
            "merge" => {
                let preview = lifecycle::preview_session(state, git, &target.task.session_id)
                    .await
                    .map_err(|error| Stop::of(name, error, published));
                match preview {
                    Err(stop) => Err(stop),
                    Ok(preview) => {
                        match lifecycle::merge_session(
                            state,
                            git,
                            &target.task.session_id,
                            &preview.preview_token,
                        )
                        .await
                        {
                            Ok(merge::MergeOutcome::Merged { commits, files }) => {
                                Ok(Some(format!("{commits} commit(s), {files} file(s)")))
                            }
                            Ok(merge::MergeOutcome::NothingToMerge) => {
                                Err(Stop::new(name, "nothing-to-merge", published))
                            }
                            Err(error) => Err(Stop::of(name, error, published)),
                        }
                    }
                }
            }
            "cleanup" => cleanup_step(state, git, target).await.map(|_| None),
            other => Err(Stop::new(
                "cleanup",
                format!("unknown step {other}"),
                published,
            )),
        };
        match outcome {
            Ok(detail) => {
                record.record(name, "done", detail.filter(|text| !text.is_empty()));
                store_state(state, &task_id, &record).await?;
            }
            Err(stop) => {
                record.record(name, "failed", Some(stop.message.clone()));
                store_state(state, &task_id, &record).await?;
                return stop_with_card(state, &task_id, stop).await;
            }
        }
    }
    record.finished_at = Some(ms_to_ts(now_ms()));
    store_state(state, &task_id, &record).await?;
    let task = {
        let st = state.lock().await;
        tasks::get_task(&st.db, &task_id)?
    };
    Ok(json!({
        "merged": true,
        "task": task,
        "failedStep": Value::Null,
        "detail": Value::Null,
        "published": true,
    }))
}

// ---- the steps --------------------------------------------------------------

/// The preconditions of a *fast-forward* merge, all of them checked before
/// anything is written: the worktree is clean and on its own branch, its HEAD is
/// exactly the commit the PR published, and the project's checkout is on `main`
/// with nothing uncommitted.
async fn head_step(
    git: &GitRunner,
    target: &Target,
    facts: Option<&PrFacts>,
) -> std::result::Result<(), Stop> {
    let worktree = Path::new(&target.row.path);
    let status = merge::worktree_status(git, worktree)
        .await
        .map_err(|error| Stop::of("head", error, false))?;
    if !status.trim().is_empty() {
        return Err(Stop::new(
            "head",
            "the task's workspace has uncommitted changes; commit or discard them first",
            false,
        ));
    }
    let head = git
        .run(worktree, &["rev-parse", "--verify", "HEAD"])
        .await
        .map_err(|error| Stop::new("head", error.to_string(), false))?;
    if let Some(expected) = facts.and_then(|facts| facts.head_ref_oid.clone()) {
        if !expected.is_empty() && expected != head.trim() {
            return Err(Stop::new(
                "head",
                "you have local commits that are not on the pull request yet; push them first",
                false,
            ));
        }
    }
    // Checked out where the merge expects it: the project is the checkout that
    // gets fast-forwarded, and `land` refuses a switched branch anyway — this
    // says why before anything runs.
    let checked_out = git
        .output(&target.project, &["symbolic-ref", "--quiet", "HEAD"])
        .await
        .map_err(|error| Stop::new("head", error.to_string(), false))?;
    if checked_out.stdout.trim() != merge::head_ref(&target.base_branch) {
        return Err(Stop::new(
            "head",
            format!(
                "the project is not on `{}`; check it out to merge",
                target.base_branch
            ),
            false,
        ));
    }
    let dirty = git
        .run(
            &target.project,
            &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
        )
        .await
        .map_err(|error| Stop::new("head", error.to_string(), false))?;
    if !dirty.trim().is_empty() {
        return Err(Stop::new(
            "head",
            "the project has uncommitted changes; commit or stash them first",
            false,
        ));
    }
    // The merge must be a pure fast-forward, which is only true when the task
    // branch already contains every commit of the base branch. Anything else
    // would put a merge commit on `main`, and the design says it does not.
    let contained = git
        .output(
            &target.project,
            &[
                "merge-base",
                "--is-ancestor",
                &merge::head_ref(&target.base_branch),
                &merge::head_ref(&target.row.branch),
            ],
        )
        .await
        .map_err(|error| Stop::new("head", error.to_string(), false))?;
    if !contained.success() {
        return Err(Stop::new(
            "head",
            format!(
                "`{}` has moved ahead; bring the latest `{}` into the task first",
                target.base_branch, target.base_branch
            ),
            false,
        ));
    }
    Ok(())
}

/// Fast-forward the project's `main` to the task branch, with no merge commit.
async fn land_step(git: &GitRunner, target: &Target) -> std::result::Result<(), Stop> {
    // Fetch first: a `main` that is behind its remote would be fast-forwarded to
    // a commit the remote does not have, and the push would be refused after the
    // local branch had already moved.
    let remotes = remotes_of(git, &target.project).await;
    let primary = primary_remote_of(&remotes);
    let fetched = git
        .output(&target.project, &["fetch", "--quiet", primary.as_str()])
        .await;
    if let Ok(output) = fetched {
        if output.success() {
            let tracking = format!("refs/remotes/{primary}/{}", target.base_branch);
            let behind = git
                .output(
                    &target.project,
                    &[
                        "merge-base",
                        "--is-ancestor",
                        &tracking,
                        &merge::head_ref(&target.base_branch),
                    ],
                )
                .await;
            if matches!(behind, Ok(output) if !output.success()) {
                return Err(Stop::new(
                    "land",
                    format!(
                        "local `{}` is behind `{primary}/{}`; pull it first",
                        target.base_branch, target.base_branch
                    ),
                    false,
                ));
            }
        }
    }
    merge::land(
        git,
        &target.row,
        &target.project,
        &merge::commit_message(&target.task.title),
    )
    .await
    .map_err(|error| Stop::of("land", error, false))?;
    Ok(())
}

async fn push_main(
    git: &GitRunner,
    target: &Target,
    remote: &str,
) -> std::result::Result<(), Stop> {
    let output = git
        .output(&target.project, &["push", remote, &target.base_branch])
        .await
        .map_err(|error| Stop::new("push-main", error.to_string(), false))?;
    if !output.success() {
        return Err(Stop::new(
            "push-main",
            format!("push to {remote} was refused: {}", output.stderr.trim()),
            false,
        ));
    }
    Ok(())
}

async fn push_remotes(
    git: &GitRunner,
    target: &Target,
    primary: &str,
    remotes: &[(String, String)],
) -> std::result::Result<(), Stop> {
    for (name, _) in remotes {
        if name == primary {
            continue;
        }
        let output = git
            .output(&target.project, &["push", name, &target.base_branch])
            .await
            .map_err(|error| Stop::new("push-remotes", error.to_string(), true))?;
        if !output.success() {
            return Err(Stop::new(
                "push-remotes",
                format!("{name}: {}", output.stderr.trim()),
                true,
            ));
        }
    }
    Ok(())
}

/// The PR must be merged, and the proof is the remote's own branch rather than
/// GitHub's bookkeeping: a push of the same commit is what makes it merged, and
/// GitHub can take a moment to say so.
async fn verify_merged(
    gh: &dyn GhRunner,
    git: &GitRunner,
    target: &Target,
    facts: Option<&PrFacts>,
) -> std::result::Result<String, Stop> {
    let state = read_pr_state(gh, &target.project, &target.row.branch)
        .await
        .map_err(|message| Stop::new("verify-merged", message, true))?;
    if state.as_deref() == Some("MERGED") {
        return Ok("MERGED".to_string());
    }
    let head = facts
        .and_then(|facts| facts.head_ref_oid.clone())
        .filter(|sha| !sha.is_empty())
        .ok_or_else(|| Stop::new("verify-merged", "the pull request has no head commit", true))?;
    let remotes = remotes_of(git, &target.project).await;
    let primary = primary_remote_blocking(git, &target.project, &remotes);
    let _ = git
        .output(&target.project, &["fetch", "--quiet", &primary])
        .await;
    let contained = git
        .output(
            &target.project,
            &[
                "merge-base",
                "--is-ancestor",
                &head,
                &format!("refs/remotes/{primary}/{}", target.base_branch),
            ],
        )
        .await;
    match contained {
        Ok(output) if output.success() => Ok(format!(
            "head is in {primary}/{} (gh says {})",
            target.base_branch,
            state.unwrap_or_else(|| "nothing".to_string())
        )),
        _ => Err(Stop::new(
            "verify-merged",
            format!(
                "GitHub does not report this pull request as merged (state: {})",
                state.unwrap_or_else(|| "none".to_string())
            ),
            true,
        )),
    }
}

/// Delete the task's branch on every remote that has it. A branch that is
/// already gone is the answer, not a failure: a retry must not stop on a step
/// that finished its work last time.
async fn delete_remote_branches(
    git: &GitRunner,
    target: &Target,
    remotes: &[(String, String)],
) -> std::result::Result<(), Stop> {
    for (name, _) in remotes {
        let heads = git
            .output(
                &target.project,
                &["ls-remote", "--heads", name, &target.row.branch],
            )
            .await
            .map_err(|error| Stop::new("delete-branches", error.to_string(), true))?;
        if !heads.success() || heads.stdout.trim().is_empty() {
            continue;
        }
        let output = git
            .output(
                &target.project,
                &["push", name, "--delete", &target.row.branch],
            )
            .await
            .map_err(|error| Stop::new("delete-branches", error.to_string(), true))?;
        if !output.success() {
            return Err(Stop::new(
                "delete-branches",
                format!("{name}: {}", output.stderr.trim()),
                true,
            ));
        }
    }
    Ok(())
}

/// Remove the workspace, the local branch, and the task row's place in the open
/// list. The task is archived last: its record is what a person would read if
/// the removal had gone wrong.
async fn cleanup_step(
    state: &SharedState,
    git: &GitRunner,
    target: &Target,
) -> std::result::Result<(), Stop> {
    task_workspace::cleanup_for_archive(state, git, &target.task.id, false)
        .await
        .map_err(|error| Stop::of("cleanup", error, true))?;
    // `-d`, never `-D`: a branch whose work is not on `main` is exactly the case
    // that must not be deleted, and git already knows how to say so.
    let output = git
        .output(&target.project, &["branch", "-d", &target.row.branch])
        .await
        .map_err(|error| Stop::new("cleanup", error.to_string(), true))?;
    if !output.success() {
        let message = output.stderr.trim();
        // A branch that is already gone is finished work, not a failure.
        if !message.contains("not found") && !message.contains("no such branch") {
            return Err(Stop::new("cleanup", message.to_string(), true));
        }
    }
    let st = state.lock().await;
    tasks::archive(&st.db, &json!({ "taskId": target.task.id }))
        .map_err(|error| Stop::new("cleanup", error.to_string(), true))?;
    Ok(())
}

// ---- git helpers ------------------------------------------------------------

async fn remotes_of(git: &GitRunner, project: &Path) -> Vec<(String, String)> {
    let Ok(output) = git.output(project, &["remote", "-v"]).await else {
        return Vec::new();
    };
    let mut remotes: Vec<(String, String)> = Vec::new();
    for line in output.stdout.lines() {
        let mut fields = line.split_whitespace();
        let (Some(name), Some(url)) = (fields.next(), fields.next()) else {
            continue;
        };
        if remotes.iter().any(|(known, _)| known == name) {
            continue;
        }
        remotes.push((name.to_string(), url.to_string()));
    }
    remotes
}

fn primary_remote_of(remotes: &[(String, String)]) -> String {
    remotes
        .iter()
        .find(|(_, url)| {
            task_workspace::normalize_repo_origin(url)
                .is_some_and(|origin| origin.starts_with("github.com/"))
        })
        .or_else(|| remotes.iter().find(|(name, _)| name == "origin"))
        .or_else(|| remotes.first())
        .map(|(name, _)| name.clone())
        .unwrap_or_else(|| "origin".to_string())
}

fn primary_remote_blocking(
    _git: &GitRunner,
    _project: &Path,
    remotes: &[(String, String)],
) -> String {
    primary_remote_of(remotes)
}

async fn primary_remote(git: &GitRunner, project: &Path) -> String {
    primary_remote_of(&remotes_of(git, project).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn check_run(name: &str, status: Option<&str>, conclusion: Option<&str>) -> CheckRun {
        CheckRun {
            name: Some(name.to_string()),
            status: status.map(str::to_owned),
            conclusion: conclusion.map(str::to_owned),
            ..CheckRun::default()
        }
    }

    fn facts(mergeable: &str, review: &str, checks: Vec<CheckRun>) -> PrFacts {
        PrFacts {
            url: Some("https://github.com/o/r/pull/7".to_string()),
            mergeable: Some(mergeable.to_string()),
            review_decision: Some(review.to_string()),
            head_ref_oid: Some("abc123".to_string()),
            status_check_rollup: Some(checks),
        }
    }

    fn green() -> Vec<CheckRun> {
        vec![
            check_run("build", Some("COMPLETED"), Some("SUCCESS")),
            check_run("test", Some("COMPLETED"), Some("SUCCESS")),
        ]
    }

    /// The table, one test per row of the design: every reason the button is
    /// grey has its own case, so a rule cannot be dropped silently.
    #[test]
    fn every_gate_row_refuses_with_its_own_reason() {
        // No PR at all.
        assert_eq!(gate_for(None).reason.as_deref(), Some("pr-missing"));

        // No CI result yet (an empty rollup, and a null one).
        assert_eq!(
            gate_for(Some(&facts("MERGEABLE", "", vec![])))
                .reason
                .as_deref(),
            Some("ci-missing")
        );
        let mut no_rollup = facts("MERGEABLE", "", vec![]);
        no_rollup.status_check_rollup = None;
        assert_eq!(
            gate_for(Some(&no_rollup)).reason.as_deref(),
            Some("ci-missing")
        );

        // A check still running.
        let running = facts(
            "MERGEABLE",
            "",
            vec![
                check_run("build", Some("COMPLETED"), Some("SUCCESS")),
                check_run("e2e", Some("IN_PROGRESS"), None),
            ],
        );
        let gate = gate_for(Some(&running));
        assert_eq!(gate.reason.as_deref(), Some("ci-running"));
        assert!(!gate.can_merge);

        // A failed check names itself.
        let failed = facts(
            "MERGEABLE",
            "",
            vec![
                check_run("build", Some("COMPLETED"), Some("SUCCESS")),
                check_run("e2e", Some("COMPLETED"), Some("FAILURE")),
            ],
        );
        let gate = gate_for(Some(&failed));
        assert_eq!(gate.reason.as_deref(), Some("ci-failed"));
        assert_eq!(gate.reason_detail.as_deref(), Some("e2e"));

        // A legacy commit status is read the same way.
        let legacy = facts(
            "MERGEABLE",
            "",
            vec![CheckRun {
                context: Some("ci/legacy".to_string()),
                state: Some("FAILURE".to_string()),
                ..CheckRun::default()
            }],
        );
        assert_eq!(
            gate_for(Some(&legacy)).reason_detail.as_deref(),
            Some("ci/legacy")
        );

        // A conflict, and GitHub still computing.
        assert_eq!(
            gate_for(Some(&facts("CONFLICTING", "", green())))
                .reason
                .as_deref(),
            Some("conflict")
        );
        assert_eq!(
            gate_for(Some(&facts("UNKNOWN", "", green())))
                .reason
                .as_deref(),
            Some("mergeable-unknown")
        );

        // Review required, and changes requested.
        assert_eq!(
            gate_for(Some(&facts("MERGEABLE", "REVIEW_REQUIRED", green())))
                .reason
                .as_deref(),
            Some("review-required")
        );
        assert_eq!(
            gate_for(Some(&facts("MERGEABLE", "CHANGES_REQUESTED", green())))
                .reason
                .as_deref(),
            Some("review-required")
        );
    }

    /// The two answers that are *not* refusals: an empty review decision and an
    /// approved one both mean "nothing is blocking the merge here".
    #[test]
    fn an_absent_or_approved_review_passes_the_gate() {
        for review in ["", "APPROVED"] {
            let gate = gate_for(Some(&facts("MERGEABLE", review, green())));
            assert!(gate.can_merge, "review `{review}` must not refuse");
            assert_eq!(gate.reason, None);
        }
    }

    /// A read that failed is a refusal with the reason, never a pass: this is
    /// the row that would otherwise show a green button over an unknown state.
    #[test]
    fn a_read_that_failed_refuses_with_its_reason() {
        let gate = gate_unreadable("gh is not installed");
        assert!(!gate.can_merge);
        assert_eq!(gate.reason.as_deref(), Some("pr-unreadable"));
        assert_eq!(gate.reason_detail.as_deref(), Some("gh is not installed"));
    }

    #[test]
    fn a_check_summary_counts_each_outcome_once() {
        let summary = CheckSummary::of(&[
            check_run("a", Some("COMPLETED"), Some("SUCCESS")),
            check_run("b", Some("QUEUED"), None),
            check_run("c", Some("COMPLETED"), Some("FAILURE")),
            CheckRun {
                context: Some("d".to_string()),
                state: Some("SUCCESS".to_string()),
                ..CheckRun::default()
            },
        ]);
        assert_eq!(summary.total, 4);
        assert_eq!(summary.passed, 2);
        assert_eq!(summary.pending, 1);
        assert_eq!(summary.failed, vec!["c".to_string()]);
    }
}
