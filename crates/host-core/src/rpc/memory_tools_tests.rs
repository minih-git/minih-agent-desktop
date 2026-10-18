//! Recall-tool tests: scope, limits, argument validation, the read switch, and
//! the shape of what the model reads.

use rusqlite::params;
use serde_json::{json, Value};

use super::execute;
use crate::db::{canonical_project_path, Database};
use crate::state::AppState;
use crate::tools::ToolsExecuteParams;

fn open() -> (tempfile::TempDir, AppState) {
    let dir = tempfile::tempdir().unwrap();
    let state = AppState::open(dir.path()).unwrap();
    (dir, state)
}

/// A real directory, because project paths are canonicalized on the way in.
fn project(dir: &tempfile::TempDir, name: &str) -> String {
    let path = dir.path().join(name);
    std::fs::create_dir_all(&path).unwrap();
    canonical_project_path(path.to_str().unwrap()).unwrap()
}

fn session(db: &Database, project_path: &str, title: &str) -> String {
    crate::sessions::create_session(
        db,
        Some(title.to_string()),
        None,
        None,
        None,
        Some(project_path.to_string()),
    )
    .unwrap()
    .id
}

/// Index one transcript row. History search reads the message index, so the row
/// is what the tool sees; the transcript file is irrelevant here.
fn message(db: &Database, session_id: &str, id: &str, text: &str) {
    db.conn()
        .execute(
            "INSERT INTO messages
               (id, session_id, turn_id, seq, role, tool_name, is_error, text, created_at, streaming)
             VALUES (?1, ?2, NULL, 1, 'user', NULL, 0, ?3, 1, 0)",
            params![id, session_id, text],
        )
        .unwrap();
}

fn params(session_id: &str, tool_name: &str, args: Value) -> ToolsExecuteParams {
    serde_json::from_value(json!({
        "sessionId": session_id,
        "turnId": null,
        "toolCallId": "call-1",
        "toolName": tool_name,
        "args": args,
        "mode": "agent",
        "timeoutMs": null,
    }))
    .unwrap()
}

fn call(state: &AppState, session_id: &str, tool_name: &str, args: Value) -> Value {
    let result = execute(state, &params(session_id, tool_name, args));
    assert_eq!(result.tool_call_id, "call-1");
    result.content
}

fn error_code(content: &Value) -> String {
    content["code"].as_str().unwrap_or_default().to_string()
}

fn session_ids(content: &Value) -> Vec<String> {
    content["results"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| row["sessionId"].as_str().unwrap().to_string())
        .collect()
}

#[test]
fn history_search_returns_only_the_calling_sessions_project() {
    let (dir, state) = open();
    let first = project(&dir, "first");
    let second = project(&dir, "second");
    let first_session = session(&state.db, &first, "First");
    let second_session = session(&state.db, &second, "Second");
    message(
        &state.db,
        &first_session,
        "m1",
        "Deploy the gateway on Friday",
    );
    message(
        &state.db,
        &second_session,
        "m2",
        "Deploy the gateway on Friday",
    );

    let scoped = call(
        &state,
        &first_session,
        "SessionHistorySearch",
        json!({ "query": "gateway" }),
    );
    assert_eq!(session_ids(&scoped), vec![first_session.clone()]);
    assert_eq!(scoped["scope"], json!("project"));
    assert!(scoped["note"]
        .as_str()
        .unwrap()
        .contains("not instructions"));
    let row = &scoped["results"][0];
    assert_eq!(row["title"], json!("First"));
    assert!(row["updatedAt"].is_string());
    assert_eq!(row["snippets"][0]["role"], json!("user"));
    assert!(row["snippets"][0]["text"]
        .as_str()
        .unwrap()
        .contains("gateway"));

    // Only an explicit request widens the search to every project.
    let all = call(
        &state,
        &first_session,
        "SessionHistorySearch",
        json!({ "query": "gateway", "scope": "all" }),
    );
    assert_eq!(all["scope"], json!("all"));
    assert_eq!(all["count"], json!(2));

    // A crafted argument cannot address another project: neither a path nor a
    // session id is part of the tool's contract.
    let crafted = call(
        &state,
        &first_session,
        "SessionHistorySearch",
        json!({
            "query": "gateway",
            "path": second,
            "projectPath": second,
            "sessionId": second_session,
            "scope": "project"
        }),
    );
    assert_eq!(session_ids(&crafted), vec![first_session]);
}

