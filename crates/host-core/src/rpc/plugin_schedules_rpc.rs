//! Plugin timer bookkeeping (`plugin_schedules`) RPC.
//!
//! The host owns this table: it records what it last knew about one declared
//! timer — `last_run_at`, `last_ok`, `attempts`, `paused` — never the
//! declaration itself, which stays in the manifest (`contributes.schedules`).
//! Electron Main calls these methods after each fire so the state survives a
//! restart, and when a plugin is uninstalled or one of its timers is dropped so
//! an undeclared timer cannot keep a row.
//!
//! Methods (params are camelCase, times are epoch milliseconds):
//!
//! | method | params | result |
//! | --- | --- | --- |
//! | `plugins.schedules.list` | – | `{ schedules: [ row ] }` |
//! | `plugins.schedules.update` | `{ pluginId, scheduleId, lastRunAt?, lastOk?, attempts?, paused? }` | `{ schedule: row }` |
//! | `plugins.schedules.delete` | `{ pluginId, scheduleId }` | `{ deleted }` |
//! | `plugins.schedules.clear` | `{ pluginId }` | `{ deleted }` |
//! | `plugins.schedules.reconcile` | – | `{ removedPlugins: [ pluginId ] }` |
//!
//! A `row` is `{ pluginId, scheduleId, lastRunAt, lastOk, attempts, paused }`.
//! In `update` an omitted field keeps its stored value and an explicit `null`
//! clears `lastRunAt` / `lastOk` — `lastOk: null` means no completed result for
//! the latest attempt, including an attempt still in progress. `attempts`
//! (consecutive failures) and `paused` have no cleared state and reject `null`;
//! an unwritten row reads them as `0` / `false`. Updates require an installed,
//! enabled plugin with the scheduler grant, so late results cannot recreate a
//! row after uninstall or mutate a disabled plugin.

use rusqlite::OptionalExtension;

use super::{json, rpc_err, AppState, JsonRpcError, Value};

/// Longest id accepted from the client. Plugin and schedule ids come from a
/// manifest and are short; the bound only keeps a malformed request from
/// becoming a query argument of arbitrary size.
const MAX_ID_CHARS: usize = 256;

/// One `plugin_schedules` row, in the shape both the database and the wire use.
#[derive(Debug, Clone, PartialEq, Eq)]
struct ScheduleRow {
    plugin_id: String,
    schedule_id: String,
    last_run_at: Option<i64>,
    last_ok: Option<bool>,
    attempts: i64,
    paused: bool,
}

impl ScheduleRow {
    fn to_json(&self) -> Value {
        json!({
            "pluginId": self.plugin_id,
            "scheduleId": self.schedule_id,
            "lastRunAt": self.last_run_at,
            "lastOk": self.last_ok,
            "attempts": self.attempts,
            "paused": self.paused,
        })
    }
}

/// One nullable column an `update` may set, clear, or leave alone.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Column<T> {
    Keep,
    Clear,
    Value(T),
}

const SELECT_COLUMNS: &str = "plugin_id, schedule_id, last_run_at, last_ok, attempts, paused";

/// One statement writes the row and merges a partial request into it. `?7` and
/// `?8` say whether `lastRunAt` / `lastOk` were present at all, so an omitted
/// field can never overwrite a stored one while a present `null` still clears
/// it. `attempts` and `paused` need no such flag: they have no cleared state,
/// so `COALESCE` keeps the stored value when they are absent and starts a new
/// row at zero, which is what the schema defaults say.
const UPSERT_SQL: &str = r#"
INSERT INTO plugin_schedules (plugin_id, schedule_id, last_run_at, last_ok, attempts, paused)
VALUES (?1, ?2, ?3, ?4, COALESCE(?5, 0), COALESCE(?6, 0))
ON CONFLICT(plugin_id, schedule_id) DO UPDATE SET
  last_run_at = CASE WHEN ?7 = 1 THEN excluded.last_run_at ELSE plugin_schedules.last_run_at END,
  last_ok     = CASE WHEN ?8 = 1 THEN excluded.last_ok     ELSE plugin_schedules.last_ok     END,
  attempts    = COALESCE(?5, plugin_schedules.attempts),
  paused      = COALESCE(?6, plugin_schedules.paused)
"#;

