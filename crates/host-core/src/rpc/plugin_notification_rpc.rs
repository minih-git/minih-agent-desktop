//! Durable inbox rows a plugin delivers (`pluginNotification.create`).
//!
//! Electron main owns the manifest half of this contract: it knows which
//! plugin is calling, whether that plugin's manifest may deliver notifications
//! at all, and which links it is allowed to open. This module is the host trust
//! boundary behind that call, so it re-checks everything that reaches SQLite:
//!
//! * types and lengths: `pluginId` 200 characters, trimmed, without inner
//!   whitespace or control characters (it is also the budget key), `title` 200
//!   characters and required after trimming, `body` 2000 characters, `linkJson`
//!   4096 bytes of JSON object, `dedupeKey` 256 characters and never blank when
//!   supplied. Titles, bodies and keys are stored verbatim — a newline or an
//!   inner space is the plugin's own text, not the host's to normalize. Main
//!   applies the same bounds before it calls, so a rejection here means the two
//!   sides disagree, not that a user typed too much,
//! * the `kind` vocabulary — only `alert` and `digest` are storable, and they
//!   map onto the two plugin kinds the schema's `CHECK` allows,
//! * that the plugin is still installed — read from the registry under the
//!   same host state lock the uninstall takes, so a delivery main sent while
//!   awaiting the plugin call cannot outlive the plugin that sent it,
//! * the reserved dedupe key the overflow digest owns, matched exactly, so a
//!   plugin cannot address or overwrite the host's folded summary,
//! * a rolling hour of at most [`HOURLY_LIMIT`] new rows per plugin, `alert`
//!   and `digest` counted together — spending one kind as a bypass for the
//!   other is exactly what a per-kind counter would allow — measured from the
//!   durable audit log rather than from the inbox itself, so clearing or
//!   pruning notifications cannot reset the budget and a restart reads the
//!   same evidence,
//! * the global [`NOTIFICATION_KEEP`] row cap the task and prompt families
//!   already share.
//!
//! A delivery that repeats a `(pluginId, dedupeKey)` pair updates the row that
//! is already there — `kind`, `title`, `body`, `link_json`, `created_at` and
//! unread state — instead of adding a second copy, which is what makes a
//! retried delivery idempotent and keeps a re-delivered row at the newest
//! position for the reader's watermark. Keys, titles and bodies are stored and
//! compared exactly as the plugin sent them; the host only judges
//! required-ness after trimming, it never rewrites the text.
//!
//! Once a plugin has added its 60 rows of the hour, every later new delivery
//! folds into one durable digest row per plugin. Its body is the decimal
//! number of notifications folded into it (the renderer localizes the count),
//! its title is fixed, and it carries no link. That folded row is the only row
//! which never spends budget and never writes an audit record, so a flood
//! cannot turn the rate limit into unbounded audit growth.

use anyhow::{anyhow, Result};
use rusqlite::{params, OptionalExtension, Transaction};
use serde::Deserialize;
use std::sync::Arc;
use tokio::sync::Mutex;
use uuid::Uuid;

use super::{json, rpc_err, AppState, JsonRpcError, Value};
use crate::db::{ms_to_ts, now_ms, Database, NOTIFICATION_KEEP};
use crate::notifications::Notification;

#[cfg(test)]
#[path = "plugin_notification_rpc_tests.rs"]
mod tests;

/// The dedupe key the overflow digest owns. A plugin may not send it.
pub(super) const RESERVED_DEDUPE_KEY: &str = "__minih_notify_overflow__";
/// Fixed title of the overflow digest; the count lives in its body.
const OVERFLOW_TITLE: &str = "More notifications were folded";

const ALERT_KIND: &str = "plugin.alert";
const DIGEST_KIND: &str = "plugin.digest";

const MAX_PLUGIN_ID_CHARS: usize = 200;
const MAX_TITLE_CHARS: usize = 200;
const MAX_BODY_CHARS: usize = 2_000;
const MAX_LINK_JSON_BYTES: usize = 4_096;
const MAX_DEDUPE_KEY_CHARS: usize = 256;

/// Rolling window the per-plugin row budget is measured over.
const HOURLY_WINDOW_MS: i64 = 60 * 60 * 1_000;
/// New rows one plugin may add per rolling hour before folding starts.
const HOURLY_LIMIT: i64 = 60;

/// One audit row per notification row the plugin actually added, and nothing
/// else: it is the durable budget evidence, so a folded or refreshed delivery —
/// neither of which adds a row — writes none.
const AUDIT_DELIVERED: &str = "plugin_notification_delivered";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateRequest {
    plugin_id: String,
    kind: String,
    title: String,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    link_json: Option<String>,
    #[serde(default)]
    dedupe_key: Option<String>,
}

