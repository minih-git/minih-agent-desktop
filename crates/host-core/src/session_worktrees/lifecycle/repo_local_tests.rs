//! Repo-local placement for task sessions (ADR 0329 amendment 2026-11).
//!
//! These are the properties the amendment turns on: the folder sits inside the
//! repository without dirtying it, the ignore rule is a local exclude, the
//! branch starts from the remote branch when one can be fetched, and every other
//! path — registry, tool root, behind, sync, merge, removal — keeps working on a
//! path inside the project.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use tokio::sync::Mutex;

use super::*;
use crate::session_worktrees::delegate;
use crate::session_worktrees::test_support::{git_cmd, init_repo};

struct Env {
    _dir: tempfile::TempDir,
    state: SharedState,
    git: GitRunner,
    project: PathBuf,
}

fn env() -> Env {
    let dir = tempfile::tempdir().unwrap();
    let project = init_repo(&dir.path().join("project"));
    fs::write(project.join("f.txt"), "base\n").unwrap();
    git_cmd(&project, &["add", "f.txt"]);
    git_cmd(&project, &["commit", "-q", "-m", "f"]);
    let data = dir.path().join("data");
    fs::create_dir_all(&data).unwrap();
    let state = Arc::new(Mutex::new(AppState::open(&data).unwrap()));
    Env {
        _dir: dir,
        state,
        git: GitRunner::default(),
        project,
    }
}

async fn new_session(env: &Env) -> String {
    let st = env.state.lock().await;
    sessions::create_session_with_options(
        &st.db,
        sessions::SessionCreateOptions {
            title: Some("Task".into()),
            mode: None,
            provider_id: None,
            model_id: None,
            project_path: Some(env.project.to_string_lossy().into_owned()),
            thinking_level: None,
            permission_mode: None,
            role: Some("task".into()),
            bot_profile_json: None,
        },
    )
    .unwrap()
    .id
}

async fn repo_local(
    env: &Env,
    session: &str,
    name: &str,
) -> Result<CreatedWorktree, WorktreeError> {
    create_session_worktree(
        &env.state,
        &env.git,
        session,
        &env.project.to_string_lossy(),
        Placement::RepoLocal(name),
    )
    .await
}

fn canonical(path: &Path) -> PathBuf {
    crate::workspace::simple_canonicalize(path).unwrap()
}

/// A bare repository other clones can push to, standing in for GitHub.
fn bare_remote(dir: &Path) -> PathBuf {
    let bare = dir.join("remote.git");
    fs::create_dir_all(&bare).unwrap();
    git_cmd(&bare, &["init", "--bare", "-q", "-b", "main"]);
    bare
}

/// The folder is inside the repository, the project stays clean, and the ignore
/// rule is the repository's local `info/exclude` — not a change to
/// `.gitignore` and not a commit.
#[tokio::test]
async fn a_repo_local_worktree_lives_in_the_repository_and_keeps_it_clean() {
    let env = env();
    let session = new_session(&env).await;
    let created = repo_local(&env, &session, "task-1-fix-login")
        .await
        .unwrap();

    let root = canonical(&env.project.join(".worktree/task-1-fix-login"));
    assert!(root.join("f.txt").is_file());
    assert_eq!(
        canonical(
            &tool_root(&env.state.lock().await.db, &session)
                .unwrap()
                .unwrap()
        ),
        root
    );
    // The project sees no new file, and its own ignore file is untouched.
    assert_eq!(git_cmd(&env.project, &["status", "--porcelain"]), "");
    assert!(!env.project.join(".gitignore").exists());
    let exclude = fs::read_to_string(env.project.join(".git/info/exclude")).unwrap();
    assert_eq!(exclude.matches(".worktree/").count(), 1, "{exclude}");
    // Everything else reads the registry row, so the path is the only change.
    let row = registry::for_owner(&env.state.lock().await.db, &session, None)
        .unwrap()
        .unwrap();
    assert_eq!(canonical(Path::new(&row.path)), root);
    assert_eq!(row.branch, format!("minih-agent/{}", short_id(&session)));
    assert_eq!(created.worktree.branch, row.branch);
    // No remote: the branch starts from the project's own tip, and says so.
    let base = created.base.unwrap();
    assert_eq!(base.ref_name, "refs/heads/main");
    assert!(!base.remote);
}

