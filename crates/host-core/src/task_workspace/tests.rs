//! The task workspace (employee mode 0.5 slice 2): where the folder goes, what
//! the task records about it, and what archiving does with it.
//!
//! Every test uses real temporary git repositories and a real database; the only
//! stub is the shell the setup command runs in, which is the production Bash
//! path.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use tokio::sync::Mutex;

use super::*;
use crate::session_worktrees::lifecycle::{self, tool_root};
use crate::session_worktrees::registry;
use crate::session_worktrees::test_support::{git_cmd, init_repo};
use crate::state::AppState;
use crate::tasks;

struct Env {
    _dir: tempfile::TempDir,
    state: SharedState,
    git: GitRunner,
    project: PathBuf,
}

fn env(with_employee_project: bool) -> Env {
    let dir = tempfile::tempdir().unwrap();
    let project = init_repo(&dir.path().join("project"));
    fs::write(project.join("f.txt"), "base\n").unwrap();
    git_cmd(&project, &["add", "f.txt"]);
    git_cmd(&project, &["commit", "-q", "-m", "f"]);
    let data = dir.path().join("data");
    fs::create_dir_all(&data).unwrap();
    let state = Arc::new(Mutex::new(AppState::open(&data).unwrap()));
    if with_employee_project {
        let st = state.try_lock().unwrap();
        st.db
            .ensure_project(&project.to_string_lossy(), true)
            .unwrap();
    }
    Env {
        _dir: dir,
        state,
        git: GitRunner::default(),
        project,
    }
}

/// An employee, and one task under it. `project` decides whether the task is
/// bound to a repository.
async fn task(env: &Env, project: Option<&Path>) -> (String, String) {
    let st = env.state.lock().await;
    let employee = crate::sessions::create_session_with_options(
        &st.db,
        crate::sessions::SessionCreateOptions {
            title: Some("Router 后端".into()),
            mode: Some("agent".into()),
            permission_mode: Some("accept-edits".into()),
            project_path: project.map(|path| path.to_string_lossy().into_owned()),
            role: Some("bot".into()),
            bot_profile_json: Some(
                r#"{"name":"Router 后端","permissionMode":"accept-edits","mustAsk":[],"observe":false}"#
                    .into(),
            ),
            ..Default::default()
        },
    )
    .unwrap()
    .id;
    let tx = st.db.conn().unchecked_transaction().unwrap();
    let created = tasks::create_in(
        &st.db,
        &tx,
        tasks::CreateRequest {
            employee_session_id: &employee,
            title: "Fix the login timeout",
            origin: "direct",
            project_path: project.map(|path| path.to_string_lossy().into_owned()),
            branch: None,
            source_utterance: None,
            delivery_id: None,
            permission_mode: None,
        },
    )
    .unwrap();
    tx.commit().unwrap();
    (created.id, created.session_id)
}

async fn read(env: &Env, task_id: &str) -> tasks::Task {
    let st = env.state.lock().await;
    tasks::get_task(&st.db, task_id).unwrap().unwrap()
}

fn canonical(path: &Path) -> PathBuf {
    crate::workspace::simple_canonicalize(path).unwrap()
}

// ---- names and identity ----------------------------------------------------

#[test]
fn a_folder_name_is_a_short_id_and_a_slug_of_the_title() {
    assert_eq!(
        workspace_name("a1b2c3", "Fix the login timeout"),
        "a1b2c3-fix-the-login-timeout"
    );
    // Only `[a-z0-9-]`, and 40 characters at most.
    assert_eq!(slugify("Fix: login/timeout!"), "fix-login-timeout");
    assert_eq!(slugify("   "), "");
    assert_eq!(slugify("修一下登录超时"), "");
    assert_eq!(
        workspace_name("a1b2c3", "修一下登录超时"),
        "a1b2c3-task",
        "a title with no ASCII letters still needs a usable folder name"
    );
    let long = slugify(&"a".repeat(120));
    assert_eq!(long.chars().count(), 40);
    let punctuation = slugify("a---b   c");
    assert_eq!(punctuation, "a-b-c");
}

