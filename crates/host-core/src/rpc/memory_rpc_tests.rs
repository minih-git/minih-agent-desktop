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
    // A held lease and the user's own exclusion are both refusals, and the
    // caller has to tell them apart: one is a race, the other is a decision.
    assert_eq!(again["reason"], json!("busy"));

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
    assert_eq!(excluded["reason"], json!("excluded"));
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

// ---- remember again --------------------------------------------------------

/// A finished turn of `session_id` with one user message, the way a receipt is
/// answered after its turn ended. Returns `(turnId, messageId)`.
async fn finished_turn(
    state: &Arc<Mutex<AppState>>,
    session_id: &str,
    content: &str,
) -> (String, String) {
    let turn = call(
        state,
        "session.beginTurn",
        json!({ "sessionId": session_id }),
    )
    .await
    .unwrap();
    let turn_id = turn["turnId"].as_str().unwrap().to_string();
    let message_id = uuid::Uuid::new_v4().to_string();
    call(
        state,
        "session.appendMessage",
        json!({
            "sessionId": session_id,
            "turnId": turn_id,
            "message": {
                "id": message_id,
                "role": "user",
                "content": content,
                "createdAt": crate::db::ms_to_ts(crate::db::now_ms()),
            }
        }),
    )
    .await
    .unwrap();
    {
        let st = state.lock().await;
        st.db
            .conn()
            .execute(
                "UPDATE turns SET status = 'completed' WHERE id = ?1",
                rusqlite::params![turn_id],
            )
            .unwrap();
    }
    (turn_id, message_id)
}

/// One stored note, through the M1 create path. A `preference` has to cite what
/// the user said, so the caller passes the turn's own message.
async fn create_note(
    state: &Arc<Mutex<AppState>>,
    session_id: &str,
    message_id: &str,
    content: &str,
) -> String {
    let created = call(
        state,
        "memory.create",
        json!({
            "sessionId": session_id,
            "kind": "preference",
            "content": content,
            "sourceSessionId": session_id,
            "sourceMessageIds": [message_id],
        }),
    )
    .await
    .unwrap();
    assert!(created["entry"].is_object(), "{created}");
    created["entry"]["id"].as_str().unwrap().to_string()
}

