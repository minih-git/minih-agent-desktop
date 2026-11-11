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

/// The crew a person gets when they explicitly ask for defaults. The steward is
/// the only one allowed to dispatch, and it is the only one that starts without
/// asking; every other employee begins in `observe`.
pub const DEFAULT_CREW: [(&str, Option<&str>, &str); 4] = [
    (
        "管家",
        Some("steward"),
        "Dispatch work, track it, and report back in chat.",
    ),
    (
        "Router 后端",
        None,
        "Minih-Router gateway, accounts and billing.",
    ),
    (
        "Desktop 前端",
        None,
        "Minih-Agent-Desktop renderer and desktop shell.",
    ),
    ("调研与文档", None, "Research, notes and documentation."),
];

fn string(input: &Value, key: &str, limit: usize) -> Result<String> {
    super::string(input, key, limit).map(str::to_owned)
}

/// Where an employee stands, from its latest delivery.
///
/// Only `person/*` stages are worth a person's attention, so the dot reports the
/// stage verbatim and the renderer decides emphasis. A bot with no delivery at
/// all is `idle`, which is not the same as "working".
fn status_point(db: &Database, session_id: &str) -> Result<(Value, Option<String>)> {
    let latest: Option<(String, Option<String>, String)> = db
        .conn()
        .query_row(
            "SELECT id, stage, status FROM session_collaboration_messages
             WHERE target_session_id=?1
             ORDER BY created_at DESC, rowid DESC LIMIT 1",
            params![session_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    let Some((delivery_id, stage, status)) = latest else {
        return Ok((json!({"kind": "idle"}), None));
    };
    match stage {
        Some(stage) => Ok((json!({"kind": "stage", "stage": stage}), Some(delivery_id))),
        // Never reported. A queued delivery is waiting on the machine; anything
        // settled has nothing left to show.
        None => {
            let point = match status.as_str() {
                "queued" | "running" => json!({"kind": "stage", "stage": "queued"}),
                _ => json!({"kind": "idle"}),
            };
            Ok((point, None))
        }
    }
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
        let (status, delivery) = status_point(db, &id)?;
        let mut item = json!({
            "sessionId": id,
            "title": title,
            "profile": profile,
            "status": status,
            "updatedAt": summary.updated_at,
            "createdAt": summary.created_at,
        });
        if let Some(delivery) = delivery {
            item["currentDeliveryId"] = json!(delivery);
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
    let profile_json = serde_json::to_string(&sessions::normalize_bot_profile(&merged)?)?;
    db.conn().execute(
        "UPDATE sessions SET bot_profile_json=?2, updated_at=?3 WHERE id=?1 AND role='bot'",
        params![session_id, profile_json, now_ms()],
    )?;
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

/// Create the default crew. Only ever called from an explicit user action.
pub fn seed_defaults(db: &Database) -> Result<Value> {
    let mut created = Vec::new();
    let mut skipped = Vec::new();
    for (name, definition, duty) in DEFAULT_CREW {
        let exists: bool = db.conn().query_row(
            "SELECT EXISTS(SELECT 1 FROM sessions
              WHERE role='bot' AND deleted_at IS NULL
                AND json_extract(bot_profile_json, '$.name') = ?1)",
            params![name],
            |row| row.get(0),
        )?;
        if exists {
            skipped.push(json!({"name": name, "reason": "exists"}));
            continue;
        }
        // The steward is the only employee that starts acting on its own; the
        // others record what they would do until the person turns them on.
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
        created.push(json!({
            "sessionId": session.id,
            "name": name,
            "definition": definition,
        }));
    }
    Ok(json!({ "created": created, "skipped": skipped }))
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