#[test]
fn a_repository_origin_is_normalized_the_way_the_mandate_stores_it() {
    for input in [
        "git@github.com:minih-git/minih-agent-desktop.git",
        "https://github.com/minih-git/minih-agent-desktop.git",
        "https://github.com/minih-git/minih-agent-desktop",
        "ssh://git@github.com/minih-git/minih-agent-desktop.git/",
        "github.com/minih-git/minih-agent-desktop",
    ] {
        assert_eq!(
            normalize_repo_origin(input).as_deref(),
            Some("github.com/minih-git/minih-agent-desktop"),
            "{input}"
        );
    }
    // Only the host is case-insensitive: two owners that differ in case are two
    // repositories.
    assert_eq!(
        normalize_repo_origin("git@GitHub.com:Minih-Git/Router.git").as_deref(),
        Some("github.com/Minih-Git/Router")
    );
    assert_eq!(normalize_repo_origin("not-a-remote"), None);
    assert_eq!(normalize_repo_origin("   "), None);
}

/// The delivery route is read from the project's own remotes; nothing asks the
/// person, and nothing needs the network.
#[tokio::test]
async fn the_delivery_route_follows_the_projects_remote() {
    let env = env(false);
    assert_eq!(delivery_mode(&env.git, None).await, DeliveryMode::None);
    assert_eq!(
        delivery_mode(&env.git, Some(&env.project.to_string_lossy())).await,
        DeliveryMode::Local,
        "a project without a remote merges back locally"
    );

    git_cmd(
        &env.project,
        &[
            "remote",
            "add",
            "origin",
            "git@gitea.example.com:team/router.git",
        ],
    );
    assert_eq!(
        delivery_mode(&env.git, Some(&env.project.to_string_lossy())).await,
        DeliveryMode::Local
    );

    git_cmd(
        &env.project,
        &[
            "remote",
            "set-url",
            "origin",
            "git@github.com:minih-git/router.git",
        ],
    );
    assert_eq!(
        delivery_mode(&env.git, Some(&env.project.to_string_lossy())).await,
        DeliveryMode::Pr,
        "a GitHub remote delivers as a pull request"
    );

    // A second, non-GitHub remote does not change that: one GitHub remote is
    // enough to deliver as a PR.
    git_cmd(
        &env.project,
        &[
            "remote",
            "add",
            "origin2",
            "https://gitea.example.com/team/router.git",
        ],
    );
    assert_eq!(
        delivery_mode(&env.git, Some(&env.project.to_string_lossy())).await,
        DeliveryMode::Pr
    );
}

/// A card names a repository; the checkout is found by comparing the remotes of
/// the projects this computer already knows.
#[tokio::test]
async fn a_card_repository_maps_to_the_local_project_that_points_at_it() {
    let env = env(true);
    git_cmd(
        &env.project,
        &[
            "remote",
            "add",
            "origin",
            "git@github.com:minih-git/router.git",
        ],
    );
    let paths = {
        let st = env.state.lock().await;
        project_paths(&st.db).unwrap()
    };
    assert_eq!(
        project_for_origin(&env.git, &paths, "github.com/minih-git/router")
            .await
            .map(|path| canonical(Path::new(&path))),
        Some(canonical(&env.project))
    );
    // A `refs`-style spelling of the same repository still matches.
    assert_eq!(
        project_for_origin(&env.git, &paths, "https://github.com/minih-git/router.git")
            .await
            .map(|path| canonical(Path::new(&path))),
        Some(canonical(&env.project))
    );
    // Another repository on the same host does not.
    assert_eq!(
        project_for_origin(&env.git, &paths, "github.com/minih-git/elsewhere").await,
        None
    );
    // And neither does a project this computer does not have at all.
    assert_eq!(
        project_for_origin(&env.git, &[], "github.com/minih-git/router").await,
        None
    );
}

// ---- preparation -----------------------------------------------------------

