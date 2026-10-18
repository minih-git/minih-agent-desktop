//! Learned-memory RPC sub-dispatch (ADR agent-long-term-memory).
//!
//! Every mutation goes through here, so the validation in `crate::memory` cannot
//! be bypassed by a caller: the desktop manager, the explicit remember tool, and
//! the optional extractor all speak the same methods.

use super::{json, rpc_err, AppState, JsonRpcError, Value};
use crate::db::Database;

#[cfg(test)]
#[path = "memory_rpc_tests.rs"]
mod tests;
use crate::memory::{
    is_known, CreateMemoryOutcome, CreateMemoryRequest, MemoryScope, SearchMemoryRequest,
    StatusMemoryOutcome, UpdateMemoryOutcome, UpdateMemoryRequest, EVIDENCES, EVIDENCE_USER_STATED,
    EXTRACTION_LEASE_MS, KINDS, MAX_LIST_LIMIT, MAX_SEARCH_LIMIT, ORIGINS, ORIGIN_USER_UI, SCOPES,
    SCOPE_PROJECT, SCOPE_USER, STATUSES, STATUS_ACTIVE, STATUS_ARCHIVED,
};

pub(super) fn handle(st: &AppState, method: &str, params: Value) -> Result<Value, JsonRpcError> {
    match method {
        "memory.list" => list(&st.db, &params),
        "memory.search" => search(&st.db, &params),
        "memory.index" => index(&st.db, &params),
        "memory.create" => create(&st.db, &params),
        "memory.update" => update(&st.db, &params),
        "memory.archive" => set_status(&st.db, &params, STATUS_ARCHIVED),
        "memory.restore" => set_status(&st.db, &params, STATUS_ACTIVE),
        "memory.delete" => delete(&st.db, &params),
        "memory.suggestions.decide" => decide_suggestion(&st.db, &params),
        "memory.session.get" => session_state(&st.db, &params),
        "memory.session.setExcluded" => set_excluded(&st.db, &params),
        "memory.extraction.claim" => claim_extraction(&st.db, &params),
        "memory.extraction.complete" => complete_extraction(&st.db, &params),
        "memory.extraction.fail" => fail_extraction(&st.db, &params),
        _ => Err(rpc_err(1007, "unknown memory method", "NOT_FOUND")),
    }
}

fn list(db: &Database, params: &Value) -> Result<Value, JsonRpcError> {
    let scope = resolve_scope(db, params)?;
    let status = optional_str(params, "status")?;
    if let Some(status) = status {
        if !is_known(status, &STATUSES) {
            return Err(invalid_params("status is not a supported value"));
        }
    }
    let kind = optional_str(params, "kind")?;
    if let Some(kind) = kind {
        if !is_known(kind, &KINDS) {
            return Err(invalid_params("kind is not a supported value"));
        }
    }
    let limit = optional_i64(params, "limit")?
        .unwrap_or(50)
        .clamp(1, MAX_LIST_LIMIT);
    let offset = optional_i64(params, "offset")?.unwrap_or(0).max(0);
    let entries = db
        .list_memory_entries(&scope, status, kind, limit, offset)
        .map_err(internal)?;
    Ok(json!({
        "entries": entries,
        "scope": { "kind": scope.kind, "key": scope.key }
    }))
}

fn search(db: &Database, params: &Value) -> Result<Value, JsonRpcError> {
    let query = required_str(params, "query")?;
    let kinds = string_array(params, "kinds")?;
    for kind in &kinds {
        if !is_known(kind, &KINDS) {
            return Err(invalid_params("kinds contains an unsupported value"));
        }
    }
    let limit = optional_i64(params, "limit")?
        .unwrap_or(8)
        .clamp(1, MAX_SEARCH_LIMIT);
    let record_use = optional_bool(params, "recordUse")?.unwrap_or(false);
    let scopes = readable_scopes(db, params)?;
    let entries = db
        .search_memory_entries(SearchMemoryRequest {
            scopes: &scopes,
            query,
            kinds: &kinds,
            limit,
            record_use,
        })
        .map_err(internal)?;
    Ok(json!({ "entries": entries }))
}

