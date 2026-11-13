//! Durable task-card drafts: propose, revise, drop, and the one path that turns
//! a draft into a delivery (ADR bot-sessions-and-steward §3).
//!
//! The shape of this module follows one rule: **a confirmation is not a tool
//! call**. `TaskCard` can propose, revise and drop; only [`confirm`] freezes a
//! card and dispatches it, and the host reaches it from the desktop's IPC — the
//! click — never from the model. The model therefore cannot approve its own
//! work, and the ledger's authorization always has a person (or an explicit
//! policy rule, recorded as such) behind it.
//!
//! A confirmation compares the hash the person's screen was showing with the
//! hash stored now. That is what makes "revise then confirm" safe: a click on a
//! stale card is refused instead of approving text nobody read.

use super::repository::{self, Message};
use crate::db::{ms_to_ts, now_ms, Database};
use crate::sessions;
use anyhow::{anyhow, Result};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

/// One steward session holds at most this many drafts; the oldest proposed one
/// is evicted first, so a long conversation cannot grow without bound.
pub const MAX_DRAFTS_PER_SESSION: i64 = 50;

/// How a draft was settled. `policy` is the host's own auto-start rule; `user`
/// is a person's click. They are recorded separately so an audit can tell them
/// apart without trusting anything a caller says.
/// The ledger owner a card-based delivery is recorded under, matching the value
/// Electron main uses for its built-in session tools, so one tool's deliveries
/// are one kind of row.
pub const CARD_DELIVERY_OWNER: &str = "builtin:session-messaging";

pub const CONFIRMED_BY_USER: &str = "user";
pub const CONFIRMED_BY_POLICY: &str = "policy";

/// The stored form of one draft.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Draft {
    pub id: String,
    pub session_id: String,
    pub status: String,
    /// The normalized card, as the person was shown it.
    pub card: Value,
    /// SHA-256 of the canonical encoding of `card`; a confirmation must match.
    pub card_hash: String,
    pub source_utterance: String,
    pub target_session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confirmed_by: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confirmed_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delivery_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

const SELECT: &str = "SELECT id,session_id,status,card_json,card_hash,source_utterance,
 target_session_id,confirmed_by,confirmed_at,delivery_id,created_at,updated_at
 FROM task_card_drafts";

fn row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Draft> {
    Ok(Draft {
        id: row.get(0)?,
        session_id: row.get(1)?,
        status: row.get(2)?,
        card: serde_json::from_str(&row.get::<_, String>(3)?).unwrap_or(Value::Null),
        card_hash: row.get(4)?,
        source_utterance: row.get(5)?,
        target_session_id: row.get(6)?,
        confirmed_by: row.get(7)?,
        confirmed_at: row.get::<_, Option<i64>>(8)?.map(ms_to_ts),
        delivery_id: row.get(9)?,
        created_at: ms_to_ts(row.get(10)?),
        updated_at: ms_to_ts(row.get(11)?),
    })
}

