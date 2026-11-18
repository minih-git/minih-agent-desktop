//! Host trust-boundary tests for `pluginNotification.create`.
//!
//! Everything here starts at the RPCs the desktop actually calls, so the checks
//! cover the real path: validation, the durable row, the dedupe update, the
//! hourly budget that folds into the overflow digest, and the uninstall
//! lifecycle that owns the rows a plugin delivered.

use std::path::Path;
use std::sync::Arc;

use serde_json::{json, Value};
use tokio::sync::{mpsc, Mutex};

use crate::rpc::{handle_request, JsonRpcError};
use crate::state::AppState;

const METHOD: &str = "pluginNotification.create";
const RESERVED: &str = "__minih_notify_overflow__";

fn open_at(path: &Path) -> Arc<Mutex<AppState>> {
    let mut app = AppState::open(path).unwrap();
    app.handshook = true;
    Arc::new(Mutex::new(app))
}

async fn open() -> (tempfile::TempDir, Arc<Mutex<AppState>>) {
    let dir = tempfile::tempdir().unwrap();
    let state = open_at(dir.path());
    (dir, state)
}

async fn call(
    state: &Arc<Mutex<AppState>>,
    method: &str,
    params: Value,
) -> Result<Value, JsonRpcError> {
    handle_request(state.clone(), method, params, mpsc::unbounded_channel().0).await
}

/// Install a throwaway plugin so the delivery RPC finds it in the registry,
/// exactly like a real plugin main loads.
async fn install(state: &Arc<Mutex<AppState>>, root: &Path, id: &str) {
    let source = root.join(format!("{id}-source"));
    std::fs::create_dir_all(&source).unwrap();
    std::fs::write(
        source.join("manifest.json"),
        serde_json::to_string_pretty(&json!({
            "schemaVersion": 1,
            "id": id,
            "name": id,
            "version": "0.1.0",
            "main": "main.js",
        }))
        .unwrap(),
    )
    .unwrap();
    std::fs::write(source.join("main.js"), "export function onLoad() {}\n").unwrap();
    let installed = call(
        state,
        "plugins.installFromPath",
        json!({ "path": source.to_str().unwrap(), "enable": true }),
    )
    .await;
    assert!(installed.is_ok(), "installing {id} failed: {installed:?}");
}

async fn deliver(state: &Arc<Mutex<AppState>>, params: Value) -> Value {
    match call(state, METHOD, params).await {
        Ok(result) => result,
        Err(error) => panic!("pluginNotification.create failed: {error:?}"),
    }
}

fn alert(plugin: &str, key: &str, title: &str) -> Value {
    json!({
        "pluginId": plugin,
        "kind": "alert",
        "title": title,
        "body": "details",
        "linkJson": "{\"view\":\"inbox\"}",
        "dedupeKey": key,
    })
}

fn digest(plugin: &str, key: &str) -> Value {
    json!({
        "pluginId": plugin,
        "kind": "digest",
        "title": "Weekly summary",
        "body": "3 issues closed",
        "dedupeKey": key,
    })
}

async fn row_count(state: &Arc<Mutex<AppState>>) -> i64 {
    let guard = state.lock().await;
    guard
        .db
        .conn()
        .query_row("SELECT COUNT(*) FROM notifications", [], |row| row.get(0))
        .unwrap()
}

async fn rows_for(state: &Arc<Mutex<AppState>>, plugin_id: &str) -> i64 {
    let guard = state.lock().await;
    guard
        .db
        .conn()
        .query_row(
            "SELECT COUNT(*) FROM notifications WHERE plugin_id = ?1",
            [plugin_id],
            |row| row.get(0),
        )
        .unwrap()
}