fn index(db: &Database, params: &Value) -> Result<Value, JsonRpcError> {
    let path = required_str(params, "path")?;
    let index = db.learned_memory_index(path).map_err(internal)?;
    Ok(json!({ "index": index }))
}

fn create(db: &Database, params: &Value) -> Result<Value, JsonRpcError> {
    let scope = resolve_scope(db, params)?;
    let kind = required_str(params, "kind")?;
    if !is_known(kind, &KINDS) {
        return Err(invalid_params("kind is not a supported value"));
    }
    let content = required_str(params, "content")?;
    let origin = optional_str(params, "origin")?.unwrap_or(ORIGIN_USER_UI);
    if !is_known(origin, &ORIGINS) {
        return Err(invalid_params("origin is not a supported value"));
    }
    let evidence = optional_str(params, "evidence")?.unwrap_or(EVIDENCE_USER_STATED);
    if !is_known(evidence, &EVIDENCES) {
        return Err(invalid_params("evidence is not a supported value"));
    }
    let status = optional_str(params, "status")?.unwrap_or(STATUS_ACTIVE);
    let outcome = db
        .create_memory_entry(CreateMemoryRequest {
            scope,
            kind: kind.to_string(),
            content: content.to_string(),
            rationale: optional_str(params, "rationale")?.map(str::to_string),
            origin: origin.to_string(),
            evidence: evidence.to_string(),
            status: status.to_string(),
            source_session_id: optional_str(params, "sourceSessionId")?.map(str::to_string),
            source_message_ids: string_array(params, "sourceMessageIds")?,
            override_tombstone: optional_bool(params, "overrideTombstone")?.unwrap_or(false),
        })
        .map_err(internal)?;
    Ok(match outcome {
        CreateMemoryOutcome::Created(entry) => json!({ "entry": entry, "duplicate": false }),
        CreateMemoryOutcome::Duplicate(entry) => json!({ "entry": entry, "duplicate": true }),
        CreateMemoryOutcome::Rejected(rejection) => json!({ "rejected": rejection }),
    })
}

fn update(db: &Database, params: &Value) -> Result<Value, JsonRpcError> {
    let id = required_str(params, "id")?;
    let revision = optional_i64(params, "revision")?
        .ok_or_else(|| rpc_err(1002, "revision required", "INVALID_PARAMS"))?;
    let scope = if params.get("scope").is_some()
        || params.get("path").is_some()
        || params.get("sessionId").is_some()
    {
        Some(resolve_scope(db, params)?)
    } else {
        None
    };
    let outcome = db
        .update_memory_entry(UpdateMemoryRequest {
            id: id.to_string(),
            revision,
            content: optional_str(params, "content")?.map(str::to_string),
            rationale: optional_str(params, "rationale")?.map(str::to_string),
            kind: optional_str(params, "kind")?.map(str::to_string),
            scope,
        })
        .map_err(internal)?;
    match outcome {
        UpdateMemoryOutcome::Updated(entry) => Ok(json!({ "entry": entry })),
        UpdateMemoryOutcome::NotFound => Err(not_found("memory not found")),
        UpdateMemoryOutcome::RevisionConflict => Err(rpc_err(
            1008,
            "memory changed since it was read",
            "MEMORY_REVISION_CONFLICT",
        )),
        UpdateMemoryOutcome::Rejected(rejection) => Ok(json!({ "rejected": rejection })),
    }
}

