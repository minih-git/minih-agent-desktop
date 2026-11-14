//! What other tasks in one repository are changing (employee mode 0.5 slice 7).
//!
//! Two questions get answered here, and they are different questions: which
//! files *another* task touches, and which of those this task touches too. The
//! third — "nobody could tell" — must never be reported as "nothing".

use std::path::PathBuf;
use std::sync::Arc;

use serde_json::{json, Value};
use tokio::sync::Mutex;

use crate::session_worktrees::git::GitRunner;
use crate::session_worktrees::lifecycle::SharedState;
use crate::session_worktrees::test_support::{git_cmd, init_repo};
use crate::state::AppState;
use crate::task_overlap;
use crate::tasks;

struct Fixture {
    _dir: tempfile::TempDir,
    state: SharedState,
    project: PathBuf,
}

/// A project with three tasks, one branch each: `one` touches `a.txt`, `two`
/// touches `a.txt` and `b.txt`, `three` only adds `c.txt`.
async fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let project = init_repo(&dir.path().join("project"));
    let mut app = AppState::open(dir.path().join("data").as_path()).unwrap();
    app.handshook = true;
    let state: SharedState = Arc::new(Mutex::new(app));
    let project_path = std::fs::canonicalize(&project)
        .unwrap()
        .to_string_lossy()
        .to_string();
    git_cmd(&project, &["checkout", "-q", "-b", "one", "main"]);
    std::fs::write(project.join("a.txt"), "first\n").unwrap();
    git_cmd(&project, &["add", "a.txt"]);
    git_cmd(&project, &["commit", "-q", "-m", "feat: first step writes a"]);
    git_cmd(&project, &["checkout", "-q", "main"]);
    git_cmd(&project, &["checkout", "-q", "-b", "two", "main"]);
    std::fs::write(project.join("a.txt"), "second\n").unwrap();
    std::fs::write(project.join("b.txt"), "second\n").unwrap();
    git_cmd(&project, &["add", "a.txt", "b.txt"]);
    git_cmd(&project, &["commit", "-q", "-m", "feat: second step writes a and b"]);
    git_cmd(&project, &["checkout", "-q", "main"]);
    git_cmd(&project, &["checkout", "-q", "-b", "three", "main"]);
    std::fs::write(project.join("c.txt"), "third\n").unwrap();
    git_cmd(&project, &["add", "c.txt"]);
    git_cmd(&project, &["commit", "-q", "-m", "feat: third step writes c"]);
    git_cmd(&project, &["checkout", "-q", "main"]);

    {
        let st = state.lock().await;
        crate::db::upsert_project_row(st.db.conn(), &project_path, false).unwrap();
    }
    for (title, branch) in [("First", "one"), ("Second", "two"), ("Third", "three")] {
        let employee = {
            let st = state.lock().await;
            crate::sessions::create_session_with_options(
                &st.db,
                crate::sessions::SessionCreateOptions {
                    title: Some(title.into()),
                    mode: Some("agent".into()),
                    permission_mode: Some("accept-edits".into()),
                    role: Some("bot".into()),
                    bot_profile_json: Some(
                        json!({"name": title, "permissionMode": "accept-edits", "observe": false})
                            .to_string(),
                    ),
                    ..Default::default()
                },
            )
            .unwrap()
            .id
        };
        let created = {
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
        let task_id = created["task"]["id"].as_str().unwrap().to_string();
        let st = state.lock().await;
        st.db
            .conn()
            .execute(
                "UPDATE tasks SET workspace_branch=?2, workspace_status='ready' WHERE id=?1",
                rusqlite::params![task_id, branch],
            )
            .unwrap();
    }
    Fixture {
        _dir: dir,
        state,
        project,
    }
}

/// The three tasks by title: the list is ordered by creation, and a test that
/// reads a position would be about the ordering rather than about the overlap.
async fn task_ids(fixture: &Fixture) -> (String, String, String) {
    let st = fixture.state.lock().await;
    let listed = tasks::list(&st.db, &json!({})).unwrap();
    let items = listed["tasks"].as_array().unwrap().clone();
    let pick = |title: &str| {
        items
            .iter()
            .find(|task| task["title"] == json!(title))
            .and_then(|task| task["id"].as_str())
            .unwrap()
            .to_string()
    };
    (pick("First"), pick("Second"), pick("Third"))
}

