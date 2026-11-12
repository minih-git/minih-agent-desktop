//! Durable provenance, idempotent delivery and turn-bound outcomes. Execution
//! remains owned by Agent Host; this module never starts a runtime.
use anyhow::{anyhow, Result};
use rusqlite::params;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{
    db::{ms_to_ts, now_ms, Database},
    sessions,
};
pub mod bots;
pub mod task_api;
pub(crate) use crate::tasks;
pub mod drafts;
mod permissions;
pub mod progress;
mod projections;
mod provenance;
pub(crate) mod repository;
mod settlement;
pub use provenance::{prepare_append, validate_replacement};
pub use repository::{get, Message};
pub use settlement::{begin_turn, recover, settle_turn};
pub const SCHEMA: &str = include_str!("schema.sql");

pub(super) fn string<'a>(input: &'a Value, key: &str, limit: usize) -> Result<&'a str> {
    let value = input
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow!("INVALID_ARGUMENT: {key} required"))?;
    if value.chars().count() > limit {
        return Err(anyhow!("LIMIT_EXCEEDED: {key} too long"));
    }
    Ok(value)
}

fn send_record(db: &Database, input: &Value, target: &str, kind: &str) -> Result<Message> {
    send_record_on(db, db.conn(), input, target, kind)
}

/// The one delivery write, reachable from a sibling module's tests without
/// re-opening the plugin round trip that normally produces it.
#[cfg(test)]
pub(crate) fn dispatch_send_for_test(
    db: &Database,
    input: &Value,
    target: &str,
    kind: &str,
) -> Result<Message> {
    send_record(db, input, target, kind)
}

/// The one delivery path, usable inside a caller's transaction.
///
/// A confirmation writes the delivery and the draft's own state in one
/// transaction (ADR bot-sessions-and-steward §3), so this takes the connection
/// the caller already opened instead of starting a second one.
fn send_record_on(
    db: &Database,
    conn: &rusqlite::Connection,
    input: &Value,
    target: &str,
    kind: &str,
) -> Result<Message> {
    let source = string(input, "sourceSessionId", 256)?;
    let plugin = string(input, "pluginId", 256)?;
    let content = string(input, "content", 65_536)?;
    let key = string(input, "idempotencyKey", 256)?;
    let notify = input
        .get("notifyOnCompletion")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    if let Some(existing) = repository::existing(db, plugin, source, key)? {
        if existing.target_session_id != target
            || existing.content != content
            || existing.kind != kind
            || existing.notify_on_completion != notify
        {
            return Err(anyhow!(
                "IDEMPOTENCY_CONFLICT: key was already used for another message"
            ));
        }
        return Ok(existing);
    }
    if source == target {
        return Err(anyhow!(
            "INVALID_ARGUMENT: cannot send a session message to itself"
        ));
    }
    if sessions::session_mode(db, source)?.as_deref() != Some("agent")
        || sessions::session_mode(db, target)?.as_deref() != Some("agent")
    {
        return Err(anyhow!(
            "PERMISSION_DENIED: session communication requires Agent mode"
        ));
    }
    // The mandate travels with the delivery, never as a second call: a card a
    // person confirmed is the authorization of this exact task, so a delivery
    // that arrives authorized and one that is authorized afterwards must not be
    // two different states of the ledger (ADR bot-sessions-and-steward §3).
    let mandate_json = match input.get("mandate") {
        None | Some(Value::Null) => None,
        Some(value) => {
            let encoded = match value {
                Value::String(raw) => raw.clone(),
                other => other.to_string(),
            };
            progress::validate_mandate(&encoded)?;
            Some(encoded)
        }
    };
    // A confirmed card is a ceiling of its own: the delivery may only be as
    // permissive as the *narrower* of what the sender may grant and what the
    // person confirmed. Without this, a `ask` card would dispatch under the
    // steward's `auto` and the person's choice would be silently ignored.
    let sender_ceiling = permissions::effective_mode(db, source)?;
    let permission_ceiling = match mandate_json.as_deref() {
        Some(encoded) => permissions::narrower(
            &sender_ceiling,
            &progress::mandate_permission_mode(encoded)?,
        ),
        None => sender_ceiling,
    };
    permissions::check_target(db, target, &permission_ceiling)?;
    // Work delivered to an employee needs an authorization (ADR
    // bot-sessions-and-steward §3): either the confirmed card travelling with
    // this delivery, or a follow-up that names a task already dispatched to
    // that same bot and still running. Without this a steward could skip the
    // card entirely and hand work to a bot as if it were a plain conversation.
    if sessions::session_role(db, target)?.as_deref() == Some("bot") {
        match mandate_json.as_deref() {
            Some(_) => {}
            None => match input.get("taskId").and_then(Value::as_str) {
                Some(task) => repository::require_open_task(db, task, target)?,
                None => {
                    return Err(anyhow!(
                        "MANDATE_REQUIRED: a delivery to a bot needs a confirmed task card or the task it continues"
                    ))
                }
            },
        }
    }
    let pending: i64 = conn.query_row(
        "SELECT COUNT(*) FROM session_collaboration_messages
        WHERE target_session_id=?1 AND status='queued'",
        params![target],
        |row| row.get(0),
    )?;
    if pending >= 8 {
        return Err(anyhow!("AGENT_BUSY: target session inbox is full"));
    }
    let at = ms_to_ts(now_ms());
    let message = Message {
        id: Uuid::new_v4().to_string(),
        plugin_id: plugin.into(),
        source_session_id: source.into(),
        source_title: repository::title(db, source)?,
        target_session_id: target.into(),
        target_title: repository::title(db, target)?,
        kind: kind.into(),
        content: content.into(),
        status: "queued".into(),
        notify_on_completion: notify,
        turn_id: None,
        reply_to_message_id: None,
        result: None,
        error: None,
        created_at: at.clone(),
        updated_at: at,
        remaining_hops: repository::remaining_hops(
            db,
            source,
            input.get("sourceTurnId").and_then(Value::as_str),
        )?,
        permission_ceiling,
        mandate_json,
        stage: None,
        report_seq: 0,
    };
    repository::insert_on(conn, &message, key)?;
    Ok(message)
}