/// One validated delivery, in the shapes the `notifications` table stores.
struct Delivery {
    plugin_id: String,
    kind: &'static str,
    title: String,
    body: Option<String>,
    link_json: Option<String>,
    dedupe_key: Option<String>,
}

impl Delivery {
    fn parse(params: Value) -> Result<Self, JsonRpcError> {
        let input: CreateRequest = serde_json::from_value(params).map_err(|_| {
            rpc_err(
                -32602,
                "pluginNotification.create parameters are invalid",
                "INVALID_ARGUMENT",
            )
        })?;
        let kind = match input.kind.trim() {
            "alert" => ALERT_KIND,
            "digest" => DIGEST_KIND,
            _ => return Err(boundary_err("kind", "must be \"alert\" or \"digest\"")),
        };
        Ok(Self {
            plugin_id: bounded_plugin_id(&input.plugin_id)?,
            kind,
            title: bounded_title(&input.title)?,
            body: bounded_body(input.body.as_deref())?,
            link_json: bounded_link_json(input.link_json.as_deref())?,
            dedupe_key: bounded_dedupe_key(input.dedupe_key.as_deref())?,
        })
    }
}

fn boundary_err(field: &str, rule: &str) -> JsonRpcError {
    rpc_err(-32602, format!("{field} {rule}"), "INVALID_ARGUMENT")
}

fn too_long(field: &str, unit: &str, max: usize) -> JsonRpcError {
    boundary_err(field, &format!("exceeds {max} {unit}"))
}

/// The plugin identity is the budget key, so it is normalized: a manifest id
/// with stray whitespace must not become a second budget.
fn bounded_plugin_id(raw: &str) -> Result<String, JsonRpcError> {
    let value = raw.trim();
    if value.is_empty() {
        return Err(boundary_err("pluginId", "is required"));
    }
    if value.chars().count() > MAX_PLUGIN_ID_CHARS {
        return Err(too_long("pluginId", "characters", MAX_PLUGIN_ID_CHARS));
    }
    if value.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err(boundary_err(
            "pluginId",
            "must not contain spaces or control characters",
        ));
    }
    Ok(value.to_string())
}

fn bounded_title(raw: &str) -> Result<String, JsonRpcError> {
    if raw.trim().is_empty() {
        return Err(boundary_err("title", "is required"));
    }
    if raw.chars().count() > MAX_TITLE_CHARS {
        return Err(too_long("title", "characters", MAX_TITLE_CHARS));
    }
    Ok(raw.to_string())
}

fn bounded_body(raw: Option<&str>) -> Result<Option<String>, JsonRpcError> {
    let Some(raw) = raw else {
        return Ok(None);
    };
    if raw.chars().count() > MAX_BODY_CHARS {
        return Err(too_long("body", "characters", MAX_BODY_CHARS));
    }
    Ok(Some(raw.to_string()))
}

fn bounded_link_json(raw: Option<&str>) -> Result<Option<String>, JsonRpcError> {
    let Some(raw) = raw else {
        return Ok(None);
    };
    if raw.trim().is_empty() {
        return Ok(None);
    }
    // Main resolves the link against the manifest; the host still refuses
    // anything the column could not hand back to a renderer as a target.
    if raw.len() > MAX_LINK_JSON_BYTES {
        return Err(too_long("linkJson", "bytes", MAX_LINK_JSON_BYTES));
    }
    let parsed: Value =
        serde_json::from_str(raw).map_err(|_| boundary_err("linkJson", "must be a JSON object"))?;
    if !parsed.is_object() {
        return Err(boundary_err("linkJson", "must be a JSON object"));
    }
    Ok(Some(raw.to_string()))
}

fn bounded_dedupe_key(raw: Option<&str>) -> Result<Option<String>, JsonRpcError> {
    let Some(raw) = raw else {
        return Ok(None);
    };
    // A supplied key must be non-empty and is compared exactly as sent.
    if raw.trim().is_empty() {
        return Err(boundary_err("dedupeKey", "must not be empty"));
    }
    if raw.chars().count() > MAX_DEDUPE_KEY_CHARS {
        return Err(too_long("dedupeKey", "characters", MAX_DEDUPE_KEY_CHARS));
    }
    // Exact match only: the host's folded summary is not reachable, but a key
    // that merely looks like it is an ordinary key of the plugin's own.
    if raw == RESERVED_DEDUPE_KEY {
        return Err(boundary_err("dedupeKey", "is reserved by the host"));
    }
    Ok(Some(raw.to_string()))
}