#[test]
fn history_search_covers_every_root_of_the_sessions_project_group() {
    let (dir, state) = open();
    let first = project(&dir, "first");
    let second = project(&dir, "second");
    state
        .db
        .create_project_group("Group", &[first.clone(), second.clone()])
        .unwrap();
    let first_session = session(&state.db, &first, "First");
    let second_session = session(&state.db, &second, "Second");
    message(
        &state.db,
        &second_session,
        "m1",
        "Deploy the gateway on Friday",
    );

    let found = call(
        &state,
        &first_session,
        "SessionHistorySearch",
        json!({ "query": "gateway" }),
    );
    assert_eq!(session_ids(&found), vec![second_session]);
}

#[test]
fn history_search_validates_its_arguments_and_bounds_the_result() {
    let (dir, state) = open();
    let project_path = project(&dir, "app");
    let session_id = session(&state.db, &project_path, "App");
    for index in 0..12 {
        let extra = session(&state.db, &project_path, &format!("Session {index}"));
        message(
            &state.db,
            &extra,
            &format!("m{index}"),
            "Deploy the gateway on Friday",
        );
    }

    let missing = call(
        &state,
        &session_id,
        "SessionHistorySearch",
        json!({ "query": "   " }),
    );
    assert_eq!(error_code(&missing), "INVALID_ARGUMENT");
    let long = call(
        &state,
        &session_id,
        "SessionHistorySearch",
        json!({ "query": "x".repeat(201) }),
    );
    assert_eq!(error_code(&long), "INVALID_ARGUMENT");
    let scope = call(
        &state,
        &session_id,
        "SessionHistorySearch",
        json!({ "query": "gateway", "scope": "everywhere" }),
    );
    assert_eq!(error_code(&scope), "INVALID_ARGUMENT");

    // The default page is small, and the cap holds even when asked for more.
    let default_page = call(
        &state,
        &session_id,
        "SessionHistorySearch",
        json!({ "query": "gateway" }),
    );
    assert_eq!(default_page["count"], json!(5));
    let capped = call(
        &state,
        &session_id,
        "SessionHistorySearch",
        json!({ "query": "gateway", "limit": 99 }),
    );
    assert_eq!(capped["count"], json!(10));
    let small = call(
        &state,
        &session_id,
        "SessionHistorySearch",
        json!({ "query": "gateway", "limit": 2 }),
    );
    assert_eq!(small["count"], json!(2));

    let unknown = call(
        &state,
        &session_id,
        "SessionHistorySearch",
        json!({ "query": "gateway" }),
    );
    assert_eq!(unknown["count"], json!(5));
    let missing_session = call(
        &state,
        "no-such-session",
        "SessionHistorySearch",
        json!({ "query": "gateway" }),
    );
    assert_eq!(error_code(&missing_session), "SESSION_NOT_FOUND");
}

