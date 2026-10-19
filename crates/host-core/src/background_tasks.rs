//! Background command tasks: long-lived processes started from a chat turn
//! (dev servers, watchers, builds) that must outlive the turn.
//!
//! A foreground `Bash` tool call belongs to its turn: the timeout kills it and
//! the abort path tears down the whole process group. Tasks registered here
//! are detached from that lifecycle — the registry owns the process, output is
//! kept in bounded ring buffers so reads never grow unbounded, and every
//! state change (start, exit, stop) bumps a counter that the RPC layer turns
//! into a `backgroundTasks.changed` notification for the renderer.
//!
//! Lifecycle: tasks live with the host process. `AppState::shutdown` stops
//! every running task, so an application exit never leaves orphans behind.

use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::time::Instant;

use crate::tools;
use serde::Serialize;
use tokio::io::AsyncReadExt;
use tokio::sync::{watch, Mutex};

/// Keep the last 256KB per stream. A server that logs fast for hours must not
/// grow host memory; a caller that needs earlier output re-runs the command.
const RING_MAX_BYTES: usize = 256 * 1024;
/// Upper bound on concurrently running background tasks. Each holds a process
/// tree and two pipe readers; a runaway loop spawning servers must fail fast.
pub(crate) const MAX_RUNNING_TASKS: usize = 32;
/// Bounded set of finished tasks kept so the UI can show what just exited.
const FINISHED_TASK_HISTORY: usize = 16;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum BackgroundTaskState {
    Running,
    Exited,
    Failed,
    Stopped,
}

/// Shared between the registry entry and the detached supervisor task. The
/// supervisor writes output and the terminal state; RPC handlers read.
#[derive(Debug)]
pub(crate) struct TaskShared {
    state: BackgroundTaskState,
    exit_code: Option<i32>,
    stdout: VecDeque<String>,
    stderr: VecDeque<String>,
    stdout_bytes: usize,
    stderr_bytes: usize,
    truncated: bool,
}

impl TaskShared {
    fn push_text(ring: &mut VecDeque<String>, total: &mut usize, text: &str) -> bool {
        if text.is_empty() {
            return false;
        }
        ring.push_back(text.to_string());
        *total += text.len();
        let mut dropped = false;
        while *total > RING_MAX_BYTES && ring.len() > 1 {
            if let Some(front) = ring.pop_front() {
                *total -= front.len();
                dropped = true;
            }
        }
        dropped
    }

    fn push_stdout(&mut self, text: &str) -> bool {
        Self::push_text(&mut self.stdout, &mut self.stdout_bytes, text)
    }

    fn push_stderr(&mut self, text: &str) -> bool {
        Self::push_text(&mut self.stderr, &mut self.stderr_bytes, text)
    }

    fn render(ring: &VecDeque<String>) -> String {
        ring.iter().map(String::as_str).collect()
    }
}

/// Immutable identity plus the shared cell. `started_at` is fixed at spawn.
#[derive(Debug, Clone)]
pub struct BackgroundTask {
    pub id: String,
    pub session_id: String,
    pub command: String,
    pub command_shell_id: String,
    pub started_at: Instant,
    pub shared: Arc<Mutex<TaskShared>>,
    stop: watch::Sender<bool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundTaskSummary {
    pub id: String,
    pub session_id: String,
    pub command: String,
    pub command_shell_id: String,
    pub state: BackgroundTaskState,
    /// Milliseconds since the task started, not a wall-clock timestamp.
    pub elapsed_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
}

#[derive(Default, Debug)]
pub struct BackgroundTaskRegistry {
    pub(crate) tasks: HashMap<String, BackgroundTask>,
    /// Insertion order, for stable oldest-first pruning of finished entries.
    order: Vec<String>,
}

/// Process-wide change counter. Every start, exit, and stop bumps it; the RPC
/// layer reads it to decide whether a `backgroundTasks.changed` notification is
/// due. A static keeps the detached supervisors independent of the AppState
/// mutex — they can never deadlock against a tool call that holds it.
static CHANGE_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

pub fn bump_change_counter() {
    CHANGE_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
}

pub fn change_counter() -> u64 {
    CHANGE_COUNTER.load(std::sync::atomic::Ordering::Relaxed)
}

impl BackgroundTaskRegistry {
    /// A snapshot is a `try_lock` on a short critical section; a contended
    /// cell reports "running" so a concurrent read never hides a live task.
    fn snapshot(task: &BackgroundTask) -> (BackgroundTaskState, Option<i32>) {
        task.shared
            .try_lock()
            .map(|shared| (shared.state, shared.exit_code))
            .unwrap_or((BackgroundTaskState::Running, None))
    }