pub(super) async fn create(
    state: Arc<Mutex<AppState>>,
    params: Value,
) -> Result<Value, JsonRpcError> {
    let delivery = Delivery::parse(params)?;
    let st = state.lock().await;
    // The plugin may have been uninstalled while main was awaiting the plugin's
    // own call, so the registry — not the caller's earlier reading of it — is
    // what decides. This runs under the same host state lock the uninstall
    // holds, so a delivery cannot land between "plugin removed" and "its rows
    // deleted" and leave an orphan in the inbox.
    if st.plugins.get(&delivery.plugin_id).is_none() {
        return Err(rpc_err(
            -32602,
            "plugin is not installed",
            "PLUGIN_NOT_FOUND",
        ));
    }
    let (id, notification) =
        store(&st.db, &delivery).map_err(|error| rpc_err(1000, error.to_string(), "INTERNAL"))?;
    Ok(json!({ "id": id, "notification": notification }))
}

/// Remove rows even on an uninstall retry after a partial failure. Audit rows
/// remain as the per-plugin rate-limit evidence.
pub(super) fn delete_for_plugin(db: &Database, plugin_id: &str) -> Result<(), JsonRpcError> {
    db.conn()
        .execute(
            "DELETE FROM notifications WHERE plugin_id = ?1",
            params![plugin_id],
        )
        .map(|_| ())
        .map_err(|error| {
            tracing::error!(plugin = plugin_id, %error, "plugin notification cleanup failed");
            rpc_err(
                1000,
                format!("plugin notifications were not removed: {error}"),
                "INTERNAL",
            )
        })
}

/// Quota, row write and audit record in one transaction: a delivery either
/// lands with its evidence or changes nothing.
fn store(db: &Database, delivery: &Delivery) -> Result<(String, Notification)> {
    let tx = db.conn().unchecked_transaction()?;
    let now = now_ms();

    // A repeated `(pluginId, dedupeKey)` is the same notification. It takes the
    // update path because it adds no row, so it spends no budget.
    if let Some(key) = delivery.dedupe_key.as_deref() {
        if let Some(id) = find_deduplicated(&tx, &delivery.plugin_id, key)? {
            tx.prepare_cached(
                // A re-delivery must be a strictly newer version even when two
                // writes land in the same millisecond: `created_at` is the
                // version the reader and the read watermark compare, so
                // `MAX(now, old + 1)` keeps it monotonic per id.
                "UPDATE notifications
                    SET kind = ?2, title = ?3, body = ?4, link_json = ?5,
                        created_at = MAX(?6, created_at + 1), read_at = NULL
                  WHERE id = ?1",
            )?
            .execute(params![
                id,
                delivery.kind,
                delivery.title,
                delivery.body,
                delivery.link_json,
                now
            ])?;
            let notification = load(&tx, &id)?
                .ok_or_else(|| anyhow!("notification row disappeared during update"))?;
            tx.commit()?;
            return Ok((id, notification));
        }
    }

    // One budget for both kinds: counting only one of them is the bypass.
    let over_budget = deliveries_in_window(&tx, &delivery.plugin_id, now)? >= HOURLY_LIMIT;
    let id = if over_budget {
        // The folded row is the host's summary, not a plugin delivery, so it
        // adds no audit record — a flood must not grow the audit log.
        fold_into_digest(&tx, &delivery.plugin_id, now)?
    } else {
        let id = insert_delivery(&tx, delivery, now)?;
        crate::audit::append_tx(
            &tx,
            AUDIT_DELIVERED,
            None,
            json!({ "pluginId": delivery.plugin_id, "kind": delivery.kind }),
        )?;
        id
    };
    prune_oldest(&tx)?;

    let notification =
        load(&tx, &id)?.ok_or_else(|| anyhow!("notification row missing after it was written"))?;
    tx.commit()?;
    Ok((id, notification))
}

fn find_deduplicated(
    tx: &Transaction<'_>,
    plugin_id: &str,
    dedupe_key: &str,
) -> Result<Option<String>> {
    Ok(tx
        .prepare_cached("SELECT id FROM notifications WHERE plugin_id = ?1 AND dedupe_key = ?2")?
        .query_row(params![plugin_id, dedupe_key], |row| {
            row.get::<_, String>(0)
        })
        .optional()?)
}

/// Rows this plugin added inside the rolling window, read from the audit log
/// so the inbox cannot be used as a reset switch.
fn deliveries_in_window(tx: &Transaction<'_>, plugin_id: &str, now: i64) -> Result<i64> {
    let deliveries = tx
        .prepare_cached(
            "SELECT COUNT(*) FROM audit_log
              WHERE kind = ?1 AND ts >= ?2
                AND CASE WHEN json_valid(payload_json)
                         THEN json_extract(payload_json, '$.pluginId') END = ?3",
        )?
        .query_row(
            params![AUDIT_DELIVERED, now - HOURLY_WINDOW_MS, plugin_id],
            |row| row.get(0),
        )?;
    Ok(deliveries)
}

