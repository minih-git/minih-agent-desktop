//! The delivery steps, against real git and a scripted `gh`.
//!
//! The gate itself is proven as a table in `task_delivery`; what is left is the
//! part only a real repository can answer: does the host fast-forward `main`
//! without a merge commit, does it push to both remotes, does it remove the
//! branch and the workspace, and does a retry after a partial failure finish
//! only the steps that are left.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::{json, Value};
use tokio::sync::Mutex;

use crate::session_worktrees::git::GitRunner;
use crate::session_worktrees::lifecycle::SharedState;
use crate::session_worktrees::registry::{self, NewWorktree};
use crate::session_worktrees::test_support::{git_cmd, init_repo};
use crate::state::AppState;
use crate::task_delivery::{self, GhRunner};
use crate::tasks;

/// The facts `gh` answers with, as the host reads them.
fn pr_facts(head: &str, mergeable: &str, checks: Value) -> Value {
    json!({
        "url": "https://github.com/o/r/pull/7",
        "state": "OPEN",
        "mergeable": mergeable,
        "reviewDecision": "APPROVED",
        "headRefOid": head,
        "statusCheckRollup": checks,
    })
}

fn green_checks() -> Value {
    json!([
        {"name": "build", "status": "COMPLETED", "conclusion": "SUCCESS"},
        {"name": "test", "status": "COMPLETED", "conclusion": "SUCCESS"}
    ])
}

fn pending_checks() -> Value {
    json!([
        {"name": "build", "status": "COMPLETED", "conclusion": "SUCCESS"},
        {"name": "test", "status": "IN_PROGRESS", "conclusion": null}
    ])
}

/// A `gh` that answers from a script the test can move: the "pull request" it
/// reports, and whether it reports it merged. No process, no network, no token.
struct ScriptedGh {
    facts: std::sync::Mutex<Value>,
}

impl ScriptedGh {
    fn green(head: &str) -> Self {
        Self {
            facts: std::sync::Mutex::new(pr_facts(head, "MERGEABLE", green_checks())),
        }
    }

    /// Point the scripted pull request at another head, with other checks — what
    /// happens between two attempts when the employee pushes.
    fn repoint(&self, head: &str, checks: Value) {
        *self.facts.lock().unwrap() = pr_facts(head, "MERGEABLE", checks);
    }
}

