//! The roster: who the person hired and what each of them is doing.
//!
//! Split out of the `plugin_tasks` facade so the read-only view of the team
//! sits apart from the create and drive path. Nothing here writes a row, and
//! nothing here returns a prompt, a question, a task title or a report: a
//! plugin with `tasks.read` learns the shape of the person's team, not its
//! words.

use super::{required_id, LIST_MAX_LIMIT, PLUGIN_PERMISSION_MODES};
use crate::db::Database;
use anyhow::{anyhow, Result};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};

/// Rows a roster read returns when the call names no limit, matching the
/// ledger's own default.
const ROSTER_DEFAULT_LIMIT: i64 = 50;

/// One employee, as the roster and the create path read it.
pub struct Employee {
    pub id: String,
    pub name: String,
    /// What the employee was hired to do, when the profile says.
    pub duty: Option<String>,
    pub project_id: Option<i64>,
    /// The employee's own mode, resolved: `inherit` is answered from settings,
    /// so a caller never has to know that word.
    pub permission_mode: String,
}

/// Resolve a stored per-session mode the way the delivery path does.
fn resolved_mode(db: &Database, stored: Option<&str>) -> Result<String> {
    let Some(stored) = stored.map(str::trim).filter(|mode| !mode.is_empty()) else {
        // A row with no usable mode is not "wide open": it is the narrowest
        // mode the host has.
        return Ok("ask".to_string());
    };
    if stored != "inherit" {
        return Ok(stored.to_string());
    }
    Ok(db
        .get_setting("app")?
        .and_then(|settings| {
            settings
                .get("defaultPermissionMode")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .filter(|mode| mode != "inherit" && PLUGIN_PERMISSION_MODES.contains(&mode.as_str()))
        .unwrap_or_else(|| "ask".into()))
}

/// One employee, or `NOT_FOUND` for everything that is not one.
///
/// "A dismissed conversation", "an ordinary conversation" and "an id nobody
/// has" are one answer on purpose: a plugin may not learn which of them it
/// named.
pub fn employee(db: &Database, employee_id: &str) -> Result<Employee> {
    let id = required_id(employee_id, "employeeId")?;
    let row = db
        .conn()
        .prepare_cached(
            "SELECT title, role, bot_profile_json, project_id, permission_mode, deleted_at
               FROM sessions WHERE id=?1",
        )?
        .query_row(params![id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<i64>>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<i64>>(5)?,
            ))
        })
        .optional()?;
    let Some((title, role, profile_json, project_id, mode, deleted_at)) = row else {
        return Err(anyhow!("NOT_FOUND: employee"));
    };
    if deleted_at.is_some() || role != "bot" {
        return Err(anyhow!("NOT_FOUND: employee"));
    }
    // A bot row without a usable profile is not an employee the person
    // configured; it is reported as absent rather than invented.
    let profile: Value = profile_json
        .as_deref()
        .and_then(|raw| serde_json::from_str(raw).ok())
        .filter(Value::is_object)
        .ok_or_else(|| anyhow!("NOT_FOUND: employee"))?;
    let name = profile
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| title.trim().to_string());
    let duty = profile
        .get("duty")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|duty| !duty.is_empty())
        .map(str::to_owned);
    Ok(Employee {
        id: id.to_string(),
        name,
        duty,
        project_id,
        permission_mode: resolved_mode(db, mode.as_deref())?,
    })
}

/// An employee's dot and counts, derived from its open tasks.
struct Load {
    open: i64,
    waiting: i64,
    busy: bool,
}

fn employee_load(db: &Database, employee_id: &str) -> Result<Load> {
    let rows = db
        .conn()
        .prepare_cached(
            "SELECT stage, accepted_at FROM tasks
              WHERE employee_session_id=?1 AND archived_at IS NULL",
        )?
        .query_map(params![employee_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<i64>>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut load = Load {
        open: rows.len() as i64,
        waiting: 0,
        busy: false,
    };
    for (stage, accepted_at) in rows {
        match stage.as_str() {
            // An accepted task is not something the person still has to act
            // on: they already did. The same exception the employee's own dot
            // makes (`tasks::task_status_point`).
            "person/accept" if accepted_at.is_none() => load.waiting += 1,
            "person/answer" | "blocked" | "failed" => load.waiting += 1,
            "working" | "queued" | "waiting" => load.busy = true,
            _ => {}
        }
    }
    if !load.busy {
        load.busy = db
            .conn()
            .prepare_cached(
                "SELECT EXISTS(SELECT 1 FROM turns WHERE session_id=?1 AND status='running')",
            )?
            .query_row(params![employee_id], |row| row.get::<_, bool>(0))?;
    }
    Ok(load)
}

/// The roster: who the person hired, what each is doing, and how much of it is
/// waiting on them.
///
/// Nothing here is a prompt, a question, a task title or a report: a plugin
/// with `tasks.read` learns the shape of the person's team, not its words.
/// `limit` is the caller's page size, clamped to the same 1–`LIST_MAX_LIMIT`
/// range the ledger uses, so one read can never enumerate an unbounded team.
pub fn roster(db: &Database, limit: Option<i64>) -> Result<Value> {
    let limit = limit
        .unwrap_or(ROSTER_DEFAULT_LIMIT)
        .clamp(1, LIST_MAX_LIMIT);
    let employees = db
        .conn()
        .prepare_cached(
            "SELECT id FROM sessions
              WHERE role='bot' AND deleted_at IS NULL AND bot_profile_json IS NOT NULL
              ORDER BY updated_at DESC, id DESC LIMIT ?1",
        )?
        .query_map(params![limit], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut rows = Vec::with_capacity(employees.len());
    for id in employees {
        // A row whose profile stopped being usable is skipped rather than
        // shown with an invented name.
        let Ok(employee) = employee(db, &id) else {
            continue;
        };
        let load = employee_load(db, &id)?;
        let mut row = json!({
            "employeeId": employee.id,
            "name": employee.name,
            "projectId": employee.project_id,
            "permissionMode": employee.permission_mode,
            "busy": load.busy,
            "openTasks": load.open,
            "waitingOnYou": load.waiting,
        });
        if let Some(duty) = employee.duty {
            row["duty"] = json!(duty);
        }
        rows.push(row);
    }
    Ok(json!({ "employees": rows }))
}
