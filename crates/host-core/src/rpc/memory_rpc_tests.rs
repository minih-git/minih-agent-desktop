//! Learned-memory RPC contract tests: the wire shape, the refusal values, and
//! the typed errors every caller of `memory.*` depends on.

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

#[tokio::test]
async fn memory_rpc_round_trips_an_entry_through_its_lifecycle() {
    let (dir, state) = open().await;
    let project_dir = dir.path().join("app");
    std::fs::create_dir_all(&project_dir).unwrap();
    let project = canonical_project_path(project_dir.to_str().unwrap()).unwrap();

    let created = call(
        &state,
        "memory.create",
        json!({
            "path": project,
            "kind": "fact",
            "content": "The host core is Rust.",
            "origin": "user_ui"
        }),
    )
    .await
    .unwrap();
    assert_eq!(created["duplicate"], json!(false));
    let id = created["entry"]["id"].as_str().unwrap().to_string();
    assert_eq!(created["entry"]["scopeKind"], json!("project"));
    assert_eq!(created["entry"]["status"], json!("active"));
    assert_eq!(created["entry"]["revision"], json!(1));

    let listed = call(
        &state,
        "memory.list",
        json!({ "path": project, "status": "active" }),
    )
    .await
    .unwrap();
    assert_eq!(listed["entries"].as_array().unwrap().len(), 1);
    assert_eq!(listed["scope"]["kind"], json!("project"));

    let found = call(
        &state,
        "memory.search",
        json!({ "path": project, "query": "rust" }),
    )
    .await
    .unwrap();
    assert_eq!(found["entries"].as_array().unwrap().len(), 1);
    assert_eq!(found["entries"][0]["id"], json!(id));

    let index = call(&state, "memory.index", json!({ "path": project }))
        .await
        .unwrap();
    assert_eq!(index["index"]["entries"].as_array().unwrap().len(), 1);
    assert_eq!(index["index"]["omittedCount"], json!(0));

    // A stale revision is a typed conflict and changes nothing.
    let conflict = call(
        &state,
        "memory.update",
        json!({ "id": id, "revision": 9, "content": "Rewritten." }),
    )
    .await
    .unwrap_err();
    assert_eq!(conflict.code, 1008);
    assert_eq!(error_code(&conflict), "MEMORY_REVISION_CONFLICT");
    let listed = call(&state, "memory.list", json!({ "path": project }))
        .await
        .unwrap();
    assert_eq!(
        listed["entries"][0]["content"],
        json!("The host core is Rust.")
    );

    let updated = call(
        &state,
        "memory.update",
        json!({ "id": id, "revision": 1, "content": "The host core is Rust." }),
    )
    .await
    .unwrap();
    assert_eq!(updated["entry"]["revision"], json!(2));

    // Forget, then the same content cannot come back. The row is erased, so a
    // repeated delete has nothing left to forget and hiding cannot reach it.
    let deleted = call(&state, "memory.delete", json!({ "id": id }))
        .await
        .unwrap();
    assert_eq!(deleted["ok"], json!(true));
    let deleted_again = call(&state, "memory.delete", json!({ "id": id }))
        .await
        .unwrap();
    assert_eq!(deleted_again["ok"], json!(false));
    for method in ["memory.restore", "memory.archive"] {
        let gone = call(&state, method, json!({ "id": id })).await.unwrap_err();
        assert_eq!(gone.code, 1007, "{method} must not reach a deleted memory");
        assert_eq!(error_code(&gone), "NOT_FOUND");
    }
    let listed = call(&state, "memory.list", json!({ "path": project }))
        .await
        .unwrap();
    assert!(listed["entries"].as_array().unwrap().is_empty());
    let refused = call(
        &state,
        "memory.create",
        json!({ "path": project, "kind": "fact", "content": "The host core is Rust." }),
    )
    .await
    .unwrap();
    assert_eq!(refused["rejected"]["code"], json!("MEMORY_TOMBSTONED"));
    // Only the explicit origin may override a tombstone.
    let restored = call(
        &state,
        "memory.create",
        json!({
            "path": project,
            "kind": "fact",
            "content": "The host core is Rust.",
            "origin": "explicit",
            "overrideTombstone": true
        }),
    )
    .await
    .unwrap();
    assert_eq!(
        restored["entry"]["content"],
        json!("The host core is Rust.")
    );

    let unknown = call(&state, "memory.nope", json!({})).await.unwrap_err();
    assert_eq!(unknown.code, 1007);
    let missing = call(&state, "memory.create", json!({ "path": project }))
        .await
        .unwrap_err();
    assert_eq!(error_code(&missing), "INVALID_PARAMS");
}