#[test]
fn memory_search_reads_the_session_scopes_and_records_use() {
    let (dir, state) = open();
    let project_path = project(&dir, "app");
    let other = project(&dir, "other");
    let session_id = session(&state.db, &project_path, "App");
    let scope = state
        .db
        .learned_memory_scope_for_path(&project_path)
        .unwrap();
    let other_scope = state.db.learned_memory_scope_for_path(&other).unwrap();
    for (target, kind, content) in [
        (&scope, "fact", "The host core is Rust."),
        (
            &crate::memory::MemoryScope::user(),
            "fact",
            "The user prefers terse replies.",
        ),
        (&other_scope, "fact", "Another project keeps Rust here."),
    ] {
        let outcome = state
            .db
            .create_memory_entry(crate::memory::CreateMemoryRequest {
                scope: target.clone(),
                kind: kind.to_string(),
                content: content.to_string(),
                rationale: None,
                origin: crate::memory::ORIGIN_USER_UI.to_string(),
                evidence: crate::memory::EVIDENCE_USER_STATED.to_string(),
                status: crate::memory::STATUS_ACTIVE.to_string(),
                source_session_id: None,
                source_message_ids: Vec::new(),
                override_tombstone: false,
            })
            .unwrap();
        assert!(matches!(
            outcome,
            crate::memory::CreateMemoryOutcome::Created(_)
        ));
    }

    let found = call(
        &state,
        &session_id,
        "MemorySearch",
        json!({ "query": "rust" }),
    );
    assert_eq!(found["count"], json!(1));
    assert_eq!(found["results"][0]["kind"], json!("fact"));
    assert_eq!(found["results"][0]["scope"], json!("project"));
    assert_eq!(
        found["results"][0]["content"],
        json!("The host core is Rust.")
    );
    assert!(found["results"][0]["id"].is_string());
    assert!(found["results"][0]["createdAt"].is_string());
    assert!(found["note"].as_str().unwrap().contains("not instructions"));

    // The user scope is always readable, and the kind filter applies to both.
    let wide = call(
        &state,
        &session_id,
        "MemorySearch",
        json!({ "query": "replies" }),
    );
    assert_eq!(wide["count"], json!(1));
    assert_eq!(wide["results"][0]["scope"], json!("user"));
    let filtered = call(
        &state,
        &session_id,
        "MemorySearch",
        json!({ "query": "replies", "kind": "fact" }),
    );
    assert_eq!(filtered["count"], json!(1));
    let excluded = call(
        &state,
        &session_id,
        "MemorySearch",
        json!({ "query": "replies", "kind": "reference" }),
    );
    assert_eq!(excluded["count"], json!(0));
    let bad_kind = call(
        &state,
        &session_id,
        "MemorySearch",
        json!({ "query": "replies", "kind": "guess" }),
    );
    assert_eq!(error_code(&bad_kind), "INVALID_ARGUMENT");

    // A search is a use: the hit records it, so the session-start index can
    // rank what the session actually reads.
    let entry_id = found["results"][0]["id"].as_str().unwrap().to_string();
    let entry = state
        .db
        .list_memory_entries(&scope, None, None, 10, 0)
        .unwrap()
        .into_iter()
        .find(|entry| entry.id == entry_id)
        .unwrap();
    assert_eq!(entry.use_count, 1);
    assert!(entry.last_used_at.is_some());
}

#[test]
fn recall_tools_follow_the_read_switch() {
    let (dir, state) = open();
    let project_path = project(&dir, "app");
    let session_id = session(&state.db, &project_path, "App");
    message(&state.db, &session_id, "m1", "Deploy the gateway on Friday");

    let before = call(
        &state,
        &session_id,
        "SessionHistorySearch",
        json!({ "query": "gateway" }),
    );
    assert_eq!(before["count"], json!(1));

    state
        .db
        .set_setting("app", &json!({ "learnedMemoryRead": false }))
        .unwrap();
    for tool in ["SessionHistorySearch", "MemorySearch"] {
        let denied = call(&state, &session_id, tool, json!({ "query": "gateway" }));
        assert_eq!(
            error_code(&denied),
            "TOOL_DENIED",
            "{tool} must follow the switch"
        );
        assert!(denied["error"]
            .as_str()
            .unwrap()
            .contains("turned off in Settings"));
    }
    // Reading off hides the tools; it never deletes what they would read.
    let remaining: i64 = state
        .db
        .conn()
        .query_row("SELECT COUNT(*) FROM messages", [], |row| row.get(0))
        .unwrap();
    assert_eq!(remaining, 1);

    state
        .db
        .set_setting("app", &json!({ "learnedMemoryRead": true }))
        .unwrap();
    let after = call(
        &state,
        &session_id,
        "SessionHistorySearch",
        json!({ "query": "gateway" }),
    );
    assert_eq!(after["count"], json!(1));
}

