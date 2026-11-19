//! `plugin.tcpUsage.*` host RPC contract tests.
//!
//! The RPC-level cases go through `handle_request`, so they cover the routing
//! arm as well as the handler. The window cases call the rollup directly with
//! an explicit `today`, because a calendar boundary is the one input a test
//! cannot wait for.

use std::sync::Arc;

use chrono::{Duration, Local, NaiveDate};
use rusqlite::params;
use serde_json::{json, Value};
use tokio::sync::{mpsc, Mutex};

use crate::rpc::{handle_request, JsonRpcError};
use crate::state::AppState;

use super::{apply_batch, purge_plugin, summarize, Sample, DAY_FORMAT, SUMMARY_DAYS};

const PLUGIN: &str = "pi.tcp-test";
const OTHER_PLUGIN: &str = "pi.tcp-other";

/// One plugin in the registry the host reads on launch: `record` attributes
/// traffic only to an id it can still find, so the case needs a real row.
fn seed_registry(dir: &std::path::Path, ids: &[&str]) {
    let plugins = dir.join("plugins");
    std::fs::create_dir_all(&plugins).unwrap();
    let rows: Vec<Value> = ids
        .iter()
        .map(|id| {
            json!({
                "id": id,
                "name": "TCP test plugin",
                "version": "1.0.0",
                "enabled": true,
                "source": "local",
                "status": "ready",
                "permissions": ["net.tcp"],
            })
        })
        .collect();
    std::fs::write(
        plugins.join("registry.json"),
        serde_json::to_string(&rows).unwrap(),
    )
    .unwrap();
}

async fn open() -> (tempfile::TempDir, Arc<Mutex<AppState>>) {
    let dir = tempfile::tempdir().unwrap();
    seed_registry(dir.path(), &[PLUGIN, OTHER_PLUGIN]);
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

fn today() -> NaiveDate {
    Local::now().date_naive()
}

fn day(value: NaiveDate) -> String {
    value.format(DAY_FORMAT).to_string()
}

type StoredRow = (String, i64, i64, i64, String);

/// Rows actually stored for one plugin, read straight from the table so the
/// assertions do not depend on the read path they are checking. It takes the
/// same state lock every RPC takes, so it must be awaited rather than blocked.
async fn stored_rows(state: &Arc<Mutex<AppState>>, plugin_id: &str) -> Vec<StoredRow> {
    let guard = state.lock().await;
    let mut stmt = guard
        .db
        .conn()
        .prepare(
            "SELECT host, port, COALESCE(bytes_in, 0), COALESCE(bytes_out, 0), day
               FROM plugin_tcp_usage WHERE plugin_id = ?1 ORDER BY host, port, day",
        )
        .unwrap();
    let rows = stmt
        .query_map(params![plugin_id], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
            ))
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    rows
}

fn totals(window: &Value) -> (i64, i64) {
    (
        window["bytesIn"].as_i64().unwrap(),
        window["bytesOut"].as_i64().unwrap(),
    )
}

#[tokio::test]
async fn flushes_accumulate_on_one_row_per_endpoint_and_day() {
    let (_dir, state) = open().await;
    let applied = call(
        &state,
        "plugin.tcpUsage.record",
        json!({
            "pluginId": PLUGIN,
            "samples": [
                { "host": "Api.Example", "port": 443, "bytesIn": 100, "bytesOut": 200 },
                // The same endpoint twice in one flush is still one row.
                { "host": "api.example", "port": 443, "bytesIn": 10, "bytesOut": 20 },
            ],
        }),
    )
    .await
    .unwrap();
    assert_eq!(applied["applied"], 2);

    call(
        &state,
        "plugin.tcpUsage.record",
        json!({
            "pluginId": PLUGIN,
            "samples": [{ "host": "api.example", "port": 443, "bytesIn": 5, "bytesOut": 7 }],
        }),
    )
    .await
    .unwrap();

    // One row per (plugin, host, port, day): the second flush added to the
    // first instead of inserting a second row, and the host is normalized.
    assert_eq!(
        stored_rows(&state, PLUGIN).await,
        vec![("api.example".to_string(), 443, 115, 227, day(today()))]
    );

    let summary = call(
        &state,
        "plugin.tcpUsage.summary",
        json!({ "pluginId": PLUGIN }),
    )
    .await
    .unwrap();
    assert_eq!(summary["today"]["fromDay"], day(today()));
    assert_eq!(summary["today"]["toDay"], day(today()));
    assert_eq!(totals(&summary["today"]), (115, 227));
    assert_eq!(totals(&summary["last7Days"]), (115, 227));
    assert_eq!(
        summary["today"]["endpoints"],
        json!([{ "host": "api.example", "port": 443, "bytesIn": 115, "bytesOut": 227 }])
    );
}