/// The representative path: a task on an employee that has a project gets a
/// folder inside the repository, its real branch, and its start point — and the
/// session's tool root is that folder, which is what the runtime launches in.
#[tokio::test]
async fn preparing_a_task_makes_its_session_work_in_the_repositorys_worktree() {
    let env = env(true);
    let (task_id, session_id) = task(&env, Some(&env.project)).await;

    prepare(&env.state, &env.git, &task_id).await.unwrap();

    let row = read(&env, &task_id).await;
    assert_eq!(row.workspace_status, "ready", "{:?}", row.workspace_error);
    assert_eq!(row.delivery_mode.as_deref(), Some("local"));
    assert_eq!(row.base_ref.as_deref(), Some("refs/heads/main"));
    assert!(!row.base_remote);
    assert_eq!(
        row.workspace_branch.as_deref(),
        Some(
            format!(
                "minih-agent/{}",
                crate::session_worktrees::lifecycle::short_id(&session_id)
            )
            .as_str()
        )
    );
    assert!(
        row.branch.is_none(),
        "the task asked for no particular branch"
    );

    // Where the folder is.
    let expected = canonical(
        &env.project
            .join(".worktree")
            .join(workspace_name(&row.short_id, "Fix the login timeout")),
    );
    let st = env.state.lock().await;
    let registered = registry::for_owner(&st.db, &session_id, None)
        .unwrap()
        .unwrap();
    assert_eq!(canonical(Path::new(&registered.path)), expected);
    // Recorded on the task as well, so the workbench does not have to guess.
    let stored: String = st
        .db
        .conn()
        .query_row(
            "SELECT workspace_path FROM tasks WHERE id=?1",
            rusqlite::params![task_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(canonical(Path::new(&stored)), expected);
    drop(st);

    // What the runtime actually gets: `tool_root`, not a display string.
    let root = {
        let st = env.state.lock().await;
        tool_root(&st.db, &session_id).unwrap().unwrap()
    };
    assert_eq!(canonical(&root), expected);
    assert!(root.join("f.txt").is_file());
    // The project is still clean.
    assert_eq!(git_cmd(&env.project, &["status", "--porcelain"]), "");
}

/// A task without a project is not prepared at all: it works in the session's
/// own folder, and the row says so.
#[tokio::test]
async fn a_task_without_a_repository_has_no_workspace() {
    let env = env(true);
    let (task_id, session_id) = task(&env, None).await;
    prepare(&env.state, &env.git, &task_id).await.unwrap();
    let row = read(&env, &task_id).await;
    assert_eq!(row.workspace_status, "none");
    assert_eq!(row.delivery_mode.as_deref(), Some("none"));
    assert!(row.base_ref.is_none());
    let st = env.state.lock().await;
    assert!(registry::for_session(&st.db, &session_id)
        .unwrap()
        .is_empty());
    assert!(tool_root(&st.db, &session_id).unwrap().is_none());
}

/// A failing setup command fails the preparation, and the retry runs the fixed
/// command in the same folder instead of building a second one.
#[tokio::test]
async fn a_failed_setup_command_can_be_retried_in_the_same_worktree() {
    let env = env(true);
    let path = env.project.to_string_lossy().to_string();
    {
        let st = env.state.lock().await;
        lifecycle::set_setup_command(&st.db, &path, Some("exit 3"))
            .unwrap()
            .then_some(())
            .unwrap();
    }
    let (task_id, session_id) = task(&env, Some(&env.project)).await;

    prepare(&env.state, &env.git, &task_id).await.unwrap();
    let failed = read(&env, &task_id).await;
    assert_eq!(failed.workspace_status, "failed");
    let error = failed.workspace_error.clone().unwrap_or_default();
    assert!(
        error.contains("setup command failed"),
        "the failure does not say what happened: {error}"
    );
    // The folder and the branch were still recorded: the retry needs them.
    assert!(failed.workspace_branch.is_some());
    let root = {
        let st = env.state.lock().await;
        tool_root(&st.db, &session_id).unwrap().unwrap()
    };
    assert!(root.is_dir());

    // The person fixes the command; the retry re-runs it here.
    {
        let st = env.state.lock().await;
        lifecycle::set_setup_command(&st.db, &path, Some("mkdir -p deps && touch deps/ready"))
            .unwrap();
    }
    prepare(&env.state, &env.git, &task_id).await.unwrap();
    let ready = read(&env, &task_id).await;
    assert_eq!(
        ready.workspace_status, "ready",
        "{:?}",
        ready.workspace_error
    );
    assert!(root.join("deps/ready").is_file(), "the retry did not run");
    // One folder, one branch: the retry reused what existed.
    let st = env.state.lock().await;
    assert_eq!(registry::for_session(&st.db, &session_id).unwrap().len(), 1);
}

/// A project that cannot host a worktree fails the preparation instead of
/// leaving a task that looks ready and has nowhere to work.
#[tokio::test]
async fn a_project_that_is_not_a_repository_fails_the_preparation() {
    let env = env(false);
    let plain = env._dir.path().join("plain");
    fs::create_dir_all(&plain).unwrap();
    let (task_id, _session_id) = task(&env, Some(&plain)).await;
    prepare(&env.state, &env.git, &task_id).await.unwrap();
    let row = read(&env, &task_id).await;
    assert_eq!(row.workspace_status, "failed");
    assert!(row
        .workspace_error
        .as_deref()
        .unwrap_or_default()
        .contains("not inside a git working tree"));
}

// ---- archive ---------------------------------------------------------------

/// A workspace whose work has left the machine is removed with the archive.
#[tokio::test]
async fn archiving_a_clean_workspace_removes_it() {
    let env = env(true);
    let (task_id, session_id) = task(&env, Some(&env.project)).await;
    prepare(&env.state, &env.git, &task_id).await.unwrap();
    let root = {
        let registered = {
            let st = env.state.lock().await;
            registry::for_owner(&st.db, &session_id, None)
                .unwrap()
                .unwrap()
        };
        PathBuf::from(registered.path)
    };

    cleanup_for_archive(&env.state, &env.git, &task_id, false)
        .await
        .unwrap();
    assert!(!root.exists());
    // The task no longer has a workspace: a `ready` here would offer a retry for
    // a folder that was just deleted.
    let after = read(&env, &task_id).await;
    assert_eq!(after.workspace_status, "none");
    assert!(
        after.workspace_error.is_none(),
        "{:?}",
        after.workspace_error
    );
    let st = env.state.lock().await;
    assert!(registry::for_session(&st.db, &session_id)
        .unwrap()
        .is_empty());
    assert!(
        !git_cmd(&env.project, &["branch", "--list"]).contains(&format!(
            "minih-agent/{}",
            crate::session_worktrees::lifecycle::short_id(&session_id)
        ))
    );
}

/// A task that made no commits can be archived even while the project's own
/// branch is behind the remote it started from.
///
/// Counting `main..branch` reported the *remote's* commit as the task's work, so
/// a task that had done nothing asked the person to confirm discarding a commit
/// they never wrote. The start point is excluded from the count.
#[tokio::test]
async fn a_task_with_no_commits_of_its_own_archives_even_when_the_project_is_behind() {
    let env = env(true);
    let bare = env._dir.path().join("remote.git");
    fs::create_dir_all(&bare).unwrap();
    git_cmd(&bare, &["init", "--bare", "-q", "-b", "main"]);
    git_cmd(
        &env.project,
        &["remote", "add", "origin", &bare.to_string_lossy()],
    );
    git_cmd(&env.project, &["push", "-q", "origin", "main"]);

    // Another clone moves the remote forward; this checkout stays where it was.
    let other = env._dir.path().join("other");
    fs::create_dir_all(&other).unwrap();
    git_cmd(&other, &["clone", "-q", &bare.to_string_lossy(), "."]);
    git_cmd(&other, &["config", "user.name", "PI Test"]);
    git_cmd(&other, &["config", "user.email", "pi-test@example.invalid"]);
    fs::write(other.join("remote-only.txt"), "from remote\n").unwrap();
    git_cmd(&other, &["add", "."]);
    git_cmd(&other, &["commit", "-q", "-m", "remote work"]);
    git_cmd(&other, &["push", "-q", "origin", "main"]);

    let (task_id, session_id) = task(&env, Some(&env.project)).await;
    prepare(&env.state, &env.git, &task_id).await.unwrap();
    let row = read(&env, &task_id).await;
    assert_eq!(row.workspace_status, "ready", "{:?}", row.workspace_error);
    assert_eq!(row.base_ref.as_deref(), Some("refs/remotes/origin/main"));
    assert!(row.base_remote);
    // The local branch really is behind the ref the task started from: the old
    // count would have reported exactly that one commit.
    assert_eq!(
        git_cmd(&env.project, &["rev-list", "--count", "main..origin/main"]).trim(),
        "1"
    );

    let work = unsaved_work(
        &env.state,
        &env.git,
        &session_id,
        DeliveryMode::Local,
        row.base_ref.as_deref(),
    )
    .await
    .unwrap();
    assert!(work.is_empty(), "the task's own work is empty: {work:?}");

    // So the archive goes straight through, with no discard confirmation.
    cleanup_for_archive(&env.state, &env.git, &task_id, false)
        .await
        .unwrap();
    assert_eq!(read(&env, &task_id).await.workspace_status, "none");
}

/// A count that cannot be read refuses the archive instead of assuming zero.
///
/// `rev-list` fails for reasons that have nothing to do with the task — the
/// project's branch was renamed, the repository is damaged, the command timed
/// out — and the first version turned every one of them into "0 commits left".
/// The archive then removed the folder and its branch without a question,
/// deleting commits that existed only on this machine. The uncommitted-file side
/// already refused on error; this side has to agree.
#[tokio::test]
async fn an_unreadable_commit_count_blocks_the_archive_instead_of_deleting_work() {
    let env = env(true);
    let (task_id, session_id) = task(&env, Some(&env.project)).await;
    prepare(&env.state, &env.git, &task_id).await.unwrap();
    let root = {
        let st = env.state.lock().await;
        let registered = registry::for_owner(&st.db, &session_id, None)
            .unwrap()
            .unwrap();
        PathBuf::from(registered.path)
    };
    // The task's own work, which only exists here.
    fs::write(root.join("f.txt"), "task work\n").unwrap();
    git_cmd(&root, &["commit", "-q", "-am", "task work"]);

    // Break the comparison the count needs: the project's branch is renamed, so
    // the delivery target the exclusion list names no longer resolves.
    git_cmd(&env.project, &["branch", "-m", "main", "renamed"]);

    let error = cleanup_for_archive(&env.state, &env.git, &task_id, false)
        .await
        .unwrap_err();
    assert_eq!(error.code, WORKSPACE_UNSAVED_UNKNOWN, "{}", error.message);
    assert!(
        error.message.contains("could not be checked"),
        "the refusal does not say what failed: {}",
        error.message
    );
    // Nothing was removed: the worktree and the task's branch are still there.
    assert!(
        root.exists(),
        "the worktree was removed on an unreadable count"
    );
    assert!(root.join("f.txt").is_file());
    assert_eq!(read(&env, &task_id).await.workspace_status, "ready");

    // The person's explicit discard still ends it.
    cleanup_for_archive(&env.state, &env.git, &task_id, true)
        .await
        .unwrap();
    assert!(!root.exists());
    assert_eq!(read(&env, &task_id).await.workspace_status, "none");
}

/// Uncommitted files stop the archive, and the person's second click removes it.
#[tokio::test]
async fn archiving_refuses_uncommitted_work_until_it_is_discarded() {
    let env = env(true);
    let (task_id, session_id) = task(&env, Some(&env.project)).await;
    prepare(&env.state, &env.git, &task_id).await.unwrap();
    let root = {
        let st = env.state.lock().await;
        let registered = registry::for_owner(&st.db, &session_id, None)
            .unwrap()
            .unwrap();
        PathBuf::from(registered.path)
    };
    fs::write(root.join("draft.txt"), "not committed\n").unwrap();

    let error = cleanup_for_archive(&env.state, &env.git, &task_id, false)
        .await
        .unwrap_err();
    assert_eq!(error.code, WORKSPACE_UNSAVED);
    assert!(
        error.message.contains("1 uncommitted file"),
        "{}",
        error.message
    );
    assert!(
        root.exists(),
        "a refused archive removed the worktree anyway"
    );

    // The second click discards it.
    cleanup_for_archive(&env.state, &env.git, &task_id, true)
        .await
        .unwrap();
    assert!(!root.exists());
}

/// Commits that never left this machine stop the archive too, and are counted.
#[tokio::test]
async fn archiving_refuses_commits_that_never_left_the_machine() {
    let env = env(true);
    let (task_id, _session_id) = task(&env, Some(&env.project)).await;
    prepare(&env.state, &env.git, &task_id).await.unwrap();
    let root = {
        let st = env.state.lock().await;
        let registered = registry::for_owner(&st.db, &_session_id, None)
            .unwrap()
            .unwrap();
        PathBuf::from(registered.path)
    };
    fs::write(root.join("f.txt"), "task work\n").unwrap();
    git_cmd(&root, &["commit", "-q", "-am", "task work"]);

    let error = cleanup_for_archive(&env.state, &env.git, &task_id, false)
        .await
        .unwrap_err();
    assert_eq!(error.code, WORKSPACE_UNSAVED);
    assert!(
        error.message.contains("1 unpushed commit"),
        "{}",
        error.message
    );
    // The work is still there: nothing was thrown away by the refusal.
    assert!(root.join("f.txt").is_file());
    assert_eq!(
        fs::read_to_string(env.project.join("f.txt")).unwrap(),
        "base\n"
    );
}
