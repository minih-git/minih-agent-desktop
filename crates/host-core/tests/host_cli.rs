//! The host binary's own command line and its data-directory lock, exercised
//! against the compiled binary rather than in-process.
//!
//! These are the guarantees behind the 2026-11-12 incident: a manual
//! `--version` invocation of the installed binary fell through to a normal
//! start, opened the user's data directory, and marked the turns a running host
//! was executing as `aborted`. Every case here uses a throwaway data directory.

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Output, Stdio};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const HOST_BIN: &str = env!("CARGO_BIN_EXE_minih-agent-desktop-host-core");
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(60);
/// The binary waits up to five seconds for a lock before refusing, so this bound
/// only has to be larger than that plus process start.
const LOCK_CONFLICT_TIMEOUT: Duration = Duration::from_secs(30);

/// A live host process on a data directory.
struct Host {
    data_dir: PathBuf,
    child: Child,
    stdin: Option<ChildStdin>,
    lines: Receiver<String>,
}

impl Host {
    fn start(data_dir: &Path) -> Self {
        let mut child = Command::new(HOST_BIN)
            .env("MINIH_AGENT_DATA_DIR", data_dir)
            .stdin(Stdio::piped())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn host binary");
        let stdin = child.stdin.take();
        let stdout = child.stdout.take().expect("host stdout");
        let (tx, lines) = channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                if let Ok(line) = line {
                    if tx.send(line).is_err() {
                        break;
                    }
                } else {
                    break;
                }
            }
        });
        Self {
            data_dir: data_dir.to_path_buf(),
            child,
            stdin,
            lines,
        }
    }

    /// Handshake first, because every other method answers `UNAUTHORIZED`
    /// before it. The protocol version is not exported to this test crate, and
    /// the host names its own in the mismatch error, so the first request is a
    /// discovery call that keeps working when the version is bumped.
    fn handshake(&mut self) {
        let mut claimed = 0u64;
        for _ in 0..3 {
            let response = self.call(
                "app.handshake",
                serde_json::json!({ "protocolVersion": claimed }),
            );
            if let Some(result) = response.get("result") {
                assert!(
                    result["protocolVersion"].as_u64().unwrap_or_default() > 0,
                    "handshake returned no protocol version: {result}"
                );
                return;
            }
            let message = response["error"]["message"]
                .as_str()
                .unwrap_or_default()
                .to_string();
            let Some(host_version) = message
                .split("host=")
                .nth(1)
                .and_then(|tail| tail.trim().parse::<u64>().ok())
            else {
                panic!("handshake failed for a reason other than the protocol: {message}");
            };
            claimed = host_version;
        }
        panic!("handshake kept rejecting the protocol version the host reported");
    }

    fn call(&mut self, method: &str, params: serde_json::Value) -> serde_json::Value {
        let id = next_request_id();
        let request =
            serde_json::json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        self.stdin
            .as_mut()
            .expect("host stdin is open")
            .write_all(format!("{request}\n").as_bytes())
            .expect("write request");
        let deadline = Instant::now() + HANDSHAKE_TIMEOUT;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            let line = match self.lines.recv_timeout(remaining) {
                Ok(line) => line,
                Err(RecvTimeoutError::Timeout) => panic!("timed out waiting for {method}"),
                Err(RecvTimeoutError::Disconnected) => {
                    panic!("host closed its stdout while {method} was in flight")
                }
            };
            let value: serde_json::Value =
                serde_json::from_str(&line).unwrap_or_else(|_| panic!("non-JSON line: {line}"));
            // The host pushes notifications (`backgroundTasks.changed`) beside
            // the replies; only the matching id is this call's answer.
            if value.get("id").and_then(|id| id.as_u64()) == Some(id) {
                return value;
            }
        }
    }

    /// Close stdin, which is the graceful shutdown signal, and wait for exit.
    fn shutdown(mut self) {
        self.stdin.take();
        let deadline = Instant::now() + Duration::from_secs(60);
        loop {
            match self.child.try_wait().expect("wait for host") {
                Some(status) => {
                    assert!(status.success(), "host exited on stdin EOF with {status}");
                    return;
                }
                None if Instant::now() >= deadline => {
                    let _ = self.child.kill();
                    panic!("host did not exit after stdin EOF");
                }
                None => std::thread::sleep(Duration::from_millis(25)),
            }
        }
    }

    fn data_dir(&self) -> &Path {
        &self.data_dir
    }
}

