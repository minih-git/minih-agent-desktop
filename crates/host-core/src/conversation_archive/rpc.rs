//! Host RPC for the conversation archive (ADR conversation-archive).
//!
//! Two audiences share one module because they read the same rows: the plugin
//! methods (`plugin.conversations.*`, gated by Electron main's
//! `conversation.read`) and the summary generator's own methods
//! (`conversation.summary.*`, called by Electron main after the user's switch and
//! budget check). Every answer is a projection; no method returns a stored row
//! shape or message body that the caller did not ask for.

use super::{feed, repo};
use crate::db::Database;
use crate::rpc::{json, rpc_err, AppState, JsonRpcError, Value};

/// Rent one summary run holds; a crashed run's lease expires on its own.
const ARCHIVE_LEASE_MS: i64 = 10 * 60 * 1000;
/// Attempts one session gets before the run stops retrying it.
const ARCHIVE_MAX_ATTEMPTS: i64 = 3;

pub(crate) fn handle(st: &AppState, method: &str, params: Value) -> Result<Value, JsonRpcError> {
    match method {
        "plugin.conversations.changes" => changes(&st.db, &params),
        "plugin.conversations.summary" => summary(&st.db, &params),
        "plugin.conversations.transcript" => transcript(&st.db, &params),
        "conversation.summary.queue" => queue(&st.db, &params),
        "conversation.summary.claim" => claim(&st.db, &params),
        "conversation.summary.input" => input(&st.db, &params),
        "conversation.summary.complete" => complete(&st.db, &params),
        "conversation.summary.fail" => fail(&st.db, &params),
        "conversation.summary.release" => release(&st.db, &params),
        _ => Err(rpc_err(1007, "unknown conversation method", "NOT_FOUND")),
    }
}

fn invalid(message: impl Into<String>) -> JsonRpcError {
    rpc_err(1002, message.into(), "INVALID_PARAMS")
}

fn internal(error: impl ToString) -> JsonRpcError {
    rpc_err(1000, error.to_string(), "INTERNAL")
}

fn not_found(message: &str) -> JsonRpcError {
    rpc_err(1007, message, "NOT_FOUND")
}

fn required_str<'a>(params: &'a Value, key: &str) -> Result<&'a str, JsonRpcError> {
    params
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| invalid(format!("{key} is required")))
}

fn optional_i64(params: &Value, key: &str) -> Result<Option<i64>, JsonRpcError> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value
            .as_i64()
            .map(Some)
            .ok_or_else(|| invalid(format!("{key} must be an integer"))),
    }
}

fn optional_str<'a>(params: &'a Value, key: &str) -> Result<Option<&'a str>, JsonRpcError> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.as_str())),
        Some(_) => Err(invalid(format!("{key} must be a string"))),
    }
}

fn changes(db: &Database, params: &Value) -> Result<Value, JsonRpcError> {
    let limit = optional_i64(params, "limit")?.unwrap_or(50);
    if !(1..=feed::CHANGES_MAX_LIMIT).contains(&limit) {
        return Err(invalid("limit must be an integer between 1 and 100"));
    }
    let cursor = optional_str(params, "cursor")?;
    feed::changes_page(db, cursor, limit).map_err(internal)
}

fn summary(db: &Database, params: &Value) -> Result<Value, JsonRpcError> {
    let session_id = required_str(params, "sessionId")?;
    feed::summary_for_plugin(db, session_id).map_err(internal)
}

fn transcript(db: &Database, params: &Value) -> Result<Value, JsonRpcError> {
    let session_id = required_str(params, "sessionId")?;
    let from_turn = optional_i64(params, "fromTurn")?.unwrap_or(0);
    if from_turn < 0 {
        return Err(invalid("fromTurn must be a non-negative integer"));
    }
    let limit = optional_i64(params, "limit")?.unwrap_or(50);
    if !(1..=feed::TRANSCRIPT_MAX_LIMIT).contains(&limit) {
        return Err(invalid("limit must be an integer between 1 and 200"));
    }
    match feed::transcript_page(db, session_id, from_turn, limit).map_err(internal)? {
        Some(value) => Ok(value),
        None => Err(not_found("session not found")),
    }
}

