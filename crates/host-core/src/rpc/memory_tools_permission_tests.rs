//! The recall tools' permission path: what a call reads decides the risk it
//! carries (ADR agent-long-term-memory §5).
//!
//! Reading the calling session's own project is the free read the tool is
//! registered as. Asking for every project on the machine crosses the same
//! boundary as an explicit outside path, so it takes the normal approval path
//! instead of the low-risk auto-allow — in Agent and in the contract modes
//! alike. `permissions.evaluate` is the preview the renderer shows and the same
//! evaluation `tools.execute` performs, so asserting on it asserts on the gate.

use std::sync::Arc;

use serde_json::{json, Value};
use tokio::sync::{mpsc, Mutex};

use crate::db::canonical_project_path;
use crate::rpc::handle_request;
use crate::state::AppState;

async fn open() -> (tempfile::TempDir, Arc<Mutex<AppState>>) {
    let dir = tempfile::tempdir().unwrap();
    let mut app_state = AppState::open(dir.path()).unwrap();
    app_state.handshook = true;
    (dir, Arc::new(Mutex::new(app_state)))
}

/// A session with one durable mode and one explicit permission mode.
fn session(state: &AppState, dir: &tempfile::TempDir, mode: &str, permission_mode: &str) -> String {
    let project = dir.path().join(format!("{mode}-{permission_mode}"));
    std::fs::create_dir_all(&project).unwrap();
    let project_path = canonical_project_path(project.to_str().unwrap()).unwrap();
    crate::sessions::create_session_with_options(
        &state.db,
        crate::sessions::SessionCreateOptions {
            title: Some(format!("{mode} session")),
            mode: Some(mode.to_string()),
            permission_mode: Some(permission_mode.to_string()),
            project_path: Some(project_path),
            ..Default::default()
        },
    )
    .unwrap()
    .id
}

async fn evaluate(
    state: &Arc<Mutex<AppState>>,
    session_id: &str,
    tool_name: &str,
    args: Value,
) -> Value {
    handle_request(
        state.clone(),
        "permissions.evaluate",
        json!({ "sessionId": session_id, "toolName": tool_name, "args": args }),
        mpsc::unbounded_channel().0,
    )
    .await
    .unwrap()
}

#[tokio::test]
async fn a_history_search_prompts_before_it_reads_another_project() {
    let (dir, state) = open().await;
    let (agent, plan, auto) = {
        let st = state.lock().await;
        (
            session(&st, &dir, "agent", "ask"),
            session(&st, &dir, "plan", "ask"),
            session(&st, &dir, "agent", "auto"),
        )
    };

    // The calling session's own project is the free read it has always been,
    // in every mode: the default scope is that project.
    for session_id in [&agent, &plan] {
        for args in [
            json!({ "query": "gateway" }),
            json!({ "query": "gateway", "scope": "project" }),
        ] {
            let own = evaluate(&state, session_id, "SessionHistorySearch", args.clone()).await;
            assert_eq!(own["decision"], json!("allow-once"), "{args} {own}");
            assert_eq!(own["risk"], json!("low"), "{args} {own}");
        }
    }

    // Every project is a different boundary: Ask needs a card, in Agent and in
    // Plan alike, and the card reports the risk the call carries.
    for session_id in [&agent, &plan] {
        let all = evaluate(
            &state,
            session_id,
            "SessionHistorySearch",
            json!({ "query": "gateway", "scope": "all" }),
        )
        .await;
        assert_eq!(all["decision"], Value::Null, "{all}");
        assert_eq!(all["risk"], json!("medium"), "{all}");
    }

    // The resolved `auto` policy is the normal path for a medium-risk call.
    let allowed = evaluate(
        &state,
        &auto,
        "SessionHistorySearch",
        json!({ "query": "gateway", "scope": "all" }),
    )
    .await;
    assert_eq!(allowed["decision"], json!("allow-once"), "{allowed}");
    assert_eq!(allowed["risk"], json!("medium"), "{allowed}");

    // An unrecognized scope is not a widening: it stays the free read the tool
    // is registered as, and the tool itself refuses the argument.
    let crafted = evaluate(
        &state,
        &agent,
        "SessionHistorySearch",
        json!({ "query": "gateway", "scope": "everything" }),
    )
    .await;
    assert_eq!(crafted["decision"], json!("allow-once"), "{crafted}");
    assert_eq!(crafted["risk"], json!("low"), "{crafted}");
}

#[tokio::test]
async fn learned_memory_search_stays_a_free_read() {
    let (dir, state) = open().await;
    let (agent, plan) = {
        let st = state.lock().await;
        (
            session(&st, &dir, "agent", "ask"),
            session(&st, &dir, "plan", "ask"),
        )
    };
    for session_id in [&agent, &plan] {
        let decision = evaluate(
            &state,
            session_id,
            "MemorySearch",
            json!({ "query": "gateway" }),
        )
        .await;
        assert_eq!(decision["decision"], json!("allow-once"), "{decision}");
        assert_eq!(decision["risk"], json!("low"), "{decision}");
    }
}