/// The exclude entry is written once, no matter how many task worktrees the
/// project gets, and a real `.gitignore` is never edited.
#[tokio::test]
async fn the_exclude_entry_is_written_once_and_a_gitignore_is_never_edited() {
    let env = env();
    fs::write(env.project.join(".gitignore"), "target\n").unwrap();
    git_cmd(&env.project, &["add", ".gitignore"]);
    git_cmd(&env.project, &["commit", "-q", "-m", "ignore"]);
    let before = fs::read_to_string(env.project.join(".gitignore")).unwrap();

    for name in ["task-1-a", "task-2-b"] {
        let session = new_session(&env).await;
        repo_local(&env, &session, name).await.unwrap();
    }

    let exclude = fs::read_to_string(env.project.join(".git/info/exclude")).unwrap();
    assert_eq!(exclude.matches(".worktree/").count(), 1, "{exclude}");
    assert_eq!(
        fs::read_to_string(env.project.join(".gitignore")).unwrap(),
        before
    );
    assert_eq!(git_cmd(&env.project, &["status", "--porcelain"]), "");
}

/// The branch starts from `<remote>/<branch>` after a fetch, so a task works on
/// what the project actually has rather than on a stale local copy.
#[tokio::test]
async fn a_repo_local_worktree_starts_from_the_fetched_remote_branch() {
    let env = env();
    let bare = bare_remote(env._dir.path());
    git_cmd(
        &env.project,
        &["remote", "add", "origin", &bare.to_string_lossy()],
    );
    git_cmd(&env.project, &["push", "-q", "origin", "main"]);

    // Another clone moves the remote forward; this checkout has not seen it.
    let other = env._dir.path().join("other");
    fs::create_dir_all(&other).unwrap();
    git_cmd(&other, &["clone", "-q", &bare.to_string_lossy(), "."]);
    git_cmd(&other, &["config", "user.name", "PI Test"]);
    git_cmd(&other, &["config", "user.email", "pi-test@example.invalid"]);
    fs::write(other.join("remote-only.txt"), "from remote\n").unwrap();
    git_cmd(&other, &["add", "."]);
    git_cmd(&other, &["commit", "-q", "-m", "remote work"]);
    git_cmd(&other, &["push", "-q", "origin", "main"]);

    let session = new_session(&env).await;
    let created = repo_local(&env, &session, "task-9-remote").await.unwrap();
    let base = created.base.unwrap();
    assert_eq!(base.ref_name, "refs/remotes/origin/main");
    assert!(base.remote);
    let root = canonical(&env.project.join(".worktree/task-9-remote"));
    assert!(
        root.join("remote-only.txt").is_file(),
        "the worktree did not start from the fetched remote branch"
    );
    // The project itself is still where it was: only the task moved forward.
    assert!(!env.project.join("remote-only.txt").exists());
}