#[tokio::test]
async fn a_flush_naming_an_earlier_day_counts_there_not_today() {
    let (_dir, state) = open().await;
    let yesterday = today() - Duration::days(1);

    // A flush buffered before midnight names the day its bytes were counted
    // on, so the day rollover does not credit yesterday's traffic to today.
    call(
        &state,
        "plugin.tcpUsage.record",
        json!({
            "pluginId": PLUGIN,
            "day": day(yesterday),
            "samples": [{ "host": "api.example", "port": 443, "bytesIn": 40, "bytesOut": 60 }],
        }),
    )
    .await
    .unwrap();
    call(
        &state,
        "plugin.tcpUsage.record",
        json!({
            "pluginId": PLUGIN,
            "samples": [{ "host": "api.example", "port": 443, "bytesIn": 1, "bytesOut": 2 }],
        }),
    )
    .await
    .unwrap();

    let summary = call(
        &state,
        "plugin.tcpUsage.summary",
        json!({ "pluginId": PLUGIN }),
    )
    .await
    .unwrap();
    assert_eq!(totals(&summary["today"]), (1, 2));
    assert_eq!(totals(&summary["last7Days"]), (41, 62));
    // One endpoint across two days is one line in the rollup.
    assert_eq!(
        summary["last7Days"]["endpoints"].as_array().unwrap().len(),
        1
    );
    // Stored as two rows, one per calendar day, oldest first.
    assert_eq!(
        stored_rows(&state, PLUGIN).await,
        vec![
            ("api.example".to_string(), 443, 40, 60, day(yesterday)),
            ("api.example".to_string(), 443, 1, 2, day(today())),
        ]
    );
}

/// A day the caller writes loosely is stored in the canonical `YYYY-MM-DD`
/// form, because the column is compared as text by the window query.
#[tokio::test]
async fn a_loosely_written_day_is_stored_canonically() {
    let (_dir, state) = open().await;
    call(
        &state,
        "plugin.tcpUsage.record",
        json!({
            "pluginId": PLUGIN,
            "day": "2025-3-1",
            "samples": [{ "host": "api.example", "port": 443, "bytesIn": 1, "bytesOut": 1 }],
        }),
    )
    .await
    .unwrap();
    assert_eq!(
        stored_rows(&state, PLUGIN).await,
        vec![(
            "api.example".to_string(),
            443,
            1,
            1,
            "2025-03-01".to_string()
        )]
    );
}

/// The seven-day window is today plus the six days before it; the day that
/// falls out of it keeps its row (retention prunes by day, not this read).
#[tokio::test]
async fn the_seven_day_window_includes_today_and_stops_at_six_days_back() {
    let (_dir, state) = open().await;
    let reference = NaiveDate::from_ymd_opt(2026, 3, 15).unwrap();
    let samples: Vec<Sample> = (0..=SUMMARY_DAYS)
        .map(|offset| Sample {
            host: "api.example".into(),
            port: 443,
            bytes_in: 10,
            bytes_out: 20,
            day: reference - Duration::days(offset),
        })
        .collect();
    {
        let guard = state.lock().await;
        apply_batch(guard.db.conn(), PLUGIN, &samples).unwrap();
    }

    let summary = {
        let guard = state.lock().await;
        summarize(&guard.db, PLUGIN, reference).unwrap()
    };
    assert_eq!(summary["today"]["fromDay"], "2026-03-15");
    assert_eq!(summary["today"]["toDay"], "2026-03-15");
    assert_eq!(totals(&summary["today"]), (10, 20));
    assert_eq!(summary["last7Days"]["fromDay"], "2026-03-09");
    assert_eq!(summary["last7Days"]["toDay"], "2026-03-15");
    // Seven of the eight stored days are in the window.
    assert_eq!(totals(&summary["last7Days"]), (70, 140));
    assert_eq!(
        summary["last7Days"]["endpoints"],
        json!([{ "host": "api.example", "port": 443, "bytesIn": 70, "bytesOut": 140 }])
    );
    // Nothing was deleted: only the calendar moved.
    assert_eq!(stored_rows(&state, PLUGIN).await.len(), 8);
}