fn queue(db: &Database, params: &Value) -> Result<Value, JsonRpcError> {
    let limit = optional_i64(params, "limit")?.unwrap_or(1).clamp(1, 50);
    let sessions = db.conversation_archive_queue(limit).map_err(internal)?;
    Ok(json!({ "sessions": sessions }))
}

fn claim(db: &Database, params: &Value) -> Result<Value, JsonRpcError> {
    let session_id = required_str(params, "sessionId")?;
    let owner = required_str(params, "owner")?;
    let claimed = db
        .claim_conversation_summary(session_id, owner, ARCHIVE_LEASE_MS)
        .map_err(internal)?;
    let attempts = claimed.as_ref().map(|state| state.attempts).unwrap_or(0);
    let reason = if claimed.is_some() {
        None
    } else if db
        .memory_session_state(session_id)
        .map_err(internal)?
        .is_some_and(|state| state.excluded)
    {
        Some("excluded")
    } else {
        Some("leased")
    };
    Ok(json!({
        "claimed": claimed.is_some() && attempts < ARCHIVE_MAX_ATTEMPTS,
        "reason": reason,
        "attempts": attempts,
        "maxAttempts": ARCHIVE_MAX_ATTEMPTS,
    }))
}

fn input(db: &Database, params: &Value) -> Result<Value, JsonRpcError> {
    let session_id = required_str(params, "sessionId")?;
    match db
        .conversation_archive_input(session_id)
        .map_err(internal)?
    {
        None => Err(not_found("session not found")),
        Some(repo::ConversationArchiveInputOutcome::Input(input)) => Ok(json!({ "input": input })),
        Some(repo::ConversationArchiveInputOutcome::Skipped(skip)) => {
            Ok(json!({ "skipped": skip }))
        }
    }
}

fn complete(db: &Database, params: &Value) -> Result<Value, JsonRpcError> {
    let session_id = required_str(params, "sessionId")?;
    let owner = required_str(params, "owner")?;
    let cursor_seq =
        optional_i64(params, "cursorSeq")?.ok_or_else(|| invalid("cursorSeq is required"))?;
    let model_key = required_str(params, "modelKey")?;
    let summary_value = params
        .get("summary")
        .ok_or_else(|| invalid("summary is required"))?;
    let summary = repo::ConversationSummary::from_model_value(summary_value);
    if summary.is_empty() {
        return Err(invalid("summary is empty"));
    }
    let updated = db
        .complete_conversation_summary(session_id, owner, cursor_seq, model_key, &summary)
        .map_err(internal)?;
    Ok(json!({ "stored": updated.is_some(), "state": updated }))
}

fn fail(db: &Database, params: &Value) -> Result<Value, JsonRpcError> {
    let session_id = required_str(params, "sessionId")?;
    let owner = required_str(params, "owner")?;
    let error = required_str(params, "error")?;
    // Only a code reaches the row: the message a model produced is content.
    let updated = db
        .fail_conversation_summary(session_id, owner, error)
        .map_err(internal)?;
    Ok(json!({ "state": updated }))
}

fn release(db: &Database, params: &Value) -> Result<Value, JsonRpcError> {
    let session_id = required_str(params, "sessionId")?;
    let owner = required_str(params, "owner")?;
    let released = db
        .release_conversation_summary(session_id, owner)
        .map_err(internal)?;
    Ok(json!({ "state": released }))
}

/// A permanent deletion is recorded before the session row goes, so the change
/// feed can still name the file a plugin wrote.
pub(crate) fn record_deletion(db: &Database, session_id: &str) -> anyhow::Result<()> {
    repo::record_archive_tombstone(db, session_id)
}