/// Behind, sync, merge, and removal read the registry row, so a folder inside
/// the repository needs no special case.
#[tokio::test]
async fn a_repo_local_worktree_is_behind_syncs_merges_and_removes() {
    let env = env();
    let session = new_session(&env).await;
    let created = repo_local(&env, &session, "task-3-merge").await.unwrap();
    let root = canonical(&env.project.join(".worktree/task-3-merge"));
    fs::write(root.join("f.txt"), "task\n").unwrap();
    git_cmd(&root, &["commit", "-q", "-am", "task work"]);

    // The project moves on after the worktree was created.
    fs::write(env.project.join("g.txt"), "project\n").unwrap();
    git_cmd(&env.project, &["add", "g.txt"]);
    git_cmd(&env.project, &["commit", "-q", "-m", "project work"]);
    assert_eq!(
        behind_session(&env.state, &env.git, &session)
            .await
            .unwrap(),
        1
    );

    sync_session(&env.state, &env.git, &session).await.unwrap();
    assert!(root.join("g.txt").is_file(), "the sync did not land");
    assert_eq!(fs::read_to_string(root.join("f.txt")).unwrap(), "task\n");

    let preview = preview_session(&env.state, &env.git, &session)
        .await
        .unwrap();
    merge_session(&env.state, &env.git, &session, &preview.preview_token)
        .await
        .unwrap();
    assert_eq!(
        fs::read_to_string(env.project.join("f.txt")).unwrap(),
        "task\n"
    );

    remove_session_worktrees(&env.state, &env.git, &session)
        .await
        .unwrap();
    assert!(!root.exists());
    assert!(!git_cmd(&env.project, &["branch", "--list"]).contains(&created.worktree.branch));
    assert_eq!(git_cmd(&env.project, &["status", "--porcelain"]), "");
    assert!(registry::for_session(&env.state.lock().await.db, &session)
        .unwrap()
        .is_empty());
}

/// A worktree folder name that could escape `<top level>/.worktree/` is refused
/// before anything is created.
#[tokio::test]
async fn a_worktree_name_that_is_not_one_segment_is_refused() {
    let env = env();
    let session = new_session(&env).await;
    for name in ["../escape", "a/b", "", "task 1"] {
        let error = repo_local(&env, &session, name).await.unwrap_err();
        assert_eq!(error.code, "WORKTREE_PATH_INVALID", "name {name:?}");
    }
    assert!(
        !env.project.join(".worktree").exists() || {
            fs::read_dir(env.project.join(".worktree")).unwrap().count() == 0
        }
    );
    assert!(registry::for_session(&env.state.lock().await.db, &session)
        .unwrap()
        .is_empty());
}

/// The subagent's own worktree is placed next to its session's, which for a
/// repo-local session means inside the same `.worktree` directory, and its work
/// still merges back into the task's branch.
#[tokio::test]
async fn a_subagent_of_a_repo_local_session_gets_a_sibling_worktree() {
    let env = env();
    let session = new_session(&env).await;
    repo_local(&env, &session, "task-4-subagent").await.unwrap();

    let summary = delegate::create_delegate_worktree(&env.state, &env.git, &session, "chain-1")
        .await
        .unwrap();
    let row = registry::for_owner(&env.state.lock().await.db, &session, Some("chain-1"))
        .unwrap()
        .unwrap();
    assert_eq!(
        canonical(Path::new(&row.path).parent().unwrap()),
        canonical(&env.project.join(".worktree"))
    );
    assert!(canonical(Path::new(&row.path)).starts_with(canonical(&env.project.join(".worktree"))));
    assert!(summary.branch.starts_with("minih-agent/"));

    let root = delegate::tool_root(&env.state.lock().await.db, &session, Some("chain-1"))
        .unwrap()
        .unwrap();
    fs::write(root.join("sub.txt"), "subagent\n").unwrap();
    git_cmd(&root, &["add", "sub.txt"]);
    git_cmd(&root, &["commit", "-q", "-m", "subagent work"]);

    let settlement =
        delegate::settle_delegate_worktree(&env.state, &env.git, &session, "chain-1", true)
            .await
            .unwrap();
    assert!(
        matches!(settlement, delegate::DelegateSettlement::Merged { .. }),
        "{settlement:?}"
    );
    let session_root = tool_root(&env.state.lock().await.db, &session)
        .unwrap()
        .unwrap();
    assert!(session_root.join("sub.txt").is_file());
    assert_eq!(git_cmd(&env.project, &["status", "--porcelain"]), "");
}
