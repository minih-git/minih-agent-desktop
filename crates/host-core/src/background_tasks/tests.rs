use super::*;
use std::time::Duration;

#[tokio::test]
async fn retains_output_when_the_process_exits_before_supervision_starts() {
    let dir = tempfile::tempdir().unwrap();
    let shell = crate::tools::shell::default_shell_id();
    let command = if cfg!(windows) {
        "[Console]::Out.Write('final-stdout'); [Console]::Error.Write('final-stderr')"
    } else {
        "printf final-stdout; printf final-stderr >&2"
    };
    let config = resolve_runner_config(shell, command, dir.path(), None, &[]).unwrap();
    let runner = tools::spawn_tool_runner(&config).await.unwrap();
    tokio::time::timeout(Duration::from_secs(10), async {
        while !runner.wait_task.is_finished() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let mut registry = BackgroundTaskRegistry::default();
    let changed = Arc::new(tokio::sync::Notify::new());
    let notify = changed.clone();
    let task = register_spawned_task(
        &mut registry,
        "session-output",
        command,
        shell,
        runner,
        Arc::new(move || notify.notify_one()),
    );
    tokio::time::timeout(Duration::from_secs(5), changed.notified())
        .await
        .expect("the process must settle after draining both pipes");
    let output = task_output(&registry, &task.id).await.unwrap().unwrap();
    assert_eq!(output["state"], "exited");
    assert_eq!(output["stdout"], "final-stdout");
    assert_eq!(output["stderr"], "final-stderr");
}

#[tokio::test]
async fn shutdown_signals_a_task_while_its_output_is_locked() {
    let dir = tempfile::tempdir().unwrap();
    let shell = crate::tools::shell::default_shell_id();
    let config = resolve_runner_config(shell, "sleep 30", dir.path(), None, &[]).unwrap();
    let runner = tools::spawn_tool_runner(&config).await.unwrap();
    let mut registry = BackgroundTaskRegistry::default();
    let changed = Arc::new(tokio::sync::Notify::new());
    let notify = changed.clone();
    let task = register_spawned_task(
        &mut registry,
        "session-output",
        "sleep 30",
        shell,
        runner,
        Arc::new(move || notify.notify_one()),
    );
    let output_lock = task.shared.lock().await;
    stop_all_running_sync(&registry);
    drop(output_lock);
    let settled = tokio::time::timeout(Duration::from_secs(3), changed.notified()).await;
    if settled.is_err() {
        // Clean up the real child even when the regression is present.
        stop_task(&registry, &task.id).await.unwrap();
        tokio::time::timeout(Duration::from_secs(5), changed.notified())
            .await
            .unwrap();
    }
    assert!(
        settled.is_ok(),
        "shutdown must not skip a contended output lock"
    );
    assert_eq!(registry.summaries()[0].state, BackgroundTaskState::Stopped);
}

/// A start must bump the change counter. The renderer only learns about a
/// running task through `backgroundTasks.changed`; a start that stays
/// silent leaves the running-tasks bar empty while the process is alive —
/// the exact regression this test locks down.
#[tokio::test]
async fn start_notifies_stop_settles_and_shutdown_reaps() {
    let dir = tempfile::tempdir().unwrap();
    let state = tokio::sync::Mutex::new(crate::state::AppState::open(dir.path()).unwrap());

    let before_start = change_counter();
    let id = spawn_background_task_detached(
        &state,
        "session-1",
        "sleep 30",
        crate::tools::shell::default_shell_id(),
        dir.path(),
        None,
        &[],
    )
    .await
    .unwrap();
    assert!(
        change_counter() > before_start,
        "registering a task must notify listeners"
    );

    {
        let st = state.lock().await;
        let summaries = st.background_tasks.summaries();
        assert_eq!(summaries.len(), 1, "the registry owns the started task");
        assert_eq!(summaries[0].id, id);
        assert_eq!(summaries[0].state, BackgroundTaskState::Running);
        assert_eq!(summaries[0].command, "sleep 30");
        assert_eq!(summaries[0].session_id, "session-1");
        assert_eq!(st.background_tasks.running_count(), 1);
    }

    let before_stop = change_counter();
    {
        let st = state.lock().await;
        assert!(stop_task(&st.background_tasks, &id).await.unwrap());
        assert!(
            !stop_task(&st.background_tasks, &id).await.unwrap(),
            "a task that is already stopping is not stopped twice"
        );
    }

    // The detached supervisor kills the tree and records the terminal
    // state; nothing here blocks the turn that started the task.
    let mut settled = None;
    for _ in 0..100 {
        tokio::time::sleep(Duration::from_millis(50)).await;
        let st = state.lock().await;
        let summary = st.background_tasks.summaries().remove(0);
        if summary.state != BackgroundTaskState::Running {
            settled = Some(summary);
            break;
        }
    }
    let settled = settled.expect("the stopped task reaches a terminal state");
    assert_eq!(settled.state, BackgroundTaskState::Stopped);
    assert!(
        change_counter() > before_stop,
        "the terminal state must notify listeners"
    );

    {
        let st = state.lock().await;
        let output = task_output(&st.background_tasks, &id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(output["id"], serde_json::json!(id));
        assert_eq!(output["state"], serde_json::json!("stopped"));
        assert_eq!(st.background_tasks.running_count(), 0);
    }
}

/// Application exit must not leave an orphan: `AppState::shutdown` signals
/// every running supervisor, which kills and reaps its process tree.
#[tokio::test]
async fn shutdown_stops_every_running_task() {
    let dir = tempfile::tempdir().unwrap();
    let state = tokio::sync::Mutex::new(crate::state::AppState::open(dir.path()).unwrap());
    spawn_background_task_detached(
        &state,
        "session-1",
        "sleep 30",
        crate::tools::shell::default_shell_id(),
        dir.path(),
        None,
        &[],
    )
    .await
    .unwrap();

    {
        let mut st = state.lock().await;
        assert_eq!(st.background_tasks.running_count(), 1);
        st.shutdown();
    }

    let mut settled = None;
    for _ in 0..100 {
        tokio::time::sleep(Duration::from_millis(50)).await;
        let st = state.lock().await;
        if st.background_tasks.running_count() == 0 {
            settled = Some(st.background_tasks.summaries().remove(0).state);
            break;
        }
    }
    assert_eq!(
        settled.expect("shutdown stops the running task"),
        BackgroundTaskState::Stopped
    );
}

#[tokio::test]
async fn background_runner_preserves_worktree_environment() {
    let dir = tempfile::tempdir().unwrap();
    let shell = crate::tools::shell::default_shell_id();
    let command = if cfg!(windows) {
        "[Console]::Write($env:PI_PORT + '|' + $env:PI_PROJECT_ROOT + '|' + $env:PI_WORKTREE_ROOT)"
    } else {
        "printf '%s|%s|%s' \"$PI_PORT\" \"$PI_PROJECT_ROOT\" \"$PI_WORKTREE_ROOT\""
    };
    let env = vec![
        ("PI_PORT".to_string(), "41010".to_string()),
        ("PI_PROJECT_ROOT".to_string(), "/test/project".to_string()),
        ("PI_WORKTREE_ROOT".to_string(), "/test/worktree".to_string()),
    ];
    let config = resolve_runner_config(shell, command, dir.path(), None, &env).unwrap();
    let runner = tools::spawn_tool_runner(&config).await.unwrap();
    let mut registry = BackgroundTaskRegistry::default();
    let changed = Arc::new(tokio::sync::Notify::new());
    let notify = changed.clone();
    let task = register_spawned_task(
        &mut registry,
        "session-env",
        command,
        shell,
        runner,
        Arc::new(move || notify.notify_one()),
    );
    tokio::time::timeout(Duration::from_secs(10), changed.notified())
        .await
        .unwrap();
    let output = task_output(&registry, &task.id).await.unwrap().unwrap();
    assert_eq!(output["state"], "exited");
    assert_eq!(output["stdout"], "41010|/test/project|/test/worktree");
}

#[tokio::test]
async fn shutdown_rejects_a_new_background_command_before_spawn() {
    let dir = tempfile::tempdir().unwrap();
    let state = Mutex::new(crate::state::AppState::open(dir.path()).unwrap());
    state.lock().await.shutdown();
    let result = spawn_background_task_detached(
        &state,
        "session-late",
        "sleep 30",
        crate::tools::shell::default_shell_id(),
        dir.path(),
        None,
        &[],
    )
    .await;
    assert_eq!(result.unwrap_err().0, "TOOL_ABORTED");
    assert!(state.lock().await.background_tasks.tasks.is_empty());
}
