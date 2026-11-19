//! Durable delivery log for accepted inbound webhook requests
//! (`inbound.webhook`, schema v43 `plugin_webhook_events`).
//!
//! Electron main owns the listening socket, the path, the per-webhook token,
//! and the accepted copy of the body; the host owns the delivery record. These
//! methods are the only way that record changes, so every statement touching
//! the table lives here. No method accepts a request body, a header, or a
//! token: `bodyRef` is the host-named file the accepted copy already lives in,
//! and the token stays in the secret store. A request that carries any of them
//! is refused instead of silently ignored, so nothing sensitive can be written
//! into the table by accident.
//!
//! This surface never touches the filesystem. The accepted copy of a body is
//! Electron main's file (`<dataDir>/plugin-webhooks/<pluginId>/<eventId>.json`);
//! the methods here only read and write delivery rows and answer with the
//! `bodyRef` each removed row names, so the caller can act on the file it owns.

use anyhow::{anyhow, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::{json, Value};

use super::{plugin_session_rpc_err, rpc_err, JsonRpcError};
use crate::db::{now_ms, Database};

/// Pending events returned when the caller names no page size.
const DEFAULT_PENDING_LIMIT: i64 = 100;
/// Largest page a single replay call may ask for.
const MAX_PENDING_LIMIT: i64 = 500;
/// Largest batch one `deleteByIds` call accepts.
const MAX_DELETE_BATCH: usize = 500;
/// Plugin ids, webhook ids, and event ids are names, never paths.
const MAX_ID_CHARS: usize = 128;
/// `body_ref` is one file name inside that plugin's webhook sidecar directory.
const MAX_BODY_REF_CHARS: usize = 256;

/// Fields a caller must never send: the body copy and the token are outside
/// this table by construction (spec §4.19e).
const NEVER_ACCEPTED: &[&str] = &[
    "body",
    "bodyText",
    "bodyBase64",
    "headers",
    "token",
    "authorization",
    "cookie",
];

/// One row of the delivery log. `deliveredAt` is the acknowledgement: `null`
/// means the event is still owed to the plugin.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WebhookEvent {
    event_id: String,
    plugin_id: String,
    webhook_id: String,
    source_ip: Option<String>,
    body_ref: Option<String>,
    received_at: Option<i64>,
    delivered_at: Option<i64>,
}

fn invalid(message: impl Into<String>) -> anyhow::Error {
    anyhow!("INVALID_PARAMS: {}", message.into())
}

fn not_found(message: impl Into<String>) -> anyhow::Error {
    anyhow!("NOT_FOUND: {}", message.into())
}

fn conflict(message: impl Into<String>) -> anyhow::Error {
    anyhow!("CONFLICT: {}", message.into())
}

/// Rejects every field the method does not take. Without this a caller could
/// pass `body` or `token` and believe the host stored it; with it, the request
/// fails at the boundary and the sensitive value never reaches SQL.
fn check_only_keys(params: &Value, allowed: &[&str]) -> Result<()> {
    let object = params
        .as_object()
        .ok_or_else(|| invalid("params must be an object"))?;
    for key in object.keys() {
        if allowed.contains(&key.as_str()) {
            continue;
        }
        if NEVER_ACCEPTED.contains(&key.as_str()) {
            return Err(invalid(format!(
                "{key} is never accepted: the accepted copy and the token stay outside this table"
            )));
        }
        return Err(invalid(format!("unknown field {key}")));
    }
    Ok(())
}

