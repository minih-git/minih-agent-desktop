//! The redacted task ledger: the person's tasks, and where they stand.
//!
//! Split out of the `plugin_tasks` facade so every read-only projection of a
//! task row lives in one place, beside the roster read. Everything here is a
//! query: none of it creates, drives or archives a task, and none of it
//! returns a field that would leak what a person asked for.

use super::{required_id, LIST_MAX_LIMIT};
use crate::db::Database;
use anyhow::{anyhow, Result};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};

/// Rows a ledger read returns when the call names no limit, and its cap.
const LIST_DEFAULT_LIMIT: i64 = 50;

/// One redacted ledger row: what a task is, never what it says.
///
/// The field set is the plugin SDK's `PluginTaskSummary` exactly — no
/// `sourceUtterance`, no waiting question, no progress, report or blocker.
struct LedgerRow {
    id: String,
    title: String,
    stage: String,
    origin: String,
    plugin_id: Option<String>,
    session_id: String,
    employee_id: String,
    project_id: Option<i64>,
    created_at: i64,
    archived_at: Option<i64>,
    rowid: i64,
}

impl LedgerRow {
    fn to_json(&self) -> Value {
        json!({
            "taskId": self.id,
            "title": self.title,
            "stage": self.stage,
            "origin": self.origin,
            "pluginId": self.plugin_id,
            "sessionId": self.session_id,
            "employeeId": self.employee_id,
            "projectId": self.project_id,
            "createdAt": self.created_at,
            "archivedAt": self.archived_at,
        })
    }

    fn cursor(&self) -> String {
        format!("{}:{}", self.created_at, self.rowid)
    }
}

const LEDGER_SELECT: &str = "SELECT t.id, t.title, t.stage, t.origin, t.plugin_id,
        t.session_id, t.project_id, t.created_at, t.archived_at, t.rowid, t.employee_session_id
   FROM tasks t";

fn ledger_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<LedgerRow> {
    Ok(LedgerRow {
        id: row.get(0)?,
        title: row.get(1)?,
        stage: row.get(2)?,
        origin: row.get(3)?,
        plugin_id: row.get(4)?,
        session_id: row.get(5)?,
        project_id: row.get(6)?,
        created_at: row.get(7)?,
        archived_at: row.get(8)?,
        rowid: row.get(9)?,
        employee_id: row.get(10)?,
    })
}
/// The keyset position of a page, `"<createdAtMs>:<rowid>"`.
fn parse_cursor(raw: &str) -> Result<(i64, i64)> {
    let (created_at, rowid) = raw
        .split_once(':')
        .ok_or_else(|| anyhow!("INVALID_ARGUMENT: cursor"))?;
    Ok((
        created_at
            .trim()
            .parse::<i64>()
            .map_err(|_| anyhow!("INVALID_ARGUMENT: cursor"))?,
        rowid
            .trim()
            .parse::<i64>()
            .map_err(|_| anyhow!("INVALID_ARGUMENT: cursor"))?,
    ))
}

/// The ledger: every task of the person's employees, newest first, redacted.
pub struct LedgerQuery<'a> {
    pub limit: Option<i64>,
    pub cursor: Option<&'a str>,
}

/// One page of the redacted ledger.
///
/// Read-only over the roster, which is what `tasks.read` means: the plugin sees
/// that work exists and where it stands, and none of the fields that would leak
/// what a person asked for — no `sourceUtterance`, no `waiting` (a question's
/// text lives there), no progress, report or blocker.
pub fn list(db: &Database, query: LedgerQuery<'_>) -> Result<Value> {
    let limit = query
        .limit
        .unwrap_or(LIST_DEFAULT_LIMIT)
        .clamp(1, LIST_MAX_LIMIT);
    let cursor = query.cursor.map(parse_cursor).transpose()?;
    let (has_cursor, boundary, rowid) = match cursor {
        Some((created_at, rowid)) => (1_i64, created_at, rowid),
        None => (0_i64, 0_i64, 0_i64),
    };
    let mut rows = db
        .conn()
        .prepare_cached(&format!(
            "{LEDGER_SELECT}
              WHERE (?1 = 0 OR t.created_at < ?2 OR (t.created_at = ?2 AND t.rowid < ?3))
              ORDER BY t.created_at DESC, t.rowid DESC
              LIMIT ?4"
        ))?
        .query_map(params![has_cursor, boundary, rowid, limit + 1], ledger_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    // One row past the page is the only honest answer to "is there more".
    let more = rows.len() as i64 > limit;
    rows.truncate(limit as usize);
    let next_cursor = if more {
        rows.last().map(LedgerRow::cursor)
    } else {
        None
    };
    Ok(json!({
        "tasks": rows.iter().map(LedgerRow::to_json).collect::<Vec<_>>(),
        "nextCursor": next_cursor,
    }))
}

/// One row of the ledger, for a task this plugin created.
///
/// A task this plugin did not create answers `NOT_FOUND`, not
/// `PERMISSION_DENIED`: the call must not become a way to learn that somebody
/// else's task exists. The answer is the row itself, the same shape `list`
/// returns, so the caller has one type to read.
pub fn get(db: &Database, plugin_id: &str, task_id: &str) -> Result<Value> {
    let plugin_id = required_id(plugin_id, "pluginId")?;
    let task_id = required_id(task_id, "taskId")?;
    let row = db
        .conn()
        .prepare_cached(&format!("{LEDGER_SELECT} WHERE t.id=?1 AND t.plugin_id=?2"))?
        .query_row(params![task_id, plugin_id], ledger_row)
        .optional()?
        .ok_or_else(|| anyhow!("NOT_FOUND: task"))?;
    Ok(row.to_json())
}

/// Which plugin created a task — the host's own reading, for wiring an event to
/// the plugin that owns the work.
///
/// It answers for any task, including one no plugin created (`null`), so the
/// caller needs no second lookup; a task that does not exist is `NOT_FOUND`.
pub fn owner(db: &Database, task_id: &str) -> Result<Value> {
    let task_id = required_id(task_id, "taskId")?;
    let plugin_id: Option<Option<String>> = db
        .conn()
        .prepare_cached("SELECT plugin_id FROM tasks WHERE id=?1")?
        .query_row(params![task_id], |row| row.get::<_, Option<String>>(0))
        .optional()?;
    let Some(plugin_id) = plugin_id else {
        return Err(anyhow!("NOT_FOUND: task"));
    };
    Ok(json!({ "pluginId": plugin_id }))
}