/// SHA-256 over the card's canonical JSON.
///
/// Canonical here means one fixed key order and no incidental whitespace, so the
/// same card hashed in the renderer and in the host compares equal. It is a
/// content identity, not a signature: its only job is to prove the card a click
/// targeted is the card still stored.
pub fn card_hash(card: &Value) -> String {
    let canonical = canonical_json(card);
    let digest = Sha256::digest(canonical.as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn canonical_json(value: &Value) -> String {
    match value {
        Value::Object(map) => {
            let mut entries: Vec<(&String, &Value)> = map.iter().collect();
            entries.sort_by(|left, right| left.0.cmp(right.0));
            let body = entries
                .into_iter()
                .map(|(key, item)| {
                    format!(
                        "{}:{}",
                        serde_json::to_string(key).unwrap_or_default(),
                        canonical_json(item)
                    )
                })
                .collect::<Vec<_>>()
                .join(",");
            format!("{{{body}}}")
        }
        Value::Array(items) => format!(
            "[{}]",
            items
                .iter()
                .map(canonical_json)
                .collect::<Vec<_>>()
                .join(",")
        ),
        other => serde_json::to_string(other).unwrap_or_default(),
    }
}

pub fn get(db: &Database, draft_id: &str) -> Result<Option<Draft>> {
    Ok(db
        .conn()
        .prepare_cached(&format!("{SELECT} WHERE id=?1"))?
        .query_row(params![draft_id], row)
        .optional()?)
}

/// Every draft of one steward session, newest first.
pub fn list(db: &Database, session_id: &str) -> Result<Vec<Draft>> {
    let mut statement = db.conn().prepare_cached(&format!(
        "{SELECT} WHERE session_id=?1 ORDER BY created_at DESC,rowid DESC LIMIT ?2"
    ))?;
    let rows = statement.query_map(params![session_id, MAX_DRAFTS_PER_SESSION], row)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

fn require_text<'a>(input: &'a Value, key: &str, limit: usize) -> Result<&'a str> {
    let value = super::string(input, key, limit)?;
    Ok(value)
}

fn evict_oldest(conn: &rusqlite::Connection, session_id: &str) -> Result<()> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM task_card_drafts WHERE session_id=?1",
        params![session_id],
        |row| row.get(0),
    )?;
    // Called after the insert, so one row must go once the session is full.
    if count <= MAX_DRAFTS_PER_SESSION {
        return Ok(());
    }
    // Oldest *proposed* first: a settled draft is already part of a delivery or
    // deliberately discarded, while an open one is what the person may still act
    // on. Only when nothing is open do settled rows go, oldest first.
    conn.execute(
        "DELETE FROM task_card_drafts WHERE id IN (
           SELECT id FROM task_card_drafts WHERE session_id=?1
           ORDER BY CASE status WHEN 'proposed' THEN 0 ELSE 1 END,
                    created_at ASC, rowid ASC
           LIMIT ?2)",
        params![session_id, count - MAX_DRAFTS_PER_SESSION],
    )?;
    Ok(())
}

/// Propose a card. The card is normalized and hashed here, so the stored text is
/// exactly what a person will be shown.
pub fn propose(db: &Database, input: &Value) -> Result<Value> {
    let session_id = require_text(input, "sessionId", 256)?.to_string();
    let target = require_text(input, "targetSessionId", 256)?.to_string();
    let source_utterance = require_text(input, "sourceUtterance", 4_096)?.to_string();
    let card = input
        .get("card")
        .ok_or_else(|| anyhow!("INVALID_ARGUMENT: card required"))?
        .clone();
    // A steward cannot dispatch to itself, and the target has to be a bot: a
    // card exists to hand work to an employee, not to a casual conversation.
    if target == session_id {
        return Err(anyhow!(
            "INVALID_ARGUMENT: a card cannot target its own session"
        ));
    }
    if sessions::session_role(db, &target)?.as_deref() != Some("bot") {
        return Err(anyhow!(
            "INVALID_ARGUMENT: a task card targets an employee session"
        ));
    }
    let hash = card_hash(&card);
    let now = now_ms();
    let id = Uuid::new_v4().to_string();
    // The same card proposed again is the same draft: re-proposing must not
    // queue a second card the person has to reconcile.
    let existing: Option<Draft> = db
        .conn()
        .prepare_cached(&format!(
            "{SELECT} WHERE session_id=?1 AND card_hash=?2 AND status='proposed'"
        ))?
        .query_row(params![session_id, hash], row)
        .optional()?;
    if let Some(existing) = existing {
        return Ok(json!({"draft": existing, "created": false}));
    }
    let tx = db.conn().unchecked_transaction()?;
    tx.execute(
        "INSERT INTO task_card_drafts
         (id,session_id,status,card_json,card_hash,source_utterance,target_session_id,
          created_at,updated_at)
         VALUES (?1,?2,'proposed',?3,?4,?5,?6,?7,?7)",
        params![
            id,
            session_id,
            serde_json::to_string(&card)?,
            hash,
            source_utterance,
            target,
            now
        ],
    )?;
    evict_oldest(&tx, &session_id)?;
    tx.commit()?;
    Ok(json!({"draft": get(db, &id)?, "created": true}))
}

