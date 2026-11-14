//! The fixed steps that land a task's work.
//!
//! One list per delivery mode, and one loop that cannot skip a step or repeat
//! one: each step records itself in `tasks.delivery_json` before the next starts,
//! so a retry continues where the last attempt stopped instead of running an
//! irreversible command twice.

use std::path::Path;

use anyhow::Result;
use serde_json::{json, Value};

use super::gate::{gate_for, read_pr, read_pr_state, GhRunner, PrFacts};
use super::{
    load_state, published_index, stop_with_card, store_state, Stop, Target, LOCAL_STEPS, PR_STEPS,
};
use crate::db::{ms_to_ts, now_ms};
use crate::session_worktrees::git::GitRunner;
use crate::session_worktrees::lifecycle::{self, SharedState};
use crate::session_worktrees::merge;
use crate::task_workspace::{self, DeliveryMode};
use crate::tasks;

pub(super) async fn merge_pr(
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
                delete_remote_branches(git, &target.project, &target.row.branch, &remotes)
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

pub(super) async fn merge_local(
    state: &SharedState,
    git: &GitRunner,
    target: &Target,
) -> Result<Value> {
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
    project: &Path,
    branch: &str,
    remotes: &[(String, String)],
) -> std::result::Result<(), Stop> {
    for (name, _) in remotes {
        let heads = git
            .output(project, &["ls-remote", "--heads", name, branch])
            .await
            .map_err(|error| {
                Stop::new(
                    "delete-branches",
                    format!("{name}: could not be read ({error})"),
                    true,
                )
            })?;
        // "Nobody could tell" is not "already gone": reporting success over a
        // failed read would leave the branch on the remote while calling the
        // step finished, and the person would never be told.
        if !heads.success() {
            return Err(Stop::new(
                "delete-branches",
                format!("{name}: {}", heads.stderr.trim()),
                true,
            ));
        }
        if heads.stdout.trim().is_empty() {
            continue;
        }
        let output = git
            .output(project, &["push", name, "--delete", branch])
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
///
/// A relay chain is cleaned whole (employee mode 0.5 slice 7): the last step's
/// merge carried every earlier step's commits onto `main`, so their branches are
/// ancestors now — `-d` accepts them — and their workspaces are folders nothing
/// will ever use again. Leaving them behind would leave the person with a
/// sidebar full of finished steps and a repository full of dead branches.
async fn cleanup_step(
    state: &SharedState,
    git: &GitRunner,
    target: &Target,
) -> std::result::Result<(), Stop> {
    let chain = {
        let st = state.lock().await;
        tasks::relay_chain(&st.db, &target.task.id).map_err(|error| {
            Stop::new("cleanup", error.to_string(), true)
        })?
    };
    for step in &chain {
        task_workspace::cleanup_for_archive(state, git, &step.id, false)
            .await
            .map_err(|error| Stop::of("cleanup", error, true))?;
    }
    for step in &chain {
        // `-d`, never `-D`: a branch whose work is not on `main` is exactly the
        // case that must not be deleted, and git already knows how to say so.
        let Some(branch) = step.workspace_branch.as_deref() else {
            continue;
        };
        let output = git
            .output(&target.project, &["branch", "-d", branch])
            .await
            .map_err(|error| Stop::new("cleanup", error.to_string(), true))?;
        if !output.success() {
            let message = output.stderr.trim();
            // A branch that is already gone is finished work, not a failure.
            if !message.contains("not found") && !message.contains("no such branch") {
                return Err(Stop::new("cleanup", message.to_string(), true));
            }
        }
    }
    let st = state.lock().await;
    // Every step leaves the open list: the chain is delivered, and a step whose
    // work is on `main` has nothing left to do on its own.
    for step in &chain {
        tasks::archive(&st.db, &json!({ "taskId": step.id }))
            .map_err(|error| Stop::new("cleanup", error.to_string(), true))?;
    }
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
    use crate::session_worktrees::test_support::init_repo;

    /// **C5.** A remote that cannot be read is a failed step, never a pass.
    ///
    /// `ls-remote` answers "does this branch still exist", and "nobody could
    /// tell" is not "it is gone": reporting success would leave the branch on the
    /// remote while the record said the step was finished.
    #[tokio::test]
    async fn a_remote_that_cannot_be_read_fails_the_delete_step() {
        let dir = tempfile::tempdir().unwrap();
        let repo = init_repo(dir.path());
        let git = GitRunner::default();
        let remotes = vec![("ghost".to_string(), "nowhere".to_string())];
        let failure = delete_remote_branches(&git, &repo, "minih-agent/task-1", &remotes)
            .await
            .unwrap_err();
        assert_eq!(failure.step, "delete-branches");
        assert!(
            failure.message.starts_with("ghost:"),
            "the refusal does not name the remote: {}",
            failure.message
        );
    }

    /// A branch that is already gone is finished work, not a failure.
    #[tokio::test]
    async fn a_branch_that_is_already_gone_passes_the_delete_step() {
        let dir = tempfile::tempdir().unwrap();
        let repo = init_repo(dir.path());
        let bare = dir.path().join("origin.git");
        std::fs::create_dir_all(&bare).unwrap();
        crate::session_worktrees::test_support::git_cmd(
            &bare,
            &["init", "-q", "--bare", "-b", "main"],
        );
        crate::session_worktrees::test_support::git_cmd(
            &repo,
            &["remote", "add", "origin", bare.to_str().unwrap()],
        );
        crate::session_worktrees::test_support::git_cmd(&repo, &["push", "-q", "origin", "main"]);
        let git = GitRunner::default();
        let remotes = vec![("origin".to_string(), bare.to_string_lossy().to_string())];
        match delete_remote_branches(&git, &repo, "minih-agent/gone", &remotes).await {
            Ok(()) => {}
            Err(failure) => panic!("a branch that does not exist is not a failure: {failure:?}"),
        }
    }
}
