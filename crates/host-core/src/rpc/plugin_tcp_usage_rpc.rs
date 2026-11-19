//! Host-mediated TCP (`net.tcp`) byte accounting.
//!
//! A plugin never holds a socket of its own — the host dials, relays and
//! counts — so `plugin_tcp_usage` is the only record of what that capability
//! cost. The table is a **daily counter, not an event log**: one row per
//! `(plugin_id, host, port, day)`, accumulated by an upsert on that primary
//! key (spec `03-runtime/04-data-storage.md` §4.19e). `day` is the local
//! calendar day (`YYYY-MM-DD`), which is the unit a usage view groups by.
//!
//! Three things follow from the shape of the table and are the reason this is
//! not folded into the session-usage surface:
//!
//! - **One flush is one transaction.** A batch either lands whole or not at
//!   all, so a crash between two statements cannot show half of one flush.
//!   Every statement runs under the host state lock, so a batch and the purge
//!   below can never interleave.
//! - **There is no foreign key to cascade, and cannot be one.** `plugin_id` is
//!   a label with the same lifecycle as `providers.owner_plugin_id`: a plugin
//!   is a directory under the plugin root, not a row in this database. Rows
//!   are therefore deleted explicitly by [`purge_plugin`], which the
//!   `plugins.uninstall` arm calls once the plugin is gone.
//! - **A purge must not be undone by a late flush.** The Electron main process
//!   releases the plugin's connections and stops flushing *before* it asks for
//!   the uninstall, and `record` refuses an id the host no longer has
//!   installed, so a flush that loses that race cannot recreate purged rows.
use std::sync::Arc;

use anyhow::Result;
use chrono::{Duration, Local, NaiveDate};
use rusqlite::{params, Connection};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::Mutex;

use super::{rpc_err, AppState, JsonRpcError};
use crate::db::Database;

#[cfg(test)]
#[path = "plugin_tcp_usage_rpc_tests.rs"]
mod tests;

/// The read window behind `last7Days`: today and the six days before it.
const SUMMARY_DAYS: i64 = 7;

/// Upper bound on one flush. A batch is one transaction on the host state
/// lock, so it is bounded rather than trusted: a plugin with four connections
/// and literal endpoints produces a handful of rows per flush, and a caller
/// that sends thousands is not describing real traffic.
const MAX_SAMPLES: usize = 256;

const MAX_HOST_LEN: usize = 253;
const DAY_FORMAT: &str = "%Y-%m-%d";

/// One accumulated `(host, port, day)` sample of a flush.
struct Sample {
    host: String,
    port: i64,
    bytes_in: i64,
    bytes_out: i64,
    day: NaiveDate,
}

pub(super) async fn handle(
    state: Arc<Mutex<AppState>>,
    method: &str,
    params: Value,
) -> Result<Value, JsonRpcError> {
    match method {
        "plugin.tcpUsage.record" => record(state, &params).await,
        "plugin.tcpUsage.summary" => summary(state, &params).await,
        "plugin.tcpUsage.purge" => purge(state, &params).await,
        _ => Err(rpc_err(
            -32601,
            format!("method not found: {method}"),
            "METHOD_NOT_FOUND",
        )),
    }
}

// ---- record -------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RecordRequest {
    plugin_id: String,
    #[serde(default)]
    samples: Vec<RecordSample>,
    /// The local day these bytes were counted on. Absent means the day this
    /// request arrived on. A flush that straddles midnight is therefore split
    /// by the caller into one batch per day instead of being credited whole to
    /// whichever day the timer happened to fire.
    #[serde(default)]
    day: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RecordSample {
    host: String,
    port: i64,
    #[serde(default)]
    bytes_in: i64,
    #[serde(default)]
    bytes_out: i64,
}

fn invalid_params(message: impl std::fmt::Display) -> JsonRpcError {
    rpc_err(-32602, message.to_string(), "INVALID_PARAMS")
}

/// The host's own local calendar day. Read per request, never cached: a host
/// that stays up across midnight must roll the counter over with the calendar.
fn local_today() -> NaiveDate {
    Local::now().date_naive()
}

fn parse_day(raw: &str, today: NaiveDate) -> std::result::Result<NaiveDate, String> {
    let day = NaiveDate::parse_from_str(raw, DAY_FORMAT)
        .map_err(|_| format!("day must be a local calendar day (YYYY-MM-DD), not {raw}"))?;
    if day > today {
        // A day after the host's own is a caller clock error. Storing it would
        // hide the bytes from every "today" and "last 7 days" view until the
        // real date catches up, so it is refused at the boundary.
        return Err(format!(
            "day {raw} must not be after today ({})",
            today.format(DAY_FORMAT)
        ));
    }
    Ok(day)
}