pub(super) fn handle(st: &AppState, method: &str, params: Value) -> Result<Value, JsonRpcError> {
    match method {
        "plugins.schedules.list" => list(st),
        "plugins.schedules.update" => update(st, &params),
        "plugins.schedules.delete" => delete(st, &params),
        "plugins.schedules.clear" => clear(st, &params),
        "plugins.schedules.reconcile" => reconcile(st),
        _ => Err(rpc_err(
            -32601,
            "unknown plugin schedule method",
            "METHOD_NOT_FOUND",
        )),
    }
}

/// Every row, ordered so two reads of the same state match.
fn list(st: &AppState) -> Result<Value, JsonRpcError> {
    let conn = st.db.conn();
    let mut statement = conn
        .prepare_cached(&format!(
            "SELECT {SELECT_COLUMNS} FROM plugin_schedules ORDER BY plugin_id, schedule_id"
        ))
        .map_err(internal)?;
    let rows = statement
        .query_map([], map_row)
        .map_err(internal)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(internal)?;
    Ok(json!({
        "schedules": rows.iter().map(ScheduleRow::to_json).collect::<Vec<_>>(),
    }))
}

/// Compare against the registry while the RPC state lock is held, so a
/// concurrent plugin install cannot race the cleanup decision.
fn reconcile(st: &AppState) -> Result<Value, JsonRpcError> {
    let installed: std::collections::HashSet<String> = st
        .plugins
        .list()
        .into_iter()
        .map(|plugin| plugin.id)
        .collect();
    let conn = st.db.conn();
    let existing = {
        let mut statement = conn
            .prepare("SELECT DISTINCT plugin_id FROM plugin_schedules")
            .map_err(internal)?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(internal)?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(internal)?
    };
    let mut removed = Vec::new();
    for plugin_id in existing {
        if !installed.contains(&plugin_id) {
            conn.execute(
                "DELETE FROM plugin_schedules WHERE plugin_id = ?1",
                [&plugin_id],
            )
            .map_err(internal)?;
            removed.push(plugin_id);
        }
    }
    Ok(json!({ "removedPlugins": removed }))
}

/// Write one timer's attempt state, creating the row when the timer has none.
fn update(st: &AppState, params: &Value) -> Result<Value, JsonRpcError> {
    let plugin_id = id_param(params, "pluginId")?;
    let schedule_id = id_param(params, "scheduleId")?;
    let last_run_at = nullable_millis_column(params, "lastRunAt")?;
    let last_ok = nullable_flag_column(params, "lastOk")?;
    let attempts = count_param(params, "attempts")?;
    let paused = flag_param(params, "paused")?;
    let plugin = st
        .plugins
        .get(&plugin_id)
        .ok_or_else(|| rpc_err(1007, "schedule plugin is not installed", "NOT_FOUND"))?;
    if !plugin.enabled
        || !plugin
            .permissions
            .iter()
            .any(|permission| permission == "scheduler")
    {
        return Err(rpc_err(
            1003,
            "schedule plugin is disabled or lacks scheduler permission",
            "PERMISSION_DENIED",
        ));
    }

    st.db
        .conn()
        .execute(
            UPSERT_SQL,
            rusqlite::params![
                plugin_id,
                schedule_id,
                match last_run_at {
                    Column::Value(ms) => Some(ms),
                    _ => None,
                },
                match last_ok {
                    Column::Value(ok) => Some(i64::from(ok)),
                    _ => None,
                },
                attempts,
                paused.map(i64::from),
                i64::from(!matches!(last_run_at, Column::Keep)),
                i64::from(!matches!(last_ok, Column::Keep)),
            ],
        )
        .map_err(internal)?;

    let row = read_row(st, &plugin_id, &schedule_id)?
        .ok_or_else(|| rpc_err(1000, "plugin schedule row vanished", "INTERNAL"))?;
    Ok(json!({ "schedule": row.to_json() }))
}

/// Drop one timer's row. A row that is already gone is not an error: the
/// caller's intent — "this timer has no state" — holds either way.
fn delete(st: &AppState, params: &Value) -> Result<Value, JsonRpcError> {
    let plugin_id = id_param(params, "pluginId")?;
    let schedule_id = id_param(params, "scheduleId")?;
    let deleted = st
        .db
        .conn()
        .execute(
            "DELETE FROM plugin_schedules WHERE plugin_id = ?1 AND schedule_id = ?2",
            rusqlite::params![plugin_id, schedule_id],
        )
        .map_err(internal)?;
    Ok(json!({ "deleted": deleted }))
}