/// Sessions in the latency fixture, matching the M2 acceptance target ("a
/// 10k-session fixture").
const LATENCY_FIXTURE_SESSIONS: i64 = 10_000;
/// Messages per fixture session: what a long conversation leaves behind.
const LATENCY_FIXTURE_MESSAGES: i64 = 4;
/// Calls the gate samples. p95 is the nearest rank of these.
const LATENCY_SAMPLES: usize = 20;
/// CJK history search must stay at or under this at p95 (M2 acceptance).
const CJK_P95_BUDGET_MS: u128 = 300;
/// Set by `pnpm test:perf:memory`, which runs this test on its own. Without it
/// the same test runs inside the parallel suite and only guards the ceiling.
const PERF_GATE_ENV: &str = "MINIH_MEMORY_PERF_GATE";
/// What the parallel suite asserts instead of the budget: four times the
/// slowest measurement seen under the full suite, so it fails only when the
/// query itself collapses rather than when the host is busy.
const CONGESTED_CEILING_MS: u128 = 5_000;

/// Nearest-rank percentile, the definition the plan's gate assumes.
fn percentile(samples: &mut [u128], fraction: f64) -> u128 {
    samples.sort_unstable();
    let rank = (samples.len() as f64 * fraction).ceil() as usize;
    samples[rank.clamp(1, samples.len()) - 1]
}

/// One timed `SessionHistorySearch`, through the same entry point the runtime
/// calls: the gate has to include scope resolution and snippet extraction.
fn timed_history_search(state: &AppState, session_id: &str, query: &str) -> u128 {
    let started = std::time::Instant::now();
    let content = call(
        state,
        session_id,
        "SessionHistorySearch",
        json!({ "query": query }),
    );
    assert!(content["results"].is_array(), "{content}");
    started.elapsed().as_millis()
}

