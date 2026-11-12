//! Creating a session's worktree, preparing it, and the repo-local placement of
//! task sessions (ADR 0329 and its 2026-11 amendment).
//!
//! A worktree is created in one of two places: under the data directory (this
//! ADR's own address, the default) or inside the repository, which is where a
//! task session works. Both go through the same registry row, so every later
//! path — tool root, behind, sync, merge, removal — is shared.
//!
//! The project's setup command runs here too: in the background for an ordinary
//! isolated session (ADR 0329 decision 8) and awaited for a task, whose first
//! turn may not start in a half-prepared folder.

use super::*;
use crate::session_worktrees::probe::RepoInfo;
use serde::Serialize;

/// Bound for the per-project setup command (dependency installs can be slow).
pub const SETUP_TIMEOUT_MS: u64 = 30 * 60 * 1000;
const SETUP_LOG_LIMIT: usize = 16 * 1024;

/// Where a session's worktree is created (ADR 0329; amendment 2026-11).
///
/// `DataDir` is the address the ADR chose and stays the default. `RepoLocal`
/// puts a task's worktree inside its repository: the person works on a task in
/// the project it belongs to and expects the folder next to the project, not
/// under the app's data directory.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Placement<'a> {
    /// `<data dir>/worktrees/<project key>/<short session id>`.
    DataDir,
    /// `<repository top level>/.worktree/<name>`.
    RepoLocal(&'a str),
}

/// The ref a repo-local worktree branch was started from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BasePoint {
    /// `refs/remotes/<remote>/<branch>`, or `refs/heads/<branch>` when the
    /// project has no remote (or the fetch failed).
    #[serde(rename = "ref")]
    pub ref_name: String,
    /// True when the ref was fetched from the project's remote first.
    pub remote: bool,
}

/// The directory a repo-local worktree lives in, inside the repository.
pub const REPO_LOCAL_DIR: &str = ".worktree";

/// A worktree folder name is one path segment, so it can never escape
/// `<top level>/.worktree/`.
pub fn check_local_name(name: &str) -> Result<(), WorktreeError> {
    let usable = !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if usable {
        return Ok(());
    }
    Err(WorktreeError::new(
        "WORKTREE_PATH_INVALID",
        format!("`{name}` is not usable as a worktree folder name"),
    ))
}

/// `RepoLocal` must not leave the project dirty: `<top level>/.worktree/` is
/// checked against every ignore source, and when the project does not ignore
/// it the pattern is appended to `<common dir>/info/exclude`.
///
/// `info/exclude` is local to this checkout and is never committed, so the
/// person's `.gitignore` keeps meaning what they wrote. The append happens
/// once: a file that already carries the pattern is left alone.
pub async fn ensure_local_dir_ignored(
    git: &GitRunner,
    repo: &RepoInfo,
) -> Result<(), WorktreeError> {
    let sample = format!("{REPO_LOCAL_DIR}/sample");
    let ignored = git
        .output(&repo.toplevel, &["check-ignore", "-q", "--", &sample])
        .await?;
    if ignored.success() {
        return Ok(());
    }
    let info = repo.common_dir.join("info");
    std::fs::create_dir_all(&info)?;
    let exclude = info.join("exclude");
    let existing = std::fs::read_to_string(&exclude).unwrap_or_default();
    let covered = existing.lines().any(|line| {
        let line = line.trim();
        line == REPO_LOCAL_DIR
            || line == format!("{REPO_LOCAL_DIR}/")
            || line == format!("/{REPO_LOCAL_DIR}/")
    });
    if covered {
        return Ok(());
    }
    let mut text = existing;
    if !text.is_empty() && !text.ends_with('\n') {
        text.push('\n');
    }
    text.push_str(&format!(
        "# Minih-Agent-Desktop task worktrees\n{REPO_LOCAL_DIR}/\n"
    ));
    std::fs::write(&exclude, text)?;
    Ok(())
}

/// The remote a project's current branch belongs to: the branch's own remote,
/// else `origin`, else the only remote it has.
async fn default_remote(git: &GitRunner, project: &Path, branch: &str) -> Option<String> {
    if let Ok(output) = git
        .output(
            project,
            &["config", "--get", &format!("branch.{branch}.remote")],
        )
        .await
    {
        let name = output.stdout.trim();
        if output.success() && !name.is_empty() && name != "." {
            return Some(name.to_string());
        }
    }
    let output = git.output(project, &["remote"]).await.ok()?;
    let remotes: Vec<&str> = output
        .stdout
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();
    if remotes.contains(&"origin") {
        return Some("origin".to_string());
    }
    remotes.first().map(|name| (*name).to_string())
}

