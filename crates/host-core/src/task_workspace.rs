//! A task's own workspace: preparing it before the work starts, deciding how
//! the work will be delivered, and cleaning it up when the task is archived
//! (employee mode 0.5 slice 2; ADR 0329 and its 2026-11 amendment).
//!
//! A task is the unit a person hands to an employee, so it reuses the isolation
//! ADR 0329 already builds — the same creation, branch namespace,
//! `.worktreeinclude` copy, setup command, link-safe removal, and behind / sync
//! / merge surface. Three things differ, and only three:
//!
//! - **Placement.** The folder is `<top level>/.worktree/<short id>-<slug>`, so
//!   the person finds the task next to the project they asked about.
//! - **Start point.** The branch starts from the project's remote branch when a
//!   fetch succeeds, and the task records which commit it really used.
//! - **Preparation is a state.** A task is not `working` until its workspace is
//!   `ready`; a failure is recorded on the task and can be retried, instead of a
//!   turn starting in a half-built folder.
//!
//! The workspace itself is still a `worktrees` row: `tool_root`, the merge and
//! sync paths, the "behind" count, and the delete/cleanup paths all read it
//! from there and need no task-specific copy.

use std::path::Path;

use anyhow::Result;
use rusqlite::params;
use serde::Serialize;

use crate::db::Database;
use crate::session_worktrees::git::GitRunner;
use crate::session_worktrees::lifecycle::{self, Placement, SharedState};
use crate::session_worktrees::merge;
use crate::session_worktrees::registry::{self, SetupStatus, WorktreeRow};
use crate::session_worktrees::{remove::is_real_dir, WorktreeError};
use crate::tasks;

/// The refusal `task.archive` returns when the workspace still holds work.
pub const WORKSPACE_UNSAVED: &str = "WORKSPACE_HAS_UNSAVED_WORK";
/// The refusal when the workspace could not be inspected at all.
///
/// "Nothing is left" and "nobody could tell" are different answers, and only one
/// of them may remove a folder. A git failure while counting commits — the
/// project's branch was renamed, the repository is damaged, the command timed
/// out — must not read as zero.
pub const WORKSPACE_UNSAVED_UNKNOWN: &str = "WORKSPACE_UNSAVED_UNKNOWN";
/// How much of a failed setup command's output is kept on the task.
const ERROR_LIMIT: usize = 1_200;
/// A folder name stays short enough to read in a path.
const SLUG_LIMIT: usize = 40;

/// Where a task is in preparing the folder it works in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WorkspaceStatus {
    /// The task has no repository, so it works in the session's own folder.
    None,
    Preparing,
    Ready,
    Failed,
}

impl WorkspaceStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            WorkspaceStatus::None => "none",
            WorkspaceStatus::Preparing => "preparing",
            WorkspaceStatus::Ready => "ready",
            WorkspaceStatus::Failed => "failed",
        }
    }
}

/// How a task's work will reach the project. This slice decides and records it;
/// slice 4 acts on it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DeliveryMode {
    /// The project has a GitHub remote, so the work becomes a pull request.
    Pr,
    /// No GitHub remote: the work merges back into the local project (ADR 0329).
    Local,
    /// The task has no repository.
    None,
}

impl DeliveryMode {
    pub fn as_str(self) -> &'static str {
        match self {
            DeliveryMode::Pr => "pr",
            DeliveryMode::Local => "local",
            DeliveryMode::None => "none",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "pr" => Some(DeliveryMode::Pr),
            "local" => Some(DeliveryMode::Local),
            "none" => Some(DeliveryMode::None),
            _ => None,
        }
    }
}

// ---- names -----------------------------------------------------------------

/// `<short id>-<slug of the title>`, or `<short id>-task` when the title has no
/// ASCII letters (a Chinese title, for example) — a worktree folder a person can
/// still recognize in a path.
pub fn workspace_name(short_id: &str, title: &str) -> String {
    let slug = slugify(title);
    if slug.is_empty() {
        format!("{short_id}-task")
    } else {
        format!("{short_id}-{slug}")
    }
}

/// `[a-z0-9-]` only, dashes collapsed, trailing dash trimmed, 40 characters.
pub fn slugify(title: &str) -> String {
    let mut out = String::new();
    let mut pending_dash = false;
    for character in title.chars() {
        let character = character.to_ascii_lowercase();
        if character.is_ascii_alphanumeric() {
            if pending_dash && !out.is_empty() {
                out.push('-');
            }
            pending_dash = false;
            out.push(character);
        } else {
            pending_dash = true;
        }
        if out.chars().count() >= SLUG_LIMIT {
            break;
        }
    }
    out.truncate(SLUG_LIMIT);
    out
}