/// What a derived session takes from the session that creates it.
pub(super) struct SpawnRequest<'a> {
    /// The session whose configuration is inherited.
    pub source: &'a str,
    pub title: String,
    /// An explicit override; absent means the source's own binding is kept.
    pub provider_id: Option<String>,
    pub model_id: Option<String>,
    /// `None` for a worker: a worker inherits configuration, never an identity.
    pub role: Option<String>,
    /// The repository the child works in, when the work names one.
    ///
    /// Absent means "the source session's project", which is what a worker
    /// wants. A task passes the project it resolved, because the repository a
    /// task was given *is* the one its work must run in: the runtime reads the
    /// workspace from the session row, so leaving the parent's project there
    /// would make the choice display-only.
    pub project_path: Option<String>,
}

/// Create a child of an existing session, and inherit exactly what a child may.
///
/// This is the one place a derived session is created, shared by the plugin's
/// worker `spawn` and by a task created under an employee (ADR
/// bot-sessions-and-steward §7). The rule is the same in both directions:
///
/// - **inherited**: mode (`agent`), project, thinking level, and the permission
///   mode of the source session — a child never starts wider than its parent,
///   and never wider than what the source already had to be allowed to do;
/// - **overridden by the caller**: provider, model, and the project, when the
///   request names them — the source may have no model bound at all, and a task
///   works in the repository it was given rather than in the employee's own;
/// - **not inherited**: an employee's `role`/`botProfile` and its transcript.
///   A child is a session in its own right; copying an identity would make two
///   rows claim to be the same employee.
///
/// The caller owns the transaction and the surrounding bookkeeping (a worker's
/// link row, or the task row), so a failure there rolls the session back too.
pub(super) fn spawn_session(
    db: &Database,
    request: SpawnRequest<'_>,
) -> Result<sessions::SessionSummary> {
    let parent = sessions::get_session_with_options(
        db,
        request.source,
        sessions::SessionReadOptions {
            message_limit: Some(1),
            content_limit: Some(1),
            ..Default::default()
        },
    )?
    .ok_or_else(|| anyhow!("NOT_FOUND: parent session"))?;
    sessions::create_session_with_options(
        db,
        sessions::SessionCreateOptions {
            title: Some(request.title),
            mode: Some("agent".into()),
            provider_id: request.provider_id,
            model_id: request.model_id,
            project_path: request.project_path.or(parent.summary.project_path),
            thinking_level: Some(parent.summary.thinking_level),
            permission_mode: Some(parent.summary.permission_mode),
            role: request.role,
            bot_profile_json: None,
        },
    )
}