async fn created_at(state: &Arc<Mutex<AppState>>, id: &str) -> Option<i64> {
    let guard = state.lock().await;
    guard
        .db
        .conn()
        .query_row(
            "SELECT created_at FROM notifications WHERE id = ?1",
            [id],
            |row| row.get::<_, i64>(0),
        )
        .ok()
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

/// The row a plugin delivered comes back to the caller, so Main can publish it
/// without a re-read, and it is the plugin family in the shared inbox.
#[tokio::test]
async fn a_delivery_returns_the_stored_row() {
    let (dir, state) = open().await;
    install(&state, dir.path(), "acme.ci").await;
    let result = deliver(&state, alert("acme.ci", "event-1", "Build failed")).await;

    let id = result["id"].as_str().expect("id");
    let notification = &result["notification"];
    assert_eq!(notification["id"], id);
    assert_eq!(notification["kind"], "plugin.alert");
    assert_eq!(notification["pluginId"], "acme.ci");
    assert_eq!(notification["title"], "Build failed");
    assert_eq!(notification["body"], "details");
    assert_eq!(notification["linkJson"], "{\"view\":\"inbox\"}");
    assert_eq!(notification["dedupeKey"], "event-1");
    assert!(notification["sessionId"].is_null());
    assert!(notification["sessionTitle"].is_null());
    assert!(notification["readAt"].is_null());
    assert!(
        notification.get("turnId").is_none(),
        "a plugin row has no turn to name"
    );
    assert_eq!(row_count(&state).await, 1);
}

/// A retried delivery with the same dedupe key is the same notification: one
/// row, refreshed content, back to unread, and at the newest position.
#[tokio::test]
async fn a_repeated_dedupe_key_updates_the_same_row() {
    let (dir, state) = open().await;
    install(&state, dir.path(), "acme.ci").await;
    let first = deliver(&state, alert("acme.ci", "event-1", "Build failed")).await;
    let id = first["id"].as_str().expect("id").to_string();
    call(&state, "notification.markRead", json!({ "id": id }))
        .await
        .unwrap();
    {
        // Age the row so the refresh is observable rather than inferred.
        let guard = state.lock().await;
        guard
            .db
            .conn()
            .execute(
                "UPDATE notifications SET created_at = 1 WHERE id = ?1",
                [&id],
            )
            .unwrap();
    }

    let second = deliver(
        &state,
        json!({
            "pluginId": "acme.ci",
            "kind": "alert",
            "title": "Build failed again",
            "body": "1 job failed",
            "linkJson": "{\"view\":\"detail\"}",
            "dedupeKey": "event-1",
        }),
    )
    .await;

    assert_eq!(second["id"], id.as_str());
    assert_eq!(row_count(&state).await, 1, "a retry must not add a row");
    assert_eq!(second["notification"]["title"], "Build failed again");
    assert_eq!(second["notification"]["body"], "1 job failed");
    assert_eq!(second["notification"]["linkJson"], "{\"view\":\"detail\"}");
    assert!(
        second["notification"]["readAt"].is_null(),
        "a refreshed delivery is unread again"
    );
    assert!(
        created_at(&state, &id).await.unwrap() > 1,
        "the refreshed row moves to the newest position"
    );

    // The same key delivered as a digest keeps its identity and changes family.
    let third = deliver(
        &state,
        json!({
            "pluginId": "acme.ci",
            "kind": "digest",
            "title": "Weekly summary",
            "dedupeKey": "event-1",
        }),
    )
    .await;
    assert_eq!(third["id"], id.as_str());
    assert_eq!(third["notification"]["kind"], "plugin.digest");
    assert_eq!(row_count(&state).await, 1);
}

/// Two plugins may use the same dedupe key; neither sees the other's row.
#[tokio::test]
async fn plugins_with_the_same_dedupe_key_stay_isolated() {
    let (dir, state) = open().await;
    install(&state, dir.path(), "acme.ci").await;
    install(&state, dir.path(), "other.plugin").await;
    let first = deliver(&state, alert("acme.ci", "event-1", "Acme build")).await;
    let second = deliver(&state, alert("other.plugin", "event-1", "Other build")).await;

    assert_ne!(first["id"], second["id"]);
    assert_eq!(first["notification"]["pluginId"], "acme.ci");
    assert_eq!(second["notification"]["pluginId"], "other.plugin");
    assert_eq!(row_count(&state).await, 2);
}

/// The host does not rewrite what the plugin sent: only required-ness is
/// judged after trimming, and keys keep their exact spelling.
#[tokio::test]
async fn the_host_stores_the_text_the_plugin_sent() {
    let (dir, state) = open().await;
    install(&state, dir.path(), "acme.ci").await;
    let delivered = deliver(
        &state,
        json!({
            "pluginId": "acme.ci",
            "kind": "alert",
            "title": " Build failed ",
            "body": "line one\nline two\n",
            "linkJson": " {\"view\":\"inbox\"} ",
            "dedupeKey": "event-1 ",
        }),
    )
    .await;
    assert_eq!(delivered["notification"]["title"], " Build failed ");
    assert_eq!(delivered["notification"]["body"], "line one\nline two\n");
    assert_eq!(
        delivered["notification"]["linkJson"],
        " {\"view\":\"inbox\"} "
    );
    assert_eq!(delivered["notification"]["dedupeKey"], "event-1 ");

    // A key that differs only in whitespace is a different key, not a retry.
    deliver(&state, alert("acme.ci", "event-1", "Plain key")).await;
    assert_eq!(row_count(&state).await, 2);

    // Only the exact reserved spelling is the host's; a look-alike is the
    // plugin's own key and stores an ordinary row.
    let look_alike = deliver(
        &state,
        alert("acme.ci", "__MINIH_NOTIFY_OVERFLOW__", "Look-alike key"),
    )
    .await;
    assert_eq!(
        look_alike["notification"]["dedupeKey"],
        "__MINIH_NOTIFY_OVERFLOW__"
    );
    assert_eq!(look_alike["notification"]["kind"], "plugin.alert");
}

/// Everything the host cannot store comes back as an invalid-argument error
/// and leaves the inbox untouched.
#[tokio::test]
async fn the_host_rejects_what_it_cannot_store() {
    let (dir, state) = open().await;
    install(&state, dir.path(), "acme.ci").await;
    let long_title = "t".repeat(201);
    let long_body = "b".repeat(2_001);
    let long_key = "k".repeat(257);
    let long_link = format!("{{\"v\":\"{}\"}}", "x".repeat(4_096));
    let cases = vec![
        json!({ "kind": "alert", "title": "No plugin" }),
        json!({ "pluginId": "   ", "kind": "alert", "title": "Blank plugin" }),
        json!({ "pluginId": "acme ci", "kind": "alert", "title": "Spaced plugin" }),
        json!({ "pluginId": "acme.ci", "kind": "system", "title": "Wrong kind" }),
        json!({ "pluginId": "acme.ci", "kind": "alert", "title": "  " }),
        json!({ "pluginId": "acme.ci", "kind": "alert", "title": long_title }),
        json!({ "pluginId": "acme.ci", "kind": "alert", "title": "Body", "body": " ".repeat(2001) }),
        json!({ "pluginId": "acme.ci", "kind": "alert", "title": "Key", "dedupeKey": "   " }),
        json!({
            "pluginId": "acme.ci", "kind": "alert", "title": "Body", "body": long_body
        }),
        json!({
            "pluginId": "acme.ci", "kind": "alert", "title": "Link", "linkJson": "{not json}"
        }),
        json!({
            "pluginId": "acme.ci", "kind": "alert", "title": "Link", "linkJson": "[]"
        }),
        json!({
            "pluginId": "acme.ci", "kind": "alert", "title": "Link", "linkJson": long_link
        }),
        json!({
            "pluginId": "acme.ci", "kind": "alert", "title": "Key", "dedupeKey": long_key
        }),
        // The overflow digest is the host's row; a plugin may not address it.
        json!({
            "pluginId": "acme.ci", "kind": "alert", "title": "Key", "dedupeKey": RESERVED
        }),
        // The contract is exact: an unknown field is a caller bug, not noise.
        json!({
            "pluginId": "acme.ci", "kind": "alert", "title": "Extra", "channel": "push"
        }),
    ];

    for params in cases {
        let error = call(&state, METHOD, params.clone())
            .await
            .expect_err(&format!("must be rejected: {params}"));
        assert_eq!(error.code, -32602, "rejected with a params error: {params}");
        assert_eq!(
            error_code(&error),
            "INVALID_ARGUMENT",
            "the boundary reports the same code main uses: {params}"
        );
    }
    assert_eq!(row_count(&state).await, 0);
}

/// The 61st new row of the hour folds, and every fold after it keeps counting
/// in the same durable row.
#[tokio::test]
async fn the_sixty_first_row_folds_into_the_digest() {
    let (dir, state) = open().await;
    install(&state, dir.path(), "acme.ci").await;
    for index in 0..60 {
        deliver(&state, alert("acme.ci", &format!("event-{index}"), "Alert")).await;
    }
    assert_eq!(row_count(&state).await, 60);

    let first_fold = deliver(&state, alert("acme.ci", "event-60", "Alert")).await;
    let digest_id = first_fold["id"].as_str().expect("digest id").to_string();
    let folded = &first_fold["notification"];
    assert_eq!(folded["kind"], "plugin.digest");
    assert_eq!(folded["dedupeKey"], RESERVED);
    assert_eq!(folded["title"], "More notifications were folded");
    assert_eq!(
        folded["body"], "1",
        "the count is a decimal for the renderer"
    );
    assert!(folded["linkJson"].is_null());
    assert!(folded["readAt"].is_null());
    assert_eq!(row_count(&state).await, 61);
    {
        let guard = state.lock().await;
        let folded_row: i64 = guard
            .db
            .conn()
            .query_row(
                "SELECT COUNT(*) FROM notifications WHERE dedupe_key = 'event-60'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(folded_row, 0, "a folded delivery stores no row of its own");
    }

    let second_fold = deliver(&state, alert("acme.ci", "event-61", "Alert")).await;
    assert_eq!(second_fold["id"], digest_id.as_str());
    assert_eq!(second_fold["notification"]["body"], "2");
    assert_eq!(row_count(&state).await, 61);
}

/// Sixty-one digests hit the same wall as sixty-one alerts: neither kind can be
/// spent as a bypass for the other.
#[tokio::test]
async fn sixty_one_digest_rows_fold_like_alerts() {
    let (dir, state) = open().await;
    install(&state, dir.path(), "acme.ci").await;
    for index in 0..60 {
        deliver(&state, digest("acme.ci", &format!("digest-{index}"))).await;
    }
    assert_eq!(row_count(&state).await, 60);

    let fold = deliver(&state, digest("acme.ci", "digest-60")).await;
    assert_eq!(fold["notification"]["kind"], "plugin.digest");
    assert_eq!(fold["notification"]["dedupeKey"], RESERVED);
    assert_eq!(
        fold["notification"]["title"],
        "More notifications were folded"
    );
    assert_eq!(fold["notification"]["body"], "1");
    assert_eq!(row_count(&state).await, 61);

    let next = deliver(&state, digest("acme.ci", "digest-61")).await;
    assert_eq!(next["id"], fold["id"]);
    assert_eq!(next["notification"]["body"], "2");
}

/// Alerts and digests draw from one counter, in either order.
#[tokio::test]
async fn both_kinds_share_one_budget() {
    let (dir, state) = open().await;
    install(&state, dir.path(), "acme.ci").await;
    for index in 0..30 {
        deliver(&state, alert("acme.ci", &format!("event-{index}"), "Alert")).await;
    }
    for index in 0..30 {
        deliver(&state, digest("acme.ci", &format!("digest-{index}"))).await;
    }
    assert_eq!(row_count(&state).await, 60);

    let alert_fold = deliver(&state, alert("acme.ci", "event-60", "Alert")).await;
    assert_eq!(alert_fold["notification"]["dedupeKey"], RESERVED);
    assert_eq!(alert_fold["notification"]["body"], "1");

    let digest_fold = deliver(&state, digest("acme.ci", "digest-60")).await;
    assert_eq!(digest_fold["id"], alert_fold["id"]);
    assert_eq!(digest_fold["notification"]["body"], "2");
    assert_eq!(row_count(&state).await, 61);
}

/// Clearing the inbox is a user action, not a rate-limit reset.
#[tokio::test]
async fn clearing_the_inbox_does_not_reset_the_budget() {
    let (dir, state) = open().await;
    install(&state, dir.path(), "acme.ci").await;
    for index in 0..60 {
        deliver(&state, alert("acme.ci", &format!("event-{index}"), "Alert")).await;
    }
    call(&state, "notification.clear", json!({})).await.unwrap();
    assert_eq!(row_count(&state).await, 0);

    let fold = deliver(&state, alert("acme.ci", "event-60", "Alert")).await;
    assert_eq!(fold["notification"]["dedupeKey"], RESERVED);
    assert_eq!(fold["notification"]["body"], "1");
    assert_eq!(row_count(&state).await, 1);
}

/// The budget lives in the database, so a restart reads the same window.
#[tokio::test]
async fn restarting_the_host_keeps_the_budget() {
    let (dir, state) = open().await;
    install(&state, dir.path(), "acme.ci").await;
    for index in 0..60 {
        deliver(&state, alert("acme.ci", &format!("event-{index}"), "Alert")).await;
    }
    drop(state);

    let reopened = open_at(dir.path());
    let fold = deliver(&reopened, alert("acme.ci", "event-60", "Alert")).await;
    assert_eq!(fold["notification"]["dedupeKey"], RESERVED);
    assert_eq!(fold["notification"]["body"], "1");
}

/// The window rolls: evidence older than an hour no longer spends budget.
#[tokio::test]
async fn the_budget_window_rolls_forward() {
    let (dir, state) = open().await;
    install(&state, dir.path(), "acme.ci").await;
    for index in 0..60 {
        deliver(&state, alert("acme.ci", &format!("event-{index}"), "Alert")).await;
    }
    {
        let guard = state.lock().await;
        guard
            .db
            .conn()
            .execute(
                "UPDATE audit_log SET ts = ts - 3600001
                  WHERE kind = 'plugin_notification_delivered'",
                [],
            )
            .unwrap();
    }

    let delivered = deliver(&state, alert("acme.ci", "event-60", "Alert")).await;
    assert_eq!(delivered["notification"]["kind"], "plugin.alert");
    assert_eq!(delivered["notification"]["dedupeKey"], "event-60");
    assert_eq!(row_count(&state).await, 61);
}

/// Folded deliveries add no audit record, so a flood cannot grow the log past
/// one entry per row it actually created.
#[tokio::test]
async fn folding_writes_no_extra_audit_rows() {
    let (dir, state) = open().await;
    install(&state, dir.path(), "acme.ci").await;
    for index in 0..80 {
        deliver(&state, alert("acme.ci", &format!("event-{index}"), "Alert")).await;
    }
    let guard = state.lock().await;
    let audit_rows: i64 = guard
        .db
        .conn()
        .query_row(
            "SELECT COUNT(*) FROM audit_log WHERE kind = 'plugin_notification_delivered'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(audit_rows, 60, "one audit row per created row, and no more");
}

/// The audit evidence names the plugin and nothing a user wrote, so the inbox
/// content never reaches the audit log.
#[tokio::test]
async fn the_rate_limit_evidence_carries_no_notification_content() {
    let (dir, state) = open().await;
    install(&state, dir.path(), "acme.ci").await;
    deliver(
        &state,
        json!({
            "pluginId": "acme.ci",
            "kind": "alert",
            "title": "Private build title",
            "body": "private build body",
            "dedupeKey": "event-1",
        }),
    )
    .await;

    let guard = state.lock().await;
    let (kind, payload): (String, String) = guard
        .db
        .conn()
        .query_row(
            "SELECT kind, payload_json FROM audit_log ORDER BY id DESC LIMIT 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(kind, "plugin_notification_delivered");
    let parsed: Value = serde_json::from_str(&payload).unwrap();
    assert_eq!(parsed["pluginId"], "acme.ci");
    assert_eq!(parsed["kind"], "plugin.alert");
    assert!(!payload.contains("Private build title"));
    assert!(!payload.contains("private build body"));
}

/// Plugin rows share one budget with the task and prompt families.
#[tokio::test]
async fn the_global_row_cap_applies_to_plugin_rows() {
    let (dir, state) = open().await;
    for plugin in ["one.plugin", "two.plugin", "three.plugin", "four.plugin"] {
        install(&state, dir.path(), plugin).await;
        for index in 0..60 {
            deliver(&state, alert(plugin, &format!("event-{index}"), "Alert")).await;
        }
    }
    assert_eq!(row_count(&state).await, crate::db::NOTIFICATION_KEEP);
}

/// Uninstalling a plugin takes its notifications with it, and leaves every
/// other plugin's rows alone.
#[tokio::test]
async fn uninstalling_a_plugin_removes_its_notifications() {
    let (dir, state) = open().await;
    install(&state, dir.path(), "acme.notify").await;
    install(&state, dir.path(), "other.plugin").await;
    deliver(
        &state,
        alert("acme.notify", "event-1", "From the installed plugin"),
    )
    .await;
    deliver(
        &state,
        alert("other.plugin", "event-1", "From another plugin"),
    )
    .await;
    assert_eq!(row_count(&state).await, 2);

    let uninstalled = call(&state, "plugins.uninstall", json!({ "id": "acme.notify" }))
        .await
        .unwrap();
    assert_eq!(uninstalled["ok"], true);

    assert_eq!(row_count(&state).await, 1);
    {
        let guard = state.lock().await;
        let remaining: String = guard
            .db
            .conn()
            .query_row("SELECT plugin_id FROM notifications", [], |row| row.get(0))
            .unwrap();
        assert_eq!(remaining, "other.plugin");
    }
}

/// A first attempt that removed the plugin and then failed to remove its rows
/// leaves orphans; the retry reports `ok: false` and must still repair them.
#[tokio::test]
async fn a_retried_uninstall_removes_orphan_notifications() {
    let (dir, state) = open().await;
    install(&state, dir.path(), "acme.notify").await;
    install(&state, dir.path(), "other.plugin").await;
    deliver(&state, alert("acme.notify", "event-1", "Orphan to be")).await;
    deliver(&state, alert("other.plugin", "event-1", "Not an orphan")).await;

    {
        // Exactly what the first attempt left behind: the registry row is gone,
        // the rows the plugin delivered are still there.
        let mut guard = state.lock().await;
        assert!(guard.plugins.uninstall("acme.notify").unwrap());
    }
    assert_eq!(rows_for(&state, "acme.notify").await, 1);

    let retried = call(&state, "plugins.uninstall", json!({ "id": "acme.notify" }))
        .await
        .unwrap();
    assert_eq!(retried["ok"], false, "the plugin was already gone");
    assert_eq!(rows_for(&state, "acme.notify").await, 0);
    assert_eq!(rows_for(&state, "other.plugin").await, 1);
}

/// A delivery that reaches the host after its plugin was uninstalled is
/// rejected instead of writing an orphan row, and re-installing makes the
/// surface usable again.
#[tokio::test]
async fn a_delivery_after_uninstall_is_rejected() {
    let (dir, state) = open().await;
    install(&state, dir.path(), "acme.notify").await;
    deliver(&state, alert("acme.notify", "event-1", "Before uninstall")).await;

    call(&state, "plugins.uninstall", json!({ "id": "acme.notify" }))
        .await
        .unwrap();
    assert_eq!(rows_for(&state, "acme.notify").await, 0);

    // Main may already have accepted the plugin's call before the uninstall
    // finished; the host, not the caller's earlier reading, decides.
    let rejected = call(
        &state,
        METHOD,
        alert("acme.notify", "event-2", "After uninstall"),
    )
    .await
    .expect_err("a departed plugin cannot deliver");
    assert_eq!(rejected.code, -32602);
    assert_eq!(error_code(&rejected), "PLUGIN_NOT_FOUND");
    assert_eq!(rows_for(&state, "acme.notify").await, 0);

    install(&state, dir.path(), "acme.notify").await;
    deliver(&state, alert("acme.notify", "event-3", "After reinstall")).await;
    assert_eq!(rows_for(&state, "acme.notify").await, 1);
}

async fn read_at(state: &Arc<Mutex<AppState>>, id: &str) -> Option<i64> {
    let guard = state.lock().await;
    guard
        .db
        .conn()
        .query_row(
            "SELECT read_at FROM notifications WHERE id = ?1",
            [id],
            |row| row.get::<_, Option<i64>>(0),
        )
        .ok()
        .flatten()
}

async fn push_created_at(state: &Arc<Mutex<AppState>>, id: &str, created_at: i64) {
    let guard = state.lock().await;
    guard
        .db
        .conn()
        .execute(
            "UPDATE notifications SET created_at = ?2 WHERE id = ?1",
            rusqlite::params![id, created_at],
        )
        .unwrap();
}

/// `created_at` is the version the reader compares, so a re-delivery must move
/// it forward even when both writes land in the same millisecond.
#[tokio::test]
async fn a_redelivery_is_always_a_strictly_newer_version() {
    let (dir, state) = open().await;
    install(&state, dir.path(), "acme.ci").await;

    let first = deliver(&state, alert("acme.ci", "event-1", "Build failed")).await;
    let id = first["id"].as_str().expect("id").to_string();
    let first_created_at = created_at(&state, &id).await.expect("created_at");
    deliver(&state, alert("acme.ci", "event-1", "Build failed again")).await;
    let second_created_at = created_at(&state, &id).await.expect("created_at");
    assert!(
        second_created_at > first_created_at,
        "a same-millisecond re-delivery must still bump the version: \
         {second_created_at} vs {first_created_at}"
    );

    // Whatever the stored version is, the next one is one millisecond later.
    let ahead = second_created_at + 5_000;
    push_created_at(&state, &id, ahead).await;
    deliver(&state, alert("acme.ci", "event-1", "Third copy")).await;
    assert_eq!(created_at(&state, &id).await.unwrap(), ahead + 1);
}

/// The folded digest is a row like any other: folding twice in the same
/// millisecond still moves its version forward, so the renderer sees a new one.
#[tokio::test]
async fn the_folded_digest_also_moves_forward() {
    let (dir, state) = open().await;
    install(&state, dir.path(), "acme.ci").await;
    for index in 0..60 {
        deliver(&state, alert("acme.ci", &format!("event-{index}"), "Alert")).await;
    }
    let fold = deliver(&state, alert("acme.ci", "event-60", "Alert")).await;
    let id = fold["id"].as_str().expect("digest id").to_string();
    let created = created_at(&state, &id).await.expect("created_at");

    let ahead = created + 5_000;
    push_created_at(&state, &id, ahead).await;
    deliver(&state, alert("acme.ci", "event-61", "Alert")).await;
    assert_eq!(created_at(&state, &id).await.unwrap(), ahead + 1);
}

/// A damaged count must not panic the next fold; it saturates instead.
#[tokio::test]
async fn the_fold_count_saturates_instead_of_overflowing() {
    let (dir, state) = open().await;
    install(&state, dir.path(), "acme.ci").await;
    for index in 0..60 {
        deliver(&state, alert("acme.ci", &format!("event-{index}"), "Alert")).await;
    }
    let fold = deliver(&state, alert("acme.ci", "event-60", "Alert")).await;
    let id = fold["id"].as_str().expect("digest id").to_string();
    {
        let guard = state.lock().await;
        guard
            .db
            .conn()
            .execute(
                "UPDATE notifications SET body = ?2 WHERE id = ?1",
                rusqlite::params![id, u64::MAX.to_string()],
            )
            .unwrap();
    }

    let next = deliver(&state, alert("acme.ci", "event-61", "Alert")).await;

    assert_eq!(next["id"], id.as_str());
    assert_eq!(next["notification"]["body"], u64::MAX.to_string());
}

/// A click that was in flight while the plugin re-delivered the row settles the
/// version that was on screen, never the newer one.
#[tokio::test]
async fn marking_read_a_version_does_not_settle_a_newer_one() {
    let (dir, state) = open().await;
    install(&state, dir.path(), "acme.ci").await;
    let first = deliver(&state, alert("acme.ci", "event-1", "Build failed")).await;
    let id = first["id"].as_str().expect("id").to_string();
    let clicked = first["notification"]["createdAt"]
        .as_str()
        .expect("createdAt")
        .to_string();

    // The dedupe key fires again while the click is still in flight.
    deliver(&state, alert("acme.ci", "event-1", "Build failed again")).await;
    let current = deliver(&state, alert("acme.ci", "event-1", "Build failed again")).await;
    let current_version = current["notification"]["createdAt"]
        .as_str()
        .expect("createdAt")
        .to_string();
    assert_ne!(clicked, current_version);

    let stale = call(
        &state,
        "notification.markRead",
        json!({ "id": id, "expectedCreatedAt": clicked }),
    )
    .await
    .unwrap();
    assert_eq!(stale, json!({ "ok": false }));
    assert!(
        read_at(&state, &id).await.is_none(),
        "the older click must not read the newer version"
    );

    let applied = call(
        &state,
        "notification.markRead",
        json!({ "id": id, "expectedCreatedAt": current_version }),
    )
    .await
    .unwrap();
    assert_eq!(applied, json!({ "ok": true }));
    assert!(read_at(&state, &id).await.is_some());
}

/// The call shape that predates the plugin family keeps reading whatever the
/// row is now, and rejects a row that is gone.
#[tokio::test]
async fn an_unversioned_mark_read_keeps_its_old_behavior() {
    let (dir, state) = open().await;
    install(&state, dir.path(), "acme.ci").await;
    let delivered = deliver(&state, alert("acme.ci", "event-1", "Build failed")).await;
    let id = delivered["id"].as_str().expect("id").to_string();

    let marked = call(&state, "notification.markRead", json!({ "id": id }))
        .await
        .unwrap();
    assert_eq!(marked, json!({ "ok": true }));
    assert!(read_at(&state, &id).await.is_some());

    let missing = call(
        &state,
        "notification.markRead",
        json!({ "id": "no-such-row" }),
    )
    .await
    .unwrap();
    assert_eq!(missing, json!({ "ok": false }));
}

/// "Mark all read" settles the plugin rows the user saw and the conversation
/// rows as before; a plugin row re-delivered meanwhile stays unread.
#[tokio::test]
async fn marking_all_read_keeps_a_concurrently_delivered_version_unread() {
    let (dir, state) = open().await;
    install(&state, dir.path(), "acme.ci").await;

    // One conversation row: the pre-plugin families keep the old rule.
    let task_id = {
        let guard = state.lock().await;
        let session = crate::sessions::create_session(
            &guard.db,
            Some("Long task".into()),
            None,
            None,
            None,
            None,
        )
        .unwrap();
        let turn = crate::sessions::begin_turn(&guard.db, &session.id, None, None).unwrap();
        crate::sessions::end_turn(&guard.db, &turn, "completed", None, None, true)
            .unwrap()
            .notification
            .expect("terminal row")
            .id
    };

    let settled = deliver(&state, alert("acme.ci", "event-1", "Already seen")).await;
    let settled_id = settled["id"].as_str().expect("id").to_string();
    let settled_version = settled["notification"]["createdAt"]
        .as_str()
        .expect("createdAt")
        .to_string();
    let redelivered = deliver(&state, alert("acme.ci", "event-2", "Saw this one")).await;
    let redelivered_id = redelivered["id"].as_str().expect("id").to_string();
    let redelivered_version = redelivered["notification"]["createdAt"]
        .as_str()
        .expect("createdAt")
        .to_string();

    // The user clicked "mark all" when the inbox held the first version of
    // `event-2`; the plugin re-delivered it before the write landed.
    let newer = deliver(&state, alert("acme.ci", "event-2", "Arrived later")).await;
    assert_eq!(newer["id"], redelivered_id.as_str());
    let newer_version = newer["notification"]["createdAt"]
        .as_str()
        .expect("createdAt")
        .to_string();
    assert_ne!(redelivered_version, newer_version);

    let marked = call(
        &state,
        "notification.markAllRead",
        json!({
            "pluginRows": [
                { "id": settled_id, "createdAt": settled_version },
                { "id": redelivered_id, "createdAt": redelivered_version },
            ],
        }),
    )
    .await
    .unwrap();
    assert_eq!(marked, json!({ "ok": true }));

    assert!(
        read_at(&state, &task_id).await.is_some(),
        "conversation rows keep the old all-at-once rule"
    );
    assert!(read_at(&state, &settled_id).await.is_some());
    assert!(
        read_at(&state, &redelivered_id).await.is_none(),
        "the version delivered after the click is still unread"
    );

    // The pinned version can still be settled once it is the one on screen.
    call(
        &state,
        "notification.markAllRead",
        json!({ "pluginRows": [{ "id": redelivered_id, "createdAt": newer_version }] }),
    )
    .await
    .unwrap();
    assert!(read_at(&state, &redelivered_id).await.is_some());
}

/// The snapshot-free call still settles every unread row, plugin rows included.
#[tokio::test]
async fn marking_all_read_without_a_snapshot_keeps_the_old_behavior() {
    let (dir, state) = open().await;
    install(&state, dir.path(), "acme.ci").await;
    let delivered = deliver(&state, alert("acme.ci", "event-1", "Build failed")).await;
    let id = delivered["id"].as_str().expect("id").to_string();

    let marked = call(&state, "notification.markAllRead", json!({}))
        .await
        .unwrap();
    assert_eq!(marked, json!({ "ok": true }));
    assert!(read_at(&state, &id).await.is_some());
}

#[tokio::test]
async fn mark_all_rejects_an_oversized_plugin_snapshot() {
    let (_dir, state) = open().await;
    let rows = vec![json!({ "id": "x", "createdAt": "2026-01-01T00:00:00.000Z" }); 201];
    let error = call(
        &state,
        "notification.markAllRead",
        json!({ "pluginRows": rows }),
    )
    .await
    .expect_err("snapshot must be bounded by the inbox cap");
    assert_eq!(error.code, 1002);
}