// ---- delivery mode and repository identity ---------------------------------

/// `normalizeRepoOrigin` (`packages/shared/src/bot-session.ts`) in Rust: a git
/// remote URL reduced to `host/owner/name`, with only the host lower-cased.
///
/// Only the host is case-insensitive: two repositories whose owners differ only
/// in case are still two repositories.
pub fn normalize_repo_origin(value: &str) -> Option<String> {
    let mut text = value.trim().to_string();
    if text.is_empty() {
        return None;
    }
    if let Some(index) = text.find("://") {
        text = text[index + 3..].to_string();
    }
    if let Some(index) = text.find('@') {
        if !text[..index].contains('/') {
            text = text[index + 1..].to_string();
        }
    }
    // The scp form (`git@host:owner/name`) uses `:` where a URL uses `/`.
    if let Some(index) = text.find(':') {
        text = format!("{}/{}", &text[..index], &text[index + 1..]);
    }
    let text = text.trim_matches('/');
    let text = if text.to_ascii_lowercase().ends_with(".git") {
        &text[..text.len() - 4]
    } else {
        text
    };
    let segments: Vec<&str> = text.split('/').collect();
    if segments.len() < 3 {
        return None;
    }
    let host = segments[0].to_ascii_lowercase();
    let owner = segments[1];
    let repo = segments[2..].join("/");
    if host.is_empty() || owner.is_empty() || repo.is_empty() {
        return None;
    }
    let normalized = format!("{host}/{owner}/{repo}");
    if normalized.chars().count() > 512 {
        return None;
    }
    Some(normalized)
}

/// `pr` when the project has a GitHub remote, `local` when it has another (or
/// none), `none` when the task has no project.
pub async fn delivery_mode(git: &GitRunner, project: Option<&str>) -> DeliveryMode {
    let Some(project) = project.filter(|path| !path.trim().is_empty()) else {
        return DeliveryMode::None;
    };
    let Ok(output) = git.output(Path::new(project), &["remote", "-v"]).await else {
        return DeliveryMode::Local;
    };
    if !output.success() {
        return DeliveryMode::Local;
    }
    for line in output.stdout.lines() {
        let Some(url) = line.split_whitespace().nth(1) else {
            continue;
        };
        if let Some(origin) = normalize_repo_origin(url) {
            if origin.starts_with("github.com/") {
                return DeliveryMode::Pr;
            }
        }
    }
    DeliveryMode::Local
}

/// Every local project path, newest first. Read under the state lock, so a
/// caller can run the git lookups below without holding it.
pub fn project_paths(db: &Database) -> Result<Vec<String>> {
    let mut statement = db
        .conn()
        .prepare_cached("SELECT path FROM projects ORDER BY last_opened_at DESC")?;
    let paths = statement
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(paths)
}

/// The local project whose git remote matches a card's normalized origin.
///
/// A card names a repository (`minih-git/minih-agent-desktop`), not a folder on
/// this disk. It is on this machine only when some registered project actually
/// points at it, which is what this reads — the projects' own `git remote -v`,
/// compared the same way the mandate normalizes the origin it was given.
pub async fn project_for_origin(git: &GitRunner, paths: &[String], origin: &str) -> Option<String> {
    let wanted = normalize_repo_origin(origin)?;
    for path in paths {
        // A remote-host project names a workspace on another machine; it cannot
        // be this computer's checkout.
        if path.starts_with(crate::db::REMOTE_PROJECT_PREFIX) || !Path::new(path).is_dir() {
            continue;
        }
        let Ok(output) = git.output(Path::new(path), &["remote", "-v"]).await else {
            continue;
        };
        if !output.success() {
            continue;
        }
        let matches = output.stdout.lines().any(|line| {
            line.split_whitespace()
                .nth(1)
                .and_then(normalize_repo_origin)
                .as_deref()
                == Some(wanted.as_str())
        });
        if matches {
            return Some(path.clone());
        }
    }
    None
}

// ---- preparation -----------------------------------------------------------