/// Start a repo-local branch from the project's remote counterpart when there
/// is one, else from its local tip.
///
/// A fetch failure is not a creation failure: the person still gets a
/// worktree, and the returned [`BasePoint`] says which commit it really came
/// from. Task sessions report that instead of pretending they are current.
pub async fn repo_local_base(
    git: &GitRunner,
    project: &Path,
    repo: &RepoInfo,
) -> (String, BasePoint) {
    let local = merge::head_ref(&repo.branch);
    let Some(remote) = default_remote(git, project, &repo.branch).await else {
        return (
            local.clone(),
            BasePoint {
                ref_name: local,
                remote: false,
            },
        );
    };
    let tracking = format!("refs/remotes/{remote}/{}", repo.branch);
    // An explicit refspec, so the remote-tracking ref this call reads is the
    // one it fetches regardless of how the remote was configured.
    let refspec = format!("+refs/heads/{branch}:{tracking}", branch = repo.branch);
    match git
        .output(
            project,
            &["fetch", "--no-tags", "--quiet", &remote, &refspec],
        )
        .await
    {
        Err(error) => {
            tracing::warn!(%error, %remote, "could not fetch the project before creating a worktree")
        }
        Ok(output) if !output.success() => tracing::warn!(
            stderr = output.stderr.trim(),
            %remote,
            "could not fetch the project before creating a worktree"
        ),
        Ok(_) => {}
    }
    let fetched = git
        .output(
            &repo.toplevel,
            &["show-ref", "--verify", "--quiet", &tracking],
        )
        .await
        .map(|output| output.success())
        .unwrap_or(false);
    if fetched {
        (
            tracking.clone(),
            BasePoint {
                ref_name: tracking,
                remote: true,
            },
        )
    } else {
        (
            local.clone(),
            BasePoint {
                ref_name: local,
                remote: false,
            },
        )
    }
}
/// Create the session's own worktree, copy `.worktreeinclude` files, and start
/// the optional setup command in the background. On failure nothing is left
/// behind.
///
/// `placement` decides where the folder goes and where its branch starts:
/// `DataDir` is the ADR's own address (from the project's current branch tip),
/// `RepoLocal` sits inside the repository and starts from the project's remote
/// branch when it can fetch one.
pub async fn create_session_worktree(
    state: &SharedState,
    git: &GitRunner,
    session_id: &str,
    project_path: &str,
    placement: Placement<'_>,
) -> Result<CreatedWorktree, WorktreeError> {
    let project = Path::new(project_path);
    let repo = probe(git, project).await?;
    let project_had_uncommitted_changes = !merge::worktree_status(git, project).await?.is_empty();
    let _guard = repo_lock::lock(&repo.common_dir).await;

    let name = match placement {
        Placement::DataDir => short_id(session_id),
        Placement::RepoLocal(name) => {
            check_local_name(name)?;
            name.to_string()
        }
    };
    let (root, start_ref, base) = match placement {
        Placement::DataDir => {
            let data_dir = state.lock().await.data_dir.clone();
            let parent = worktrees_dir(&data_dir).join(project_key(&repo.toplevel));
            std::fs::create_dir_all(&parent)?;
            let parent = crate::workspace::simple_canonicalize(&parent)?;
            (parent.join(&name), merge::head_ref(&repo.branch), None)
        }
        Placement::RepoLocal(_) => {
            // The project must not show the worktree as untracked work.
            ensure_local_dir_ignored(git, &repo).await?;
            let parent = repo.toplevel.join(REPO_LOCAL_DIR);
            std::fs::create_dir_all(&parent)?;
            let parent = crate::workspace::simple_canonicalize(&parent)?;
            let (start_ref, base) = repo_local_base(git, project, &repo).await;
            (parent.join(&name), start_ref, Some(base))
        }
    };
    if root.exists() {
        return Err(WorktreeError::new(
            "WORKTREE_PATH_EXISTS",
            format!("{} already exists", root.display()),
        ));
    }
    // The branch keeps the ADR's own name (`minih-agent/<short session id>`),
    // whichever placement the folder used: tooling, cleanup, and the subagent
    // worktrees all read it back from this convention.
    let branch = format!("{BRANCH_NAMESPACE}/{}", short_id(session_id));
    ensure_branch_free(git, project, &branch).await?;
    let root_text = root.to_string_lossy().into_owned();
    let common_dir = repo.common_dir.to_string_lossy().into_owned();

    let row = {
        let st = state.lock().await;
        let port = registry::next_port_base(&st.db, port_is_free)?;
        registry::insert(
            &st.db,
            &NewWorktree {
                session_id,
                delegation_id: None,
                path: &root_text,
                common_dir: &common_dir,
                prefix: &repo.prefix,
                branch: &branch,
                owner_branch: &repo.branch,
                port_base: port,
            },
        )?
    };

    let created: Result<IncludeReport, WorktreeError> = async {
        git.run(
            project,
            &[
                "worktree", "add", "-q", "-b", &branch, &root_text, &start_ref,
            ],
        )
        .await?;
        git.run(
            &root,
            &[
                "worktree",
                "lock",
                "--reason",
                &format!("Minih-Agent-Desktop session {session_id}"),
                &root_text,
            ],
        )
        .await?;
        copy_included(git, &repo.toplevel, &root).await
    }
    .await;

    let included = match created {
        Ok(included) => included,
        Err(error) => {
            discard_failed_creation(state, git, &row).await;
            return Err(error);
        }
    };

    let (row, command) = {
        let st = state.lock().await;
        registry::set_status(&st.db, &row.id, WorktreeStatus::Active)?;
        let command = setup_command(&st.db, project_path)?;
        let status = if command.is_some() {
            SetupStatus::Running
        } else {
            SetupStatus::None
        };
        registry::set_setup_status(&st.db, &row.id, status, None)?;
        let row = registry::get(&st.db, &row.id)?.unwrap_or(row);
        (row, command)
    };
    if let Some(command) = command {
        match placement {
            // ADR 0329: the session starts working and the setup runs behind it.
            Placement::DataDir => {
                tokio::spawn(run_setup(
                    state.clone(),
                    row.clone(),
                    project_path.to_string(),
                    command,
                ));
            }
            // A task is not allowed to start in a half-prepared workspace, so
            // its preparation waits for the command and reports the outcome.
            Placement::RepoLocal(_) => {
                run_setup(
                    state.clone(),
                    row.clone(),
                    project_path.to_string(),
                    command,
                )
                .await;
            }
        }
    }
    Ok(CreatedWorktree {
        worktree: summary_of(&row),
        included,
        project_had_uncommitted_changes,
        base,
    })
}