/// A plugin id, a webhook id, or an event id: alphanumeric first character,
/// then alphanumeric, `-`, `_`, or `.`. Dots are allowed inside (`plugin.one`)
/// but a name made only of dots is refused so a stored value can never be a
/// directory traversal step.
fn id_param(params: &Value, key: &str) -> Result<String> {
    let raw = params
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| invalid(format!("{key} required")))?;
    if raw.chars().count() > MAX_ID_CHARS {
        return Err(invalid(format!(
            "{key} must be at most {MAX_ID_CHARS} characters"
        )));
    }
    let mut chars = raw.chars();
    let first_ok = chars
        .next()
        .is_some_and(|first| first.is_ascii_alphanumeric());
    if !first_ok
        || !chars.all(|value| value.is_ascii_alphanumeric() || matches!(value, '-' | '_' | '.'))
    {
        return Err(invalid(format!(
            "{key} must start with a letter or digit and use only a-z, 0-9, '-', '_', '.'"
        )));
    }
    if raw.trim_matches('.').is_empty() {
        return Err(invalid(format!("{key} must not be only dots")));
    }
    Ok(raw.to_string())
}

/// The event id the caller proposes, or a fresh one. A caller-supplied id keeps
/// the accept step retryable: the same request recorded twice stays one event.
fn event_id_param(params: &Value) -> Result<String> {
    match params.get("eventId") {
        None | Some(Value::Null) => Ok(uuid::Uuid::new_v4().to_string()),
        Some(_) => id_param(params, "eventId"),
    }
}

/// An optional id field: absent and `null` both mean "not given".
fn optional_id_param(params: &Value, key: &str) -> Result<Option<String>> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(_) => id_param(params, key).map(Some),
    }
}

/// The peer address, kept for diagnosis and normalized to one spelling. The
/// receiver sends `""` when the socket has no usable peer, which stores as
/// `NULL`; typed non-address values are refused.
fn source_ip_param(params: &Value) -> Result<Option<String>> {
    let Some(raw) = params.get("sourceIp") else {
        return Ok(None);
    };
    if raw.is_null() {
        return Ok(None);
    }
    let text = raw
        .as_str()
        .ok_or_else(|| invalid("sourceIp must be a string"))?
        .trim();
    if text.is_empty() {
        return Ok(None);
    }
    text.parse::<std::net::IpAddr>()
        .map(|address| Some(address.to_string()))
        .map_err(|_| invalid("sourceIp must be an IPv4 or IPv6 address"))
}

/// `body_ref` names a file Electron main wrote under
/// `<dataDir>/plugin-webhooks/<pluginId>/`, so it is a single name: no
/// separator, no parent segment, no absolute path.
fn body_ref_param(params: &Value) -> Result<Option<String>> {
    let Some(raw) = params.get("bodyRef") else {
        return Ok(None);
    };
    if raw.is_null() {
        return Ok(None);
    }
    let text = raw
        .as_str()
        .ok_or_else(|| invalid("bodyRef must be a string"))?
        .trim();
    if text.is_empty() {
        return Err(invalid("bodyRef must not be empty"));
    }
    if text.chars().count() > MAX_BODY_REF_CHARS {
        return Err(invalid(format!(
            "bodyRef must be at most {MAX_BODY_REF_CHARS} characters"
        )));
    }
    if text.contains(['/', '\\', ':'])
        || text.contains("..")
        || text.starts_with('.')
        || text.chars().any(char::is_control)
    {
        return Err(invalid(
            "bodyRef must be one file name with no separator or parent segment",
        ));
    }
    Ok(Some(text.to_string()))
}

/// An optional millisecond timestamp. `null` and absence are the same, which is
/// unlike a typed non-integer: a string is refused rather than guessed.
fn timestamp_param(params: &Value, key: &str) -> Result<Option<i64>> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value
            .as_i64()
            .filter(|ms| *ms >= 0)
            .map(Some)
            .ok_or_else(|| {
                invalid(format!(
                    "{key} must be a non-negative integer of milliseconds"
                ))
            }),
    }
}