/// Prepare the task's workspace. Called after the task row exists and before the
/// first message of its session is sent, so a task never opens a turn in a
/// folder that is still being built.
///
/// Every outcome is written on the task, including a failure: the person sees
/// why it stopped and can retry, and nothing has to be guessed from a log.
pub async fn prepare(
    state: &SharedState,
    git: &GitRunner,
    task_id: &str,
) -> Result<(), WorktreeError> {
    let task = {
        let st = state.lock().await;
        tasks::get_task(&st.db, task_id)?
            .ok_or_else(|| WorktreeError::new("TASK_NOT_FOUND", "the task no longer exists"))?
    };
    let Some(project) = task
        .project_path
        .clone()
        .filter(|path| !path.trim().is_empty())
    else {
        set_workspace(state, task_id, WorkspaceStatus::None, None).await?;
        set_delivery_mode(state, task_id, DeliveryMode::None).await?;
        return Ok(());
    };

    set_workspace(state, task_id, WorkspaceStatus::Preparing, None).await?;
    let mode = delivery_mode(git, Some(&project)).await;
    set_delivery_mode(state, task_id, mode).await?;

    // A step whose predecessor was abandoned has nothing to continue from, and
    // this is not the place to decide otherwise: the blocked card offers
    // 「改从 main 开工」, and that click clears the edge before coming back here.
    if task.relay_state.as_deref() == Some("orphaned") {
        set_workspace(state, task_id, WorkspaceStatus::None, None).await?;
        return Ok(());
    }

    let existing = {
        let st = state.lock().await;
        registry::for_owner(&st.db, &task.session_id, None)?
    };
    if let Some(row) = existing {
        if is_real_dir(Path::new(&row.path)) {
            return retry_setup(state, git, task_id, &row, &project).await;
        }
        // The folder was deleted outside the app: drop the registry row so the
        // retry rebuilds it instead of refusing with "already exists".
        if let Err(error) = lifecycle::remove_session_worktrees(state, git, &task.session_id).await
        {
            tracing::warn!(%error, task = task_id, "could not drop a vanished task workspace");
        }
    }

    let name = workspace_name(&task.short_id, &task.title);
    // A relay step starts from the end of the step before it (employee mode 0.5
    // slice 7). A predecessor that has no branch yet, or whose branch is gone,
    // stops this step with the reason on the card instead of falling back to
    // `main`: the chain was agreed for a reason, and only the person may drop it.
    let start = match task.relay_parent_task_id.as_deref() {
        Some(parent) => match relay_base(state, git, &project, parent).await {
            Ok(start) => Some(start),
            Err(message) => {
                set_workspace(state, task_id, WorkspaceStatus::Failed, Some(&message)).await?;
                let st = state.lock().await;
                crate::task_stage::block_relay_base(
                    &st.db,
                    st.db.conn(),
                    task_id,
                    &crate::tasks::short_id(parent),
                    &message,
                )?;
                return Ok(());
            }
        },
        None => None,
    };
    let placement = match start.as_deref() {
        Some(start) => Placement::RepoLocalFrom(&name, start),
        None => Placement::RepoLocal(&name),
    };
    let created = match lifecycle::create_session_worktree(
        state,
        git,
        &task.session_id,
        &project,
        placement,
    )
    .await
    {
        Ok(created) => created,
        Err(error) => {
            set_workspace(
                state,
                task_id,
                WorkspaceStatus::Failed,
                Some(&error.message),
            )
            .await?;
            return Ok(());
        }
    };

    let row = {
        let st = state.lock().await;
        registry::for_owner(&st.db, &task.session_id, None)?
    };
    let Some(row) = row else {
        set_workspace(
            state,
            task_id,
            WorkspaceStatus::Failed,
            Some("the worktree was created but its registry row is gone"),
        )
        .await?;
        return Ok(());
    };
    // The folder and the real branch are recorded even when the setup command
    // failed: the retry re-runs the command in this same folder.
    record_ready(state, task_id, &row, &created).await?;
    if row.setup_status == Some(SetupStatus::Failed) {
        let log = lifecycle::setup_log_tail(&row, ERROR_LIMIT);
        let message = if log.trim().is_empty() {
            "the workspace setup command failed".to_string()
        } else {
            format!("the workspace setup command failed\n{log}")
        };
        set_workspace(state, task_id, WorkspaceStatus::Failed, Some(&message)).await?;
    }
    Ok(())
}

/// The branch a relay step has to continue: the predecessor's own branch, which
/// must still exist (employee mode 0.5 slice 7).
///
/// The branch is the whole point of a chain, so "it is gone" is a refusal with a
/// reason rather than a quiet restart from `main`. Each message names the step
/// the person has to look at.
async fn relay_base(
    state: &SharedState,
    git: &GitRunner,
    project: &str,
    parent_id: &str,
) -> Result<String, String> {
    let parent = {
        let st = state.lock().await;
        tasks::get_task(&st.db, parent_id).map_err(|error| error.to_string())?
    };
    let short = crate::tasks::short_id(parent_id);
    let Some(parent) = parent else {
        return Err(format!(
            "the step before this one (#{short}) no longer exists, so there is no branch to continue"
        ));
    };
    let branch = parent
        .workspace_branch
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            format!("step #{short} has no branch yet; this step cannot continue from it")
        })?;
    let exists = git
        .output(
            Path::new(project),
            &[
                "show-ref",
                "--verify",
                "--quiet",
                &format!("refs/heads/{branch}"),
            ],
        )
        .await
        .map(|output| output.success())
        .unwrap_or(false);
    if !exists {
        return Err(format!(
            "the branch of step #{short} ({branch}) is gone, so this step has nothing to continue from"
        ));
    }
    Ok(branch)
}

