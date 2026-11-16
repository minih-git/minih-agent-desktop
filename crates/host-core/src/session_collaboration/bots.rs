//! The employee surface: list, create, update, and dismiss (ADR
//! bot-sessions-and-steward §5).
//!
//! Everything here edits a `sessions` row's `role` and `bot_profile_json`. There
//! is no second lifecycle to keep in sync, which is the whole reason a bot is a
//! session: dismissing an employee flips the role back to `user` and the
//! conversation — with its transcript and memory — stays where it was.

use crate::db::{now_ms, Database};
use crate::sessions;
use anyhow::{anyhow, Result};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
fn string(input: &Value, key: &str, limit: usize) -> Result<String> {
    super::string(input, key, limit).map(str::to_owned)
}

fn bot_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<(String, String)> {
    Ok((row.get(0)?, row.get(1)?))
}

/// Every employee, newest activity first.
pub fn list(db: &Database) -> Result<Value> {
    let mut statement = db.conn().prepare_cached(
        "SELECT id, title FROM sessions
             WHERE role='bot' AND deleted_at IS NULL
             ORDER BY updated_at DESC, id DESC LIMIT 200",
    )?;
    let rows = statement
        .query_map([], bot_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut bots = Vec::new();
    for (id, title) in rows {
        let Some(summary) = sessions::session_summary(db, &id)? else {
            continue;
        };
        let Some(profile) = summary.bot_profile else {
            // A bot row without a usable profile is reported without a dot rather
            // than invented: guessing would show an employee nobody configured.
            continue;
        };
        // Work lives in tasks now (ADR bot-sessions-and-steward §7): the count
        // is how many are open, and the dot is derived from their stages.
        let open_tasks = crate::tasks::employee_tasks(db, &id)?;
        let status = crate::tasks::task_status_point(&open_tasks);
        let mut item = json!({
            "sessionId": id,
            "title": title,
            "profile": profile,
            "status": status,
            "updatedAt": summary.updated_at,
            "createdAt": summary.created_at,
        });
        if !open_tasks.is_empty() {
            item["openTaskCount"] = json!(open_tasks.len());
        }
        if let Some(path) = summary.project_path {
            item["projectPath"] = json!(path);
        }
        if let (Some(provider), Some(model)) = (summary.provider_id, summary.model_id) {
            item["modelKey"] = json!(format!("{provider}/{model}"));
        }
        bots.push(item);
    }
    Ok(json!({ "bots": bots }))
}

fn profile_of(input: &Value) -> Result<String> {
    let profile = input
        .get("profile")
        .ok_or_else(|| anyhow!("INVALID_ARGUMENT: profile required"))?;
    let normalized = sessions::normalize_bot_profile(profile)?;
    Ok(serde_json::to_string(&normalized)?)
}

/// The model an employee is hired with, from the form's `providerId/modelId`
/// key (employee mode 0.5 slice 6).
///
/// The hire form suggests a model per template and the person may keep it or
/// pick another; a new employee's session stores it, so its tasks inherit the
/// model the job was hired with (ADR §9). An absent key means "no model chosen",
/// which is every employee hired before this slice.
fn model_of(input: &Value) -> Result<(Option<String>, Option<String>)> {
    let Some(raw) = input.get("modelKey") else {
        return Ok((None, None));
    };
    let Some(key) = raw.as_str().map(str::trim).filter(|key| !key.is_empty()) else {
        return Err(anyhow!(
            "INVALID_ARGUMENT: modelKey must be a provider/model string"
        ));
    };
    let (provider, model) = key
        .split_once('/')
        .map(|(provider, model)| (provider.trim(), model.trim()))
        .unwrap_or_default();
    if provider.is_empty() || model.is_empty() {
        return Err(anyhow!(
            "INVALID_ARGUMENT: modelKey must be a provider/model string"
        ));
    }
    Ok((Some(provider.to_owned()), Some(model.to_owned())))
}

/// Create an employee, either as a new session or by promoting an existing one.
pub fn create(db: &Database, input: &Value) -> Result<Value> {
    let profile_json = profile_of(input)?;
    let profile: Value = serde_json::from_str(&profile_json)?;
    let title = profile
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("Employee")
        .to_string();
    match input.get("sessionId").and_then(Value::as_str) {
        Some(session_id) => {
            // Promotion keeps the conversation intact: only the role and the
            // profile change, so nothing the person already talked about is lost.
            let updated = db.conn().execute(
                "UPDATE sessions SET role='bot', bot_profile_json=?2, updated_at=?3
                 WHERE id=?1 AND deleted_at IS NULL",
                params![session_id, profile_json, now_ms()],
            )?;
            if updated == 0 {
                return Err(anyhow!("NOT_FOUND: session {session_id}"));
            }
            Ok(json!({ "session": sessions::session_summary(db, session_id)? }))
        }
        None => {
            let (provider_id, model_id) = model_of(input)?;
            let created = sessions::create_session_with_options(
                db,
                sessions::SessionCreateOptions {
                    title: input
                        .get("title")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                        .or(Some(title)),
                    mode: Some("agent".into()),
                    project_path: input
                        .get("projectPath")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    permission_mode: profile
                        .get("permissionMode")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    provider_id,
                    model_id,
                    role: Some("bot".into()),
                    bot_profile_json: Some(profile_json),
                    ..Default::default()
                },
            )?;
            Ok(json!({ "session": created }))
        }
    }
}

/// Edit a profile. Fields the caller omits are kept, so a rename does not reset
/// the permission mode or the consent flag.
pub fn update(db: &Database, input: &Value) -> Result<Value> {
    let session_id = string(input, "sessionId", 256)?;
    let existing = sessions::session_bot_profile(db, &session_id)?
        .ok_or_else(|| anyhow!("NOT_FOUND: no employee on session {session_id}"))?;
    let patch = input
        .get("profile")
        .ok_or_else(|| anyhow!("INVALID_ARGUMENT: profile required"))?;
    let mut merged = existing.clone();
    if let Some(object) = patch.as_object() {
        for (key, value) in object {
            merged[key] = value.clone();
        }
    }
    let normalized = sessions::normalize_bot_profile(&merged)?;
    let profile_json = serde_json::to_string(&normalized)?;
    // The name is the label every surface shows, and the session title is the
    // same label: renaming the employee must not leave the sidebar and the task
    // card showing two different names for one person.
    let name = normalized
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let tx = db.conn().unchecked_transaction()?;
    tx.execute(
        "UPDATE sessions SET bot_profile_json=?2, title=?3, updated_at=?4
         WHERE id=?1 AND role='bot'",
        params![session_id, profile_json, name, now_ms()],
    )?;
    // The project is what the employee reads when it runs, so binding one is
    // part of editing the employee. `null` or blank clears the binding; an
    // absent key keeps the row's value, like every other patchable field here.
    //
    // A session stores `project_id`, not a path, so this resolves through the
    // same upsert-by-path the session create path uses (`ensure_project`).
    if let Some(project) = input.get("projectPath") {
        let path = match project {
            Value::Null => None,
            Value::String(path) if path.trim().is_empty() => None,
            Value::String(path) => Some(path.trim().to_owned()),
            _ => {
                return Err(anyhow!(
                    "INVALID_ARGUMENT: projectPath must be a string or null"
                ))
            }
        };
        let project_id = match path {
            Some(path) => Some(db.ensure_project(&path, false)?),
            None => None,
        };
        tx.execute(
            "UPDATE sessions SET project_id=?2, updated_at=?3 WHERE id=?1 AND role='bot'",
            params![session_id, project_id, now_ms()],
        )?;
    }
    tx.commit()?;
    Ok(json!({ "session": sessions::session_summary(db, &session_id)? }))
}

/// Dismiss an employee: the role goes back to `user` and the conversation stays.
pub fn dismiss(db: &Database, input: &Value) -> Result<Value> {
    let session_id = string(input, "sessionId", 256)?;
    let changed = db.conn().execute(
        "UPDATE sessions SET role='user', bot_profile_json=NULL, updated_at=?2
         WHERE id=?1 AND role='bot'",
        params![session_id, now_ms()],
    )?;
    if changed == 0 {
        return Err(anyhow!("NOT_FOUND: no employee on session {session_id}"));
    }
    Ok(json!({ "session": sessions::session_summary(db, &session_id)? }))
}

/// The employee a **task session** belongs to, and the profile it runs as
/// (employee mode 0.5 slice 6).
///
/// A task's own session carries no profile: the role lives on the employee, so
/// this is the one read Main needs before it can run a task under its role.
/// `employee: null` means the session is not a task's own session — the honest
/// answer, not an empty employee.
pub fn for_task_session(db: &Database, input: &Value) -> Result<Value> {
    let session_id = string(input, "sessionId", 256)?;
    let employee_id: Option<String> = db
        .conn()
        .prepare_cached("SELECT employee_session_id FROM tasks WHERE session_id=?1")?
        .query_row(params![session_id], |row| row.get(0))
        .optional()?;
    let Some(employee_id) = employee_id else {
        return Ok(json!({ "employee": Value::Null }));
    };
    let profile = sessions::session_bot_profile(db, &employee_id)?;
    Ok(json!({
        "employee": { "sessionId": employee_id, "profile": profile }
    }))
}
