use super::*;
use serde_json::json;
use tokio::sync::watch;

fn params(tool_name: &str, session_id: &str, args: serde_json::Value) -> ToolsExecuteParams {
    ToolsExecuteParams {
        session_id: session_id.to_string(),
        turn_id: Some("turn-1".into()),
        tool_call_id: format!("call-{tool_name}"),
        tool_name: tool_name.to_string(),
        args,
        _mode: "agent".into(),
        declared_risk: None,
        permission_scope: None,
        delegation_id: None,
        expected_command_shell_id: None,
        expected_command_shell_dialect: None,
        run_in_background: false,
        timeout_ms: None,
        plan_safe_actions: None,
    }
}

fn new_session(state: &AppState) -> String {
    crate::sessions::create_session(
        &state.db,
        Some("background tool fixture".into()),
        None,
        None,
        None,
        None,
    )
    .unwrap()
    .id
}

/// Open a workspace directory plus a host state rooted beside it.
fn fixture() -> (tempfile::TempDir, tokio::sync::Mutex<AppState>) {
    let dir = tempfile::tempdir().unwrap();
    let state = tokio::sync::Mutex::new(AppState::open(dir.path()).unwrap());
    (dir, state)
}

async fn start_task(
    state: &tokio::sync::Mutex<AppState>,
    session_id: &str,
    workspace: &std::path::Path,
    command: &str,
) -> String {
    crate::background_tasks::spawn_background_task_detached(
        state,
        session_id,
        command,
        crate::tools::shell::default_shell_id(),
        workspace,
        None,
        &[],
    )
    .await
    .unwrap()
}