/// Trim and lowercase so one peer cannot own two rows. The manifest's own
/// comparison normalizes the endpoint the same way, and a bare hostname is
/// case-insensitive either way.
fn normalize_host(raw: &str) -> std::result::Result<String, String> {
    let host = raw.trim();
    if host.is_empty() {
        return Err("host must not be empty".into());
    }
    if host.len() > MAX_HOST_LEN {
        return Err(format!("host must be at most {MAX_HOST_LEN} characters"));
    }
    if host.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(format!("host must be a bare host name, not {host}"));
    }
    Ok(host.to_ascii_lowercase())
}

/// Validate the whole batch before the first statement runs, so a rejected
/// flush writes nothing at all rather than its valid prefix.
fn parse_batch(
    params: &Value,
    today: NaiveDate,
) -> std::result::Result<(String, Vec<Sample>), String> {
    let request: RecordRequest =
        serde_json::from_value(params.clone()).map_err(|error| error.to_string())?;
    if request.plugin_id.trim().is_empty() {
        return Err("pluginId must not be empty".into());
    }
    if request.samples.len() > MAX_SAMPLES {
        return Err(format!(
            "a flush carries at most {MAX_SAMPLES} samples, not {}",
            request.samples.len()
        ));
    }
    let day = match request.day.as_deref() {
        Some(raw) => parse_day(raw, today)?,
        None => today,
    };
    let mut samples = Vec::with_capacity(request.samples.len());
    for sample in request.samples {
        let host = normalize_host(&sample.host)?;
        if !(1..=65535).contains(&sample.port) {
            return Err(format!(
                "port must be 1..65535 for {host}, not {}",
                sample.port
            ));
        }
        if sample.bytes_in < 0 || sample.bytes_out < 0 {
            return Err(format!(
                "byte counts must not be negative for {host}:{}",
                sample.port
            ));
        }
        samples.push(Sample {
            host,
            port: sample.port,
            bytes_in: sample.bytes_in,
            bytes_out: sample.bytes_out,
            day,
        });
    }
    Ok((request.plugin_id, samples))
}

fn apply_batch(conn: &Connection, plugin_id: &str, samples: &[Sample]) -> Result<usize> {
    if samples.is_empty() {
        return Ok(0);
    }
    let tx = conn.unchecked_transaction()?;
    {
        let mut stmt = tx.prepare_cached(
            "INSERT INTO plugin_tcp_usage (plugin_id, host, port, bytes_in, bytes_out, day)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(plugin_id, host, port, day) DO UPDATE SET
               bytes_in  = COALESCE(plugin_tcp_usage.bytes_in, 0) + excluded.bytes_in,
               bytes_out = COALESCE(plugin_tcp_usage.bytes_out, 0) + excluded.bytes_out",
        )?;
        for sample in samples {
            stmt.execute(params![
                plugin_id,
                sample.host,
                sample.port,
                sample.bytes_in,
                sample.bytes_out,
                sample.day.format(DAY_FORMAT).to_string(),
            ])?;
        }
    }
    tx.commit()?;
    Ok(samples.len())
}

async fn record(state: Arc<Mutex<AppState>>, params: &Value) -> Result<Value, JsonRpcError> {
    let today = local_today();
    let (plugin_id, samples) = parse_batch(params, today).map_err(invalid_params)?;
    let st = state.lock().await;
    // Traffic is only attributable to a plugin the host has. This is also what
    // keeps a flush that loses the uninstall race from recreating the rows the
    // purge just deleted.
    if st.plugins.get(&plugin_id).is_none() {
        return Err(rpc_err(
            -32602,
            "plugin is not installed",
            "PLUGIN_NOT_FOUND",
        ));
    }
    let applied = apply_batch(st.db.conn(), &plugin_id, &samples)
        .map_err(|error| rpc_err(-32000, error.to_string(), "INTERNAL"))?;
    tracing::debug!(
        method = "plugin.tcpUsage.record",
        plugin_id,
        applied,
        day = %today.format(DAY_FORMAT),
        "plugin tcp usage recorded"
    );
    Ok(json!({ "applied": applied }))
}

// ---- summary ------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SummaryRequest {
    plugin_id: String,
}

#[derive(Debug, PartialEq, Eq)]
struct EndpointRow {
    host: String,
    port: i64,
    bytes_in: i64,
    bytes_out: i64,
}