/// The user's own action is the one write that clears a delete: it reaches the
/// host through `memory.rememberAgain`, never through the tool, and the cited
/// evidence is still resolved host-side from the turn the receipt belongs to.
#[tokio::test]
async fn remember_again_restores_a_deleted_note_for_the_user() {
    let (dir, state) = open().await;
    let project_dir = dir.path().join("app");
    std::fs::create_dir_all(&project_dir).unwrap();
    let project = canonical_project_path(project_dir.to_str().unwrap()).unwrap();
    let session = call(
        &state,
        "session.create",
        json!({ "projectPath": project, "title": "App" }),
    )
    .await
    .unwrap();
    let session_id = session["session"]["id"].as_str().unwrap().to_string();
    let (turn_id, message_id) = finished_turn(&state, &session_id, "以后都用中文回答。").await;

    let note = create_note(
        &state,
        &session_id,
        &message_id,
        "Prefers terse Chinese replies.",
    )
    .await;
    call(&state, "memory.delete", json!({ "id": note }))
        .await
        .unwrap();

    // The user presses "remember again" on the receipt. The turn has already
    // ended, which is fine: the receipt is answered after the fact.
    let restored = call(
        &state,
        "memory.rememberAgain",
        json!({
            "sessionId": session_id,
            "turnId": turn_id,
            "kind": "preference",
            "content": "Prefers terse Chinese replies.",
            "scope": "project",
        }),
    )
    .await
    .unwrap();
    assert_eq!(restored["duplicate"], json!(false));
    let entry = &restored["entry"];
    assert_ne!(entry["id"], json!(note));
    assert_eq!(entry["status"], json!("active"));
    assert_eq!(entry["origin"], json!("explicit"));
    assert_eq!(entry["evidence"], json!("user_stated"));
    assert_eq!(entry["sourceSessionId"], json!(session_id));
    // The provenance is the turn's own user message, resolved by the host.
    assert_eq!(entry["sourceMessageIds"], json!([message_id]));

    // The same content can no longer be refused by the tombstone.
    let listed = call(&state, "memory.list", json!({ "path": project }))
        .await
        .unwrap();
    assert_eq!(listed["entries"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn remember_again_refuses_a_turn_from_another_session() {
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
        sessions.push(session["session"]["id"].as_str().unwrap().to_string());
    }
    let (other_turn, _) = finished_turn(&state, &sessions[1], "别人的话").await;

    // The renderer cannot point at another session's turn to borrow its
    // evidence, and it cannot name a message id at all.
    let refused = call(
        &state,
        "memory.rememberAgain",
        json!({
            "sessionId": sessions[0],
            "turnId": other_turn,
            "kind": "preference",
            "content": "Prefers terse Chinese replies.",
            "sourceMessageIds": ["whatever"],
        }),
    )
    .await
    .unwrap_err();
    assert_eq!(error_code(&refused), "SESSION_NOT_FOUND");

    // A turn id that does not exist is refused the same way.
    let missing = call(
        &state,
        "memory.rememberAgain",
        json!({
            "sessionId": sessions[0],
            "turnId": "no-such-turn",
            "kind": "preference",
            "content": "Prefers terse Chinese replies.",
        }),
    )
    .await
    .unwrap_err();
    assert_eq!(error_code(&missing), "SESSION_NOT_FOUND");
}

#[tokio::test]
async fn remember_again_keeps_every_other_write_rule() {
    let (dir, state) = open().await;
    let project_dir = dir.path().join("app");
    std::fs::create_dir_all(&project_dir).unwrap();
    let project = canonical_project_path(project_dir.to_str().unwrap()).unwrap();
    let session = call(
        &state,
        "session.create",
        json!({ "projectPath": project, "title": "App" }),
    )
    .await
    .unwrap();
    let session_id = session["session"]["id"].as_str().unwrap().to_string();
    let (turn_id, _) = finished_turn(&state, &session_id, "用中文回答。").await;

    // A credential is refused here too, and the text is not echoed.
    let secret = "sk-ant-api03-abcdefghijklmnopqrstuvwx";
    let refused = call(
        &state,
        "memory.rememberAgain",
        json!({
            "sessionId": session_id,
            "turnId": turn_id,
            "kind": "fact",
            "content": format!("The API key is {secret}"),
        }),
    )
    .await
    .unwrap();
    assert_eq!(
        refused["rejected"]["code"],
        json!("MEMORY_CREDENTIAL_DETECTED")
    );
    assert!(!refused.to_string().contains(secret));

    // `verified` stays limited to a fact or a reference.
    let refused = call(
        &state,
        "memory.rememberAgain",
        json!({
            "sessionId": session_id,
            "turnId": turn_id,
            "kind": "preference",
            "content": "Prefers Chinese replies.",
            "basis": "verified",
        }),
    )
    .await
    .unwrap();
    assert_eq!(
        refused["rejected"]["code"],
        json!("MEMORY_PROVENANCE_REQUIRED")
    );
}

#[tokio::test]
async fn memory_index_without_a_project_returns_the_user_scope_alone() {
    let (dir, state) = open().await;
    let project_dir = dir.path().join("app");
    std::fs::create_dir_all(&project_dir).unwrap();
    let project = canonical_project_path(project_dir.to_str().unwrap()).unwrap();

    let project_entry = call(
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
    let user_entry = call(
        &state,
        "memory.create",
        json!({
            "scope": "user",
            "kind": "fact",
            "content": "Prefers terse Chinese replies.",
            "origin": "user_ui"
        }),
    )
    .await
    .unwrap();
    assert_eq!(user_entry["entry"]["scopeKind"], json!("user"));

    let index = call(&state, "memory.index", json!({})).await.unwrap();
    let entries = index["index"]["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 1, "{index}");
    assert_eq!(entries[0]["id"], user_entry["entry"]["id"]);
    assert_eq!(entries[0]["scopeKind"], json!("user"));

    // A project snapshot still carries both scopes.
    let scoped = call(&state, "memory.index", json!({ "path": project }))
        .await
        .unwrap();
    let ids: Vec<&str> = scoped["index"]["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids.len(), 2, "{scoped}");
    assert!(ids.contains(&project_entry["entry"]["id"].as_str().unwrap()));
    assert!(ids.contains(&user_entry["entry"]["id"].as_str().unwrap()));
}

#[tokio::test]
async fn memory_rpc_serves_the_extraction_input_and_the_suggestion_inbox() {
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
    let message_id = "user-1".to_string();
    let started = call(
        &state,
        "session.beginTurn",
        json!({ "sessionId": session_id }),
    )
    .await
    .unwrap();
    let turn_id = started["turnId"].as_str().unwrap().to_string();
    call(
        &state,
        "session.appendMessage",
        json!({
            "sessionId": session_id,
            "turnId": turn_id,
            "message": {
                "id": message_id,
                "role": "user",
                "content": "Use pnpm and never npm",
                "createdAt": "2026-10-20T00:00:00.000Z"
            }
        }),
    )
    .await
    .unwrap();
    call(
        &state,
        "session.endTurn",
        json!({ "sessionId": session_id, "turnId": turn_id }),
    )
    .await
    .unwrap();

    let input = call(
        &state,
        "memory.extraction.input",
        json!({ "sessionId": session_id }),
    )
    .await
    .unwrap();
    let messages = input["input"]["messages"].as_array().unwrap();
    assert_eq!(messages.len(), 1, "{input}");
    assert_eq!(messages[0]["id"], json!(message_id));
    assert_eq!(input["input"]["cursorSeq"], json!(0));

    // The budget endpoint adds one run and answers the same day's total.
    let spent = call(
        &state,
        "memory.extraction.budget",
        json!({ "day": "2026-10-20", "tokens": 900 }),
    )
    .await
    .unwrap();
    assert_eq!(spent["budget"]["tokens"], json!(900));
    let read = call(
        &state,
        "memory.extraction.budget",
        json!({ "day": "2026-10-20" }),
    )
    .await
    .unwrap();
    assert_eq!(read["budget"]["tokens"], json!(900));
    let tomorrow = call(
        &state,
        "memory.extraction.budget",
        json!({ "day": "2026-10-21" }),
    )
    .await
    .unwrap();
    assert_eq!(tomorrow["budget"]["tokens"], json!(0));

    // A suggestion reaches the inbox with its citations, and the count the
    // badge reads matches it.
    let suggestion = call(
        &state,
        "memory.create",
        json!({
            "path": project,
            "kind": "preference",
            "content": "Uses pnpm instead of npm",
            "origin": "extracted",
            "status": "suggested",
            "sourceSessionId": session_id,
            "sourceMessageIds": [message_id]
        }),
    )
    .await
    .unwrap();
    assert_eq!(suggestion["duplicate"], json!(false));
    let inbox = call(
        &state,
        "memory.suggestions.list",
        json!({ "path": project }),
    )
    .await
    .unwrap();
    assert_eq!(inbox["count"], json!(1));
    let entries = inbox["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0]["status"], json!("suggested"));
    assert_eq!(entries[0]["origin"], json!("extracted"));
    assert_eq!(entries[0]["sourceMessageIds"], json!([message_id]));

    // Accepting moves it out of the inbox, which is the only activation path.
    call(
        &state,
        "memory.suggestions.decide",
        json!({ "id": entries[0]["id"], "decision": "accept" }),
    )
    .await
    .unwrap();
    let after = call(
        &state,
        "memory.suggestions.list",
        json!({ "path": project }),
    )
    .await
    .unwrap();
    assert_eq!(after["count"], json!(0));
}

#[tokio::test]
async fn an_extraction_write_resolves_its_scope_from_the_session() {
    let (dir, state) = open().await;
    // A group session: the project identity is the group, not the folder path.
    let folder = dir.path().join("grouped");
    std::fs::create_dir_all(&folder).unwrap();
    let project = canonical_project_path(folder.to_str().unwrap()).unwrap();
    let group = call(
        &state,
        "project.group.create",
        json!({ "name": "Grouped", "folders": [project] }),
    )
    .await
    .unwrap();
    let group_id = group["group"]["id"].as_str().unwrap().to_string();
    let grouped_session = call(
        &state,
        "session.create",
        json!({ "projectPath": project, "title": "grouped" }),
    )
    .await
    .unwrap();
    let grouped_session_id = grouped_session["session"]["id"]
        .as_str()
        .unwrap()
        .to_string();

    // A session that belongs to no project at all.
    let loose_session = call(&state, "session.create", json!({ "title": "loose" }))
        .await
        .unwrap();
    let loose_session_id = loose_session["session"]["id"].as_str().unwrap().to_string();

    // The service never passes a path: a group id is not one, and a session with
    // no project has none. The host resolves the scope from the session itself.
    let in_group = call(
        &state,
        "memory.create",
        json!({
            "sessionId": grouped_session_id,
            "kind": "fact",
            "content": "The group deploys on Fridays.",
            "origin": "extracted",
            "status": "suggested",
            "evidence": "inferred"
        }),
    )
    .await
    .unwrap();
    assert_eq!(in_group["entry"]["scopeKind"], json!("project"));
    assert_eq!(in_group["entry"]["scopeKey"], json!(group_id));

    let loose = call(
        &state,
        "memory.create",
        json!({
            "sessionId": loose_session_id,
            "scope": "user",
            "kind": "fact",
            "content": "Prefers the terminal.",
            "origin": "extracted",
            "status": "suggested",
            "evidence": "inferred"
        }),
    )
    .await
    .unwrap();
    assert_eq!(loose["entry"]["scopeKind"], json!("user"));
    // The user scope stores no key: it is compared as '' internally.
    assert_eq!(loose["entry"]["scopeKey"], json!(null));

    // And a project-scope write from a session that has no project is refused as
    // a caller mistake, which is what the service drops before asking.
    let refused = call(
        &state,
        "memory.create",
        json!({
            "sessionId": loose_session_id,
            "kind": "fact",
            "content": "Nowhere to put this.",
            "origin": "extracted",
            "status": "suggested",
            "evidence": "inferred"
        }),
    )
    .await
    .unwrap_err();
    assert_eq!(error_code(&refused), "NOT_FOUND");
}