/// Revise a draft nobody has confirmed. A confirmed card is never rewritten:
/// widening scope is a new card.
pub fn revise(db: &Database, input: &Value) -> Result<Value> {
    let draft_id = require_text(input, "draftId", 256)?;
    let existing = get(db, draft_id)?.ok_or_else(|| anyhow!("NOT_FOUND: task card draft"))?;
    if existing.status != "proposed" {
        return Err(anyhow!(
            "CONFLICT: only a proposed card can be revised; a confirmed authorization is never rewritten"
        ));
    }
    let card = input
        .get("card")
        .ok_or_else(|| anyhow!("INVALID_ARGUMENT: card required"))?
        .clone();
    let hash = card_hash(&card);
    db.conn().execute(
        "UPDATE task_card_drafts SET card_json=?2, card_hash=?3, updated_at=?4
         WHERE id=?1 AND status='proposed'",
        params![draft_id, serde_json::to_string(&card)?, hash, now_ms()],
    )?;
    Ok(json!({"draft": get(db, draft_id)?}))
}

/// Move a proposed card to another employee (employee mode 0.5 slice 3).
///
/// Reassigning is the person's click, and it re-narrows authority: the card may
/// only ask for the narrower of what it asked for, what the steward may grant,
/// and what the new employee may do. The card's hash is recomputed because the
/// card itself changed, and the card stays **proposed** — the person still has
/// to start it, so a reassignment can never become a second, unread approval.
pub fn reassign(db: &Database, input: &Value) -> Result<Value> {
    let draft_id = require_text(input, "draftId", 256)?;
    let target = require_text(input, "targetSessionId", 256)?;
    let existing = get(db, draft_id)?.ok_or_else(|| anyhow!("NOT_FOUND: task card draft"))?;
    if existing.status != "proposed" {
        return Err(anyhow!(
            "CONFLICT: only a proposed card can be reassigned; a confirmed authorization is never moved"
        ));
    }
    if target == existing.session_id {
        return Err(anyhow!(
            "INVALID_ARGUMENT: a card cannot target its own session"
        ));
    }
    if sessions::session_role(db, &target)?.as_deref() != Some("bot") {
        return Err(anyhow!(
            "INVALID_ARGUMENT: a task card targets an employee session"
        ));
    }
    let requested = existing
        .card
        .get("permissionMode")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("INVALID_ARGUMENT: the card states no permission mode"))?;
    let sender = super::permissions::effective_mode(db, &existing.session_id)?;
    let employee = super::permissions::effective_mode(db, &target)?;
    let narrowed = super::permissions::narrower(
        &super::permissions::narrower(requested, &sender),
        &employee,
    );
    let mut card = existing.card.clone();
    card["permissionMode"] = json!(narrowed);
    let hash = card_hash(&card);
    db.conn().execute(
        "UPDATE task_card_drafts
         SET target_session_id=?2, card_json=?3, card_hash=?4, updated_at=?5
         WHERE id=?1 AND status='proposed'",
        params![draft_id, target, serde_json::to_string(&card)?, hash, now_ms()],
    )?;
    // The repository the new employee reads, and whether the card's own remote
    // can be carried there. The resolution to a real checkout runs git and
    // belongs to the RPC layer, so this only reports the warning the dock needs:
    // an employee with no repository cannot work a card that names one.
    let project_path = match super::tasks::employee_project_id(db, &target)? {
        Some(id) => db.project_path(id)?,
        None => None,
    };
    let repo_available = existing
        .card
        .pointer("/repo/origin")
        .and_then(Value::as_str)
        .is_none()
        || project_path.is_some();
    Ok(json!({
        "draft": get(db, draft_id)?,
        "projectPath": project_path,
        "repoAvailable": repo_available,
    }))
}

