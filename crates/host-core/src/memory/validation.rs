//! Write-path validation shared by every learned-memory writer
//! (ADR agent-long-term-memory §3).
//!
//! The rules are the same for the explicit tool, the memory manager, and the
//! optional extractor: content limits, provenance for the kinds that must cite
//! the user, a credential detector, and the tombstones that make a delete stick.
//!
//! A policy refusal is a value (`WriteOutcome::Rejected`); a storage failure is
//! an `Err`, so a broken database can never read as "the user's memory was
//! refused".

use anyhow::Result;
use rusqlite::{params, Connection};

use super::model::*;
use super::{secrets, tombstones};

/// One write request whose JSON shape the RPC boundary already checked.
pub(crate) struct MemoryWrite {
    pub scope: MemoryScope,
    pub kind: String,
    pub content: String,
    pub rationale: Option<String>,
    pub origin: String,
    pub evidence: String,
    pub source_session_id: Option<String>,
    pub source_message_ids: Vec<String>,
    pub override_tombstone: bool,
}

pub(crate) enum WriteOutcome {
    Accepted,
    Rejected(MemoryRejection),
}

/// Which writer is calling. A create must respect tombstones; editing an entry
/// the user already owns is an explicit act on that entry, so a tombstone
/// written by an earlier delete of the same content never blocks the edit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WritePath {
    Create,
    Update,
}

pub(crate) fn validate(
    conn: &Connection,
    write: &MemoryWrite,
    path: WritePath,
) -> Result<WriteOutcome> {
    let content = write.content.trim();
    if content.is_empty() {
        return Ok(reject(
            REJECT_EMPTY_CONTENT,
            "memory content must not be blank",
        ));
    }
    if write.content.len() > MAX_CONTENT_BYTES {
        return Ok(reject(
            REJECT_CONTENT_TOO_LARGE,
            format!("memory content exceeds {MAX_CONTENT_BYTES} bytes"),
        ));
    }
    if write
        .rationale
        .as_deref()
        .is_some_and(|rationale| rationale.len() > MAX_RATIONALE_BYTES)
    {
        return Ok(reject(
            REJECT_RATIONALE_TOO_LARGE,
            format!("memory rationale exceeds {MAX_RATIONALE_BYTES} bytes"),
        ));
    }
    if !is_known(&write.kind, &KINDS) {
        return Ok(reject_invalid_field("kind"));
    }
    if !is_known(&write.origin, &ORIGINS) {
        return Ok(reject_invalid_field("origin"));
    }
    if !is_known(&write.evidence, &EVIDENCES) {
        return Ok(reject_invalid_field("evidence"));
    }
    if write.source_message_ids.len() > MAX_SOURCE_MESSAGE_IDS {
        return Ok(reject_invalid_field("sourceMessageIds"));
    }
    // A refused credential must never be echoed, logged, or stored, so this
    // check runs before anything can serialize the text.
    if secrets::looks_like_credential(content)
        || write
            .rationale
            .as_deref()
            .is_some_and(secrets::looks_like_credential)
    {
        return Ok(reject(
            REJECT_CREDENTIAL_DETECTED,
            "memory content looks like a credential and was not stored",
        ));
    }
    if requires_user_statement(&write.kind) {
        if let Some(rejection) = check_user_provenance(conn, write)? {
            return Ok(WriteOutcome::Rejected(rejection));
        }
    } else if write.evidence == EVIDENCE_VERIFIED && !allows_verified(&write.kind) {
        return Ok(reject(
            REJECT_PROVENANCE_REQUIRED,
            "only a fact or a reference may be recorded as verified",
        ));
    }
    let fingerprint = tombstones::fingerprint(&write.kind, &write.content);
    let overridden = write.origin == ORIGIN_EXPLICIT && write.override_tombstone;
    if path == WritePath::Create
        && !overridden
        && tombstones::blocks(conn, &write.scope, &fingerprint, &write.source_message_ids)?
    {
        return Ok(reject(
            REJECT_TOMBSTONED,
            "this memory was deleted before and stays forgotten",
        ));
    }
    Ok(WriteOutcome::Accepted)
}

/// Kinds that describe the user themselves must cite a message the user wrote.
/// Tool output, file or web content, MCP responses, subagent output, injected
/// instructions, and skill documents are never valid evidence for them.
pub(crate) fn requires_user_statement(kind: &str) -> bool {
    matches!(kind, KIND_PREFERENCE | KIND_FEEDBACK)
}

/// `verified` is only meaningful for something the agent observed in this
/// session: a fact or a reference (ADR §3.1).
pub(crate) fn allows_verified(kind: &str) -> bool {
    matches!(kind, KIND_FACT | KIND_REFERENCE)
}

fn check_user_provenance(
    conn: &Connection,
    write: &MemoryWrite,
) -> Result<Option<MemoryRejection>> {
    if write.evidence != EVIDENCE_USER_STATED {
        return Ok(Some(rejection(
            REJECT_PROVENANCE_REQUIRED,
            "a preference or feedback entry must cite what the user stated",
        )));
    }
    let Some(session_id) = write
        .source_session_id
        .as_deref()
        .filter(|id| !id.is_empty())
    else {
        return Ok(Some(rejection(
            REJECT_PROVENANCE_REQUIRED,
            "a preference or feedback entry must cite the session it came from",
        )));
    };
    if write.source_message_ids.is_empty() {
        return Ok(Some(rejection(
            REJECT_PROVENANCE_REQUIRED,
            "a preference or feedback entry must cite at least one user message",
        )));
    }
    let cited = tombstones::encode_ids(&write.source_message_ids);
    let user_messages: i64 = conn.query_row(
        "SELECT COUNT(*) FROM messages
         WHERE session_id = ?1 AND role = 'user'
           AND id IN (SELECT value FROM json_each(?2))",
        params![session_id, cited],
        |row| row.get(0),
    )?;
    if user_messages == 0 {
        return Ok(Some(rejection(
            REJECT_PROVENANCE_REQUIRED,
            "a preference or feedback entry must cite a user message of its own session",
        )));
    }
    Ok(None)
}

fn rejection(code: &'static str, message: impl Into<String>) -> MemoryRejection {
    MemoryRejection::new(code, message)
}

fn reject(code: &'static str, message: impl Into<String>) -> WriteOutcome {
    WriteOutcome::Rejected(rejection(code, message))
}

fn reject_invalid_field(field: &str) -> WriteOutcome {
    reject(
        REJECT_INVALID_FIELD,
        format!("{field} is not a supported value"),
    )
}