fn set_status(db: &Database, params: &Value, status: &str) -> Result<Value, JsonRpcError> {
    let id = required_str(params, "id")?;
    match db.set_memory_entry_status(id, status).map_err(internal)? {
        StatusMemoryOutcome::Updated(entry) => Ok(json!({ "entry": entry })),
        StatusMemoryOutcome::NotFound => Err(not_found("memory not found")),
        StatusMemoryOutcome::Duplicate => Err(rpc_err(
            1008,
            "another memory in this scope already holds this content",
            "MEMORY_DUPLICATE_CONTENT",
        )),
    }
}

/// Forget an entry. Idempotent: the tombstone makes a repeated delete a no-op
/// and an unknown id reports `ok: false` instead of failing.
fn delete(db: &Database, params: &Value) -> Result<Value, JsonRpcError> {
    let id = required_str(params, "id")?;
    let removed = db.delete_memory_entry(id).map_err(internal)?;
    Ok(json!({ "ok": removed }))
}

fn decide_suggestion(db: &Database, params: &Value) -> Result<Value, JsonRpcError> {
    let id = required_str(params, "id")?;
    let accept = match required_str(params, "decision")? {
        "accept" => true,
        "reject" => false,
        _ => return Err(invalid_params("decision must be accept or reject")),
    };
    match db.decide_memory_suggestion(id, accept).map_err(internal)? {
        Some(entry) => Ok(json!({ "entry": entry })),
        None => Err(not_found("suggestion not found")),
    }
}

fn session_state(db: &Database, params: &Value) -> Result<Value, JsonRpcError> {
    let session_id = required_str(params, "sessionId")?;
    let state = db.memory_session_state(session_id).map_err(internal)?;
    Ok(json!({ "state": state }))
}

fn set_excluded(db: &Database, params: &Value) -> Result<Value, JsonRpcError> {
    let session_id = required_str(params, "sessionId")?;
    let excluded = optional_bool(params, "excluded")?
        .ok_or_else(|| rpc_err(1002, "excluded required", "INVALID_PARAMS"))?;
    // Resolve the session first so an unknown id is a NOT_FOUND, not an
    // internal failure from the state row's foreign key.
    session_scopes(db, session_id)?;
    let state = db
        .set_memory_session_excluded(session_id, excluded)
        .map_err(internal)?;
    Ok(json!({ "state": state }))
}

fn claim_extraction(db: &Database, params: &Value) -> Result<Value, JsonRpcError> {
    let session_id = required_str(params, "sessionId")?;
    let owner = required_str(params, "owner")?;
    let lease_ms = optional_i64(params, "leaseMs")?.unwrap_or(EXTRACTION_LEASE_MS);
    session_scopes(db, session_id)?;
    let claimed = db
        .claim_memory_extraction(session_id, owner, lease_ms)
        .map_err(internal)?;
    Ok(match claimed {
        Some(state) => json!({ "claimed": true, "state": state }),
        None => json!({ "claimed": false }),
    })
}

fn complete_extraction(db: &Database, params: &Value) -> Result<Value, JsonRpcError> {
    let session_id = required_str(params, "sessionId")?;
    let owner = required_str(params, "owner")?;
    let cursor_seq = optional_i64(params, "cursorSeq")?
        .ok_or_else(|| rpc_err(1002, "cursorSeq required", "INVALID_PARAMS"))?;
    let state = db
        .complete_memory_extraction(session_id, owner, cursor_seq)
        .map_err(internal)?;
    Ok(json!({ "completed": state.is_some(), "state": state }))
}

fn fail_extraction(db: &Database, params: &Value) -> Result<Value, JsonRpcError> {
    let session_id = required_str(params, "sessionId")?;
    let owner = required_str(params, "owner")?;
    let error = optional_str(params, "error")?.unwrap_or("EXTRACTION_FAILED");
    let state = db
        .fail_memory_extraction(session_id, owner, error)
        .map_err(internal)?;
    Ok(json!({ "failed": state.is_some(), "state": state }))
}