pub fn drop(db: &Database, input: &Value) -> Result<Value> {
    let draft_id = require_text(input, "draftId", 256)?;
    let existing = get(db, draft_id)?.ok_or_else(|| anyhow!("NOT_FOUND: task card draft"))?;
    if existing.status == "confirmed" {
        return Err(anyhow!(
            "CONFLICT: a confirmed card is already a delivery and cannot be dropped"
        ));
    }
    db.conn().execute(
        "UPDATE task_card_drafts SET status='dropped', updated_at=?2 WHERE id=?1",
        params![draft_id, now_ms()],
    )?;
    Ok(json!({"draft": get(db, draft_id)?}))
}

/// Whether the host may confirm this card by itself.
///
/// The decision is the host's, from stored facts — never from the `risk` a model
/// typed into the card. Every condition is a refusal to guess:
///
/// - the target is an employee (`role = bot`), because a person hands work to an
///   employee and nobody else;
/// - that employee has `observe` switched off, because `observe` is the
///   person's consent and a proposal alone never expresses it;
/// - the card is **read-only**: `auto` is the mode the steward asks for
///   research, reading and review, and it is the only mode that does not change
///   the workspace. A card that changes files (`accept-edits`) or that asks for
///   everything (`ask`) waits for a click, because a person starting it is the
///   only thing that makes it reviewed;
/// - the card asks for no gate beyond `deploy` / `delete` / `spend`.
///
/// That last rule needs its construction explained, because the merged card
/// *always* carries `deploy`, `delete` and `spend`: `unionMustAsk` adds them to
/// every card so nobody can switch them off. A literal "mustAsk contains none of
/// the three" test therefore never fires, and a rule that never fires is not a
/// rule. What this checks is the part a steward can vary: an `auto` card that
/// also asked for `push`, `merge` or `criteria-change` is not read-only, and it
/// waits for the person like the rest.
///
/// Returns the reason when it must not auto-start, so the caller can record it
/// rather than silently leaving the card open.
pub fn auto_start_refusal(
    db: &Database,
    target: &str,
    card: &Value,
) -> Result<Option<&'static str>> {
    if sessions::session_role(db, target)?.as_deref() != Some("bot") {
        return Ok(Some("target-not-an-employee"));
    }
    let profile = sessions::session_bot_profile(db, target)?;
    let observe = profile
        .as_ref()
        .and_then(|profile| profile.get("observe"))
        .and_then(Value::as_bool)
        .unwrap_or(true);
    if observe {
        return Ok(Some("employee-observing"));
    }
    let mode = card
        .get("permissionMode")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if mode != "auto" {
        return Ok(Some("card-changes-files"));
    }
    let asked = card
        .get("mustAsk")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .any(|action| !crate::session_collaboration::progress::ALWAYS_ASKED.contains(&action))
        })
        .unwrap_or(false);
    if asked {
        return Ok(Some("card-asks-before-acting"));
    }
    Ok(None)
}

/// Everything a confirmation needs.
pub struct ConfirmRequest<'a> {
    pub draft_id: &'a str,
    /// The hash the person's screen was showing.
    pub card_hash: &'a str,
    pub confirmed_by: &'a str,
    pub host_id: Option<&'a str>,
    pub device_id: Option<&'a str>,
    pub policy_version: &'a str,
    pub notify_on_completion: bool,
    pub idempotency_key: &'a str,
    /// The local checkout of the repository the card names, resolved by the
    /// caller from the card's normalized origin. `None` means "the employee's
    /// own project" — and is refused when the card named a repository and the
    /// employee has none.
    pub project_path: Option<&'a str>,
}