fn limit_param(params: &Value) -> Result<i64> {
    match params.get("limit") {
        None | Some(Value::Null) => Ok(DEFAULT_PENDING_LIMIT),
        Some(value) => match value.as_i64() {
            Some(limit) if (1..=MAX_PENDING_LIMIT).contains(&limit) => Ok(limit),
            _ => Err(invalid(format!(
                "limit must be an integer between 1 and {MAX_PENDING_LIMIT}"
            ))),
        },
    }
}

fn event_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<WebhookEvent> {
    Ok(WebhookEvent {
        event_id: row.get(0)?,
        plugin_id: row.get(1)?,
        webhook_id: row.get(2)?,
        source_ip: row.get(3)?,
        body_ref: row.get(4)?,
        received_at: row.get(5)?,
        delivered_at: row.get(6)?,
    })
}

fn read_event(conn: &Connection, event_id: &str) -> Result<Option<WebhookEvent>> {
    Ok(conn
        .prepare_cached(
            "SELECT id, plugin_id, webhook_id, source_ip, body_ref, received_at, delivered_at
               FROM plugin_webhook_events
              WHERE id = ?1",
        )?
        .query_row(params![event_id], event_from_row)
        .optional()?)
}

/// `plugin.webhook.recordEvent`: keep one accepted request.
///
/// The delivery starts unacknowledged, so a request accepted just before a
/// restart is still owed to the plugin. Insert and read-back share one
/// transaction, which makes the retry case unambiguous: an id that is already
/// stored is reported as `duplicate` with the row that was kept — including an
/// acknowledgement it already carries — and an id that belongs to a different
/// plugin or webhook is a conflict instead of a silent overwrite.
fn record_event(db: &Database, params: &Value) -> Result<Value> {
    check_only_keys(
        params,
        &[
            "pluginId",
            "webhookId",
            "eventId",
            "sourceIp",
            "bodyRef",
            "receivedAt",
        ],
    )?;
    let plugin_id = id_param(params, "pluginId")?;
    let webhook_id = id_param(params, "webhookId")?;
    let event_id = event_id_param(params)?;
    let source_ip = source_ip_param(params)?;
    let body_ref = body_ref_param(params)?;
    let received_at = timestamp_param(params, "receivedAt")?.unwrap_or_else(now_ms);

    let tx = db.conn().unchecked_transaction()?;
    let inserted = tx.execute(
        "INSERT INTO plugin_webhook_events
             (id, plugin_id, webhook_id, source_ip, body_ref, received_at, delivered_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL)
         ON CONFLICT(id) DO NOTHING",
        params![
            event_id,
            plugin_id,
            webhook_id,
            source_ip,
            body_ref,
            received_at
        ],
    )?;
    let stored = read_event(&tx, &event_id)?.ok_or_else(|| {
        anyhow!("INTERNAL: accepted webhook event is missing right after its insert")
    })?;
    if inserted == 0 && (stored.plugin_id != plugin_id || stored.webhook_id != webhook_id) {
        return Err(conflict("eventId is already recorded for another webhook"));
    }
    tx.commit()?;
    Ok(json!({ "event": stored, "duplicate": inserted == 0 }))
}

/// `plugin.webhook.markDelivered`: acknowledge one event by id.
///
/// The first acknowledgement wins: a retried delivery report returns the
/// original timestamp with `delivered: false` rather than moving it, so a late
/// replay cannot rewrite when the plugin actually took the event. An unknown
/// id — or one that belongs to another plugin, when `pluginId` is given as a
/// cross-check — is `NOT_FOUND` instead of a false success.
fn mark_delivered(db: &Database, params: &Value) -> Result<Value> {
    check_only_keys(params, &["eventId", "pluginId", "deliveredAt"])?;
    let event_id = id_param(params, "eventId")?;
    let plugin_id = optional_id_param(params, "pluginId")?;
    let delivered_at = timestamp_param(params, "deliveredAt")?.unwrap_or_else(now_ms);

    let tx = db.conn().unchecked_transaction()?;
    let stored = read_event(&tx, &event_id)?.ok_or_else(|| not_found("webhook event not found"))?;
    if plugin_id
        .as_deref()
        .is_some_and(|id| id != stored.plugin_id)
    {
        return Err(not_found("webhook event not found"));
    }
    if stored
        .received_at
        .is_some_and(|received_at| delivered_at < received_at)
    {
        return Err(invalid("deliveredAt must not be earlier than receivedAt"));
    }
    let marked = tx.execute(
        "UPDATE plugin_webhook_events
            SET delivered_at = ?2
          WHERE id = ?1 AND delivered_at IS NULL",
        params![event_id, delivered_at],
    )?;
    let delivered_at = if marked == 1 {
        Some(delivered_at)
    } else {
        stored.delivered_at
    };
    tx.commit()?;
    Ok(json!({
        "eventId": event_id,
        "delivered": marked == 1,
        "deliveredAt": delivered_at,
    }))
}