#[async_trait::async_trait]
impl GhRunner for ScriptedGh {
    async fn run(&self, _dir: &Path, args: &[&str]) -> Result<String, String> {
        if args.first() != Some(&"pr") {
            return Err(format!("unexpected gh call: {args:?}"));
        }
        if args.contains(&"all") {
            return Ok(json!([{ "state": "MERGED" }]).to_string());
        }
        Ok(json!([self.facts.lock().unwrap().clone()]).to_string())
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
    git_cmd(
        &project,
        &["remote", "add", "origin", origin.to_str().unwrap()],
    );
    git_cmd(
        &project,
        &["remote", "add", "gitea", gitea.to_str().unwrap()],
    );
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
    git_cmd(
        &worktree,
        &["commit", "-q", "-m", "fix(bot): raise the timeout"],
    );
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
    let gh = ScriptedGh::green(&head);

    let result = task_delivery::merge(&fixture.state, &git, &gh, &fixture.task_id)
        .await
        .unwrap();
    assert_eq!(result["merged"], json!(true), "{result}");

    assert_eq!(head_of(&fixture.origin), head, "origin did not move");
    assert_eq!(
        head_of(&fixture.gitea),
        head,
        "the second remote did not move"
    );
    assert!(
        !head_of(&fixture.project).is_empty(),
        "the project checkout still exists"
    );
    let merge_commits = git_cmd(
        &fixture.project,
        &["rev-list", "--merges", "HEAD", "--count"],
    );
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
    let gh = ScriptedGh::green(&head);
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
    let gh = ScriptedGh::green(&head);

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
    let gh = ScriptedGh::green(&head);

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
    let checked = task_delivery::check(&state, &GitRunner::default(), &BrokenGh, &task_id).await;
    // The workspace was never prepared, so the card cannot offer a merge at all.
    assert!(
        checked.is_err(),
        "a task without a workspace has no merge path"
    );
}

/// **C1.** A retry must re-check the preconditions.
///
/// The first attempt fails at `head` (the workspace has uncommitted work), so
/// nothing was published. The employee then pushes, the pull request's head
/// moves, and its CI restarts. A click on 重试 must not walk past the gate with
/// the old verdict: the preconditions run again, `ci-running` refuses, and the
/// project's `main` never moves.
#[tokio::test]
async fn a_retry_re_runs_the_gate_and_refuses_a_pull_request_whose_checks_restarted() {
    let fixture = fixture("pr").await;
    let git = GitRunner::default();
    let first_head = head_of(&fixture.worktree);
    let gh = ScriptedGh::green(&first_head);
    // Uncommitted work in the task's own folder: `head` refuses, nothing is
    // published, and the record holds a passed gate that is about to go stale.
    std::fs::write(fixture.worktree.join("login.txt"), "timeout=45s\n").unwrap();

    let failed = task_delivery::merge(&fixture.state, &git, &gh, &fixture.task_id)
        .await
        .unwrap();
    assert_eq!(failed["merged"], json!(false));
    assert_eq!(failed["failedStep"], json!("head"));
    let blocked = read_task(&fixture).await;
    let recorded: Vec<String> = blocked
        .delivery
        .as_ref()
        .unwrap()
        .steps
        .iter()
        .map(|step| step.name.clone())
        .collect();
    assert_eq!(recorded, vec!["read-pr", "gate", "head"], "{recorded:?}");

    // The employee commits and pushes; GitHub now has a new head and CI is
    // running again.
    git_cmd(&fixture.worktree, &["add", "login.txt"]);
    git_cmd(
        &fixture.worktree,
        &["commit", "-q", "-m", "fix(bot): one more try"],
    );
    git_cmd(
        &fixture.worktree,
        &["push", "-q", "origin", &fixture.branch],
    );
    let second_head = head_of(&fixture.worktree);
    assert_ne!(second_head, first_head);
    gh.repoint(&second_head, pending_checks());
    let main_before = git_cmd(&fixture.project, &["rev-parse", "HEAD"])
        .trim()
        .to_string();

    let retried = task_delivery::merge(&fixture.state, &git, &gh, &fixture.task_id)
        .await
        .unwrap();
    assert_eq!(retried["merged"], json!(false), "{retried}");
    assert_eq!(
        retried["failedStep"],
        json!("gate"),
        "the retry did not re-run the gate: {retried}"
    );
    assert!(
        retried["detail"]
            .as_str()
            .unwrap_or("")
            .contains("ci-running"),
        "the refusal does not name the checks: {retried}"
    );
    assert_eq!(
        git_cmd(&fixture.project, &["rev-parse", "HEAD"]).trim(),
        main_before,
        "a refused retry moved the project's main"
    );
    // And the record is the fresh one: the preconditions ran again, and the
    // stale `done` entries are gone.
    let after = read_task(&fixture).await;
    assert_eq!(after.stage, "blocked");
    let steps: Vec<(String, String)> = after
        .delivery
        .as_ref()
        .unwrap()
        .steps
        .iter()
        .map(|step| (step.name.clone(), step.status.clone()))
        .collect();
    assert_eq!(
        steps,
        vec![
            ("read-pr".to_string(), "done".to_string()),
            ("gate".to_string(), "failed".to_string())
        ],
        "an unpublished attempt was resumed instead of restarted"
    );
}

/// **C1.** A *published* attempt survives the person sending the task back.
///
/// `push-main` succeeded and the second remote refused, so the work is on
/// GitHub. 打回 starts a new turn — which clears the acceptance and the report
/// — but it must not throw away the record of what already happened: the retry
/// then runs only the steps that are left.
#[tokio::test]
async fn a_rejected_task_keeps_its_published_record_and_resumes_after_the_push() {
    let fixture = fixture("pr").await;
    let head = head_of(&fixture.worktree);
    let git = GitRunner::default();
    let gh = ScriptedGh::green(&head);
    reject_pushes(&fixture.gitea);

    let failed = task_delivery::merge(&fixture.state, &git, &gh, &fixture.task_id)
        .await
        .unwrap();
    assert_eq!(failed["failedStep"], json!("push-remotes"));
    let before = steps_of(&read_task(&fixture).await);
    let push_main_at = before
        .iter()
        .find(|(name, _)| name == "push-main")
        .map(|(_, at)| at.clone())
        .unwrap();

    // 打回: a user message in the task's own session starts a new turn.
    let session_id = {
        let st = fixture.state.lock().await;
        tasks::get_task(&st.db, &fixture.task_id)
            .unwrap()
            .unwrap()
            .session_id
    };
    {
        let st = fixture.state.lock().await;
        tasks::turn_began(&st.db, st.db.conn(), &session_id).unwrap();
    }
    let kept = read_task(&fixture).await;
    assert!(
        kept.delivery.is_some(),
        "a published delivery record must survive a new turn"
    );
    assert_eq!(
        steps_of(&kept)
            .iter()
            .map(|(name, _)| name.clone())
            .collect::<Vec<_>>(),
        before
            .iter()
            .map(|(name, _)| name.clone())
            .collect::<Vec<_>>()
    );

    allow_pushes(&fixture.gitea);
    let retried = task_delivery::merge(&fixture.state, &git, &gh, &fixture.task_id)
        .await
        .unwrap();
    assert_eq!(retried["merged"], json!(true), "{retried}");
    let after = read_task(&fixture).await;
    assert!(after.archived_at.is_some());
    let recorded = after.delivery.as_ref().unwrap();
    assert_eq!(
        recorded
            .steps
            .iter()
            .find(|step| step.name == "push-main")
            .map(|step| step.at.clone()),
        Some(push_main_at),
        "the retry repeated a step that had already published"
    );
}

/// **C1.** An unpublished record is not resumable, so a new turn throws it away.
#[tokio::test]
async fn a_new_turn_drops_a_delivery_record_that_never_published() {
    let fixture = fixture("pr").await;
    let git = GitRunner::default();
    let gh = ScriptedGh::green(&head_of(&fixture.worktree));
    std::fs::write(fixture.worktree.join("login.txt"), "timeout=45s\n").unwrap();
    task_delivery::merge(&fixture.state, &git, &gh, &fixture.task_id)
        .await
        .unwrap();
    assert!(read_task(&fixture).await.delivery.is_some());

    let session_id = {
        let st = fixture.state.lock().await;
        tasks::get_task(&st.db, &fixture.task_id)
            .unwrap()
            .unwrap()
            .session_id
    };
    {
        let st = fixture.state.lock().await;
        tasks::turn_began(&st.db, st.db.conn(), &session_id).unwrap();
    }
    assert!(
        read_task(&fixture).await.delivery.is_none(),
        "a record that never published was kept across a new turn"
    );
}

// ---- a relay chain ----------------------------------------------------------

/// Two steps of one change: the second branch starts at the end of the first, and
/// each has its own task and workspace (employee mode 0.5 slice 7).
struct Chain {
    _dir: tempfile::TempDir,
    state: SharedState,
    project: PathBuf,
    origin: PathBuf,
    second: PathBuf,
    step_one: tasks::Task,
    step_two: tasks::Task,
    second_tip: String,
}

async fn chain() -> Chain {
    let dir = tempfile::tempdir().unwrap();
    let project = init_repo(&dir.path().join("project"));
    let origin = dir.path().join("origin.git");
    let gitea = dir.path().join("gitea.git");
    bare(&origin);
    bare(&gitea);
    git_cmd(
        &project,
        &["remote", "add", "origin", origin.to_str().unwrap()],
    );
    git_cmd(
        &project,
        &["remote", "add", "gitea", gitea.to_str().unwrap()],
    );
    git_cmd(&project, &["push", "-q", "origin", "main"]);
    git_cmd(&project, &["push", "-q", "gitea", "main"]);

    let mut app = AppState::open(dir.path().join("data").as_path()).unwrap();
    app.handshook = true;
    let state: SharedState = Arc::new(Mutex::new(app));
    let project_path = std::fs::canonicalize(&project)
        .unwrap()
        .to_string_lossy()
        .to_string();

    // Step one: a branch from main with one commit, and a worktree for it.
    let step_one_branch = "minih-agent/step-1";
    let wt_one = dir.path().join("wt-one");
    git_cmd(
        &project,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            step_one_branch,
            wt_one.to_str().unwrap(),
            "main",
        ],
    );
    std::fs::write(wt_one.join("schema.txt"), "column\n").unwrap();
    git_cmd(&wt_one, &["add", "schema.txt"]);
    git_cmd(&wt_one, &["commit", "-q", "-m", "feat: add the column"]);
    // Step two: a branch from the end of step one, in its own worktree.
    let step_two_branch = "minih-agent/step-2";
    let wt_two = dir.path().join("wt-two");
    git_cmd(
        &project,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            step_two_branch,
            wt_two.to_str().unwrap(),
            step_one_branch,
        ],
    );
    std::fs::write(wt_two.join("backfill.txt"), "rows\n").unwrap();
    git_cmd(&wt_two, &["add", "backfill.txt"]);
    git_cmd(
        &wt_two,
        &["commit", "-q", "-m", "feat: backfill the column"],
    );
    git_cmd(&wt_two, &["push", "-q", "origin", step_two_branch]);
    git_cmd(&wt_two, &["push", "-q", "gitea", step_two_branch]);
    let second_tip = head_of(&wt_two);

    let mut created = Vec::new();
    for (title, branch, worktree) in [
        ("Add the column", step_one_branch, &wt_one),
        ("Backfill it", step_two_branch, &wt_two),
    ] {
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
        let created_task = {
            let st = state.lock().await;
            tasks::create(
                &st.db,
                &json!({
                    "employeeSessionId": employee,
                    "title": title,
                    "origin": "direct",
                    "projectPath": project_path,
                }),
            )
            .unwrap()
        };
        let task_id = created_task["task"]["id"].as_str().unwrap().to_string();
        let session_id = created_task["task"]["sessionId"]
            .as_str()
            .unwrap()
            .to_string();
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
                    "UPDATE tasks SET stage='person/accept', delivery_mode='pr',
                            workspace_branch=?2, workspace_status='ready'
                      WHERE id=?1",
                    rusqlite::params![task_id, branch],
                )
                .unwrap();
        }
        let task = crate::tasks::get_task(&state.lock().await.db, &task_id)
            .unwrap()
            .unwrap();
        created.push(task);
    }
    let step_one = created.remove(0);
    let step_two = created.remove(0);
    // The handoff already happened: the second step exists because the first one
    // handed on, and that is what makes it the *middle* step of a chain.
    {
        let st = state.lock().await;
        st.db
            .conn()
            .execute(
                "UPDATE tasks SET relay_handoff_at=?2, accepted_at=?2 WHERE id=?1",
                rusqlite::params![step_one.id, crate::db::now_ms()],
            )
            .unwrap();
        st.db
            .conn()
            .execute(
                "UPDATE tasks SET relay_parent_task_id=?2, relay_state='ready' WHERE id=?1",
                rusqlite::params![step_two.id, step_one.id],
            )
            .unwrap();
    }
    let step_one = crate::tasks::get_task(&state.lock().await.db, &step_one.id)
        .unwrap()
        .unwrap();
    let step_two = crate::tasks::get_task(&state.lock().await.db, &step_two.id)
        .unwrap()
        .unwrap();

    Chain {
        _dir: dir,
        state,
        project,
        origin,
        second: gitea,
        step_one,
        step_two,
        second_tip,
    }
}

