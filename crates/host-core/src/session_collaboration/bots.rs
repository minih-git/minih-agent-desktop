//! The employee surface: list, create, update, dismiss, and seed defaults
//! (ADR bot-sessions-and-steward §5).
//!
//! Everything here edits a `sessions` row's `role` and `bot_profile_json`. There
//! is no second lifecycle to keep in sync, which is the whole reason a bot is a
//! session: dismissing an employee flips the role back to `user` and the
//! conversation — with its transcript and memory — stays where it was.

use super::drafts;
use crate::db::{now_ms, Database};
use crate::sessions;
use anyhow::{anyhow, Result};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
/// The name the default crew gives the steward, and the name a person sees
/// before one exists.
///
/// It is only a default: the name lives in the employee's own
/// `bot_profile_json.name` (with `sessions.title` kept equal), the person can
/// change it in Settings → Employees, and every label that refers to this role
/// interpolates that value. `steward_name_migration` moves rows that still carry
/// the previous default to this one.
pub const STEWARD_DEFAULT_NAME: &str = "Super Agent";

/// The one employee the host ever creates by itself: the steward.
///
/// Slice 6 removed the fixed crew. A person hires the jobs they need from the
/// hiring templates, so "give me the defaults" now means exactly one thing —
/// make sure the dispatcher exists — and nothing else is created behind their
/// back. `bot.seedDefaults` keeps its name and its reply shape because the
/// renderer and the older builds call it; only what it creates changed.
pub const STEWARD_SEED: (&str, Option<&str>, &str) = (
    STEWARD_DEFAULT_NAME,
    Some("steward"),
    "Dispatch work, track it, and report back in chat.",
);

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

/// Make sure the steward exists — the only employee `bot.seedDefaults` creates
/// (employee mode 0.5 slice 6).
///
/// It keeps the old method name and the old reply shape (`created` /
/// `skipped`) because the settings page and older builds call it, but it no
/// longer creates a crew: a person hires the jobs they need from the templates.
///
/// **Nothing existing is ever touched.** The steward is identified by its
/// **role in the crew** (`definition = 'steward'`), not by its name: #254 made the
/// name the person's own, so a lookup by name would hand a renamed steward a
/// second dispatcher — two employees whose definition is `steward`, which the
/// roster then refuses to offer. A dismissed steward is a `user` session with no
/// profile, so the next call creates one again, which is what the button says.
/// No other row is read, renamed or edited.
pub fn seed_defaults(db: &Database) -> Result<Value> {
    let (name, definition, duty) = STEWARD_SEED;
    let existing: Option<Option<String>> = db
        .conn()
        .prepare_cached(
            "SELECT json_extract(bot_profile_json, '$.name') FROM sessions
              WHERE role='bot' AND deleted_at IS NULL
                AND json_extract(bot_profile_json, '$.definition') = 'steward'
              ORDER BY created_at, id LIMIT 1",
        )?
        .query_row([], |row| row.get(0))
        .optional()?;
    if let Some(current) = existing {
        // Report the name the person gave it: the reply is read by a human, and
        // "already there" about a name they never used would be confusing.
        let reported = current
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| name.to_owned());
        return Ok(json!({
            "created": [],
            "skipped": [{ "name": reported, "reason": "exists" }],
        }));
    }
    let observe = definition != Some("steward");
    let mut profile = json!({
        "name": name,
        "duty": duty,
        "permissionMode": "ask",
        "mustAsk": [],
        "observe": observe,
    });
    if let Some(definition) = definition {
        profile["definition"] = json!(definition);
    }
    let profile_json = serde_json::to_string(&sessions::normalize_bot_profile(&profile)?)?;
    let session = sessions::create_session_with_options(
        db,
        sessions::SessionCreateOptions {
            title: Some(name.into()),
            mode: Some("agent".into()),
            permission_mode: Some("ask".into()),
            role: Some("bot".into()),
            bot_profile_json: Some(profile_json),
            ..Default::default()
        },
    )?;
    Ok(json!({
        "created": [{
            "sessionId": session.id,
            "name": name,
            "definition": definition,
        }],
        "skipped": [],
    }))
}