/// `plugin.webhook.pending`: what is still owed to one plugin, oldest first.
///
/// `delivered_at IS NULL` is the whole replay rule: an acknowledged event never
/// comes back, and the `(plugin_id, webhook_id, delivered_at)` index answers
/// the narrow case. `hasMore` is read from one extra row, so a caller that
/// acknowledges as it drains can simply ask again until it is `false`.
fn pending(db: &Database, params: &Value) -> Result<Value> {
    check_only_keys(params, &["pluginId", "webhookId", "limit"])?;
    let plugin_id = id_param(params, "pluginId")?;
    let webhook_id = optional_id_param(params, "webhookId")?;
    let limit = limit_param(params)?;

    let mut statement = db.conn().prepare_cached(
        "SELECT id, plugin_id, webhook_id, source_ip, body_ref, received_at, delivered_at
           FROM plugin_webhook_events
          WHERE plugin_id = ?1
            AND delivered_at IS NULL
            AND (?2 IS NULL OR webhook_id = ?2)
          ORDER BY COALESCE(received_at, 0) ASC, id ASC
          LIMIT ?3",
    )?;
    let mut rows = statement.query(params![plugin_id, webhook_id, limit + 1])?;
    let mut events = Vec::new();
    while let Some(row) = rows.next()? {
        events.push(event_from_row(row)?);
    }
    let has_more = events.len() as i64 > limit;
    events.truncate(limit as usize);
    Ok(json!({ "events": events, "limit": limit, "hasMore": has_more }))
}

/// What one cleanup removed: the row's id, its owner, and the file name it
/// named. Rows only — the RPC never reads or removes the file itself. Never the
/// body, never the token.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RemovedEvent {
    event_id: String,
    plugin_id: String,
    body_ref: Option<String>,
}

/// One row's cleanup reference, or `None` when it is not there — or belongs to
/// another plugin, when `plugin_id` is given as a cross-check.
fn selected_ref(
    tx: &rusqlite::Transaction<'_>,
    event_id: &str,
    plugin_id: Option<&str>,
) -> Result<Option<RemovedEvent>> {
    Ok(tx
        .prepare_cached(
            "SELECT id, plugin_id, body_ref
               FROM plugin_webhook_events
              WHERE id = ?1 AND (?2 IS NULL OR plugin_id = ?2)",
        )?
        .query_row(params![event_id, plugin_id], |row| {
            Ok(RemovedEvent {
                event_id: row.get(0)?,
                plugin_id: row.get(1)?,
                body_ref: row.get(2)?,
            })
        })
        .optional()?)
}