/// A preparation retry on a folder that already exists: the worktree is fine, so
/// only the project's setup command runs again.
async fn retry_setup(
    state: &SharedState,
    git: &GitRunner,
    task_id: &str,
    row: &WorktreeRow,
    project: &str,
) -> Result<(), WorktreeError> {
    let _ = git;
    match lifecycle::rerun_setup(state, row, project).await? {
        Some(SetupStatus::Failed) => {
            let refreshed = {
                let st = state.lock().await;
                registry::get(&st.db, &row.id)?
            };
            let log = refreshed
                .map(|row| lifecycle::setup_log_tail(&row, ERROR_LIMIT))
                .unwrap_or_default();
            let message = if log.trim().is_empty() {
                "the workspace setup command failed".to_string()
            } else {
                format!("the workspace setup command failed\n{log}")
            };
            set_workspace(state, task_id, WorkspaceStatus::Failed, Some(&message)).await?;
        }
        // No command configured, or it passed: a workspace that exists and
        // needs nothing else is ready.
        Some(_) | None => set_workspace(state, task_id, WorkspaceStatus::Ready, None).await?,
    }
    Ok(())
}

async fn record_ready(
    state: &SharedState,
    task_id: &str,
    row: &WorktreeRow,
    created: &lifecycle::CreatedWorktree,
) -> Result<()> {
    let base = created.base.as_ref();
    let base_ref = base.map(|base| base.ref_name.clone());
    let base_remote = base.map(|base| base.remote).unwrap_or(false);
    let st = state.lock().await;
    st.db.conn().execute(
        "UPDATE tasks SET workspace_status='ready', workspace_error=NULL,
                workspace_path=?2, workspace_branch=?3, base_ref=?4, base_remote=?5
         WHERE id=?1",
        params![
            task_id,
            row.path,
            created.worktree.branch,
            base_ref,
            if base_remote { 1 } else { 0 }
        ],
    )?;
    Ok(())
}

async fn set_workspace(
    state: &SharedState,
    task_id: &str,
    status: WorkspaceStatus,
    error: Option<&str>,
) -> Result<()> {
    let st = state.lock().await;
    st.db.conn().execute(
        "UPDATE tasks SET workspace_status=?2, workspace_error=?3 WHERE id=?1",
        params![task_id, status.as_str(), error],
    )?;
    Ok(())
}

async fn set_delivery_mode(state: &SharedState, task_id: &str, mode: DeliveryMode) -> Result<()> {
    let st = state.lock().await;
    st.db.conn().execute(
        "UPDATE tasks SET delivery_mode=?2 WHERE id=?1",
        params![task_id, mode.as_str()],
    )?;
    Ok(())
}

// ---- archive ---------------------------------------------------------------

/// What the task's workspace still holds that removing it would lose.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnsavedWork {
    pub uncommitted_files: u64,
    pub unpushed_commits: u64,
}

impl UnsavedWork {
    pub fn is_empty(&self) -> bool {
        self.uncommitted_files == 0 && self.unpushed_commits == 0
    }
}

/// Uncommitted files and commits that have not left the machine, across every
/// worktree of the task (its own and any subagent's).
///
/// `base_ref` is the ref the task's branch was created from. It is excluded from
/// the commit count for a reason that showed up in a real repository: a task
/// branched from `origin/main` while the local `main` is behind has made no
/// commits of its own, and counting `main..branch` reported the *remote's*
/// commit as the task's work — a task that did nothing asked the person to
/// confirm discarding something they never wrote.
pub async fn unsaved_work(
    state: &SharedState,
    git: &GitRunner,
    session_id: &str,
    mode: DeliveryMode,
    base_ref: Option<&str>,
) -> Result<UnsavedWork, WorktreeError> {
    let rows = {
        let st = state.lock().await;
        registry::for_session(&st.db, session_id)?
    };
    let mut work = UnsavedWork::default();
    for row in rows {
        let root = Path::new(&row.path);
        if is_real_dir(root) {
            let status = merge::worktree_status(git, root).await?;
            work.uncommitted_files += status
                .lines()
                .filter(|line| !line.trim().is_empty())
                .count() as u64;
        }
        work.unpushed_commits += commits_left_on_machine(git, &row, mode, base_ref).await?;
    }
    Ok(work)
}

