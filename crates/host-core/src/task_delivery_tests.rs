//! The delivery steps, against real git and a scripted `gh`.
//!
//! The gate itself is proven as a table in `task_delivery`; what is left is the
//! part only a real repository can answer: does the host fast-forward `main`
//! without a merge commit, does it push to both remotes, does it remove the
//! branch and the workspace, and does a retry after a partial failure finish
//! only the steps that are left.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::json;
use tokio::sync::Mutex;

use crate::session_worktrees::git::GitRunner;
use crate::session_worktrees::registry::{self, NewWorktree};
use crate::session_worktrees::test_support::{git_cmd, init_repo};
use crate::session_worktrees::lifecycle::SharedState;
use crate::state::AppState;
use crate::task_delivery::{self, GhRunner};
use crate::tasks;

/// A `gh` that answers from a fixed script: the head commit of the "PR", and
/// whether it reports the PR merged. No process, no network, no token.
struct ScriptedGh {
    head: String,
}

#[async_trait::async_trait]
impl GhRunner for ScriptedGh {
    async fn run(&self, _dir: &Path, args: &[&str]) -> Result<String, String> {
        if args.first() != Some(&"pr") {
            return Err(format!("unexpected gh call: {args:?}"));
        }
        let all = args.iter().any(|arg| *arg == "all");
        if all {
            return Ok(json!([{ "state": "MERGED" }]).to_string());
        }
        Ok(json!([{
            "url": "https://github.com/o/r/pull/7",
            "state": "OPEN",
            "mergeable": "MERGEABLE",
            "reviewDecision": "APPROVED",
            "headRefOid": self.head,
            "statusCheckRollup": [
                {"name": "build", "status": "COMPLETED", "conclusion": "SUCCESS"},
                {"name": "test", "status": "COMPLETED", "conclusion": "SUCCESS"}
            ]
        }])
        .to_string())
    }
}

/// A `gh` that fails every call: the "gh is not available" row.
struct BrokenGh;

#[async_trait::async_trait]
impl GhRunner for BrokenGh {
    async fn run(&self, _dir: &Path, _args: &[&str]) -> Result<String, String> {
        Err("gh is not installed".to_string())
    }
}

struct Fixture {
    _dir: tempfile::TempDir,
    state: SharedState,
    project: PathBuf,
    /// The remote `origin` stands in for GitHub, `gitea` for the second one.
    origin: PathBuf,
    gitea: PathBuf,
    branch: String,
    worktree: PathBuf,
    task_id: String,
}

fn bare(path: &Path) {
    std::fs::create_dir_all(path).unwrap();
    git_cmd(path, &["init", "-q", "--bare", "-b", "main"]);
}

fn head_of(repo: &Path) -> String {
    git_cmd(repo, &["rev-parse", "HEAD"]).trim().to_string()
}