/// Runs one `DELETE ... RETURNING id, plugin_id, body_ref` and collects what it
/// removed, ordered by id so the answer is stable across calls.
///
/// The delete and the reference list are one statement inside the caller's
/// transaction: the returned rows are exactly the rows that are gone, so a
/// failure before commit removes nothing and no caller is told about a row that
/// survived.
fn removed_events(
    tx: &rusqlite::Transaction<'_>,
    sql: &str,
    parameters: impl rusqlite::Params,
) -> Result<Vec<RemovedEvent>> {
    let mut statement = tx.prepare_cached(sql)?;
    let mut rows = statement.query(parameters)?;
    let mut removed = Vec::new();
    while let Some(row) = rows.next()? {
        removed.push(RemovedEvent {
            event_id: row.get(0)?,
            plugin_id: row.get(1)?,
            body_ref: row.get(2)?,
        });
    }
    removed.sort_by(|left, right| left.event_id.cmp(&right.event_id));
    Ok(removed)
}

/// `plugin.webhook.purge`: drop every event of one plugin — the uninstall path.
///
/// `webhookId` narrows it to one receiver, which is what removing a single
/// declaration needs. The delete is one statement in one transaction, and
/// `events` repeats the reference each removed row had — including rows that
/// were already acknowledged — so the caller can remove the accepted copies it
/// owns. The response shape is the one this method already sent.
fn purge(db: &Database, params: &Value) -> Result<Value> {
    check_only_keys(params, &["pluginId", "webhookId"])?;
    let plugin_id = id_param(params, "pluginId")?;
    let webhook_id = optional_id_param(params, "webhookId")?;
    let tx = db.conn().unchecked_transaction()?;
    let removed = removed_events(
        &tx,
        "DELETE FROM plugin_webhook_events
          WHERE plugin_id = ?1 AND (?2 IS NULL OR webhook_id = ?2)
        RETURNING id, plugin_id, body_ref",
        params![plugin_id, webhook_id],
    )?;
    let deleted = removed.len();
    tx.commit()?;
    Ok(json!({ "pluginId": plugin_id, "deleted": deleted, "events": removed }))
}

/// An optional absolute cutoff. Absent and `null` both mean "no cutoff"; a
/// negative or future one is refused, because a unit mix-up (seconds against
/// milliseconds) would otherwise mean "everything".
fn cutoff_param(params: &Value, key: &str) -> Result<Option<i64>> {
    let Some(value) = params.get(key).filter(|value| !value.is_null()) else {
        return Ok(None);
    };
    let cutoff = value.as_i64().filter(|ms| *ms >= 0).ok_or_else(|| {
        invalid(format!(
            "{key} must be a non-negative integer of milliseconds"
        ))
    })?;
    if cutoff > now_ms() {
        return Err(invalid(format!("{key} must not be in the future")));
    }
    Ok(Some(cutoff))
}

/// `plugin.webhook.prune`: retention by receipt time (`received_at < beforeMs`).
///
/// An event that is still owed to a live plugin is not retention garbage, so
/// only acknowledged rows are pruned by default; `includePending` is the
/// explicit opt-in for a plugin that is gone and whose deliveries nobody will
/// take. A cutoff in the future is refused: that would turn a unit mix-up into
/// "delete everything", which is a purge and has its own method.
///
/// Retention deletes rows in one statement in one transaction, so a failure
/// takes nothing, and answers with the same shape plus the references it
/// removed for the caller to act on.
fn prune(db: &Database, params: &Value) -> Result<Value> {
    check_only_keys(params, &["beforeMs", "pluginId", "includePending"])?;
    let before_ms =
        cutoff_param(params, "beforeMs")?.ok_or_else(|| invalid("beforeMs required"))?;
    let plugin_id = optional_id_param(params, "pluginId")?;
    let include_pending = match params.get("includePending") {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(_) => return Err(invalid("includePending must be a boolean")),
    };

    let tx = db.conn().unchecked_transaction()?;
    let removed = removed_events(
        &tx,
        "DELETE FROM plugin_webhook_events
          WHERE COALESCE(received_at, 0) < ?1
            AND (?2 = 1 OR delivered_at IS NOT NULL)
            AND (?3 IS NULL OR plugin_id = ?3)
        RETURNING id, plugin_id, body_ref",
        params![before_ms, include_pending, plugin_id],
    )?;
    let deleted = removed.len();
    tx.commit()?;
    Ok(json!({
        "deleted": deleted,
        "beforeMs": before_ms,
        "includePending": include_pending,
        "events": removed,
    }))
}