/// Totals per endpoint over `from..=to`, largest first. `bytes_in` /
/// `bytes_out` are nullable in the table (a sample may only know one
/// direction), so the sum coalesces per row before summing across rows.
fn endpoint_rows(
    db: &Database,
    plugin_id: &str,
    from: NaiveDate,
    to: NaiveDate,
) -> Result<Vec<EndpointRow>> {
    let mut stmt = db.conn().prepare_cached(
        "SELECT host, port,
                COALESCE(SUM(COALESCE(bytes_in, 0)), 0) AS bytes_in,
                COALESCE(SUM(COALESCE(bytes_out, 0)), 0) AS bytes_out
           FROM plugin_tcp_usage
          WHERE plugin_id = ?1 AND day >= ?2 AND day <= ?3
          GROUP BY host, port
          ORDER BY bytes_in + bytes_out DESC, host ASC, port ASC",
    )?;
    let rows = stmt.query_map(
        params![
            plugin_id,
            from.format(DAY_FORMAT).to_string(),
            to.format(DAY_FORMAT).to_string(),
        ],
        |row| {
            Ok(EndpointRow {
                host: row.get(0)?,
                port: row.get(1)?,
                bytes_in: row.get(2)?,
                bytes_out: row.get(3)?,
            })
        },
    )?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

fn window_json(rows: &[EndpointRow], from: NaiveDate, to: NaiveDate) -> Value {
    let bytes_in: i64 = rows.iter().map(|row| row.bytes_in).sum();
    let bytes_out: i64 = rows.iter().map(|row| row.bytes_out).sum();
    json!({
        "fromDay": from.format(DAY_FORMAT).to_string(),
        "toDay": to.format(DAY_FORMAT).to_string(),
        "bytesIn": bytes_in,
        "bytesOut": bytes_out,
        "endpoints": rows
            .iter()
            .map(|row| {
                json!({
                    "host": row.host,
                    "port": row.port,
                    "bytesIn": row.bytes_in,
                    "bytesOut": row.bytes_out,
                })
            })
            .collect::<Vec<_>>(),
    })
}

pub(crate) fn summarize(db: &Database, plugin_id: &str, today: NaiveDate) -> Result<Value> {
    let from = today - Duration::days(SUMMARY_DAYS - 1);
    let today_rows = endpoint_rows(db, plugin_id, today, today)?;
    let week_rows = endpoint_rows(db, plugin_id, from, today)?;
    Ok(json!({
        "pluginId": plugin_id,
        "today": window_json(&today_rows, today, today),
        "last7Days": window_json(&week_rows, from, today),
    }))
}

async fn summary(state: Arc<Mutex<AppState>>, params: &Value) -> Result<Value, JsonRpcError> {
    let request: SummaryRequest = serde_json::from_value(params.clone()).map_err(invalid_params)?;
    if request.plugin_id.trim().is_empty() {
        return Err(invalid_params("pluginId must not be empty"));
    }
    let st = state.lock().await;
    // Read-only and keyed by the id Electron main bound to the caller, so it
    // needs no registry check: a plugin that is no longer installed has no
    // rows left to read (they were purged), and an empty rollup is a truthful
    // answer for an id this host has never seen.
    summarize(&st.db, &request.plugin_id, local_today())
        .map_err(|error| rpc_err(-32000, error.to_string(), "INTERNAL"))
}

// ---- purge --------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PurgeRequest {
    plugin_id: String,
}

fn delete_rows(db: &Database, plugin_id: &str) -> Result<usize> {
    Ok(db
        .conn()
        .prepare_cached("DELETE FROM plugin_tcp_usage WHERE plugin_id = ?1")?
        .execute(params![plugin_id])?)
}

/// Delete every byte total a plugin accumulated.
///
/// There is no foreign key to cascade (a plugin is a directory, not a row), so
/// this is the only place these rows are removed: the `plugins.uninstall` arm
/// calls it once the plugin is gone, and a boot reconciliation may call it for
/// an id whose directory disappeared while the host was down. It is
/// deliberately idempotent — an uninstall that finds nothing to delete is not
/// a failure — and every row it drops belongs to one plugin only.
pub(crate) fn purge_plugin(db: &Database, plugin_id: &str) -> Result<usize> {
    let deleted = delete_rows(db, plugin_id)?;
    if deleted > 0 {
        tracing::info!(plugin = plugin_id, deleted, "plugin tcp usage purged");
    }
    Ok(deleted)
}

pub(super) fn purge_after_uninstall(db: &Database, plugin_id: &str) -> Result<(), JsonRpcError> {
    purge_plugin(db, plugin_id).map(|_| ()).map_err(|error| {
        tracing::warn!(plugin = plugin_id, %error, "plugin tcp usage purge failed");
        rpc_err(
            -32000,
            "TCP traffic cleanup failed due to a storage error; the plugin may already be removed",
            "INTERNAL",
        )
    })
}

async fn purge(state: Arc<Mutex<AppState>>, params: &Value) -> Result<Value, JsonRpcError> {
    let request: PurgeRequest = serde_json::from_value(params.clone()).map_err(invalid_params)?;
    if request.plugin_id.trim().is_empty() {
        return Err(invalid_params("pluginId must not be empty"));
    }
    let st = state.lock().await;
    let deleted = purge_plugin(&st.db, &request.plugin_id)
        .map_err(|error| rpc_err(-32000, error.to_string(), "INTERNAL"))?;
    Ok(json!({ "deleted": deleted }))
}
