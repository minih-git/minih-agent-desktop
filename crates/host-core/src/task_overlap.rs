//! What several tasks in one repository are changing (employee mode 0.5 slice 7).
//!
//! Two employees, or one employee and its own next step, can edit the same file
//! in the same project without either knowing. git answers that question exactly
//! — every task already has a branch and a workspace — so this module answers it
//! and nothing more: it is a **warning**, never a refusal, because a person who
//! is told about an overlap can still decide the two changes are unrelated.
//!
//! A failed read is reported as a failed read. "No other task touches this file"
//! and "nobody could tell" lead to opposite decisions, and presenting the second
//! as the first is the one mistake this module must not make.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use anyhow::{anyhow, Result};
use serde_json::{json, Value};

use crate::session_worktrees::git::GitRunner;
use crate::session_worktrees::lifecycle::SharedState;
use crate::session_worktrees::{merge, registry};

/// How many paths one overlap row names. The card is a hint, not a report: the
/// person reads the first few and opens the task for the rest.
pub const MAX_OVERLAP_FILES: usize = 5;

/// One other task in the same project and the files it changed.
struct Changed {
    task_id: String,
    short_id: String,
    title: String,
    files: BTreeSet<String>,
}

fn parse_porcelain(status: &str) -> Vec<String> {
    // `XY path\0`, and a rename or copy carries the source as one more field.
    let mut paths = Vec::new();
    let mut fields = status.split('\0').filter(|field| !field.is_empty());
    while let Some(entry) = fields.next() {
        if entry.len() < 4 {
            continue;
        }
        let code = &entry[..2];
        let path = entry[3..].trim();
        if code.starts_with('R') || code.starts_with('C') {
            // The source path follows; it was not changed by this task either.
            fields.next();
        }
        if !path.is_empty() {
            paths.push(path.to_string());
        }
    }
    paths
}

/// The files one task changed: what is committed on its branch relative to the
/// branch it started from, plus what its workspace still holds uncommitted.
///
/// Read from the task's own workspace when the folder is there, and from the
/// project with the branch refs when it is not: a workspace that was removed
/// while its branch still holds commits is exactly the case where "it touches
/// nothing" would be wrong.
async fn files_of(
    git: &GitRunner,
    project: &Path,
    workspace: Option<&PathBuf>,
    owner_branch: &str,
    branch: &str,
) -> Result<BTreeSet<String>> {
    let mut files = BTreeSet::new();
    let dir = workspace
        .filter(|path| path.is_dir())
        .map_or(project, |path| path.as_path());
    let from = format!("refs/heads/{owner_branch}");
    let to = format!("refs/heads/{branch}");
    let diff = git
        .output(dir, &["diff", "--name-only", &from, &to])
        .await
        .map_err(|error| anyhow!("{error}"))?;
    if !diff.success() {
        return Err(anyhow!("{}", diff.stderr.trim()));
    }
    for line in diff.stdout.lines() {
        let path = line.trim();
        if !path.is_empty() {
            files.insert(path.to_string());
        }
    }
    let Some(workspace) = workspace.filter(|path| path.is_dir()) else {
        return Ok(files);
    };
    let status = merge::worktree_status(git, workspace)
        .await
        .map_err(|error| anyhow!("{}: {}", error.code, error.message))?;
    for path in parse_porcelain(&status) {
        files.insert(path);
    }
    Ok(files)
}