async fn overlap_of(fixture: &Fixture, task_id: &str) -> Value {
    task_overlap::overlap(
        &fixture.state,
        &GitRunner::default(),
        &json!({
            "projectPath": std::fs::canonicalize(&fixture.project).unwrap().to_string_lossy(),
            "taskId": task_id,
        }),
    )
    .await
    .unwrap()
}

/// **The hint names the other task and the shared file**, because that is what
/// the person has to act on: "somebody else is editing this".
#[tokio::test]
async fn the_overlap_names_the_other_task_and_the_files_they_share() {
    let fixture = fixture().await;
    let (first, second, third) = task_ids(&fixture).await;
    let result = overlap_of(&fixture, &first).await;
    assert_eq!(result["readable"], json!(true), "{result}");
    let tasks = result["tasks"].as_array().unwrap();
    assert_eq!(tasks.len(), 2, "the other tasks are missing: {result}");
    let two = tasks.iter().find(|task| task["taskId"] == json!(second));
    assert_eq!(two.unwrap()["fileCount"], json!(2));
    assert!(tasks.iter().any(|task| task["taskId"] == json!(third)));
    let shared = result["intersections"].as_array().unwrap();
    assert_eq!(shared.len(), 1, "the shared file was not named: {result}");
    assert_eq!(shared[0]["taskId"], json!(second));
    assert_eq!(shared[0]["files"], json!(["a.txt"]));
}

/// The third step touches a file nobody else does, so there is nothing to warn
/// about — which is different from "nobody could tell", proven below.
#[tokio::test]
async fn a_task_with_no_shared_file_has_an_empty_intersection() {
    let fixture = fixture().await;
    let (_first, _second, third) = task_ids(&fixture).await;
    let result = overlap_of(&fixture, &third).await;
    assert_eq!(result["readable"], json!(true), "{result}");
    assert!(
        result["intersections"].as_array().unwrap().is_empty(),
        "an unrelated task was named as a conflict: {result}"
    );
}

/// **"Nobody could tell" is never "nothing".** A project whose git cannot be read
/// answers with `readable: false`, and the card says so instead of showing an
/// empty list the person would read as "no overlap".
#[tokio::test]
async fn an_unreadable_project_is_reported_as_such() {
    let fixture = fixture().await;
    let (first, _second, _third) = task_ids(&fixture).await;
    // A directory that is not a git repository: the project row still resolves,
    // the git read does not.
    let broken = fixture._dir.path().join("not-a-repository");
    std::fs::create_dir_all(&broken).unwrap();
    {
        let st = fixture.state.lock().await;
        st.db
            .conn()
            .execute(
                "UPDATE projects SET path=?1",
                rusqlite::params![broken.to_string_lossy()],
            )
            .unwrap();
    }
    let result = task_overlap::overlap(
        &fixture.state,
        &GitRunner::default(),
        &json!({
            "projectPath": broken.to_string_lossy(),
            "taskId": first,
        }),
    )
    .await
    .unwrap();
    assert_eq!(result["readable"], json!(false), "{result}");
    assert!(
        result["reason"].as_str().is_some_and(|text| !text.is_empty()),
        "the failure was not explained: {result}"
    );
}

/// A step of the same chain is not a conflict: two steps of one relay are
/// *supposed* to touch the same files.
#[tokio::test]
async fn the_steps_of_one_chain_are_not_compared_with_each_other() {
    let fixture = fixture().await;
    let (first, second, third) = task_ids(&fixture).await;
    {
        let st = fixture.state.lock().await;
        st.db
            .conn()
            .execute(
                "UPDATE tasks SET relay_parent_task_id=?2, relay_state='waiting' WHERE id=?1",
                rusqlite::params![second, first],
            )
            .unwrap();
    }
    let result = overlap_of(&fixture, &first).await;
    assert_eq!(result["readable"], json!(true), "{result}");
    let tasks = result["tasks"].as_array().unwrap();
    assert_eq!(
        tasks.len(),
        1,
        "a step of the same chain was reported as another task: {result}"
    );
    assert_eq!(tasks[0]["taskId"], json!(third));
}