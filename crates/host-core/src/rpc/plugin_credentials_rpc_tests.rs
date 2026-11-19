//! Plugin credential slot RPC contract tests: what Main gets back, and which
//! error code a caller sees when a slot is missing, undeclared or unconfigured.

use crate::plugins::PluginSummary;
use crate::rpc::{handle_request, JsonRpcError};
use crate::state::AppState;
use serde_json::{json, Value};
use std::fs;
use std::path::Path;
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex};

async fn open() -> (tempfile::TempDir, Arc<Mutex<AppState>>) {
    let dir = tempfile::tempdir().unwrap();
    // An empty catalog keeps `AppState::open` off the network: a fresh data
    // directory would otherwise try to fetch the official marketplace.
    let catalog = dir.path().join("plugins/market/catalog.json");
    fs::create_dir_all(catalog.parent().unwrap()).unwrap();
    fs::write(&catalog, "{}").unwrap();
    let mut state = AppState::open(dir.path()).unwrap();
    state.handshook = true;
    (dir, Arc::new(Mutex::new(state)))
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

fn field(key: &str, label: &str, secret: bool) -> Value {
    json!({ "key": key, "label": { "en": label }, "secret": secret })
}

fn contributes() -> Value {
    json!({
        "credentials": [{
            "id": "mailbox",
            "title": { "en": "Mailbox", "zh-CN": "邮箱" },
            "kind": "basic",
            "fields": [field("username", "User", false), field("password", "Password", true)],
            "scope": { "domains": ["imap.example.com"] },
        }]
    })
}

/// Register a plugin the way an install would leave it: a manifest on disk plus
/// a registry row pointing at it. The row is written directly so the test does
/// not pull in the provider reconciliation an enable/install path runs.
async fn register(dir: &Path, state: &Arc<Mutex<AppState>>, plugin_id: &str) {
    let root = dir
        .join("plugins/installed")
        .join(plugin_id.replace('.', "-"));
    fs::create_dir_all(&root).unwrap();
    fs::write(root.join("main.js"), "export function onLoad() {}").unwrap();
    let manifest = json!({
        "schemaVersion": 1,
        "id": plugin_id,
        "name": "Mail",
        "version": "0.1.0",
        "main": "main.js",
        "permissions": ["credentials.use"],
        "contributes": contributes(),
    });
    fs::write(root.join("manifest.json"), manifest.to_string()).unwrap();

    let summary: PluginSummary = serde_json::from_value(json!({
        "id": plugin_id,
        "name": "Mail",
        "version": "0.1.0",
        "enabled": true,
        "source": "dev",
        "status": "ready",
        "permissions": ["credentials.use"],
        "path": root.to_string_lossy(),
    }))
    .unwrap();
    state
        .lock()
        .await
        .plugins
        .upsert_summary(summary)
        .expect("register the plugin row");
}

fn fields() -> Value {
    json!({ "username": "alice", "password": "hunter2" })
}

#[tokio::test]
async fn status_carries_the_declaration_and_list_carries_only_state() {
    let (dir, state) = open().await;
    register(dir.path(), &state, "demo.status").await;

    let status = call(
        &state,
        "plugins.credentials.status",
        json!({ "pluginId": "demo.status" }),
    )
    .await
    .unwrap();
    let slot = &status["slots"][0];
    assert_eq!(slot["id"], "mailbox");
    assert_eq!(slot["title"], "Mailbox");
    assert_eq!(slot["kind"], "basic");
    assert_eq!(slot["fields"][0]["key"], "username");
    assert_eq!(slot["fields"][0]["label"], "User");
    assert_eq!(slot["fields"][1]["secret"], true);
    assert_eq!(slot["scope"]["domains"][0], "imap.example.com");
    assert_eq!(slot["configured"], false);
    assert!(slot["lastUsedAt"].is_null());

    call(
        &state,
        "plugins.credentials.set",
        json!({ "pluginId": "demo.status", "slotId": "mailbox", "fields": fields() }),
    )
    .await
    .unwrap();

    let status = call(
        &state,
        "plugins.credentials.status",
        json!({ "pluginId": "demo.status" }),
    )
    .await
    .unwrap();
    assert_eq!(status["slots"][0]["configured"], true);
    assert!(!status.to_string().contains("hunter2"), "{status}");

    let list = call(
        &state,
        "plugins.credentials.list",
        json!({ "pluginId": "demo.status" }),
    )
    .await
    .unwrap();
    let entry = &list["slots"][0];
    assert_eq!(entry["id"], "mailbox");
    assert_eq!(entry["configured"], true);
    // The state-only surface must not grow into a metadata (or value) surface.
    assert!(entry.get("title").is_none(), "{entry}");
    assert!(entry.get("fields").is_none(), "{entry}");
    assert!(entry.get("scope").is_none(), "{entry}");
    assert!(entry.get("lastUsedAt").is_none(), "{entry}");
}

#[tokio::test]
async fn status_reports_the_declaration_for_a_disabled_plugin() {
    let (dir, state) = open().await;
    register(dir.path(), &state, "demo.disabled").await;
    state
        .lock()
        .await
        .plugins
        .set_enabled("demo.disabled", false)
        .unwrap();

    let status = call(
        &state,
        "plugins.credentials.status",
        json!({ "pluginId": "demo.disabled" }),
    )
    .await
    .unwrap();
    assert_eq!(status["slots"][0]["title"], "Mailbox");
    assert_eq!(status["slots"][0]["configured"], false);
}

#[tokio::test]
async fn resolve_answers_the_fields_and_marks_last_use() {
    let (dir, state) = open().await;
    register(dir.path(), &state, "demo.resolve").await;
    call(
        &state,
        "plugins.credentials.set",
        json!({ "pluginId": "demo.resolve", "slotId": "mailbox", "fields": fields() }),
    )
    .await
    .unwrap();

    let resolved = call(
        &state,
        "plugins.credentials.resolve",
        json!({ "pluginId": "demo.resolve", "slotId": "mailbox" }),
    )
    .await
    .unwrap();
    assert_eq!(resolved["fields"]["username"], "alice");
    assert_eq!(resolved["fields"]["password"], "hunter2");

    let status = call(
        &state,
        "plugins.credentials.status",
        json!({ "pluginId": "demo.resolve" }),
    )
    .await
    .unwrap();
    assert!(status["slots"][0]["lastUsedAt"].is_number());
}

#[tokio::test]
async fn resolving_an_unconfigured_slot_answers_credential_not_configured() {
    let (dir, state) = open().await;
    register(dir.path(), &state, "demo.missing").await;

    let error = call(
        &state,
        "plugins.credentials.resolve",
        json!({ "pluginId": "demo.missing", "slotId": "mailbox" }),
    )
    .await
    .unwrap_err();
    assert_eq!(error_code(&error), "CREDENTIAL_NOT_CONFIGURED");
    assert!(
        error.message.contains("CREDENTIAL_NOT_CONFIGURED"),
        "{}",
        error.message
    );
}

#[tokio::test]
async fn undeclared_slots_fields_and_unknown_plugins_are_refused() {
    let (dir, state) = open().await;
    register(dir.path(), &state, "demo.refused").await;

    let error = call(
        &state,
        "plugins.credentials.set",
        json!({ "pluginId": "demo.refused", "slotId": "smtp", "fields": fields() }),
    )
    .await
    .unwrap_err();
    assert_eq!(error_code(&error), "CREDENTIAL_SLOT_NOT_DECLARED");

    let error = call(
        &state,
        "plugins.credentials.set",
        json!({
            "pluginId": "demo.refused",
            "slotId": "mailbox",
            "fields": { "username": "alice", "password": "hunter2", "tenant": "acme" },
        }),
    )
    .await
    .unwrap_err();
    assert_eq!(error_code(&error), "CREDENTIAL_INVALID");

    let error = call(
        &state,
        "plugins.credentials.set",
        json!({ "pluginId": "demo.refused", "slotId": "mailbox", "fields": { "username": "alice" } }),
    )
    .await
    .unwrap_err();
    assert_eq!(error_code(&error), "CREDENTIAL_INVALID");

    let error = call(
        &state,
        "plugins.credentials.status",
        json!({ "pluginId": "demo.not-installed" }),
    )
    .await
    .unwrap_err();
    assert_eq!(error_code(&error), "PLUGIN_NOT_FOUND");
}

#[tokio::test]
async fn clear_reports_whether_a_value_was_there_and_configures_nothing() {
    let (dir, state) = open().await;
    register(dir.path(), &state, "demo.clear").await;
    call(
        &state,
        "plugins.credentials.set",
        json!({ "pluginId": "demo.clear", "slotId": "mailbox", "fields": fields() }),
    )
    .await
    .unwrap();

    let cleared = call(
        &state,
        "plugins.credentials.clear",
        json!({ "pluginId": "demo.clear", "slotId": "mailbox" }),
    )
    .await
    .unwrap();
    assert_eq!(cleared["cleared"], true);

    let cleared = call(
        &state,
        "plugins.credentials.clear",
        json!({ "pluginId": "demo.clear", "slotId": "mailbox" }),
    )
    .await
    .unwrap();
    assert_eq!(cleared["cleared"], false);

    let status = call(
        &state,
        "plugins.credentials.status",
        json!({ "pluginId": "demo.clear" }),
    )
    .await
    .unwrap();
    assert_eq!(status["slots"][0]["configured"], false);
}

#[tokio::test]
async fn a_status_request_never_carries_a_field_value() {
    let (dir, state) = open().await;
    register(dir.path(), &state, "demo.novalues").await;
    call(
        &state,
        "plugins.credentials.set",
        json!({ "pluginId": "demo.novalues", "slotId": "mailbox", "fields": fields() }),
    )
    .await
    .unwrap();

    for method in ["plugins.credentials.status", "plugins.credentials.list"] {
        let response = call(&state, method, json!({ "pluginId": "demo.novalues" }))
            .await
            .unwrap();
        let text = response.to_string();
        assert!(!text.contains("hunter2"), "{method}: {text}");
        assert!(!text.contains("alice"), "{method}: {text}");
    }
}