/// A project with two remotes, a task, and a worktree on its own branch with
/// one commit that has been pushed to both remotes.
async fn fixture(mode: &str) -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let project = init_repo(&dir.path().join("project"));
    let origin = dir.path().join("origin.git");
    let gitea = dir.path().join("gitea.git");
    bare(&origin);
    bare(&gitea);
    git_cmd(&project, &["remote", "add", "origin", origin.to_str().unwrap()]);
    git_cmd(&project, &["remote", "add", "gitea", gitea.to_str().unwrap()]);
    git_cmd(&project, &["push", "-q", "origin", "main"]);
    git_cmd(&project, &["push", "-q", "gitea", "main"]);

    // The app database lives in its own directory; the project is another.
    let mut app = AppState::open(dir.path().join("data").as_path()).unwrap();
    app.handshook = true;
    let state: SharedState = Arc::new(Mutex::new(app));

    let employee = crate::sessions::create_session_with_options(
        &state.lock().await.db,
        crate::sessions::SessionCreateOptions {
            title: Some("后端".into()),
            mode: Some("agent".into()),
            permission_mode: Some("accept-edits".into()),
            role: Some("bot".into()),
            bot_profile_json: Some(
                json!({"name": "后端", "permissionMode": "accept-edits", "observe": false})
                    .to_string(),
            ),
            ..Default::default()
        },
    )
    .unwrap()
    .id;
    let project_path = std::fs::canonicalize(&project)
        .unwrap()
        .to_string_lossy()
        .to_string();
    let branch = "minih-agent/task-1";
    let created = {
        let st = state.lock().await;
        tasks::create(
            &st.db,
            &json!({
                "employeeSessionId": employee,
                "title": "Fix the login timeout",
                "origin": "direct",
                "projectPath": project_path,
            }),
        )
        .unwrap()
    };
    let task_id = created["task"]["id"].as_str().unwrap().to_string();
    let session_id = created["task"]["sessionId"].as_str().unwrap().to_string();

    // The worktree the task works in, on its own branch, with one commit that
    // is on both remotes — the state a finished task is in.
    let worktree = dir.path().join("wt");
    git_cmd(
        &project,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            branch,
            worktree.to_str().unwrap(),
            "main",
        ],
    );
    std::fs::write(worktree.join("login.txt"), "timeout=30s\n").unwrap();
    git_cmd(&worktree, &["add", "login.txt"]);
    git_cmd(&worktree, &["commit", "-q", "-m", "fix(bot): raise the timeout"]);
    git_cmd(&worktree, &["push", "-q", "origin", branch]);
    git_cmd(&worktree, &["push", "-q", "gitea", branch]);

    {
        let st = state.lock().await;
        registry::insert(
            &st.db,
            &NewWorktree {
                session_id: &session_id,
                delegation_id: None,
                path: &worktree.to_string_lossy(),
                common_dir: &project.join(".git").to_string_lossy(),
                prefix: "",
                branch,
                owner_branch: "main",
                port_base: None,
            },
        )
        .unwrap();
        st.db
            .conn()
            .execute(
                "UPDATE tasks SET stage='person/accept', delivery_mode=?2, workspace_branch=?3,
                        workspace_status='ready'
                  WHERE id=?1",
                rusqlite::params![task_id, mode, branch],
            )
            .unwrap();
    }

    Fixture {
        _dir: dir,
        state,
        project,
        origin,
        gitea,
        branch: branch.to_string(),
        worktree,
        task_id,
    }
}

async fn read_task(fixture: &Fixture) -> tasks::Task {
    let st = fixture.state.lock().await;
    tasks::get_task(&st.db, &fixture.task_id).unwrap().unwrap()
}

fn steps_of(task: &tasks::Task) -> Vec<(String, String)> {
    task.delivery
        .as_ref()
        .map(|delivery| {
            delivery
                .steps
                .iter()
                .map(|step| (step.name.clone(), step.at.clone()))
                .collect()
        })
        .unwrap_or_default()
}