#[tokio::test]
async fn endpoints_are_ordered_by_traffic() {
    let (_dir, state) = open().await;
    call(
        &state,
        "plugin.tcpUsage.record",
        json!({
            "pluginId": PLUGIN,
            "samples": [
                { "host": "small.example", "port": 443, "bytesIn": 1, "bytesOut": 1 },
                { "host": "large.example", "port": 9000, "bytesIn": 500, "bytesOut": 500 },
                { "host": "medium.example", "port": 80, "bytesIn": 10, "bytesOut": 10 },
            ],
        }),
    )
    .await
    .unwrap();

    let summary = call(
        &state,
        "plugin.tcpUsage.summary",
        json!({ "pluginId": PLUGIN }),
    )
    .await
    .unwrap();
    let hosts: Vec<&str> = summary["today"]["endpoints"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| row["host"].as_str().unwrap())
        .collect();
    assert_eq!(hosts, ["large.example", "medium.example", "small.example"]);
    assert_eq!(totals(&summary["today"]), (511, 511));
}

#[tokio::test]
async fn traffic_is_only_accepted_for_an_installed_plugin() {
    let (_dir, state) = open().await;
    let error = call(
        &state,
        "plugin.tcpUsage.record",
        json!({
            "pluginId": "pi.not-installed",
            "samples": [{ "host": "api.example", "port": 443, "bytesIn": 1, "bytesOut": 1 }],
        }),
    )
    .await
    .unwrap_err();
    assert_eq!(error_code(&error), "PLUGIN_NOT_FOUND");
    assert!(stored_rows(&state, "pi.not-installed").await.is_empty());
}

/// Read-back of an id this host never saw is an empty rollup, not an error:
/// the id is already bound by Electron main, and a purged plugin has nothing
/// left to read.
#[tokio::test]
async fn summary_of_an_unknown_plugin_is_empty() {
    let (_dir, state) = open().await;
    let summary = call(
        &state,
        "plugin.tcpUsage.summary",
        json!({ "pluginId": "pi.never-seen" }),
    )
    .await
    .unwrap();
    assert_eq!(totals(&summary["today"]), (0, 0));
    assert_eq!(totals(&summary["last7Days"]), (0, 0));
    assert_eq!(summary["today"]["endpoints"], json!([]));
}

/// Every sample is validated before the first statement runs, so a flush with
/// one bad sample does not write its valid prefix.
#[tokio::test]
async fn a_rejected_flush_writes_nothing() {
    let (_dir, state) = open().await;
    for params in [
        // port out of range
        json!({
            "pluginId": PLUGIN,
            "samples": [
                { "host": "ok.example", "port": 443, "bytesIn": 1, "bytesOut": 1 },
                { "host": "bad.example", "port": 0, "bytesIn": 1, "bytesOut": 1 },
            ],
        }),
        // negative counter
        json!({
            "pluginId": PLUGIN,
            "samples": [{ "host": "bad.example", "port": 443, "bytesIn": -1, "bytesOut": 0 }],
        }),
        // empty host
        json!({
            "pluginId": PLUGIN,
            "samples": [{ "host": "  ", "port": 443, "bytesIn": 1, "bytesOut": 1 }],
        }),
        // a day that is not a calendar day at all
        json!({ "pluginId": PLUGIN, "day": "last tuesday", "samples": [] }),
        // a day after the host's own
        json!({
            "pluginId": PLUGIN,
            "day": day(today() + Duration::days(1)),
            "samples": [],
        }),
        // unknown field: the contract is exact, not a bag of options
        json!({ "pluginId": PLUGIN, "samples": [], "flushId": "x" }),
        // missing plugin id
        json!({ "samples": [] }),
    ] {
        let error = call(&state, "plugin.tcpUsage.record", params.clone())
            .await
            .unwrap_err();
        assert_eq!(error_code(&error), "INVALID_PARAMS", "accepted {params}");
        assert!(
            stored_rows(&state, PLUGIN).await.is_empty(),
            "wrote for {params}"
        );
    }
}

#[tokio::test]
async fn purge_deletes_one_plugins_rows_and_is_idempotent() {
    let (_dir, state) = open().await;
    let reference = today();
    {
        let guard = state.lock().await;
        for plugin_id in [PLUGIN, OTHER_PLUGIN] {
            apply_batch(
                guard.db.conn(),
                plugin_id,
                &[Sample {
                    host: "api.example".into(),
                    port: 443,
                    bytes_in: 10,
                    bytes_out: 20,
                    day: reference,
                }],
            )
            .unwrap();
        }
    }

    let purged = call(
        &state,
        "plugin.tcpUsage.purge",
        json!({ "pluginId": PLUGIN }),
    )
    .await
    .unwrap();
    assert_eq!(purged["deleted"], 1);
    assert!(stored_rows(&state, PLUGIN).await.is_empty());
    // The other plugin's totals are untouched.
    assert_eq!(stored_rows(&state, OTHER_PLUGIN).await.len(), 1);

    let again = call(
        &state,
        "plugin.tcpUsage.purge",
        json!({ "pluginId": PLUGIN }),
    )
    .await
    .unwrap();
    assert_eq!(again["deleted"], 0);
    // An uninstalled plugin's rollup reads back empty rather than failing.
    let summary = call(
        &state,
        "plugin.tcpUsage.summary",
        json!({ "pluginId": PLUGIN }),
    )
    .await
    .unwrap();
    assert_eq!(totals(&summary["last7Days"]), (0, 0));
}

