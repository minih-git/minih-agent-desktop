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
/// typed into the card. Three conditions must all hold, and each one is a
/// refusal to guess:
///
/// - the target is an employee (`role = bot`), because a person hands work to an
///   employee and nobody else;
/// - that employee has `observe` switched off, because `observe` is the
///   person's consent and a proposal alone never expresses it;
/// - the card's ceiling is `ask` or `accept-edits`. An `auto` card always waits
///   for a click: the widest tier is exactly the one a person should not be able
///   to acquire by accident.
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
    if !matches!(mode, "ask" | "accept-edits") {
        return Ok(Some("card-too-wide"));
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
    }))
}

#[cfg(test)]
#[path = "drafts/tests.rs"]
mod tests;