/// Reject every push into a bare repository: the "second remote refuses" case.
fn reject_pushes(bare_repo: &Path) {
    let hook = bare_repo.join("hooks").join("pre-receive");
    std::fs::write(&hook, "#!/bin/sh\necho nope >&2\nexit 1\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
}

fn allow_pushes(bare_repo: &Path) {
    let _ = std::fs::remove_file(bare_repo.join("hooks").join("pre-receive"));
}

/// The whole `pr` path: both remotes move, the branch is gone from both, the
/// workspace is removed, the task is archived, and `main` gained no merge commit.
#[tokio::test]
async fn a_pull_request_task_is_fast_forwarded_to_every_remote_and_cleaned_up() {
    let fixture = fixture("pr").await;
    let head = head_of(&fixture.worktree);
    let git = GitRunner::default();
    let gh = ScriptedGh { head: head.clone() };

    let result = task_delivery::merge(&fixture.state, &git, &gh, &fixture.task_id)
        .await
        .unwrap();
    assert_eq!(result["merged"], json!(true), "{result}");

    assert_eq!(head_of(&fixture.origin), head, "origin did not move");
    assert_eq!(head_of(&fixture.gitea), head, "the second remote did not move");
    assert!(
        !head_of(&fixture.project).is_empty(),
        "the project checkout still exists"
    );
    let merge_commits = git_cmd(&fixture.project, &["rev-list", "--merges", "HEAD", "--count"]);
    assert_eq!(merge_commits.trim(), "0", "a merge commit was created");
    assert_eq!(
        head_of(&fixture.project),
        head,
        "the project's main is the task's commit"
    );

    // The branch is deleted on both remotes, and the workspace is gone.
    for remote in ["origin", "gitea"] {
        let heads = git_cmd(
            &fixture.project,
            &["ls-remote", "--heads", remote, &fixture.branch],
        );
        assert!(heads.trim().is_empty(), "{remote} still has the branch");
    }
    assert!(
        !fixture.worktree.is_dir(),
        "the task's workspace was not removed"
    );
    let task = read_task(&fixture).await;
    assert!(task.archived_at.is_some(), "the task was not archived");
    assert!(task.accepted_at.is_some(), "merging accepts the work");
    let names: Vec<String> = task
        .delivery
        .as_ref()
        .unwrap()
        .steps
        .iter()
        .map(|step| step.name.clone())
        .collect();
    assert_eq!(
        names,
        task_delivery::PR_STEPS.to_vec(),
        "every step ran, in order"
    );
}

/// The gate refuses before anything is written when `gh` cannot be read, and
/// the refusal is a card with the reason rather than a green button.
#[tokio::test]
async fn an_unreadable_pull_request_refuses_and_blocks_the_task() {
    let fixture = fixture("pr").await;
    let git = GitRunner::default();
    let checked = task_delivery::check(&fixture.state, &git, &BrokenGh, &fixture.task_id)
        .await
        .unwrap();
    assert_eq!(checked["canMerge"], json!(false));
    assert_eq!(checked["reason"], json!("pr-unreadable"));
    assert_eq!(
        checked["reasonDetail"],
        json!("gh is not installed"),
        "the reason names what could not be read"
    );

    let result = task_delivery::merge(&fixture.state, &git, &BrokenGh, &fixture.task_id)
        .await
        .unwrap();
    assert_eq!(result["merged"], json!(false));
    assert_eq!(result["failedStep"], json!("read-pr"));
    let task = read_task(&fixture).await;
    assert_eq!(task.stage, "blocked");
    assert_eq!(task.blocker.as_ref().unwrap()["reason"], json!("delivery"));
    assert_eq!(task.blocker.as_ref().unwrap()["step"], json!("read-pr"));
    // Nothing left the machine, and the task is still there to retry.
    assert!(task.archived_at.is_none());
    assert_eq!(
        git_cmd(&fixture.project, &["rev-parse", "HEAD"]).trim(),
        git_cmd(&fixture.project, &["rev-parse", "main"]).trim()
    );
}

/// A second remote that refuses the push: the work is on GitHub, the card says
/// which remote is behind, and the retry runs only the steps that are left.
#[tokio::test]
async fn a_remote_that_refuses_the_push_blocks_the_task_and_the_retry_finishes() {
    let fixture = fixture("pr").await;
    let head = head_of(&fixture.worktree);
    let git = GitRunner::default();
    let gh = ScriptedGh { head: head.clone() };
    reject_pushes(&fixture.gitea);

    let failed = task_delivery::merge(&fixture.state, &git, &gh, &fixture.task_id)
        .await
        .unwrap();
    assert_eq!(failed["merged"], json!(false));
    assert_eq!(failed["failedStep"], json!("push-remotes"));
    assert_eq!(failed["published"], json!(true), "GitHub already has it");
    let blocked = read_task(&fixture).await;
    assert_eq!(blocked.stage, "blocked");
    assert!(blocked.archived_at.is_none());
    assert_eq!(head_of(&fixture.origin), head, "origin did move");
    assert_ne!(
        head_of(&fixture.gitea),
        head,
        "the second remote must not have it"
    );
    let before = steps_of(&blocked);
    assert_eq!(
        before
            .iter()
            .map(|(name, _)| name.as_str())
            .collect::<Vec<_>>(),
        vec![
            "read-pr",
            "gate",
            "head",
            "land",
            "push-main",
            "push-remotes"
        ],
        "the record stops at the step that failed"
    );
    let push_main_at = before
        .iter()
        .find(|(name, _)| name == "push-main")
        .map(|(_, at)| at.clone())
        .unwrap();

    // The remote accepts pushes again: the retry must not repeat anything that
    // already happened.
    allow_pushes(&fixture.gitea);
    let retried = task_delivery::merge(&fixture.state, &git, &gh, &fixture.task_id)
        .await
        .unwrap();
    assert_eq!(retried["merged"], json!(true), "{retried}");
    assert_eq!(head_of(&fixture.gitea), head, "the retry finished the push");
    let task = read_task(&fixture).await;
    assert!(task.archived_at.is_some(), "the retry archived the task");
    let recorded = task.delivery.as_ref().unwrap();
    assert_eq!(
        recorded
            .steps
            .iter()
            .find(|step| step.name == "push-main")
            .map(|step| step.at.clone()),
        Some(push_main_at),
        "a completed step was executed a second time"
    );
    assert_eq!(
        recorded
            .steps
            .iter()
            .map(|step| step.name.clone())
            .collect::<Vec<_>>(),
        task_delivery::PR_STEPS.to_vec()
    );
}

/// A `local` task merges into the project through ADR 0329's preview + merge,
/// and is cleaned up the same way.
#[tokio::test]
async fn a_local_task_merges_into_the_project_and_is_archived() {
    let fixture = fixture("local").await;
    let head = head_of(&fixture.worktree);
    let git = GitRunner::default();
    let gh = ScriptedGh { head: head.clone() };

    let result = task_delivery::merge(&fixture.state, &git, &gh, &fixture.task_id)
        .await
        .unwrap();
    assert_eq!(result["merged"], json!(true), "{result}");
    assert_eq!(head_of(&fixture.project), head);
    assert!(!fixture.worktree.is_dir());
    let task = read_task(&fixture).await;
    assert!(task.archived_at.is_some());
    assert_eq!(
        task.delivery
            .as_ref()
            .unwrap()
            .steps
            .iter()
            .map(|step| step.name.clone())
            .collect::<Vec<_>>(),
        task_delivery::LOCAL_STEPS.to_vec()
    );
}

/// A `local` task whose branch conflicts with the project is a blocked task,
/// not a merged one: the conflict stays where a person can resolve it.
#[tokio::test]
async fn a_local_conflict_blocks_the_task_instead_of_merging() {
    let fixture = fixture("local").await;
    // The same file, changed on `main` after the branch left it.
    std::fs::write(fixture.project.join("login.txt"), "timeout=10s\n").unwrap();
    git_cmd(&fixture.project, &["add", "login.txt"]);
    git_cmd(&fixture.project, &["commit", "-q", "-m", "conflict"]);
    let head = head_of(&fixture.worktree);
    let git = GitRunner::default();
    let gh = ScriptedGh { head };

    let result = task_delivery::merge(&fixture.state, &git, &gh, &fixture.task_id)
        .await
        .unwrap();
    assert_eq!(result["merged"], json!(false), "{result}");
    let task = read_task(&fixture).await;
    assert_eq!(task.stage, "blocked");
    assert!(task.archived_at.is_none());
    // The project's `main` is untouched: a conflict never half-merges.
    assert_eq!(
        git_cmd(&fixture.project, &["rev-parse", "HEAD"]).trim(),
        git_cmd(&fixture.project, &["rev-parse", "main"]).trim()
    );
}

/// A task with no repository has nothing to merge into: the button is grey and
/// says so, without running `gh` or git at all.
#[tokio::test]
async fn a_task_without_a_project_refuses_to_merge() {
    let dir = tempfile::tempdir().unwrap();
    let mut app = AppState::open(dir.path()).unwrap();
    app.handshook = true;
    let state: SharedState = Arc::new(Mutex::new(app));
    let employee = crate::sessions::create_session_with_options(
        &state.lock().await.db,
        crate::sessions::SessionCreateOptions {
            title: Some("研究".into()),
            mode: Some("agent".into()),
            role: Some("bot".into()),
            bot_profile_json: Some(
                json!({"name": "研究", "permissionMode": "ask", "observe": false}).to_string(),
            ),
            ..Default::default()
        },
    )
    .unwrap()
    .id;
    let created = {
        let st = state.lock().await;
        tasks::create(
            &st.db,
            &json!({"employeeSessionId": employee, "title": "Read the spec", "origin": "direct"}),
        )
        .unwrap()
    };
    let task_id = created["task"]["id"].as_str().unwrap().to_string();
    let checked = task_delivery::check(
        &state,
        &GitRunner::default(),
        &BrokenGh,
        &task_id,
    )
    .await;
    // The workspace was never prepared, so the card cannot offer a merge at all.
    assert!(checked.is_err(), "a task without a workspace has no merge path");
}