fn spawn(db: &Database, input: &Value) -> Result<Value> {
    let source = string(input, "sourceSessionId", 256)?;
    let plugin = string(input, "pluginId", 256)?;
    let key = string(input, "idempotencyKey", 256)?;
    let content = string(input, "content", 65_536)?;
    if let Some(existing) = repository::existing(db, plugin, source, key)? {
        if existing.content != content || existing.kind != "task" {
            return Err(anyhow!("IDEMPOTENCY_CONFLICT"));
        }
        return Ok(json!({"message":existing,"sessionId":existing.target_session_id}));
    }
    // Worker limits are read inside the transaction so the counts cannot go
    // stale between the check and the session/link inserts below.
    let tx = db.conn().unchecked_transaction()?;
    let is_worker: bool = db.conn().query_row(
        "SELECT EXISTS(SELECT 1 FROM session_collaboration_links WHERE session_id=?1)",
        params![source],
        |row| row.get(0),
    )?;
    if is_worker {
        return Err(anyhow!("PERMISSION_DENIED: workers may message existing sessions but cannot create further workers"));
    }
    let (parent_active,plugin_active): (i64,i64) = db.conn().query_row(
        "SELECT COALESCE(SUM(l.created_by_session_id=?1),0),COUNT(*) FROM session_collaboration_links l
        WHERE l.plugin_id=?2 AND (EXISTS(SELECT 1 FROM turns t WHERE t.session_id=l.session_id AND t.status='running')
        OR EXISTS(SELECT 1 FROM session_collaboration_messages m WHERE m.target_session_id=l.session_id AND m.status IN ('queued','running')))",
        params![source,plugin],|row|Ok((row.get(0)?,row.get(1)?)))?;
    if parent_active >= 4 || plugin_active >= 16 {
        return Err(anyhow!("LIMIT_EXCEEDED: active worker limit reached"));
    }
    let created = spawn_session(
        db,
        SpawnRequest {
            source,
            title: input
                .get("title")
                .and_then(Value::as_str)
                .map(|value| repository::bounded(value, 80))
                .unwrap_or_else(|| repository::bounded(content, 80)),
            provider_id: input
                .get("providerId")
                .and_then(Value::as_str)
                .map(str::to_owned),
            model_id: input
                .get("modelId")
                .and_then(Value::as_str)
                .map(str::to_owned),
            // A worker is not an employee: it inherits configuration, never a
            // bot identity, so it cannot be addressed as one later.
            role: None,
            // A worker works where its parent does (ADR 0239 inheritance).
            project_path: None,
        },
    )?;
    db.conn().execute("INSERT INTO session_collaboration_links(session_id,created_by_session_id,plugin_id,created_at) VALUES(?1,?2,?3,?4)",params![created.id,source,plugin,now_ms()])?;
    let message = send_record(db, input, &created.id, "task")?;
    tx.commit()?;
    Ok(json!({"sessionId":created.id,"message":message}))
}

/// The task surface (`task.*`, ADR bot-sessions-and-steward §7).
///
/// Kept beside `handle` rather than inside it: tasks are a different identity
/// (a session's work, not a delivery) and their own module, but they answer on
/// the same host route, so a missing prefix would fail exactly the way `bot.*`
/// once did.
pub fn handle_task(db: &Database, method: &str, input: &Value) -> Result<Value> {
    task_api::handle(db, method, input)
}