/// A write scope comes from an explicit `path` (the desktop manager) or from the
/// session the caller names. The recall tools pass `sessionId` only, so the
/// model can never address another project.
fn resolve_scope(db: &Database, params: &Value) -> Result<MemoryScope, JsonRpcError> {
    let kind = optional_str(params, "scope")?.unwrap_or(SCOPE_PROJECT);
    if !is_known(kind, &SCOPES) {
        return Err(invalid_params("scope is not a supported value"));
    }
    if kind == SCOPE_USER {
        return Ok(MemoryScope::user());
    }
    if let Some(path) = optional_str(params, "path")? {
        return db
            .learned_memory_scope_for_path(path)
            .map_err(invalid_params);
    }
    let session_id = required_str(params, "sessionId")?;
    let scopes = session_scopes(db, session_id)?;
    scopes
        .into_iter()
        .find(|scope| scope.kind == SCOPE_PROJECT)
        .ok_or_else(|| not_found("session has no project"))
}

/// Scopes a read may see: the session's project scope plus the user scope, or
/// one explicit project scope plus the user scope.
fn readable_scopes(db: &Database, params: &Value) -> Result<Vec<MemoryScope>, JsonRpcError> {
    let mut scopes = match optional_str(params, "path")? {
        Some(path) => vec![db
            .learned_memory_scope_for_path(path)
            .map_err(invalid_params)?],
        None => {
            let session_id = optional_str(params, "sessionId")?;
            match session_id {
                Some(session_id) => session_scopes(db, session_id)?,
                None => Vec::new(),
            }
        }
    };
    if !scopes.iter().any(|scope| scope.kind == SCOPE_USER) {
        scopes.push(MemoryScope::user());
    }
    Ok(scopes)
}

/// A session that does not exist is a caller mistake, not an internal failure.
fn session_scopes(db: &Database, session_id: &str) -> Result<Vec<MemoryScope>, JsonRpcError> {
    db.learned_memory_scopes_for_session(session_id)
        .map_err(internal)?
        .ok_or_else(|| not_found("session not found"))
}

fn internal(error: impl ToString) -> JsonRpcError {
    rpc_err(1000, error.to_string(), "INTERNAL")
}

fn invalid_params(error: impl ToString) -> JsonRpcError {
    rpc_err(1002, error.to_string(), "INVALID_PARAMS")
}

fn not_found(message: &str) -> JsonRpcError {
    rpc_err(1007, message, "NOT_FOUND")
}

fn required_str<'a>(params: &'a Value, key: &str) -> Result<&'a str, JsonRpcError> {
    params
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| rpc_err(1002, format!("{key} required"), "INVALID_PARAMS"))
}

fn optional_str<'a>(params: &'a Value, key: &str) -> Result<Option<&'a str>, JsonRpcError> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.as_str())),
        Some(_) => Err(rpc_err(
            1002,
            format!("{key} must be a string"),
            "INVALID_PARAMS",
        )),
    }
}

fn optional_i64(params: &Value, key: &str) -> Result<Option<i64>, JsonRpcError> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value
            .as_i64()
            .map(Some)
            .ok_or_else(|| rpc_err(1002, format!("{key} must be an integer"), "INVALID_PARAMS")),
    }
}

fn optional_bool(params: &Value, key: &str) -> Result<Option<bool>, JsonRpcError> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value
            .as_bool()
            .map(Some)
            .ok_or_else(|| rpc_err(1002, format!("{key} must be a boolean"), "INVALID_PARAMS")),
    }
}

fn string_array(params: &Value, key: &str) -> Result<Vec<String>, JsonRpcError> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| {
                item.as_str().map(str::to_string).ok_or_else(|| {
                    rpc_err(
                        1002,
                        format!("{key} must contain strings"),
                        "INVALID_PARAMS",
                    )
                })
            })
            .collect(),
        Some(_) => Err(rpc_err(
            1002,
            format!("{key} must be an array"),
            "INVALID_PARAMS",
        )),
    }
}