/// Wait until the supervisor recorded a terminal state, so the assertions read
/// a settled task instead of racing the drain.
async fn settled(state: &tokio::sync::Mutex<AppState>, session_id: &str, id: &str) -> String {
    for _ in 0..200 {
        {
            let st = state.lock().await;
            if let Some(snapshot) = st
                .background_tasks
                .session_task_snapshot(session_id, id)
                .await
            {
                if snapshot.state != crate::background_tasks::BackgroundTaskState::Running {
                    return format!("{:?}", snapshot.state);
                }
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    panic!("background task {id} did not settle");
}

#[test]
fn recognizes_only_its_own_tools() {
    assert!(recognizes(LIST));
    assert!(recognizes(OUTPUT));
    assert!(recognizes(STOP));
    assert!(!recognizes("Bash"));
    assert!(!recognizes("BackgroundTaskKill"));
}

/// Stop is a state change: it keeps the default medium risk instead of the
/// free-read auto-allow. Reads are low.
#[test]
fn registering_risk_matches_the_boundary() {
    use crate::permissions::{PermissionManager, Risk};
    assert_eq!(
        PermissionManager::tool_risk_with_declared(LIST, None),
        Risk::Low
    );
    assert_eq!(
        PermissionManager::tool_risk_with_declared(OUTPUT, None),
        Risk::Low
    );
    assert_eq!(
        PermissionManager::tool_risk_with_declared(STOP, None),
        Risk::Medium
    );
    assert_eq!(risk_for(LIST), None);
    assert_eq!(risk_for(STOP), Some(Risk::Medium));
}

/// Plan and Goal admit Bash, so they can start a background task too. All three
/// tools therefore follow the same rule as Bash: a turn that starts a server can
/// read it and end it instead of leaving it running with no way to stop it.
#[test]
fn contract_modes_admit_all_three_background_task_tools() {
    use crate::permissions::PermissionManager;
    for tool in [LIST, OUTPUT, STOP] {
        assert!(
            PermissionManager::plan_mode_allows(tool),
            "{tool} follows Bash in Plan and Goal"
        );
    }
}

#[tokio::test]
async fn list_and_output_are_scoped_to_the_calling_session() {
    let (dir, state) = fixture();
    let owner = {
        let st = state.lock().await;
        new_session(&st)
    };
    let other = {
        let st = state.lock().await;
        new_session(&st)
    };
    let id = start_task(&state, &owner, dir.path(), "echo owned-output").await;
    settled(&state, &owner, &id).await;

    let listed = execute(&state, &params(LIST, &owner, json!({})), None).await;
    assert!(listed.ok, "list failed: {:?}", listed.content);
    assert_eq!(listed.content["count"], json!(1));
    assert_eq!(listed.content["tasks"][0]["id"], json!(id));
    assert_eq!(
        listed.content["tasks"][0]["command"],
        json!("echo owned-output")
    );

    // Another session sees an empty list and cannot read the id at all: the
    // answer is the same as for an id that never existed.
    let foreign_list = execute(&state, &params(LIST, &other, json!({})), None).await;
    assert!(foreign_list.ok);
    assert_eq!(foreign_list.content["count"], json!(0));

    let foreign_output = execute(&state, &params(OUTPUT, &other, json!({ "id": id })), None).await;
    assert!(!foreign_output.ok);
    assert_eq!(foreign_output.error_code.as_deref(), Some("NOT_FOUND"));

    let unknown_output = execute(
        &state,
        &params(OUTPUT, &other, json!({ "id": "no-such-task" })),
        None,
    )
    .await;
    assert!(!unknown_output.ok);
    assert_eq!(unknown_output.error_code.as_deref(), Some("NOT_FOUND"));
    assert_eq!(
        foreign_output.content["error"], unknown_output.content["error"],
        "another session's id must read exactly like an unknown id"
    );
}

#[tokio::test]
async fn output_reports_state_exit_code_and_streams() {
    let (dir, state) = fixture();
    let owner = {
        let st = state.lock().await;
        new_session(&st)
    };
    let command = if cfg!(windows) {
        "[Console]::Out.Write('shipped'); [Console]::Error.Write('warned'); exit 3"
    } else {
        "printf shipped; printf warned >&2; exit 3"
    };
    let id = start_task(&state, &owner, dir.path(), command).await;
    settled(&state, &owner, &id).await;

    let output = execute(&state, &params(OUTPUT, &owner, json!({ "id": id })), None).await;
    assert!(output.ok, "output failed: {:?}", output.content);
    assert_eq!(output.content["id"], json!(id));
    assert_eq!(output.content["state"], json!("failed"));
    assert_eq!(output.content["exitCode"], json!(3));
    assert_eq!(output.content["stdout"], json!("shipped"));
    assert_eq!(output.content["stderr"], json!("warned"));
    assert_eq!(output.content["truncated"], json!(false));
}

/// A task that logged past the model's budget keeps its ending, and the marker
/// says so. A failing command's actionable line is the last one it printed.
#[tokio::test]
async fn output_keeps_the_tail_and_marks_truncation() {
    let (dir, state) = fixture();
    let owner = {
        let st = state.lock().await;
        new_session(&st)
    };
    let command = if cfg!(windows) {
        "1..30000 | ForEach-Object { \"line-$_\" }"
    } else {
        "awk 'BEGIN { for (i = 1; i <= 30000; i++) print \"line-\" i }'"
    };
    let id = start_task(&state, &owner, dir.path(), command).await;
    settled(&state, &owner, &id).await;

    let output = execute(&state, &params(OUTPUT, &owner, json!({ "id": id })), None).await;
    assert!(output.ok, "output failed: {:?}", output.content);
    assert_eq!(output.content["truncated"], json!(true));
    let stdout = output.content["stdout"].as_str().unwrap();
    assert!(
        stdout.starts_with("[truncated:"),
        "a tail cut leads with its marker: {:?}",
        &stdout[..stdout.len().min(120)]
    );
    assert!(stdout.contains("line-30000"), "the ending survives the cut");
    assert!(
        !stdout.contains("line-1\n"),
        "the head is dropped, not the tail"
    );
    assert!(
        stdout.len() <= crate::tools::BUDGET_SHELL_ERR.max_bytes + 1_024,
        "the copy stays inside the budget"
    );
}

/// `waitSeconds` returns as soon as the task is gone instead of blocking for
/// the whole budget, which is what makes it usable after a short build.
#[tokio::test]
async fn wait_returns_early_when_the_task_exits() {
    let (dir, state) = fixture();
    let owner = {
        let st = state.lock().await;
        new_session(&st)
    };
    let command = if cfg!(windows) {
        "Start-Sleep -Milliseconds 200; Write-Output done"
    } else {
        "sleep 0.2; printf done"
    };
    let id = start_task(&state, &owner, dir.path(), command).await;

    let started = std::time::Instant::now();
    let output = execute(
        &state,
        &params(OUTPUT, &owner, json!({ "id": id, "waitSeconds": 30 })),
        None,
    )
    .await;
    assert!(output.ok, "output failed: {:?}", output.content);
    assert!(
        started.elapsed() < std::time::Duration::from_secs(20),
        "the wait must end when the task exits, not when its budget does"
    );
    assert_eq!(output.content["state"], json!("exited"));
    assert_eq!(output.content["stdout"], json!("done"));
}

/// A wait that runs out reports the current state and is not an error.
#[tokio::test]
async fn wait_timeout_reports_the_running_state() {
    let (dir, state) = fixture();
    let owner = {
        let st = state.lock().await;
        new_session(&st)
    };
    let id = start_task(&state, &owner, dir.path(), "sleep 30").await;

    let output = execute(
        &state,
        &params(OUTPUT, &owner, json!({ "id": id, "waitSeconds": 1 })),
        None,
    )
    .await;
    assert!(
        output.ok,
        "a timeout is not a failure: {:?}",
        output.content
    );
    assert_eq!(output.content["state"], json!("running"));

    let _ = execute(&state, &params(STOP, &owner, json!({ "id": id })), None).await;
}

/// Stop ends a bounded wait immediately. The process is not the turn's to kill
/// on a stop, so it keeps running and the result reports that.
#[tokio::test]
async fn cancellation_ends_the_wait_without_touching_the_process() {
    let (dir, state) = fixture();
    let owner = {
        let st = state.lock().await;
        new_session(&st)
    };
    let id = start_task(&state, &owner, dir.path(), "sleep 30").await;

    let (stop_tx, stop_rx) = watch::channel(false);
    let wait_state = &state;
    let wait_params = params(OUTPUT, &owner, json!({ "id": id, "waitSeconds": 60 }));
    let waiting = async {
        let mut receiver = Some(stop_rx);
        execute(wait_state, &wait_params, receiver.take()).await
    };
    tokio::pin!(waiting);
    let signalled = async {
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        stop_tx.send(true).unwrap();
    };
    let (output, _) = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        tokio::join!(waiting, signalled)
    })
    .await
    .expect("a stopped wait must not run out its 60s budget");
    assert!(
        output.ok,
        "a stopped wait still reports: {:?}",
        output.content
    );
    assert_eq!(output.content["state"], json!("running"));

    let stopped = execute(&state, &params(STOP, &owner, json!({ "id": id })), None).await;
    assert!(stopped.ok);
    assert_eq!(stopped.content["stopped"], json!(true));
}

#[tokio::test]
async fn stop_is_idempotent_and_marks_the_task_stopped() {
    let (dir, state) = fixture();
    let owner = {
        let st = state.lock().await;
        new_session(&st)
    };
    let id = start_task(&state, &owner, dir.path(), "sleep 30").await;

    let first = execute(&state, &params(STOP, &owner, json!({ "id": id })), None).await;
    assert!(first.ok, "stop failed: {:?}", first.content);
    assert_eq!(first.content["stopped"], json!(true));
    assert_eq!(first.content["wasRunning"], json!(true));

    // A second stop answers with the state instead of failing: nothing left to
    // signal, and the request itself is unchanged.
    let second = execute(&state, &params(STOP, &owner, json!({ "id": id })), None).await;
    assert!(second.ok);
    assert_eq!(second.content["stopped"], json!(false));

    let settled_state = settled(&state, &owner, &id).await;
    assert_eq!(settled_state, "Stopped");

    let third = execute(&state, &params(STOP, &owner, json!({ "id": id })), None).await;
    assert!(third.ok);
    assert_eq!(third.content["stopped"], json!(false));
    assert_eq!(third.content["state"], json!("stopped"));
}

#[tokio::test]
async fn stop_refuses_another_sessions_task() {
    let (dir, state) = fixture();
    let (owner, other) = {
        let st = state.lock().await;
        (new_session(&st), new_session(&st))
    };
    let id = start_task(&state, &owner, dir.path(), "sleep 30").await;

    let refused = execute(&state, &params(STOP, &other, json!({ "id": id })), None).await;
    assert!(!refused.ok);
    assert_eq!(refused.error_code.as_deref(), Some("NOT_FOUND"));

    let unknown = execute(
        &state,
        &params(STOP, &other, json!({ "id": "no-such-task" })),
        None,
    )
    .await;
    assert_eq!(refused.content["error"], unknown.content["error"]);

    // The task is untouched.
    let st = state.lock().await;
    let summary = st
        .background_tasks
        .summaries()
        .into_iter()
        .find(|summary| summary.id == id)
        .unwrap();
    assert_eq!(
        summary.state,
        crate::background_tasks::BackgroundTaskState::Running
    );
    drop(st);
    let _ = execute(&state, &params(STOP, &owner, json!({ "id": id })), None).await;
}

#[tokio::test]
async fn arguments_are_validated() {
    let (_dir, state) = fixture();
    let owner = {
        let st = state.lock().await;
        new_session(&st)
    };

    let missing_id = execute(&state, &params(OUTPUT, &owner, json!({})), None).await;
    assert!(!missing_id.ok);
    assert_eq!(missing_id.error_code.as_deref(), Some("INVALID_ARGUMENT"));

    let bad_wait = execute(
        &state,
        &params(OUTPUT, &owner, json!({ "id": "x", "waitSeconds": -1 })),
        None,
    )
    .await;
    assert!(!bad_wait.ok);
    assert_eq!(bad_wait.error_code.as_deref(), Some("INVALID_ARGUMENT"));
}

#[tokio::test]
async fn output_waits_for_a_contended_cell_instead_of_reporting_not_found() {
    let (dir, state) = fixture();
    let owner = {
        let st = state.lock().await;
        new_session(&st)
    };
    let command = if cfg!(windows) {
        "[Console]::Out.Write('contended-output')"
    } else {
        "printf contended-output"
    };
    let id = start_task(&state, &owner, dir.path(), command).await;
    settled(&state, &owner, &id).await;

    // Hold the task's own output cell while the tool call reads it.
    let shared = {
        let st = state.lock().await;
        st.background_tasks
            .tasks
            .get(&id)
            .expect("the registry owns the task")
            .shared
            .clone()
    };
    let mut guard = Some(shared.lock().await);
    let release = async {
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        drop(guard.take());
    };
    let read_params = params(OUTPUT, &owner, json!({ "id": id }));
    let (output, ()) = tokio::join!(execute(&state, &read_params, None), release);

    assert!(
        output.ok,
        "a contended read must answer, not report a missing task: {:?}",
        output.content
    );
    assert_eq!(output.content["id"], json!(id));
    assert_eq!(output.content["state"], json!("exited"));
    assert_eq!(output.content["stdout"], json!("contended-output"));
}

/// Polling a large log must not leave a copy per read. Each task and stream
/// keeps one fixed spill file that every read overwrites, so a model polling a
/// noisy dev server cannot fill the user's scratch directory.
#[tokio::test]
async fn repeated_reads_overwrite_one_spill_file_per_task_and_stream() {
    let (dir, state) = fixture();
    let owner = {
        let st = state.lock().await;
        new_session(&st)
    };
    let command = if cfg!(windows) {
        "1..30000 | ForEach-Object { \"line-$_\" }"
    } else {
        "awk 'BEGIN { for (i = 1; i <= 30000; i++) print \"line-\" i }'"
    };
    let id = start_task(&state, &owner, dir.path(), command).await;
    settled(&state, &owner, &id).await;

    let read_params = params(OUTPUT, &owner, json!({ "id": id }));
    for _ in 0..3 {
        let output = execute(&state, &read_params, None).await;
        assert!(output.ok, "output failed: {:?}", output.content);
    }

    let spill_dir = dir.path().join("scratch").join(&owner).join("tool-output");
    let mut names: Vec<String> = std::fs::read_dir(&spill_dir)
        .expect("an over-budget read spills its full copy")
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    assert_eq!(
        names,
        vec![format!("background-{id}-stdout.log")],
        "three reads leave exactly one file for the stream, not one per read"
    );

    // The marker still points the model at that file, so it can Grep the full
    // log instead of re-running the command.
    let output = execute(&state, &read_params, None).await;
    let marker = output.content["stdout"].as_str().unwrap();
    assert!(
        marker.contains(&format!("background-{id}-stdout.log")),
        "the truncation marker names the spill file: {:?}",
        &marker[..marker.len().min(160)]
    );
}