/// One event as `plugin.webhook.list` reports it: the reference and both
/// timestamps, so the caller can tell an owed delivery from a taken one. Never
/// the body, the headers, or the token.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ListedEvent {
    event_id: String,
    plugin_id: String,
    body_ref: Option<String>,
    received_at: Option<i64>,
    delivered_at: Option<i64>,
}

/// Where the previous page stopped: the `(receivedAt, eventId)` of its last row.
struct ListCursor {
    received_at: i64,
    event_id: String,
}

fn cursor_param(params: &Value) -> Result<Option<ListCursor>> {
    let Some(value) = params.get("cursor").filter(|value| !value.is_null()) else {
        return Ok(None);
    };
    let raw = value
        .as_str()
        .ok_or_else(|| invalid("cursor must be a string"))?;
    let (position, event_id) = raw
        .split_once(':')
        .ok_or_else(|| invalid("cursor is invalid"))?;
    let received_at = position
        .parse::<i64>()
        .map_err(|_| invalid("cursor is invalid"))?;
    let valid_id = !event_id.is_empty()
        && event_id.chars().count() <= MAX_ID_CHARS
        && event_id
            .chars()
            .all(|value| value.is_ascii_alphanumeric() || matches!(value, '-' | '_' | '.'));
    if !valid_id {
        return Err(invalid("cursor is invalid"));
    }
    Ok(Some(ListCursor {
        received_at,
        event_id: event_id.to_string(),
    }))
}

/// `plugin.webhook.list`: every event of a plugin, acknowledged or not.
///
/// One keyset page, not an offset one. The cursor is the `(receivedAt, eventId)`
/// of the last row handed out, so a caller that deletes what it just read — or a
/// cleanup running alongside it — cannot make the next page skip a row: rows
/// behind the cursor simply stop being candidates. `pluginId` and `beforeMs`
/// narrow the scan, and `beforeMs` is the same exclusive cutoff retention uses.
fn list(db: &Database, params: &Value) -> Result<Value> {
    check_only_keys(params, &["pluginId", "beforeMs", "limit", "cursor"])?;
    let plugin_id = optional_id_param(params, "pluginId")?;
    let before_ms = cutoff_param(params, "beforeMs")?;
    let limit = limit_param(params)?;
    let cursor = cursor_param(params)?;
    let after_position = cursor.as_ref().map(|cursor| cursor.received_at);
    let after_id = cursor.as_ref().map(|cursor| cursor.event_id.as_str());

    let mut statement = db.conn().prepare_cached(
        "SELECT id, plugin_id, body_ref, received_at, delivered_at,
                COALESCE(received_at, 0)
           FROM plugin_webhook_events
          WHERE (?1 IS NULL OR plugin_id = ?1)
            AND (?2 IS NULL OR COALESCE(received_at, 0) < ?2)
            AND (?3 IS NULL
                 OR COALESCE(received_at, 0) > ?3
                 OR (COALESCE(received_at, 0) = ?3 AND id > ?4))
          ORDER BY COALESCE(received_at, 0) ASC, id ASC
          LIMIT ?5",
    )?;
    let mut rows = statement.query(params![
        plugin_id,
        before_ms,
        after_position,
        after_id,
        limit + 1
    ])?;
    let mut page = Vec::new();
    while let Some(row) = rows.next()? {
        page.push((
            row.get::<_, i64>(5)?,
            ListedEvent {
                event_id: row.get(0)?,
                plugin_id: row.get(1)?,
                body_ref: row.get(2)?,
                received_at: row.get(3)?,
                delivered_at: row.get(4)?,
            },
        ));
    }
    let has_more = page.len() as i64 > limit;
    page.truncate(limit as usize);
    let next_cursor = match (has_more, page.last()) {
        (true, Some((position, event))) => Some(format!("{position}:{}", event.event_id)),
        _ => None,
    };
    let events: Vec<ListedEvent> = page.into_iter().map(|(_, event)| event).collect();
    Ok(json!({
        "events": events,
        "limit": limit,
        "hasMore": has_more,
        "nextCursor": next_cursor,
    }))
}