#[tokio::test]
async fn memory_rpc_refuses_credentials_without_echoing_them() {
    let (dir, state) = open().await;
    let project_dir = dir.path().join("app");
    std::fs::create_dir_all(&project_dir).unwrap();
    let project = canonical_project_path(project_dir.to_str().unwrap()).unwrap();
    let sample = format!("{}{}", "sk-", "a1b2c3d4e5f6g7h8i9j0k1l2");

    let refused = call(
        &state,
        "memory.create",
        json!({ "path": project, "kind": "fact", "content": sample }),
    )
    .await
    .unwrap();
    assert_eq!(
        refused["rejected"]["code"],
        json!("MEMORY_CREDENTIAL_DETECTED")
    );
    let message = refused["rejected"]["message"].as_str().unwrap();
    assert!(!message.contains(&sample));
    assert!(!message.contains("sk-"));

    let listed = call(&state, "memory.list", json!({ "path": project }))
        .await
        .unwrap();
    assert!(listed["entries"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn memory_rpc_scopes_a_session_to_its_own_project() {
    let (dir, state) = open().await;
    let mut sessions = Vec::new();
    for name in ["first", "second"] {
        let path = dir.path().join(name);
        std::fs::create_dir_all(&path).unwrap();
        let project = canonical_project_path(path.to_str().unwrap()).unwrap();
        let session = call(
            &state,
            "session.create",
            json!({ "projectPath": project, "title": name }),
        )
        .await
        .unwrap();
        let session_id = session["session"]["id"].as_str().unwrap().to_string();
        call(
            &state,
            "memory.create",
            json!({
                "sessionId": session_id,
                "kind": "fact",
                "content": format!("{name} project fact")
            }),
        )
        .await
        .unwrap();
        sessions.push(session_id);
    }

    let first = call(
        &state,
        "memory.list",
        json!({ "sessionId": sessions[0], "scope": "project" }),
    )
    .await
    .unwrap();
    assert_eq!(first["entries"].as_array().unwrap().len(), 1);
    assert_eq!(first["entries"][0]["content"], json!("first project fact"));
    let hits = call(
        &state,
        "memory.search",
        json!({ "sessionId": sessions[0], "query": "fact" }),
    )
    .await
    .unwrap();
    let contents: Vec<&str> = hits["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["content"].as_str().unwrap())
        .collect();
    assert_eq!(contents, vec!["first project fact"]);

    let missing = call(
        &state,
        "memory.list",
        json!({ "sessionId": "missing", "scope": "project" }),
    )
    .await
    .unwrap_err();
    assert_eq!(error_code(&missing), "NOT_FOUND");
}

#[tokio::test]
async fn memory_rpc_keeps_a_session_out_of_the_extractor() {
    let (dir, state) = open().await;
    let path = dir.path().join("app");
    std::fs::create_dir_all(&path).unwrap();
    let project = canonical_project_path(path.to_str().unwrap()).unwrap();
    let session = call(
        &state,
        "session.create",
        json!({ "projectPath": project, "title": "app" }),
    )
    .await
    .unwrap();
    let session_id = session["session"]["id"].as_str().unwrap().to_string();

    let claimed = call(
        &state,
        "memory.extraction.claim",
        json!({ "sessionId": session_id, "owner": "run-a" }),
    )
    .await
    .unwrap();
    assert_eq!(claimed["claimed"], json!(true));
    let again = call(
        &state,
        "memory.extraction.claim",
        json!({ "sessionId": session_id, "owner": "run-b" }),
    )
    .await
    .unwrap();
    assert_eq!(again["claimed"], json!(false));

    call(
        &state,
        "memory.session.setExcluded",
        json!({ "sessionId": session_id, "excluded": true }),
    )
    .await
    .unwrap();
    let excluded = call(
        &state,
        "memory.extraction.claim",
        json!({ "sessionId": session_id, "owner": "run-c" }),
    )
    .await
    .unwrap();
    assert_eq!(excluded["claimed"], json!(false));
    let state_value = call(
        &state,
        "memory.session.get",
        json!({ "sessionId": session_id }),
    )
    .await
    .unwrap();
    assert_eq!(state_value["state"]["excluded"], json!(true));
}

#[tokio::test]
async fn memory_rpc_keeps_extraction_and_suggestions_paired() {
    let (dir, state) = open().await;
    let project_dir = dir.path().join("app");
    std::fs::create_dir_all(&project_dir).unwrap();
    let project = canonical_project_path(project_dir.to_str().unwrap()).unwrap();

    // Extraction may only propose.
    let active = call(
        &state,
        "memory.create",
        json!({
            "path": project,
            "kind": "fact",
            "content": "Deploys on Fridays.",
            "origin": "extracted"
        }),
    )
    .await
    .unwrap();
    assert_eq!(active["rejected"]["code"], json!("MEMORY_INVALID_FIELD"));
    for origin in ["explicit", "user_ui"] {
        let refused = call(
            &state,
            "memory.create",
            json!({
                "path": project,
                "kind": "fact",
                "content": "Deploys on Fridays.",
                "origin": origin,
                "status": "suggested"
            }),
        )
        .await
        .unwrap();
        assert_eq!(
            refused["rejected"]["code"],
            json!("MEMORY_INVALID_FIELD"),
            "{origin} cannot create a suggestion"
        );
    }

    let suggestion = call(
        &state,
        "memory.create",
        json!({
            "path": project,
            "kind": "fact",
            "content": "Deploys on Fridays.",
            "origin": "extracted",
            "status": "suggested"
        }),
    )
    .await
    .unwrap();
    assert_eq!(suggestion["entry"]["status"], json!("suggested"));
    let id = suggestion["entry"]["id"].as_str().unwrap().to_string();
    // A suggestion is not part of the index until the user accepts it.
    let index = call(&state, "memory.index", json!({ "path": project }))
        .await
        .unwrap();
    assert!(index["index"]["entries"].as_array().unwrap().is_empty());

    let accepted = call(
        &state,
        "memory.suggestions.decide",
        json!({ "id": id, "decision": "accept" }),
    )
    .await
    .unwrap();
    assert_eq!(accepted["entry"]["status"], json!("active"));

    // A rejected suggestion is erased, and its evidence is blocked afterwards.
    let second = call(
        &state,
        "memory.create",
        json!({
            "path": project,
            "kind": "fact",
            "content": "Reviews on Mondays.",
            "origin": "extracted",
            "status": "suggested"
        }),
    )
    .await
    .unwrap();
    let second_id = second["entry"]["id"].as_str().unwrap().to_string();
    let rejected = call(
        &state,
        "memory.suggestions.decide",
        json!({ "id": second_id, "decision": "reject" }),
    )
    .await
    .unwrap();
    assert_eq!(rejected["rejected"], json!(true));
    let gone = call(
        &state,
        "memory.suggestions.decide",
        json!({ "id": second_id, "decision": "accept" }),
    )
    .await
    .unwrap_err();
    assert_eq!(error_code(&gone), "NOT_FOUND");
    let again = call(
        &state,
        "memory.create",
        json!({
            "path": project,
            "kind": "fact",
            "content": "Reviews on Mondays.",
            "origin": "extracted",
            "status": "suggested"
        }),
    )
    .await
    .unwrap();
    assert_eq!(again["rejected"]["code"], json!("MEMORY_TOMBSTONED"));
}