/// `task.overlap {projectPath, taskId?}`: which other open tasks in this project
/// are changing files, and which of those files this task changes too.
pub async fn overlap(state: &SharedState, git: &GitRunner, params: &Value) -> Result<Value> {
    let project_path = params
        .get("projectPath")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow!("INVALID_ARGUMENT: projectPath required"))?
        .to_string();
    let task_id = params
        .get("taskId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);

    // Read what the database knows under the lock; every git call below runs
    // outside it.
    struct Row {
        task_id: String,
        session_id: String,
        title: String,
        branch: Option<String>,
        workspace_branch: Option<String>,
    }
    let (mut rows, own) = {
        let st = state.lock().await;
        let db = &st.db;
        let project_id: Option<i64> = db
            .conn()
            .query_row(
                "SELECT id FROM projects WHERE path = ?1",
                rusqlite::params![project_path],
                |row| row.get(0),
            )
            .ok();
        let Some(project_id) = project_id else {
            return Ok(json!({ "readable": true, "tasks": [], "intersections": [] }));
        };
        // The chain this task belongs to is excluded whole: two steps of one
        // relay are *supposed* to touch the same files, and telling the person
        // about it would train them to ignore the warning.
        let chain: BTreeSet<String> = match task_id.as_deref() {
            Some(id) => crate::tasks::relay_chain(db, id)?
                .into_iter()
                .map(|task| task.id)
                .collect(),
            None => BTreeSet::new(),
        };
        let mut statement = db.conn().prepare(
            "SELECT id, session_id, title, branch, workspace_branch FROM tasks
              WHERE project_id = ?1 AND archived_at IS NULL
              ORDER BY created_at ASC",
        )?;
        let listed = statement
            .query_map(rusqlite::params![project_id], |row| {
                Ok(Row {
                    task_id: row.get(0)?,
                    session_id: row.get(1)?,
                    title: row.get(2)?,
                    branch: row.get(3)?,
                    workspace_branch: row.get(4)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let rows: Vec<Row> = listed
            .into_iter()
            .filter(|row| !chain.contains(&row.task_id))
            .filter(|row| task_id.as_deref() != Some(row.task_id.as_str()))
            .collect();
        // The workspaces are registry rows, not task columns: the folder is what
        // holds the uncommitted files.
        let mut found: Vec<(Row, Option<PathBuf>)> = Vec::new();
        for row in rows {
            let path = registry::for_session(db, &row.session_id)?
                .into_iter()
                .find(|entry| entry.delegation_id.is_none())
                .map(|entry| PathBuf::from(entry.path));
            found.push((row, path));
        }
        let own = match task_id.as_deref() {
            Some(id) => {
                let task =
                    crate::tasks::get_task(db, id)?.ok_or_else(|| anyhow!("NOT_FOUND: task"))?;
                let workspace = registry::for_session(db, &task.session_id)?
                    .into_iter()
                    .find(|entry| entry.delegation_id.is_none())
                    .map(|entry| PathBuf::from(entry.path));
                Some((task.title, workspace, task.workspace_branch.or(task.branch)))
            }
            None => None,
        };
        (found, own)
    };

    let project = PathBuf::from(&project_path);
    let mut changed: Vec<Changed> = Vec::new();
    for (row, workspace) in rows.drain(..) {
        let Some(branch) = row.workspace_branch.or(row.branch) else {
            // Never prepared: nothing is being changed yet, which is a fact and
            // not a failed read.
            continue;
        };
        let files = match files_of(git, &project, workspace.as_ref(), "main", &branch).await {
            Ok(files) => files,
            // A branch that does not exist is a task that has not started
            // writing; any other failure means nobody can tell, and the caller
            // is told so instead of being shown an empty list.
            Err(error) if error.to_string().contains("not a valid object name") => BTreeSet::new(),
            Err(error) => {
                return Ok(json!({
                    "readable": false,
                    "reason": error.to_string(),
                    "tasks": [],
                    "intersections": [],
                }))
            }
        };
        changed.push(Changed {
            short_id: crate::tasks::short_id(&row.task_id),
            title: row.title,
            task_id: row.task_id,
            files,
        });
    }

    // What this task itself changes, so the completion card can name the files
    // two tasks share rather than every file either of them touched.
    let mut mine: BTreeSet<String> = BTreeSet::new();
    if let Some((_title, workspace, Some(branch))) = own {
        match files_of(git, &project, workspace.as_ref(), "main", &branch).await {
            Ok(files) => mine = files,
            Err(error) => {
                return Ok(json!({
                    "readable": false,
                    "reason": error.to_string(),
                    "tasks": [],
                    "intersections": [],
                }))
            }
        }
    }

    let tasks: Vec<Value> = changed
        .iter()
        .map(|entry| {
            json!({
                "taskId": entry.task_id,
                "shortId": entry.short_id,
                "title": entry.title,
                "fileCount": entry.files.len(),
            })
        })
        .collect();
    let intersections: Vec<Value> = changed
        .iter()
        .filter_map(|entry| {
            let shared: Vec<String> = entry
                .files
                .iter()
                .filter(|path| mine.contains(*path))
                .take(MAX_OVERLAP_FILES)
                .cloned()
                .collect();
            (!shared.is_empty()).then(|| {
                json!({
                    "taskId": entry.task_id,
                    "shortId": entry.short_id,
                    "title": entry.title,
                    "files": shared,
                })
            })
        })
        .collect();

    Ok(json!({
        "readable": true,
        "tasks": tasks,
        "intersections": intersections,
    }))
}

#[cfg(test)]
#[path = "task_overlap_tests.rs"]
mod tests;