/// Drop every row of one plugin: the timers it no longer declares, or all of
/// them when it is uninstalled. Disabling a plugin preserves its rows.
fn clear(st: &AppState, params: &Value) -> Result<Value, JsonRpcError> {
    let plugin_id = id_param(params, "pluginId")?;
    let deleted = clear_for_plugin(st, &plugin_id)?;
    Ok(json!({ "deleted": deleted }))
}

pub(super) fn clear_for_plugin(st: &AppState, plugin_id: &str) -> Result<usize, JsonRpcError> {
    st.db
        .conn()
        .execute(
            "DELETE FROM plugin_schedules WHERE plugin_id = ?1",
            rusqlite::params![plugin_id],
        )
        .map_err(internal)
}

fn read_row(
    st: &AppState,
    plugin_id: &str,
    schedule_id: &str,
) -> Result<Option<ScheduleRow>, JsonRpcError> {
    st.db
        .conn()
        .prepare_cached(&format!(
            "SELECT {SELECT_COLUMNS} FROM plugin_schedules
              WHERE plugin_id = ?1 AND schedule_id = ?2"
        ))
        .map_err(internal)?
        .query_row(rusqlite::params![plugin_id, schedule_id], map_row)
        .optional()
        .map_err(internal)
}

/// A row the host itself wrote; `attempts` / `paused` are read as their
/// defaults when the column is still empty, matching what `update` reports.
fn map_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ScheduleRow> {
    Ok(ScheduleRow {
        plugin_id: row.get(0)?,
        schedule_id: row.get(1)?,
        last_run_at: row.get(2)?,
        last_ok: row.get::<_, Option<i64>>(3)?.map(|value| value != 0),
        attempts: row.get::<_, Option<i64>>(4)?.unwrap_or(0),
        paused: row.get::<_, Option<i64>>(5)?.unwrap_or(0) != 0,
    })
}

fn internal(error: impl ToString) -> JsonRpcError {
    rpc_err(1000, error.to_string(), "INTERNAL")
}

fn id_param(params: &Value, key: &str) -> Result<String, JsonRpcError> {
    params
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty() && id.chars().count() <= MAX_ID_CHARS)
        .map(str::to_string)
        .ok_or_else(|| {
            rpc_err(
                1002,
                format!("{key} must be 1 to {MAX_ID_CHARS} characters"),
                "INVALID_PARAMS",
            )
        })
}

fn nullable_millis_column(params: &Value, key: &str) -> Result<Column<i64>, JsonRpcError> {
    match params.get(key) {
        None => Ok(Column::Keep),
        Some(Value::Null) => Ok(Column::Clear),
        Some(value) => value
            .as_i64()
            .filter(|ms| *ms >= 0)
            .map(Column::Value)
            .ok_or_else(|| {
                rpc_err(
                    1002,
                    format!("{key} must be a non-negative epoch millisecond integer or null"),
                    "INVALID_PARAMS",
                )
            }),
    }
}

fn nullable_flag_column(params: &Value, key: &str) -> Result<Column<bool>, JsonRpcError> {
    match params.get(key) {
        None => Ok(Column::Keep),
        Some(Value::Null) => Ok(Column::Clear),
        Some(Value::Bool(flag)) => Ok(Column::Value(*flag)),
        Some(_) => Err(rpc_err(
            1002,
            format!("{key} must be a boolean or null"),
            "INVALID_PARAMS",
        )),
    }
}

fn flag_param(params: &Value, key: &str) -> Result<Option<bool>, JsonRpcError> {
    match params.get(key) {
        None => Ok(None),
        Some(Value::Bool(flag)) => Ok(Some(*flag)),
        Some(_) => Err(rpc_err(
            1002,
            format!("{key} must be a boolean"),
            "INVALID_PARAMS",
        )),
    }
}

fn count_param(params: &Value, key: &str) -> Result<Option<i64>, JsonRpcError> {
    match params.get(key) {
        None => Ok(None),
        Some(value) => value
            .as_i64()
            .filter(|count| *count >= 0)
            .map(Some)
            .ok_or_else(|| {
                rpc_err(
                    1002,
                    format!("{key} must be a non-negative integer"),
                    "INVALID_PARAMS",
                )
            }),
    }
}

#[cfg(test)]
#[path = "plugin_schedules_rpc_tests.rs"]
mod tests;