/// `plugin.webhook.deleteByIds`: remove exactly the events named.
///
/// The batch is 1..=500 ids: an empty list is a caller mistake rather than
/// "deleted nothing, successfully", and duplicates collapse so one id is never
/// counted twice. `pluginId` bounds the batch to one plugin, so a caller that
/// only meant its own events cannot remove another plugin's by passing a
/// foreign id — those come back in `missing`, together with ids that were never
/// recorded. The RPC deletes rows only: the caller removes the accepted copies
/// it owns first (using the `bodyRef` references in the answer), then asks for
/// the rows, and the rows go in one transaction so a failure takes none.
fn delete_by_ids(db: &Database, params: &Value) -> Result<Value> {
    check_only_keys(params, &["eventIds", "pluginId"])?;
    let plugin_id = optional_id_param(params, "pluginId")?;
    let requested = params
        .get("eventIds")
        .and_then(Value::as_array)
        .ok_or_else(|| invalid("eventIds must be an array of event ids"))?;
    if requested.is_empty() {
        return Err(invalid("eventIds must contain at least one event id"));
    }
    if requested.len() > MAX_DELETE_BATCH {
        return Err(invalid(format!(
            "eventIds must contain at most {MAX_DELETE_BATCH} ids"
        )));
    }
    let mut ids: Vec<String> = Vec::new();
    for entry in requested {
        let raw = entry
            .as_str()
            .ok_or_else(|| invalid("eventIds must contain strings"))?;
        // The insert's own rules, so a batch cannot name a value that could
        // never have been stored.
        let event_id = id_param(&json!({ "eventId": raw }), "eventId")?;
        if !ids.contains(&event_id) {
            ids.push(event_id);
        }
    }

    let tx = db.conn().unchecked_transaction()?;
    let mut removed = Vec::new();
    let mut missing = Vec::new();
    for event_id in &ids {
        let Some(row) = selected_ref(&tx, event_id, plugin_id.as_deref())? else {
            missing.push(event_id.clone());
            continue;
        };
        tx.prepare_cached("DELETE FROM plugin_webhook_events WHERE id = ?1")?
            .execute(params![event_id])?;
        removed.push(row);
    }
    tx.commit()?;
    Ok(json!({
        "deleted": removed.len(),
        "events": removed,
        "missing": missing,
    }))
}

/// Entry point for the `plugin.webhook.` prefix. Electron main stays the only
/// caller that can supply `pluginId`, and it has already checked the manifest
/// declaration and the token before either happens.
pub(super) fn handle(db: &Database, method: &str, params: Value) -> Result<Value, JsonRpcError> {
    let outcome = match method {
        "plugin.webhook.recordEvent" => record_event(db, &params),
        "plugin.webhook.markDelivered" => mark_delivered(db, &params),
        "plugin.webhook.pending" => pending(db, &params),
        "plugin.webhook.list" => list(db, &params),
        "plugin.webhook.deleteByIds" => delete_by_ids(db, &params),
        "plugin.webhook.purge" => purge(db, &params),
        "plugin.webhook.prune" => prune(db, &params),
        _ => {
            return Err(rpc_err(
                -32601,
                "unknown plugin webhook method",
                "METHOD_NOT_FOUND",
            ))
        }
    };
    outcome.map_err(plugin_session_rpc_err)
}
#[cfg(test)]
#[path = "plugin_webhook_rpc_tests.rs"]
mod tests;