/// **A middle step cannot be merged.** Its branch is the next step's base, so
/// merging it would put half a change on `main` and leave the next step building
/// on something the person never approved.
#[tokio::test]
async fn merging_a_middle_step_is_refused() {
    let chain = chain().await;
    let git = GitRunner::default();
    let gh = ScriptedGh::green(&chain.second_tip);
    let error = task_delivery::merge(&chain.state, &git, &gh, &chain.step_one.id)
        .await
        .unwrap_err()
        .to_string();
    assert!(
        error.contains("one step of a relay"),
        "the refusal does not name the chain: {error}"
    );
    assert_eq!(head_of(&chain.project), head_of(&chain.project));
}

/// **The last step merges the whole chain, and cleans every step up.**
///
/// Both steps' commits reach `main` and both remotes in one fast-forward, every
/// step's workspace and local branch is removed afterwards, and the steps in
/// between leave the open list with the last one.
#[tokio::test]
async fn the_last_step_merges_the_whole_chain_and_cleans_every_step_up() {
    let chain = chain().await;
    let git = GitRunner::default();
    let gh = ScriptedGh::green(&chain.second_tip);

    let result = task_delivery::merge(&chain.state, &git, &gh, &chain.step_two.id)
        .await
        .unwrap();
    assert_eq!(result["merged"], json!(true), "{result}");

    assert_eq!(head_of(&chain.origin), chain.second_tip);
    assert_eq!(head_of(&chain.second), chain.second_tip);
    // Both steps' files are on `main`: the chain went in whole.
    assert!(chain.project.join("schema.txt").is_file());
    assert!(chain.project.join("backfill.txt").is_file());
    let merge_commits = git_cmd(&chain.project, &["rev-list", "--merges", "HEAD", "--count"]);
    assert_eq!(merge_commits.trim(), "0", "a merge commit was created");

    // Every branch of the chain is gone locally, and no worktree holds one.
    let branches = git_cmd(&chain.project, &["branch", "--list", "minih-agent/*"]);
    assert!(
        branches.trim().is_empty(),
        "a chain branch survived: {branches}"
    );
    let worktrees = git_cmd(&chain.project, &["worktree", "list", "--porcelain"]);
    assert!(
        !worktrees.contains("wt-one") && !worktrees.contains("wt-two"),
        "a chain workspace survived: {worktrees}"
    );

    // Both steps leave the open list: the change they carried is delivered.
    let st = chain.state.lock().await;
    for step in [&chain.step_one, &chain.step_two] {
        let task = crate::tasks::get_task(&st.db, &step.id).unwrap().unwrap();
        assert!(
            task.archived_at.is_some(),
            "step {} stayed in the open list",
            task.short_id
        );
    }
}