    fn is_running(task: &BackgroundTask) -> bool {
        Self::snapshot(task).0 == BackgroundTaskState::Running
    }

    pub fn running_count(&self) -> usize {
        self.tasks
            .values()
            .filter(|task| Self::is_running(task))
            .count()
    }

    pub fn summaries(&self) -> Vec<BackgroundTaskSummary> {
        let mut list: Vec<BackgroundTaskSummary> = self
            .tasks
            .values()
            .map(|task| {
                let (state, exit_code) = Self::snapshot(task);
                BackgroundTaskSummary {
                    id: task.id.clone(),
                    session_id: task.session_id.clone(),
                    command: task.command.clone(),
                    command_shell_id: task.command_shell_id.clone(),
                    state,
                    elapsed_ms: task.started_at.elapsed().as_millis() as u64,
                    exit_code,
                }
            })
            .collect();
        // Running tasks first, then newest first, so the bar reads naturally.
        list.sort_by(|a, b| {
            let rank = |s: &BackgroundTaskSummary| {
                if s.state == BackgroundTaskState::Running {
                    0
                } else {
                    1
                }
            };
            rank(a).cmp(&rank(b)).then_with(|| b.id.cmp(&a.id))
        });
        list
    }
}

pub(crate) async fn spawn_background_task_detached(
    state: &tokio::sync::Mutex<crate::state::AppState>,
    session_id: &str,
    command: &str,
    command_shell_id: &str,
    workspace: &std::path::Path,
    scratch: Option<&std::path::Path>,
    extra_env: &[(String, String)],
) -> Result<String, (String, String)> {
    let on_changed: Arc<dyn Fn() + Send + Sync> = Arc::new(bump_change_counter);
    let config = resolve_runner_config(command_shell_id, command, workspace, scratch, extra_env)?;
    // Admission and registration share the lifecycle lock: shutdown cannot
    // pass between them, and a rejected task never starts its command.
    let mut st = state.lock().await;
    if st.shutting_down {
        return Err(("TOOL_ABORTED".into(), "host is shutting down".into()));
    }
    if st.background_tasks.running_count() >= MAX_RUNNING_TASKS {
        return Err((
            "TOOL_FAILED".into(),
            format!(
                "too many background tasks are running (limit {MAX_RUNNING_TASKS}); stop one first"
            ),
        ));
    }
    let runner = tools::spawn_tool_runner(&config).await?;
    let task = register_spawned_task(
        &mut st.background_tasks,
        session_id,
        command,
        command_shell_id,
        runner,
        on_changed,
    );
    // A start is a state change too. Without this bump the renderer would only
    // learn about the task once it finished, so the running-tasks bar would stay
    // empty for exactly as long as the process was alive.
    bump_change_counter();
    Ok(task.id)
}

fn resolve_runner_config(
    command_shell_id: &str,
    command: &str,
    workspace: &std::path::Path,
    scratch: Option<&std::path::Path>,
    extra_env: &[(String, String)],
) -> Result<tools::ToolRunnerStartConfig, (String, String)> {
    let resolved = tools::shell::resolve_shell(command_shell_id)
        .map_err(|message| ("SHELL_NOT_FOUND".to_string(), message))?;
    let invocation = tools::shell::build_invocation_for_platform(
        tools::shell::current_platform(),
        command_shell_id,
        resolved.program,
        command,
    )
    .map_err(|message| ("INVALID_ARGUMENT".to_string(), message))?;
    Ok(tools::ToolRunnerStartConfig {
        program: invocation.program,
        args: invocation.args,
        workspace: workspace.to_path_buf(),
        scratch_dir: scratch.map(|path| {
            tools::shell::format_scratch_dir_for_shell(
                tools::shell::dialect_for_id(command_shell_id),
                path,
            )
        }),
        env_path: tools::shell::user_login_path().map(str::to_string),
        extra_env: extra_env.to_vec(),
    })
}

fn register_spawned_task(
    registry: &mut BackgroundTaskRegistry,
    session_id: &str,
    command: &str,
    command_shell_id: &str,
    runner: tools::SpawnedToolRunner,
    on_changed: Arc<dyn Fn() + Send + Sync>,
) -> BackgroundTask {
    let (stop, stop_rx) = watch::channel(false);
    let task = BackgroundTask {
        id: uuid::Uuid::new_v4().to_string(),
        session_id: session_id.to_string(),
        command: command.to_string(),
        command_shell_id: command_shell_id.to_string(),
        started_at: Instant::now(),
        shared: Arc::new(Mutex::new(TaskShared {
            state: BackgroundTaskState::Running,
            exit_code: None,
            stdout: VecDeque::new(),
            stderr: VecDeque::new(),
            stdout_bytes: 0,
            stderr_bytes: 0,
            truncated: false,
        })),
        stop,
    };
    registry.order.push(task.id.clone());
    registry.tasks.insert(task.id.clone(), task.clone());
    registry.prune_finished();
    tokio::spawn(supervise(task.clone(), runner, stop_rx, on_changed));
    task
}

/// Drain pipes into the shared rings, honour the stop signal, and record the
/// terminal state. Detached from any turn: only a stop request or host
/// shutdown ends it.
async fn supervise(
    task: BackgroundTask,
    mut runner: tools::SpawnedToolRunner,
    mut stop_rx: watch::Receiver<bool>,
    on_changed: Arc<dyn Fn() + Send + Sync>,
) {
    let stdout_pipe = runner.stdout.take();
    let stderr_pipe = runner.stderr.take();
    let (chunk_tx, mut chunk_rx) = tokio::sync::mpsc::channel::<(bool, Vec<u8>)>(64);
    let stdout_reader = tokio::spawn(drain_pipe(stdout_pipe, true, chunk_tx.clone()));
    let stderr_reader = tokio::spawn(drain_pipe(stderr_pipe, false, chunk_tx.clone()));
    drop(chunk_tx);

    let mut wait = runner.wait_task;
    let mut exit = None;
    let mut output_closed = false;
    let mut stopping = false;
    let mut tree_terminated = false;
    let mut lifecycle_failed = false;
    let mut stdout_decoder = tools::Utf8Decoder::default();
    let mut stderr_decoder = tools::Utf8Decoder::default();
    // Reaping the process and draining its output are separate completion
    // conditions. Keep receiving after exit/stop so a full channel cannot
    // deadlock the readers, and disable recv after EOF to avoid a busy loop.
    while exit.is_none() || !output_closed {
        tokio::select! {
            waited = &mut wait, if exit.is_none() => {
                exit = Some(waited);
                if !tree_terminated {
                    match runner.ownership.terminate_fail_closed(runner.pid) {
                        Ok(()) => tree_terminated = true,
                        Err(error) => {
                            tracing::error!(task_id = %task.id, %error, "background task exit cleanup failed");
                            lifecycle_failed = true;
                        }
                    }
                }
            }
            chunk = chunk_rx.recv(), if !output_closed => {
                let Some((is_stdout, bytes)) = chunk else {
                    output_closed = true;
                    continue;
                };
                let decoder = if is_stdout { &mut stdout_decoder } else { &mut stderr_decoder };
                let text = decoder.push(&bytes).replace('\r', "");
                let mut shared = task.shared.lock().await;
                let dropped = if is_stdout {
                    shared.push_stdout(&text)
                } else {
                    shared.push_stderr(&text)
                };
                if dropped {
                    shared.truncated = true;
                }
            }
            changed = stop_rx.changed(), if !stopping => {
                if changed.is_err() || *stop_rx.borrow() {
                    stopping = true;
                    if !tree_terminated {
                        match runner.ownership.terminate_fail_closed(runner.pid) {
                            Ok(()) => tree_terminated = true,
                            Err(error) => {
                                tracing::error!(task_id = %task.id, %error, "background task stop failed");
                                lifecycle_failed = true;
                            }
                        }
                    }
                }
            }
        }
    }
    for reader in [stdout_reader, stderr_reader] {
        match reader.await {
            Ok(Ok(())) => {}
            result => {
                tracing::error!(task_id = %task.id, ?result, "background task output reader failed");
                lifecycle_failed = true;
            }
        }
    }
    let exit_code = match exit {
        Some(Ok(Ok(status))) => status.code(),
        result => {
            tracing::error!(task_id = %task.id, ?result, "background task wait failed");
            lifecycle_failed = true;
            None
        }
    };

    let stopped = *stop_rx.borrow();
    let state = match (exit_code, stopped, lifecycle_failed) {
        (_, _, true) => BackgroundTaskState::Failed,
        (_, true, false) => BackgroundTaskState::Stopped,
        (Some(0), false, false) => BackgroundTaskState::Exited,
        _ => BackgroundTaskState::Failed,
    };
    {
        let mut shared = task.shared.lock().await;
        let stdout_dropped = shared.push_stdout(&stdout_decoder.finish());
        let stderr_dropped = shared.push_stderr(&stderr_decoder.finish());
        shared.truncated |= stdout_dropped || stderr_dropped;
        shared.state = state;
        shared.exit_code = exit_code;
    }
    on_changed();
}

async fn drain_pipe<R>(
    pipe: Option<R>,
    is_stdout: bool,
    tx: tokio::sync::mpsc::Sender<(bool, Vec<u8>)>,
) -> std::io::Result<()>
where
    R: tokio::io::AsyncRead + Unpin,
{
    let Some(mut pipe) = pipe else { return Ok(()) };
    let mut buffer = [0u8; 8192];
    loop {
        match pipe.read(&mut buffer).await? {
            0 => break,
            read => {
                if tx.send((is_stdout, buffer[..read].to_vec())).await.is_err() {
                    break;
                }
            }
        }
    }
    Ok(())
}

/// Registry operations that read or signal a task. Output reads and state
/// snapshots go through the per-task shared cell and never block the registry.
pub async fn stop_task(registry: &BackgroundTaskRegistry, id: &str) -> Result<bool, String> {
    let Some(task) = registry.tasks.get(id).cloned() else {
        return Ok(false);
    };
    let shared = task.shared.lock().await;
    // Idempotent: a task that already finished or is already stopping reports
    // "nothing to do" so a double click cannot queue a second kill.
    if shared.state != BackgroundTaskState::Running || *task.stop.borrow() {
        return Ok(false);
    }
    let _ = task.stop.send(true);
    Ok(true)
}

pub async fn task_output(
    registry: &BackgroundTaskRegistry,
    id: &str,
) -> Result<Option<serde_json::Value>, String> {
    let Some(task) = registry.tasks.get(id) else {
        return Ok(None);
    };
    let shared = task.shared.lock().await;
    Ok(Some(serde_json::json!({
        "id": task.id,
        "state": shared.state,
        "exitCode": shared.exit_code,
        "stdout": TaskShared::render(&shared.stdout),
        "stderr": TaskShared::render(&shared.stderr),
        "truncated": shared.truncated,
    })))
}

/// Best-effort stop used by `AppState::shutdown`, which cannot await. The
/// signal wakes each supervisor; the tree is killed and reaped there, so
/// shutdown never blocks on the AppState mutex and never leaves an orphan.
pub fn stop_all_running_sync(registry: &BackgroundTaskRegistry) {
    for task in registry.tasks.values() {
        let _ = task.stop.send(true);
    }
}

impl BackgroundTaskRegistry {
    fn prune_finished(&mut self) {
        let finished: Vec<String> = self
            .order
            .iter()
            .filter(|id| {
                self.tasks
                    .get(*id)
                    .is_some_and(|task| !BackgroundTaskRegistry::is_running(task))
            })
            .cloned()
            .collect();
        if finished.len() <= FINISHED_TASK_HISTORY {
            return;
        }
        for id in &finished[..finished.len() - FINISHED_TASK_HISTORY] {
            self.order.retain(|existing| existing != id);
            self.tasks.remove(id);
        }
    }
}

#[cfg(test)]
mod tests;