impl Drop for Host {
    fn drop(&mut self) {
        // Only reached on a failing assertion: never leave a host holding the
        // lock of a temp directory that the next test case wants.
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn next_request_id() -> u64 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(1);
    NEXT.fetch_add(1, Ordering::Relaxed)
}

/// Run the binary to completion with the same data directory and argument list
/// a caller would use, with stdin closed (it never waits for input).
fn run_to_completion(data_dir: &Path, args: &[&str]) -> Output {
    Command::new(HOST_BIN)
        .args(args)
        .env("MINIH_AGENT_DATA_DIR", data_dir)
        .stdin(Stdio::null())
        .output()
        .expect("run host binary")
}

fn version_line() -> String {
    format!(
        "minih-agent-desktop-host-core {}",
        env!("CARGO_PKG_VERSION")
    )
}

fn stderr_of(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).into_owned()
}

fn stdout_of(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout).into_owned()
}

fn db_path(data_dir: &Path) -> PathBuf {
    data_dir.join("pi.sqlite")
}

fn open_db(data_dir: &Path) -> rusqlite::Connection {
    let conn = rusqlite::Connection::open(db_path(data_dir)).expect("open host database");
    conn.busy_timeout(Duration::from_secs(10))
        .expect("busy timeout");
    conn
}

/// Put one `running` turn in the database, the way a live turn appears while an
/// agent is executing it.
fn seed_running_turn(data_dir: &Path, session_id: &str, turn_id: &str) {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_millis() as i64;
    let conn = open_db(data_dir);
    conn.execute(
        "INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?1, ?2, ?1, ?1)",
        rusqlite::params![session_id, "test session"],
    )
    .expect("insert session");
    conn.execute(
        "INSERT INTO turns (id, session_id, status, started_at) VALUES (?1, ?2, 'running', ?3)",
        rusqlite::params![turn_id, session_id, now],
    )
    .expect("insert running turn");
}

fn turn_status(data_dir: &Path, turn_id: &str) -> Option<String> {
    open_db(data_dir)
        .query_row("SELECT status FROM turns WHERE id = ?1", [turn_id], |row| {
            row.get(0)
        })
        .ok()
}

#[test]
fn version_answers_without_touching_an_absent_data_directory() {
    let root = tempfile::tempdir().expect("temp dir");
    let data_dir = root.path().join("never-created");

    let output = run_to_completion(&data_dir, &["--version"]);
    let stderr = stderr_of(&output);

    assert!(
        output.status.success(),
        "--version exited with {:?}: {stderr}",
        output.status.code()
    );
    assert!(
        stdout_of(&output).contains(&version_line()),
        "--version printed {:?}",
        stdout_of(&output)
    );
    assert!(
        !data_dir.exists(),
        "--version created the data directory at {}",
        data_dir.display()
    );
}

#[test]
fn help_answers_without_touching_an_absent_data_directory() {
    let root = tempfile::tempdir().expect("temp dir");
    let data_dir = root.path().join("never-created");

    let output = run_to_completion(&data_dir, &["--help"]);

    assert!(
        output.status.success(),
        "--help exited with {:?}",
        output.status.code()
    );
    let stdout = stdout_of(&output);
    assert!(
        stdout.contains("MINIH_AGENT_DATA_DIR"),
        "usage names the data directory: {stdout}"
    );
    assert!(
        stdout.contains("--version"),
        "usage lists --version: {stdout}"
    );
    assert!(!data_dir.exists(), "--help created the data directory");
}

