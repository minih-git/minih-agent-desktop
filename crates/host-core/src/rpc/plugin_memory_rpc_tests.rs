//! Plugin learned-memory RPC contract tests.

use std::collections::BTreeSet;
use std::sync::Arc;

use rusqlite::params;
use serde_json::{json, Value};
use tokio::sync::{mpsc, Mutex};

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

async fn create_note(state: &Arc<Mutex<AppState>>, params: Value) -> String {
    let result = call(state, "memory.create", params).await.unwrap();
    result["entry"]["id"]
        .as_str()
        .unwrap_or_else(|| panic!("memory.create returned no entry: {result}"))
        .to_string()
}

#[tokio::test]
async fn plugin_memory_rpc_returns_only_active_projected_rows_and_pages_without_usage_writes() {
    let (_dir, state) = open().await;
    let reference_id = create_note(
        &state,
        json!({
            "scope": "user",
            "kind": "reference",
            "content": "Prefers small, focused changes.",
            "rationale": "Keeps reviews manageable.",
            "origin": "explicit",
            "evidence": "user_stated",
            "status": "active"
        }),
    )
    .await;
    let fact_id = create_note(
        &state,
        json!({
            "scope": "user",
            "kind": "fact",
            "content": "The project uses Rust.",
            "origin": "user_ui",
            "evidence": "verified",
            "status": "active"
        }),
    )
    .await;
    let archived_id = create_note(
        &state,
        json!({ "scope": "user", "kind": "fact", "content": "Archived note is hidden." }),
    )
    .await;
    let suggested_id = create_note(
        &state,
        json!({ "scope": "user", "kind": "fact", "content": "Suggested note is hidden." }),
    )
    .await;

    {
        let guard = state.lock().await;
        guard
            .db
            .conn()
            .execute(
                "UPDATE memory_entries
                 SET updated_at = ?2, use_count = 7, last_used_at = 1234
                 WHERE id IN (?1, ?3)",
                params![reference_id, crate::db::now_ms() + 1000, fact_id],
            )
            .unwrap();
    }

    {
        let guard = state.lock().await;
        guard
            .db
            .conn()
            .execute(
                "UPDATE memory_entries SET status = 'archived' WHERE id = ?1",
                params![archived_id],
            )
            .unwrap();
        guard
            .db
            .conn()
            .execute(
                "UPDATE memory_entries SET status = 'suggested' WHERE id = ?1",
                params![suggested_id],
            )
            .unwrap();
    }

    let listed = call(
        &state,
        "plugin.memory.list",
        json!({ "pluginId": "demo.memory", "scope": "user", "limit": 200 }),
    )
    .await
    .unwrap();
    assert_eq!(listed["readEnabled"], json!(true));
    assert_eq!(listed["entries"].as_array().unwrap().len(), 2);
    assert_eq!(listed["nextOffset"], Value::Null);
    for row in listed["entries"].as_array().unwrap() {
        let keys = row
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect::<BTreeSet<_>>();
        assert_eq!(
            keys,
            [
                "content",
                "createdAt",
                "evidence",
                "id",
                "kind",
                "origin",
                "rationale",
                "scope",
                "updatedAt",
            ]
            .into_iter()
            .collect()
        );
        assert_eq!(row["scope"], json!("user"));
        assert_eq!(row["rationale"].is_string(), row["id"] == reference_id);
    }

    let first_page = call(
        &state,
        "plugin.memory.list",
        json!({ "pluginId": "demo.memory", "scope": "user", "limit": 1 }),
    )
    .await
    .unwrap();
    assert_eq!(first_page["entries"].as_array().unwrap().len(), 1);
    assert_eq!(first_page["nextOffset"], json!(1));
    let second_page = call(
        &state,
        "plugin.memory.list",
        json!({ "pluginId": "demo.memory", "scope": "user", "limit": 1, "offset": 1 }),
    )
    .await
    .unwrap();
    assert_eq!(second_page["entries"].as_array().unwrap().len(), 1);
    assert_eq!(second_page["nextOffset"], Value::Null);

    let filtered = call(
        &state,
        "plugin.memory.list",
        json!({ "pluginId": "demo.memory", "scope": "user", "kind": "reference" }),
    )
    .await
    .unwrap();
    assert_eq!(filtered["entries"].as_array().unwrap().len(), 1);
    assert_eq!(filtered["entries"][0]["id"], json!(reference_id));

    let guard = state.lock().await;
    for id in [&reference_id, &fact_id] {
        let usage: (i64, Option<i64>) = guard
            .db
            .conn()
            .query_row(
                "SELECT use_count, last_used_at FROM memory_entries WHERE id = ?1",
                params![id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(usage, (7, Some(1234)));
    }
}

#[tokio::test]
async fn plugin_memory_rpc_resolves_group_roots_and_returns_empty_for_unlisted_paths() {
    let (dir, state) = open().await;
    let project_dir = dir.path().join("group-root");
    std::fs::create_dir_all(&project_dir).unwrap();
    let project_path = project_dir.to_str().unwrap().to_string();
    let group = call(
        &state,
        "project.group.create",
        json!({ "name": "Grouped", "folders": [project_path] }),
    )
    .await
    .unwrap();
    let group_id = group["group"]["id"].as_str().unwrap().to_string();
    let created = call(
        &state,
        "memory.create",
        json!({
            "path": project_path,
            "kind": "reference",
            "content": "Group-scoped reference.",
            "status": "active"
        }),
    )
    .await
    .unwrap();
    let listed = call(
        &state,
        "plugin.memory.list",
        json!({ "pluginId": "demo.memory", "scope": "project", "path": project_path }),
    )
    .await
    .unwrap();
    assert_eq!(listed["entries"].as_array().unwrap().len(), 1);
    assert_eq!(listed["entries"][0]["id"], created["entry"]["id"]);
    assert_eq!(listed["entries"][0]["scope"], json!("project"));
    assert!(!listed.to_string().contains(&group_id));
    assert!(listed.get("scopeKey").is_none());

    let other_project = dir.path().join("not-registered");
    std::fs::create_dir_all(&other_project).unwrap();
    let empty = call(
        &state,
        "plugin.memory.list",
        json!({
            "pluginId": "demo.memory",
            "scope": "project",
            "path": other_project.to_str().unwrap()
        }),
    )
    .await
    .unwrap();
    assert_eq!(empty["entries"], json!([]));
    assert_eq!(empty["nextOffset"], Value::Null);
}

#[tokio::test]
async fn plugin_memory_rpc_rechecks_invalid_params_without_echoing_paths() {
    let (_dir, state) = open().await;
    for params in [
        json!({ "pluginId": "demo.memory", "scope": "other" }),
        json!({ "pluginId": "demo.memory", "scope": "project" }),
        json!({ "pluginId": "demo.memory", "scope": "project", "path": "private-relative-path" }),
        json!({ "pluginId": "demo.memory", "scope": "user", "kind": "unsupported" }),
        json!({ "pluginId": "demo.memory", "scope": "user", "limit": 201 }),
        json!({ "pluginId": "demo.memory", "scope": "user", "offset": -1 }),
    ] {
        let error = call(&state, "plugin.memory.list", params.clone())
            .await
            .unwrap_err();
        assert_eq!(error.code, 1002);
        assert_eq!(error_code(&error), "INVALID_PARAMS");
        assert!(!error.message.contains("private-relative-path"));
    }
}