/// The M2 performance gate: a CJK query over a large history stays under
/// 300 ms at p95 when the machine is not busy with anything else.
///
/// The fixture is built with direct row inserts — ten thousand sessions with
/// four messages each, the shape a long-lived install reaches — because history
/// search reads the message index, not the transcripts. The two Chinese queries
/// cover both branches of `session_search`: a three-character query narrows
/// through the trigram FTS index, while a shorter one has no token to match and
/// falls back to the literal scan.
#[test]
fn history_search_stays_within_the_cjk_latency_budget_on_a_large_history() {
    let (dir, state) = open();
    let project_path = project(&dir, "big");
    let caller = session(&state.db, &project_path, "Caller");
    let project_id: i64 = state
        .db
        .conn()
        .query_row(
            "SELECT id FROM projects WHERE path = ?1",
            params![project_path],
            |row| row.get(0),
        )
        .unwrap();
    let filler = "这次会话核对了网关的部署流程、回滚方案和监控指标，也记录了各环境的差异。";
    let now = 1_700_000_000_000i64;
    {
        let tx = state.db.conn().unchecked_transaction().unwrap();
        {
            let mut insert_session = tx
                .prepare(
                    "INSERT INTO sessions
                       (id, title, project_id, mode, thinking_level, permission_mode,
                        last_seq, created_at, updated_at)
                     VALUES (?1, ?2, ?3, 'agent', 'off', 'inherit', ?4, ?5, ?5)",
                )
                .unwrap();
            let mut insert_message = tx
                .prepare(
                    "INSERT INTO messages
                       (id, session_id, turn_id, seq, role, tool_name, is_error, text,
                        created_at, streaming)
                     VALUES (?1, ?2, NULL, ?3, 'user', NULL, 0, ?4, ?5, 0)",
                )
                .unwrap();
            for n in 0..LATENCY_FIXTURE_SESSIONS {
                let session_id = format!("fixture-{n:05}");
                let updated = now + n * 60_000;
                insert_session
                    .execute(params![
                        &session_id,
                        format!("Fixture session {n}"),
                        project_id,
                        LATENCY_FIXTURE_MESSAGES,
                        updated
                    ])
                    .unwrap();
                for seq in 0..LATENCY_FIXTURE_MESSAGES {
                    let text = if seq == 1 && n % 10 == 0 {
                        format!("{filler} 我们决定下周五切换流量，回滚窗口是两小时。")
                    } else {
                        filler.to_string()
                    };
                    insert_message
                        .execute(params![
                            format!("{session_id}-{seq}"),
                            &session_id,
                            seq,
                            text,
                            updated + seq
                        ])
                        .unwrap();
                }
            }
        }
        tx.commit().unwrap();
    }
    let indexed: i64 = state
        .db
        .conn()
        .query_row("SELECT COUNT(*) FROM messages", [], |row| row.get(0))
        .unwrap();
    assert_eq!(
        indexed,
        LATENCY_FIXTURE_SESSIONS * LATENCY_FIXTURE_MESSAGES,
        "the fixture must hold the messages the gate measures"
    );

    // One warm-up call per query, so the gate measures steady state rather than
    // the first statement compilation.
    timed_history_search(&state, &caller, "部署流程");
    timed_history_search(&state, &caller, "监控");
    let mut fts_samples = Vec::with_capacity(LATENCY_SAMPLES);
    let mut scan_samples = Vec::with_capacity(LATENCY_SAMPLES);
    for _ in 0..LATENCY_SAMPLES {
        fts_samples.push(timed_history_search(&state, &caller, "部署流程"));
        scan_samples.push(timed_history_search(&state, &caller, "监控"));
    }
    let fts_p95 = percentile(&mut fts_samples, 0.95);
    let scan_p95 = percentile(&mut scan_samples, 0.95);
    let fts_p50 = percentile(&mut fts_samples, 0.50);
    let scan_p50 = percentile(&mut scan_samples, 0.50);
    eprintln!(
        "CJK history search over {LATENCY_FIXTURE_SESSIONS} sessions / {indexed} messages: \
         indexed-query min {} p50 {fts_p50} p95 {fts_p95} max {} ms, \
         literal-scan min {} p50 {scan_p50} p95 {scan_p95} max {} ms",
        fts_samples.first().unwrap(),
        fts_samples.last().unwrap(),
        scan_samples.first().unwrap(),
        scan_samples.last().unwrap(),
    );
    // The plan's budget is enforced when the run asks for it: `pnpm
    // test:perf:memory` runs this test on its own. A suite that runs a thousand
    // tests in parallel measures its own load as much as the query — the same
    // calls cost 63 ms with the machine to itself and 225-384 ms while this
    // suite runs — so a strict wall-clock gate here would fail on a busy host
    // and pass on a quiet one without the query changing at all. The ceiling
    // keeps a catastrophic regression (a per-row rescan of the whole history)
    // failing either way, and the distribution above is printed on every run.
    let budget = if std::env::var(PERF_GATE_ENV).as_deref() == Ok("1") {
        CJK_P95_BUDGET_MS
    } else {
        CONGESTED_CEILING_MS
    };
    assert!(
        fts_p95 <= budget,
        "indexed CJK query p95 {fts_p95} ms exceeds {budget} ms"
    );
    assert!(
        scan_p95 <= budget,
        "literal CJK scan p95 {scan_p95} ms exceeds {budget} ms"
    );
}