#[test]
fn an_unknown_argument_is_refused_without_creating_the_data_directory() {
    let root = tempfile::tempdir().expect("temp dir");
    let data_dir = root.path().join("never-created");

    let output = run_to_completion(&data_dir, &["--not-a-host-flag"]);

    assert_eq!(
        output.status.code(),
        Some(2),
        "an unknown argument must exit 2, got {:?}",
        output.status.code()
    );
    assert!(
        stderr_of(&output).contains("--not-a-host-flag"),
        "the message names the argument: {}",
        stderr_of(&output)
    );
    assert!(
        !data_dir.exists(),
        "an unknown argument created the data directory"
    );
}

#[test]
fn version_leaves_a_live_host_s_running_turn_alone() {
    let root = tempfile::tempdir().expect("temp dir");
    let data_dir = root.path().join("data");
    std::fs::create_dir_all(&data_dir).expect("data dir");

    let mut host = Host::start(&data_dir);
    host.handshake();
    seed_running_turn(host.data_dir(), "session-live", "turn-live");

    // The probe that caused the incident, run against a host that is using the
    // directory right now.
    let output = run_to_completion(&data_dir, &["--version"]);
    assert!(
        output.status.success(),
        "--version exited with {:?}: {}",
        output.status.code(),
        stderr_of(&output)
    );
    assert!(stdout_of(&output).contains(&version_line()));

    assert_eq!(
        turn_status(&data_dir, "turn-live").as_deref(),
        Some("running"),
        "a --version probe settled the live host's turn"
    );
    // The host is still the owner of the directory and still answers.
    let health = host.call("app.health", serde_json::json!({}));
    assert_eq!(health["result"]["ok"], serde_json::json!(true), "{health}");
    assert_eq!(
        turn_status(&data_dir, "turn-live").as_deref(),
        Some("running")
    );
    host.shutdown();
}

#[test]
fn a_second_host_refuses_an_owned_data_directory() {
    let root = tempfile::tempdir().expect("temp dir");
    let data_dir = root.path().join("data");
    std::fs::create_dir_all(&data_dir).expect("data dir");

    let mut first = Host::start(&data_dir);
    first.handshake();
    seed_running_turn(first.data_dir(), "session-lock", "turn-lock");

    let started = Instant::now();
    let second = run_to_completion(&data_dir, &[]);
    let stderr = stderr_of(&second);

    assert_eq!(
        second.status.code(),
        Some(3),
        "a second host must exit 3, got {:?} ({} ms): {stderr}",
        second.status.code(),
        started.elapsed().as_millis()
    );
    assert!(
        stderr.contains("another host-core process is using the data directory"),
        "the refusal explains itself: {stderr}"
    );
    assert!(
        started.elapsed() < LOCK_CONFLICT_TIMEOUT,
        "the refusal took {} ms, longer than the retry bound",
        started.elapsed().as_millis()
    );

    // Nothing the second process did may reach the first one's work.
    assert_eq!(
        turn_status(&data_dir, "turn-lock").as_deref(),
        Some("running"),
        "the refused host settled the running turn"
    );
    let health = first.call("app.health", serde_json::json!({}));
    assert_eq!(health["result"]["ok"], serde_json::json!(true), "{health}");
    first.shutdown();
}

#[test]
fn a_data_directory_is_reusable_after_its_host_exits() {
    let root = tempfile::tempdir().expect("temp dir");
    let data_dir = root.path().join("data");
    std::fs::create_dir_all(&data_dir).expect("data dir");

    let mut first = Host::start(&data_dir);
    first.handshake();
    seed_running_turn(first.data_dir(), "session-handover", "turn-handover");
    first.shutdown();

    // The lock is the kernel's, not a marker file: it is gone with the process,
    // and the next host boots and settles the turn the previous epoch left.
    let mut second = Host::start(&data_dir);
    second.handshake();
    let health = second.call("app.health", serde_json::json!({}));
    assert_eq!(health["result"]["ok"], serde_json::json!(true), "{health}");
    second.shutdown();
}