/// The crew a steward may hand work to (employee mode 0.5 slice 3).
///
/// This is the read the steward's `Roster` tool stands on, and it exists because
/// picking an employee by guessing a session title is how the old
/// `SessionList`-based steward went wrong. One row per employee, carrying
/// exactly what a choice needs: who they are, what they are for, which model and
/// permission they run at, which repository they read, how much work they hold,
/// whether any of it is waiting on the person, and whether they are idle.
///
/// Two employees are never offered:
///
/// - the caller itself, because a card must name someone else;
/// - every other `steward` — the secretary is the one asking, not a candidate.
pub fn roster(db: &Database, input: &Value) -> Result<Value> {
    let caller = input.get("sessionId").and_then(Value::as_str);
    let mut statement = db.conn().prepare_cached(
        "SELECT id, title FROM sessions
             WHERE role='bot' AND deleted_at IS NULL
             ORDER BY updated_at DESC, id DESC LIMIT 200",
    )?;
    let rows = statement
        .query_map([], bot_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut employees = Vec::new();
    for (id, title) in rows {
        if caller == Some(id.as_str()) {
            continue;
        }
        let Some(summary) = sessions::session_summary(db, &id)? else {
            continue;
        };
        let Some(profile) = summary.bot_profile else {
            // A bot row with no usable profile is not an employee anybody can
            // dispatch to, and inventing a name would offer a choice the host
            // then refuses.
            continue;
        };
        if profile.get("definition").and_then(Value::as_str) == Some("steward") {
            continue;
        }
        let tasks = crate::tasks::employee_tasks(db, &id)?;
        let waiting = tasks
            .iter()
            .filter(|task| task.stage.starts_with("person/"))
            .count();
        let mut entry = json!({
            "sessionId": id,
            "name": profile.get("name").cloned().unwrap_or_else(|| json!(title)),
            "duty": profile.get("duty").cloned().unwrap_or(Value::Null),
            // The job this employee was hired for (slice 6). The steward has to
            // tell "who reviews" from "who researches" before she names anyone,
            // and a name like «阿福» says nothing about that.
            "definition": profile.get("definition").cloned().unwrap_or(Value::Null),
            "permissionMode": profile.get("permissionMode").cloned().unwrap_or(Value::Null),
            "observe": profile.get("observe").cloned().unwrap_or(json!(true)),
            // Reserved for the repositories an employee is responsible for. One
            // employee reads one repository today; a list here is what a later
            // multi-repository crew needs, and an empty array is the honest
            // answer until then.
            "repos": json!([]),
            "openTaskCount": tasks.len(),
            "waitingCount": waiting,
            // Idle means "holding nothing open", not "not running a turn": an
            // employee no longer runs turns of its own (ADR §7).
            "idle": tasks.is_empty(),
            "status": crate::tasks::task_status_point(&tasks),
        });
        if let Some(path) = summary.project_path {
            entry["projectPath"] = json!(path);
        }
        if let (Some(provider), Some(model)) = (summary.provider_id, summary.model_id) {
            entry["modelKey"] = json!(format!("{provider}/{model}"));
        }
        employees.push(entry);
    }
    Ok(json!({ "employees": employees }))
}

/// The drafts of one steward session, with the target's title for display.
pub fn list_drafts(db: &Database, session_id: &str) -> Result<Value> {
    let drafts = drafts::list(db, session_id)?;
    let mut out = Vec::new();
    for draft in drafts {
        let mut value = serde_json::to_value(&draft)?;
        if let Ok(title) = db.conn().query_row(
            "SELECT title FROM sessions WHERE id=?1",
            params![draft.target_session_id],
            |row| row.get::<_, String>(0),
        ) {
            value["targetTitle"] = json!(title);
        }
        out.push(value);
    }
    Ok(json!({ "drafts": out }))
}