/// Run the project's setup command in the worktree and record the outcome.
///
/// The returned status is for callers that wait (a task's preparation): the
/// row already carries it, so a background caller ignores it.
pub async fn run_setup(
    state: SharedState,
    row: WorktreeRow,
    project_path: String,
    command: String,
) -> SetupStatus {
    let shell_id = {
        let st = state.lock().await;
        let configured = st
            .db
            .get_setting("app")
            .ok()
            .flatten()
            .and_then(|settings| {
                settings
                    .get("defaultCommandShell")
                    .and_then(|value| value.as_str())
                    .map(str::to_string)
            });
        crate::tools::shell::catalog(configured.as_deref())
            .effective
            .map(|option| option.id)
            .unwrap_or_else(|| crate::tools::shell::default_shell_id().to_string())
    };
    let root = row.workspace_root();
    let result = crate::tools::execute_tool_with_path_access(
        Some(&root),
        None,
        "Bash",
        &json!({ "command": command }),
        crate::tools::ToolExecutionOptions {
            timeout_ms: Some(SETUP_TIMEOUT_MS),
            bash_options: Some(crate::tools::BashExecutionOptions {
                session_id: row.session_id.clone().unwrap_or_default(),
                tool_call_id: format!("worktree-setup-{}", row.id),
                command_shell_id: shell_id,
                timeout_ms: Some(SETUP_TIMEOUT_MS),
                cancellation: None,
                output_tx: None,
                extra_env: env_for(&row, Some(&project_path)),
                run_in_background: false,
                app_state: None,
            }),
            allow_external_paths: false,
            hashline: None,
        },
    )
    .await;
    let log = setup_log(&result.content);
    let status = if result.ok {
        SetupStatus::Ok
    } else {
        SetupStatus::Failed
    };
    let st = state.lock().await;
    if let Err(error) = registry::set_setup_status(&st.db, &row.id, status, Some(&log)) {
        tracing::warn!(%error, "could not record the worktree setup result");
    }
    status
}

fn setup_log(content: &serde_json::Value) -> String {
    let text = match content {
        serde_json::Value::String(text) => text.clone(),
        value => {
            let stdout = value.get("stdout").and_then(|v| v.as_str()).unwrap_or("");
            let stderr = value.get("stderr").and_then(|v| v.as_str()).unwrap_or("");
            let exit = value
                .get("exitCode")
                .map(|code| code.to_string())
                .unwrap_or_default();
            format!(
                "{stdout}{}{stderr}\n[exit {exit}]",
                if stderr.is_empty() { "" } else { "\n" }
            )
        }
    };
    if text.len() <= SETUP_LOG_LIMIT {
        return text;
    }
    let mut start = text.len() - SETUP_LOG_LIMIT;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    format!("[earlier output omitted]\n{}", &text[start..])
}

/// Re-run the project's setup command in a worktree that already exists, and
/// wait for it: a task's preparation retry has nothing else to do.
///
/// Returns `None` when the project has no setup command, so the caller can tell
/// "nothing to do" from "it ran and passed".
pub async fn rerun_setup(
    state: &SharedState,
    row: &WorktreeRow,
    project_path: &str,
) -> Result<Option<SetupStatus>, WorktreeError> {
    let command = {
        let st = state.lock().await;
        setup_command(&st.db, project_path)?
    };
    let Some(command) = command else {
        return Ok(None);
    };
    {
        let st = state.lock().await;
        registry::set_setup_status(&st.db, &row.id, SetupStatus::Running, None)?;
    }
    let status = run_setup(
        state.clone(),
        row.clone(),
        project_path.to_string(),
        command,
    )
    .await;
    Ok(Some(status))
}

/// The tail of a worktree's setup log, for a caller that has to explain a
/// failure.
pub fn setup_log_tail(row: &WorktreeRow, limit: usize) -> String {
    let log = row.setup_log.clone().unwrap_or_default();
    if log.len() <= limit {
        return log;
    }
    let mut start = log.len() - limit;
    while !log.is_char_boundary(start) {
        start += 1;
    }
    format!("[earlier output omitted]\n{}", &log[start..])
}