pub fn handle(db: &Database, method: &str, input: &Value) -> Result<Value> {
    match method {
        "session.collaboration.spawn" => spawn(db, input),
        "session.collaboration.send" => {
            let target = string(input, "sessionId", 256)?;
            let kind = input
                .get("kind")
                .and_then(Value::as_str)
                .unwrap_or("message");
            if !matches!(kind, "task" | "message") {
                return Err(anyhow!("INVALID_ARGUMENT: invalid message kind"));
            }
            let tx = db.conn().unchecked_transaction()?;
            let message = send_record(db, input, target, kind)?;
            tx.commit()?;
            Ok(json!({"message":message}))
        }
        "session.collaboration.message" => {
            Ok(json!({"message":get(db,string(input,"messageId",256)?)?}))
        }
        "session.collaboration.status" => {
            projections::summary(db, string(input, "sessionId", 256)?)
        }
        "session.collaboration.list" => projections::list(db),
        "session.collaboration.result" => projections::result(db, input),
        "session.collaboration.pending" => Ok(
            json!({"messages":repository::pending_callbacks(db,input.get("sessionId").and_then(Value::as_str))?}),
        ),
        // Work that still needs a turn started: completion callbacks and
        // confirmed cards that no one started yet. Separate from `pending`,
        // whose completion-only meaning other callers already rely on.
        "session.collaboration.pendingDispatch" => {
            Ok(json!({"messages":repository::pending_dispatch(db)?}))
        }
        "session.collaboration.fail" => {
            let id = string(input, "messageId", 256)?;
            let tx = db.conn().unchecked_transaction()?;
            repository::fail_queued(db, id, string(input, "error", 2000)?)?;
            if let Some(message) = get(db, id)?.filter(|message| message.status == "failed") {
                settlement::callback(db, &message)?;
            }
            tx.commit()?;
            Ok(json!({"ok":true}))
        }
        "session.collaboration.settle" => {
            Ok(json!({"callback":settle_turn(db,string(input,"turnId",256)?)?}))
        }
        "session.collaboration.cancel" => settlement::cancel(db, input),
        // Task-card drafts (ADR bot-sessions-and-steward §3). The model reaches
        // propose/revise/drop; `confirm` is reached only from the desktop's IPC,
        // because a confirmation is a person's click, not a tool call.
        // The employee surface (ADR bot-sessions-and-steward §5): every row is a
        // session with a role and a profile, so there is no second lifecycle.
        "bot.list" => bots::list(db),
        "bot.create" => bots::create(db, input),
        "bot.update" => bots::update(db, input),
        "bot.dismiss" => bots::dismiss(db, input),
        "bot.seedDefaults" => bots::seed_defaults(db),
        "taskCard.list" => bots::list_drafts(db, string(input, "sessionId", 256)?),
        "taskCard.get" => Ok(json!({
            "draft": drafts::get(db, string(input, "draftId", 256)?)?,
        })),
        "taskCard.propose" => drafts::propose(db, input),
        "taskCard.revise" => drafts::revise(db, input),
        "taskCard.drop" => drafts::drop(db, input),
        // Whether the host may start this card by itself, from stored facts.
        "taskCard.autoStart" => {
            let target = string(input, "targetSessionId", 256)?;
            let card = input
                .get("card")
                .cloned()
                .ok_or_else(|| anyhow!("INVALID_ARGUMENT: card required"))?;
            Ok(json!({"refusal": drafts::auto_start_refusal(db, target, &card)?}))
        }
        "taskCard.confirm" => drafts::confirm(
            db,
            drafts::ConfirmRequest {
                draft_id: string(input, "draftId", 256)?,
                card_hash: string(input, "cardHash", 128)?,
                // The host records *how* it was confirmed; the only two values
                // are a person's click and the host's own auto-start policy.
                confirmed_by: match input.get("confirmedBy").and_then(Value::as_str) {
                    None | Some("user") => drafts::CONFIRMED_BY_USER,
                    Some("policy") => drafts::CONFIRMED_BY_POLICY,
                    Some(other) => {
                        return Err(anyhow!("INVALID_ARGUMENT: unknown confirmedBy '{other}'"))
                    }
                },
                host_id: input.get("hostId").and_then(Value::as_str),
                device_id: input.get("deviceId").and_then(Value::as_str),
                policy_version: input
                    .get("policyVersion")
                    .and_then(Value::as_str)
                    .unwrap_or("steward-1"),
                notify_on_completion: input
                    .get("notifyOnCompletion")
                    .and_then(Value::as_bool)
                    .unwrap_or(true),
                idempotency_key: string(input, "idempotencyKey", 256)?,
                // Resolved from the card's remote origin by the RPC layer,
                // which is the only place that can run git; the host accepts it
                // only when it names a registered project.
                project_path: input.get("projectPath").and_then(Value::as_str),
            },
        ),
        // Task progress (ADR bot-sessions-and-steward): attach the frozen card,
        // record a structured report, and read one delivery's progress.
        "session.collaboration.mandate" => crate::session_collaboration::progress::set_mandate(
            db,
            string(input, "messageId", 256)?,
            string(
                input,
                "mandate",
                crate::session_collaboration::progress::MAX_MANDATE_CHARS,
            )?,
        ),
        "session.collaboration.report" => crate::session_collaboration::progress::report(
            db,
            string(input, "messageId", 256)?,
            input
                .get("seq")
                .and_then(Value::as_i64)
                .ok_or_else(|| anyhow!("INVALID_ARGUMENT: seq required"))?,
            string(input, "report", 32)?,
            string(input, "stage", 32)?,
        ),
        _ => Err(anyhow!(
            "NOT_FOUND: unknown session collaboration operation"
        )),
    }
}

#[cfg(test)]
mod tests;
