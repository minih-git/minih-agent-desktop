//! `memory.recall`: the per-turn read the runtime makes before a user turn's
//! first provider request (ADR learned-memory-recall §2).
//!
//! Three properties are load-bearing and tested here: the read resolves its
//! scopes from the session itself, it never records a use, and the two filters
//! that make it different from `memory.search` — `excludeIds` and the two-term
//! minimum — are the host's decision, not the caller's.

use std::sync::Arc;

use serde_json::{json, Value};
use tokio::sync::{mpsc, Mutex};

use crate::db::canonical_project_path;
use crate::rpc::{handle_request, JsonRpcError};
use crate::state::AppState;

async fn open() -> (tempfile::TempDir, Arc<Mutex<AppState>>) {
    let dir = tempfile::tempdir().unwrap();
    let mut app_state = AppState::open(dir.path()).unwrap();
    app_state.handshook = true;
    (dir, Arc::new(Mutex::new(app_state)))
}

async fn call(
    state: &Arc<Mutex<AppState>>,
    method: &str,
    params: Value,
) -> Result<Value, JsonRpcError> {
    handle_request(state.clone(), method, params, mpsc::unbounded_channel().0).await
}

fn error_code(error: &JsonRpcError) -> String {
    error
        .data
        .as_ref()
        .and_then(|data| data.get("errorCode"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

/// Create a project directory and a session in it; returns the session id.
async fn project_session(
    dir: &tempfile::TempDir,
    state: &Arc<Mutex<AppState>>,
    name: &str,
) -> String {
    let path = dir.path().join(name);
    std::fs::create_dir_all(&path).unwrap();
    let project = canonical_project_path(path.to_str().unwrap()).unwrap();
    let session = call(
        state,
        "session.create",
        json!({ "projectPath": project, "title": name }),
    )
    .await
    .unwrap();
    session["session"]["id"].as_str().unwrap().to_string()
}

async fn note(state: &Arc<Mutex<AppState>>, session_id: &str, content: &str) -> String {
    let created = call(
        state,
        "memory.create",
        json!({
            "sessionId": session_id,
            "kind": "fact",
            "content": content,
            "origin": "user_ui"
        }),
    )
    .await
    .unwrap();
    created["entry"]["id"].as_str().unwrap().to_string()
}

fn recalled_ids(result: &Value) -> Vec<String> {
    result["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["id"].as_str().unwrap().to_string())
        .collect()
}

#[tokio::test]
async fn recall_returns_the_terms_it_matched_without_recording_a_use() {
    let (dir, state) = open().await;
    let session = project_session(&dir, &state, "app").await;
    let id = note(&state, &session, "The gateway deploy runs on Fridays.").await;

    let recalled = call(
        &state,
        "memory.recall",
        json!({ "sessionId": session, "query": "gateway deploy" }),
    )
    .await
    .unwrap();
    assert_eq!(recalled_ids(&recalled), vec![id.clone()]);
    assert_eq!(
        recalled["entries"][0]["matchedTerms"],
        json!(["gateway", "deploy"])
    );

    // A recall is a view the model did not ask for, so it must not look like a
    // search hit: the counters stay at zero.
    let listed = call(&state, "memory.list", json!({ "sessionId": session }))
        .await
        .unwrap();
    assert_eq!(listed["entries"][0]["useCount"], json!(0));
    assert_eq!(listed["entries"][0]["lastUsedAt"], Value::Null);

    // The tool's own search still counts, which is what makes the difference
    // observable rather than a claim about the code.
    call(
        &state,
        "memory.search",
        json!({ "sessionId": session, "query": "gateway deploy", "recordUse": true }),
    )
    .await
    .unwrap();
    let after = call(&state, "memory.list", json!({ "sessionId": session }))
        .await
        .unwrap();
    assert_eq!(after["entries"][0]["useCount"], json!(1));
}

#[tokio::test]
async fn recall_needs_two_terms_unless_the_query_has_only_one() {
    let (dir, state) = open().await;
    let session = project_session(&dir, &state, "app").await;
    let single = note(&state, &session, "The gateway listens on 8787.").await;
    let double = note(&state, &session, "The gateway deploy runs on Fridays.").await;

    // Two query terms: one shared word is not enough.
    let strict = call(
        &state,
        "memory.recall",
        json!({ "sessionId": session, "query": "gateway deploy" }),
    )
    .await
    .unwrap();
    assert_eq!(recalled_ids(&strict), vec![double]);

    // One query term: one match is all there is to ask for.
    let loose = call(
        &state,
        "memory.recall",
        json!({ "sessionId": session, "query": "gateway" }),
    )
    .await
    .unwrap();
    assert_eq!(recalled_ids(&loose).len(), 2);
    assert!(recalled_ids(&loose).contains(&single));
}

#[tokio::test]
async fn recall_drops_the_ids_the_prompt_already_carries() {
    let (dir, state) = open().await;
    let session = project_session(&dir, &state, "app").await;
    let indexed = note(&state, &session, "The gateway deploy runs on Fridays.").await;
    let overflow = note(&state, &session, "The gateway deploy is in the runbook.").await;

    let index = call(&state, "memory.index", json!({ "sessionId": session }))
        .await
        .unwrap();
    // The index orders by origin and recency, so the ids are compared as a set:
    // what matters here is that they name every note the prompt carries.
    let indexed_ids: Vec<String> = index["index"]["ids"]
        .as_array()
        .unwrap()
        .iter()
        .map(|id| id.as_str().unwrap().to_string())
        .collect();
    let mut expected = vec![indexed.clone(), overflow.clone()];
    expected.sort();
    let mut actual = indexed_ids.clone();
    actual.sort();
    assert_eq!(actual, expected);

    let recalled = call(
        &state,
        "memory.recall",
        json!({
            "sessionId": session,
            "query": "gateway deploy",
            "excludeIds": indexed_ids,
        }),
    )
    .await
    .unwrap();
    assert!(recalled_ids(&recalled).is_empty(), "{recalled}");
}

#[tokio::test]
async fn recall_reads_only_this_session_project_and_the_user() {
    let (dir, state) = open().await;
    let mine = project_session(&dir, &state, "first").await;
    let other = project_session(&dir, &state, "second").await;
    note(&state, &other, "The gateway deploy runs on Fridays.").await;

    let recalled = call(
        &state,
        "memory.recall",
        json!({ "sessionId": mine, "query": "gateway deploy" }),
    )
    .await
    .unwrap();
    assert!(recalled_ids(&recalled).is_empty(), "{recalled}");
}

#[tokio::test]
async fn recall_refuses_a_missing_session_and_a_crafted_path() {
    let (dir, state) = open().await;
    let session = project_session(&dir, &state, "app").await;
    let elsewhere = project_session(&dir, &state, "elsewhere").await;
    note(&state, &elsewhere, "The gateway deploy runs on Fridays.").await;

    let missing = call(
        &state,
        "memory.recall",
        json!({ "sessionId": "no-such-session", "query": "gateway deploy" }),
    )
    .await
    .unwrap_err();
    assert_eq!(error_code(&missing), "NOT_FOUND");

    // A caller cannot aim the read at another project: there is no argument for
    // it, and an unknown one is simply not read.
    let crafted = call(
        &state,
        "memory.recall",
        json!({
            "sessionId": session,
            "query": "gateway deploy",
            "path": dir.path().join("elsewhere").to_str().unwrap(),
        }),
    )
    .await
    .unwrap();
    assert!(recalled_ids(&crafted).is_empty());

    let no_query = call(&state, "memory.recall", json!({ "sessionId": session }))
        .await
        .unwrap_err();
    assert_eq!(error_code(&no_query), "INVALID_PARAMS");
}