/// Commits this task made that exist only here: not on the ref it started from,
/// and not where its work is delivered — any remote for `pr`, the project's own
/// branch for `local`.
///
/// Read from the repository, so a vanished folder whose branch still holds
/// commits is still reported. A missing repository means there is nothing left to
/// lose; a git failure means nobody can tell, which is why this returns the error
/// instead of a zero the caller would read as "safe to delete".
async fn commits_left_on_machine(
    git: &GitRunner,
    row: &WorktreeRow,
    mode: DeliveryMode,
    base_ref: Option<&str>,
) -> Result<u64, WorktreeError> {
    let common_dir = Path::new(&row.common_dir);
    if !common_dir.is_dir() {
        return Ok(0);
    }
    let branch = merge::head_ref(&row.branch);
    // `--not` applies to every revision after it, so the base and the delivery
    // target are excluded by one list.
    let mut args: Vec<String> = vec![
        "rev-list".to_string(),
        "--count".to_string(),
        branch,
        "--not".to_string(),
    ];
    if let Some(base) = base_ref.filter(|base| base.starts_with("refs/")) {
        if git
            .run_git_dir(common_dir, &["show-ref", "--verify", "--quiet", base])
            .await
            .is_ok()
        {
            args.push(base.to_string());
        }
    }
    match mode {
        DeliveryMode::Pr => args.push("--remotes".to_string()),
        _ => args.push(merge::head_ref(&row.owner_branch)),
    }
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let count = git.run_git_dir(common_dir, &refs).await.map_err(|error| {
        WorktreeError::new(
            WORKSPACE_UNSAVED_UNKNOWN,
            format!("the workspace's unsaved work could not be checked: {error}"),
        )
    })?;
    count.trim().parse().map_err(|_| {
        WorktreeError::new(
            WORKSPACE_UNSAVED_UNKNOWN,
            format!(
                "the workspace's unsaved work could not be checked: unexpected rev-list output: {}",
                count.trim()
            ),
        )
    })
}

/// `task.archive`: remove the workspace and its branch when nothing would be
/// lost, and refuse with [`WORKSPACE_UNSAVED`] when something would.
///
/// `discard` is the person's second confirmation. A removal that fails is not a
/// reason to keep the task archived the person already decided about: the task
/// records the pending cleanup and ADR 0329's orphan pass takes it from there.
pub async fn cleanup_for_archive(
    state: &SharedState,
    git: &GitRunner,
    task_id: &str,
    discard: bool,
) -> Result<(), WorktreeError> {
    let task = {
        let st = state.lock().await;
        tasks::get_task(&st.db, task_id)?
    };
    let Some(task) = task else {
        return Ok(());
    };
    let rows = {
        let st = state.lock().await;
        registry::for_session(&st.db, &task.session_id)?
    };
    if rows.is_empty() {
        return Ok(());
    }
    let mode = task
        .delivery_mode
        .as_deref()
        .and_then(DeliveryMode::parse)
        .unwrap_or(DeliveryMode::Local);
    if !discard {
        let work =
            unsaved_work(state, git, &task.session_id, mode, task.base_ref.as_deref()).await?;
        if !work.is_empty() {
            return Err(WorktreeError::new(
                WORKSPACE_UNSAVED,
                format!(
                    "the task's workspace still holds {} uncommitted file(s) and {} unpushed commit(s)",
                    work.uncommitted_files, work.unpushed_commits
                ),
            ));
        }
    }
    if let Err(error) = lifecycle::remove_session_worktrees(state, git, &task.session_id).await {
        tracing::warn!(%error, task = task_id, "could not remove a task workspace on archive");
        // The folder is still there: the task says so, and ADR 0329's orphan pass
        // (or a later archive attempt) finishes the job.
        set_workspace(
            state,
            task_id,
            WorkspaceStatus::Failed,
            Some(&format!(
                "the workspace could not be removed: {}",
                error.message
            )),
        )
        .await?;
    } else {
        // Nothing is left to prepare or retry: the task no longer has a
        // workspace, and a stale `ready` would offer a retry for a folder that
        // does not exist.
        set_workspace(state, task_id, WorkspaceStatus::None, None).await?;
    }
    Ok(())
}
#[cfg(test)]
mod tests;