/// Freeze one draft and dispatch it, atomically.
///
/// Four things happen in one transaction, and none of them can happen alone:
/// the hash check, the freeze, the record of *how* it was confirmed, and the
/// delivery. A failure anywhere leaves the draft proposed — there is no state in
/// which a person's card is marked confirmed but nothing was dispatched.
pub fn confirm(db: &Database, request: ConfirmRequest<'_>) -> Result<Value> {
    let tx = db.conn().unchecked_transaction()?;
    let draft = tx
        .prepare_cached(&format!("{SELECT} WHERE id=?1"))?
        .query_row(params![request.draft_id], row)
        .optional()?
        .ok_or_else(|| anyhow!("NOT_FOUND: task card draft"))?;
    if draft.status == "confirmed" {
        return Err(anyhow!("CONFLICT: this card was already confirmed"));
    }
    if draft.status == "dropped" {
        return Err(anyhow!("CONFLICT: this card was dropped"));
    }
    // The card names a repository by its normalized remote. The caller resolves
    // that to a checkout on this machine; when it could not, the employee's own
    // project is the only honest fallback, and a card whose repository this
    // computer does not have is refused instead of quietly working elsewhere.
    // Only a registered project is accepted: a caller-supplied path would create
    // a phantom project row, which is the bug this resolution replaced.
    let project_path = match request.project_path {
        Some(path) => db
            .conn()
            .query_row(
                "SELECT path FROM projects WHERE path = ?1",
                params![path],
                |row| row.get::<_, String>(0),
            )
            .optional()?,
        None => None,
    };
    if project_path.is_none() {
        if let Some(origin) = draft.card.pointer("/repo/origin").and_then(Value::as_str) {
            if super::tasks::employee_project_id(db, &draft.target_session_id)?.is_none() {
                return Err(anyhow!(
                    "REPO_NOT_ON_THIS_COMPUTER: this computer has no checkout of {origin}"
                ));
            }
        }
    }
    // The click targets the card the person read. A revise between render and
    // click changes the hash, and that click must not approve new text.
    if draft.card_hash != request.card_hash {
        return Err(anyhow!(
            "CONFLICT: the card changed since it was shown; re-render it before confirming"
        ));
    }
    super::progress::validate_mandate(&serde_json::to_string(&draft.card)?)?;
    let mut requested_by = json!({
        "kind": "user",
        "hostId": request.host_id.unwrap_or("local"),
    });
    if let Some(device) = request.device_id {
        requested_by["deviceId"] = json!(device);
    }
    let mut mandate = json!({
        "version": 1,
        "taskId": Uuid::new_v4().to_string(),
        "goal": draft.card.get("goal").cloned().unwrap_or(Value::Null),
        "criteria": draft.card.get("criteria").cloned().unwrap_or(json!([])),
        "boundaries": draft.card.get("boundaries").cloned().unwrap_or(json!([])),
        "permissionMode": draft.card.get("permissionMode").cloned().unwrap_or(Value::Null),
        "mustAsk": draft.card.get("mustAsk").cloned().unwrap_or(json!([])),
        "risk": draft.card.get("risk").cloned().unwrap_or(Value::Null),
        "requestedBy": requested_by,
        "sourceUtterance": draft.source_utterance,
        "createdAt": ms_to_ts(now_ms()),
        "policyVersion": request.policy_version,
    });
    // The repository is optional on a card, so it is added only when the person
    // confirmed one; an absent key and a null key are not the same record.
    if let Some(repo) = draft.card.get("repo") {
        mandate["repo"] = repo.clone();
    }
    let message = super::send_record_on(
        db,
        &tx,
        &json!({
            "sourceSessionId": draft.session_id,
            "pluginId": CARD_DELIVERY_OWNER,
            "content": mandate["goal"],
            "kind": "task",
            "notifyOnCompletion": request.notify_on_completion,
            "idempotencyKey": request.idempotency_key,
            "mandate": mandate,
        }),
        &draft.target_session_id,
        "task",
    )?;
    tx.execute(
        "UPDATE task_card_drafts
         SET status='confirmed', confirmed_by=?2, confirmed_at=?3, delivery_id=?4, updated_at=?3
         WHERE id=?1 AND status='proposed'",
        params![draft.id, request.confirmed_by, now_ms(), message.id],
    )?;
    // Employee mode 0.5: the confirmed work belongs to a task, not to the
    // employee's own transcript (ADR bot-sessions-and-steward §7). The task is
    // created here, in the same transaction as the confirmation, so there is no
    // state in which a card is confirmed but its work has no home; the delivery
    // is then addressed to the new task session instead of the employee.
    let task = super::tasks::create_in(
        db,
        &tx,
        super::tasks::CreateRequest {
            employee_session_id: &draft.target_session_id,
            title: draft
                .card
                .get("goal")
                .and_then(Value::as_str)
                .unwrap_or_default(),
            origin: "steward",
            // `repo.origin` is a normalized git remote (`host/owner/name`), not a
            // directory: handing it to the project resolver created a phantom
            // "project" that then appeared in the person's list. The caller
            // resolves it to a real checkout (`task_workspace::project_for_origin`)
            // and passes that here; the employee's own project remains the
            // fallback, and the refusal above covers "neither exists".
            project_path,
            branch: draft
                .card
                .pointer("/repo/ref")
                .and_then(Value::as_str)
                .map(str::to_owned),
            source_utterance: Some(draft.source_utterance.clone()),
            delivery_id: Some(message.id.clone()),
        },
    )?;
    tx.execute(
        "UPDATE session_collaboration_messages SET target_session_id=?2, target_title=?3
         WHERE id=?1 AND status='queued'",
        params![message.id, task.session_id, task.title],
    )?;
    let mut message = message;
    message.target_session_id = task.session_id.clone();
    message.target_title = task.title.clone();
    // The steward has to know what happened to the card it proposed: a person's
    // click dispatched it, and this notice is the only signal it gets.
    //
    // It is written as a ledger row rather than through `send_record`: a notice
    // is not work, so it must not be re-authorized against the *worker's*
    // permission ceiling (which may be narrower than the steward's) and must not
    // be able to fail the confirmation it merely reports. It carries no
    // mandate, requests no callback, and cannot start another chain.
    let target_title: String = tx.query_row(
        "SELECT title FROM sessions WHERE id=?1",
        params![draft.target_session_id],
        |row| row.get(0),
    )?;
    let noticed_at = ms_to_ts(now_ms());
    repository::insert_on(
        &tx,
        &Message {
            id: Uuid::new_v4().to_string(),
            plugin_id: CARD_DELIVERY_OWNER.into(),
            source_session_id: draft.target_session_id.clone(),
            source_title: target_title.clone(),
            target_session_id: draft.session_id.clone(),
            target_title: draft.session_id.clone(),
            kind: "message".into(),
            content: format!(
                "card {} confirmed by {}. Dispatched to {}.",
                draft.id, request.confirmed_by, target_title
            ),
            // Already delivered: this row tells the steward what happened, and
            // nothing will ever start a turn for it. Leaving it `queued` made the
            // ledger show a task that looked stuck forever.
            status: "completed".into(),
            notify_on_completion: false,
            turn_id: None,
            reply_to_message_id: None,
            result: None,
            error: None,
            created_at: noticed_at.clone(),
            updated_at: noticed_at,
            remaining_hops: 0,
            permission_ceiling: "ask".into(),
            mandate_json: None,
            stage: None,
            report_seq: 0,
        },
        &format!("taskcard-notice:{}", draft.id),
    )?;
    tx.commit()?;
    Ok(json!({
        "draft": get(db, &draft.id)?,
        "delivery": Message::clone(&message),
        // The task the confirmed work now belongs to, so a caller can open it
        // without a second lookup.
        "task": task,
    }))
}

#[cfg(test)]
#[path = "drafts/tests.rs"]
mod tests;