/// The uninstall path purges, then a flush that lost the race arrives. It is
/// refused because the host no longer has the plugin, so the purged rows do
/// not come back.
#[tokio::test]
async fn a_late_flush_cannot_resurrect_purged_rows() {
    let (_dir, state) = open().await;
    call(
        &state,
        "plugin.tcpUsage.record",
        json!({
            "pluginId": PLUGIN,
            "samples": [{ "host": "api.example", "port": 443, "bytesIn": 10, "bytesOut": 20 }],
        }),
    )
    .await
    .unwrap();
    {
        let mut guard = state.lock().await;
        assert!(guard.plugins.uninstall(PLUGIN).unwrap());
        purge_plugin(&guard.db, PLUGIN).unwrap();
    }

    let error = call(
        &state,
        "plugin.tcpUsage.record",
        json!({
            "pluginId": PLUGIN,
            "samples": [{ "host": "api.example", "port": 443, "bytesIn": 10, "bytesOut": 20 }],
        }),
    )
    .await
    .unwrap_err();
    assert_eq!(error_code(&error), "PLUGIN_NOT_FOUND");
    assert!(stored_rows(&state, PLUGIN).await.is_empty());
}

/// A flush and a purge issued together are serialized by the host state lock:
/// the batch lands whole or not at all, never half of it.
#[tokio::test]
async fn a_flush_racing_a_purge_leaves_no_partial_batch() {
    let (_dir, state) = open().await;
    for round in 0..8 {
        let flush = call(
            &state,
            "plugin.tcpUsage.record",
            json!({
                "pluginId": PLUGIN,
                "samples": [{ "host": "api.example", "port": 443, "bytesIn": 300, "bytesOut": 400 }],
            }),
        );
        let purge = call(
            &state,
            "plugin.tcpUsage.purge",
            json!({ "pluginId": PLUGIN }),
        );
        let (flushed, purged) = tokio::join!(flush, purge);
        assert!(flushed.is_ok(), "round {round}: flush failed");
        let deleted = purged.unwrap()["deleted"].as_i64().unwrap();
        let rows = stored_rows(&state, PLUGIN).await;
        match (deleted, rows.as_slice()) {
            // The purge ran last: nothing is left.
            (_, []) => {}
            // The flush ran last: exactly one row holding the whole batch.
            (0, [(host, 443, 300, 400, _)]) => assert_eq!(host.as_str(), "api.example"),
            // Anything else is a batch written half-way, or the two
            // interleaving inside one flush.
            (_, other) => panic!("round {round}: {other:?} after deleting {deleted}"),
        }
    }
}

#[tokio::test]
async fn uninstall_rpc_removes_only_the_uninstalled_plugins_usage() {
    let (_dir, state) = open().await;
    for id in [PLUGIN, OTHER_PLUGIN] {
        call(
            &state,
            "plugin.tcpUsage.record",
            json!({
                "pluginId": id,
                "samples": [{ "host": "mail.example", "port": 993, "bytesIn": 17, "bytesOut": 9 }]
            }),
        )
        .await
        .unwrap();
    }
    let result = call(&state, "plugins.uninstall", json!({ "id": PLUGIN }))
        .await
        .unwrap();
    assert_eq!(result["ok"], true);
    assert!(stored_rows(&state, PLUGIN).await.is_empty());
    assert_eq!(stored_rows(&state, OTHER_PLUGIN).await.len(), 1);
}

#[tokio::test]
async fn uninstall_reports_tcp_cleanup_failure_after_plugin_removal() {
    let (_dir, state) = open().await;
    {
        let guard = state.lock().await;
        guard
            .db
            .conn()
            .execute("DROP TABLE plugin_tcp_usage", [])
            .unwrap();
    }
    let error = call(&state, "plugins.uninstall", json!({ "id": PLUGIN }))
        .await
        .unwrap_err();
    assert_eq!(error_code(&error), "INTERNAL");
    assert!(error.message.contains("TCP traffic cleanup failed"));
    assert!(state.lock().await.plugins.get(PLUGIN).is_none());
}

#[tokio::test]
async fn unknown_method_is_reported_as_missing() {
    let (_dir, state) = open().await;
    let error = call(&state, "plugin.tcpUsage.nope", json!({}))
        .await
        .unwrap_err();
    assert_eq!(error_code(&error), "METHOD_NOT_FOUND");
}