fn insert_delivery(tx: &Transaction<'_>, delivery: &Delivery, now: i64) -> Result<String> {
    let id = Uuid::new_v4().to_string();
    tx.prepare_cached(
        "INSERT INTO notifications
            (id, kind, plugin_id, title, body, link_json, dedupe_key, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(plugin_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO UPDATE SET
            kind = excluded.kind, title = excluded.title, body = excluded.body,
            link_json = excluded.link_json, created_at = excluded.created_at,
            read_at = NULL",
    )?
    .execute(params![
        id,
        delivery.kind,
        delivery.plugin_id,
        delivery.title,
        delivery.body,
        delivery.link_json,
        delivery.dedupe_key,
        now
    ])?;
    match delivery.dedupe_key.as_deref() {
        // The upsert target keeps the id it already had, so report whichever
        // row now holds the key.
        Some(key) => find_deduplicated(tx, &delivery.plugin_id, key)?
            .ok_or_else(|| anyhow!("notification row missing after insert")),
        None => Ok(id),
    }
}

/// Add one notification to this plugin's overflow digest, creating it on the
/// first fold. The row is per plugin: the reserved key is unique per
/// `plugin_id`, so one plugin's flood cannot touch another's inbox.
fn fold_into_digest(tx: &Transaction<'_>, plugin_id: &str, now: i64) -> Result<String> {
    let existing = tx
        .prepare_cached(
            "SELECT id, body FROM notifications WHERE plugin_id = ?1 AND dedupe_key = ?2",
        )?
        .query_row(params![plugin_id, RESERVED_DEDUPE_KEY], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
        })
        .optional()?;
    let (id, folded) = match existing {
        // A damaged database must not be able to panic the next fold, so the
        // counter saturates instead of overflowing.
        Some((id, body)) => (id, folded_count(body.as_deref()).saturating_add(1)),
        None => (Uuid::new_v4().to_string(), 1),
    };
    tx.prepare_cached(
        "INSERT INTO notifications
            (id, kind, plugin_id, title, body, link_json, dedupe_key, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, ?7)
         ON CONFLICT(plugin_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO UPDATE SET
            kind = excluded.kind, title = excluded.title, body = excluded.body,
            link_json = NULL,
            created_at = MAX(excluded.created_at, notifications.created_at + 1),
            read_at = NULL",
    )?
    .execute(params![
        id,
        DIGEST_KIND,
        plugin_id,
        OVERFLOW_TITLE,
        folded.to_string(),
        RESERVED_DEDUPE_KEY,
        now
    ])?;
    Ok(id)
}

fn folded_count(body: Option<&str>) -> u64 {
    body.and_then(|value| value.trim().parse::<u64>().ok())
        .unwrap_or(0)
}

/// The global cap the task and prompt rows already share: the newest
/// [`NOTIFICATION_KEEP`] rows survive whatever family they belong to.
fn prune_oldest(tx: &Transaction<'_>) -> Result<()> {
    tx.execute(
        "DELETE FROM notifications
          WHERE id IN (
            SELECT id FROM notifications
             ORDER BY created_at DESC, id DESC
             LIMIT -1 OFFSET ?1
          )",
        params![NOTIFICATION_KEEP],
    )?;
    Ok(())
}

fn load(conn: &rusqlite::Connection, id: &str) -> Result<Option<Notification>> {
    Ok(conn
        .prepare_cached(
            "SELECT id, kind, session_id, session_title, turn_id, request_id, tool_name,
                    error_code, created_at, read_at, plugin_id, title, body, link_json,
                    dedupe_key
               FROM notifications WHERE id = ?1",
        )?
        .query_row(params![id], |row| {
            Ok(Notification {
                id: row.get(0)?,
                kind: row.get(1)?,
                session_id: row.get(2)?,
                session_title: row.get(3)?,
                turn_id: row.get(4)?,
                request_id: row.get(5)?,
                tool_name: row.get(6)?,
                error_code: row.get(7)?,
                created_at: ms_to_ts(row.get(8)?),
                read_at: row.get::<_, Option<i64>>(9)?.map(ms_to_ts),
                plugin_id: row.get(10)?,
                title: row.get(11)?,
                body: row.get(12)?,
                link_json: row.get(13)?,
                dedupe_key: row.get(14)?,
            })
        })
        .optional()?)
}
