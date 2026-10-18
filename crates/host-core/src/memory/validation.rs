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
    /// The status the write would store. Only a create chooses it; an edit keeps
    /// the stored one.
    pub status: String,
    pub source_session_id: Option<String>,
    pub source_message_ids: Vec<String>,
    pub override_tombstone: bool,
}

pub(crate) enum WriteOutcome {
    Accepted,
    Rejected(MemoryRejection),
}

/// Which writer is calling.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum WritePath {
    /// A create must respect tombstones and choose a legal origin/status pair.
    Create,
    /// Editing an entry the user already owns is an explicit act on that entry,
    /// so a tombstone written by an earlier delete of the same content never
    /// blocks the edit, and the provenance the entry was created with is not
    /// re-checked: its cited messages may be gone with their session. A kind
    /// change into a provenance-bearing kind is checked again.
    Update { previous_kind: String },
}

pub(crate) fn validate(
    conn: &Connection,
    write: &MemoryWrite,
    path: &WritePath,
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
    // Extraction may only propose, and only extraction may propose (ADR §4). The
    // host decides this, not the caller that happens to pass `status`.
    if matches!(path, WritePath::Create)
        && (write.origin == ORIGIN_EXTRACTED) != (write.status == STATUS_SUGGESTED)
    {
        return Ok(reject(
            REJECT_INVALID_FIELD,
            "an extracted memory must be a suggestion, and a suggestion must come from extraction",
        ));
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
    let provenance_required = requires_user_statement(&write.kind)
        && match path {
            WritePath::Create => true,
            WritePath::Update { previous_kind } => !requires_user_statement(previous_kind),
        };
    if provenance_required {
        if let Some(rejection) = check_user_provenance(conn, write)? {
            return Ok(WriteOutcome::Rejected(rejection));
        }
    } else if write.evidence == EVIDENCE_VERIFIED && !allows_verified(&write.kind) {
        return Ok(reject(
            REJECT_PROVENANCE_REQUIRED,
            "only a fact or a reference may be recorded as verified",
        ));
    }
    // A message another agent or plugin delivered into the session is stored
    // with role `user`, and the user did not write it. `user_stated` is a claim
    // about what the user said, so it may not rest on one for any kind: a fact
    // or reference that came with a delivery is recorded as `verified` instead
    // (ADR §3.1). A preference already fails the stricter rule above.
    if write.evidence == EVIDENCE_USER_STATED
        && !write.source_message_ids.is_empty()
        && cites_delivered_message(conn, write)?
    {
        return Ok(reject(
            REJECT_PROVENANCE_REQUIRED,
            "a user_stated memory must not cite a message another agent delivered",
        ));
    }
    let fingerprint = tombstones::fingerprint(&write.kind, &write.content);
    let overridden = write.origin == ORIGIN_EXPLICIT && write.override_tombstone;
    if matches!(path, WritePath::Create)
        && !overridden
        && tombstones::blocks(conn, &write.scope, &fingerprint, &write.source_message_ids)?
    {
        return Ok(reject(
            REJECT_TOMBSTONED,
            "the user deleted this memory before, so it stays forgotten. Only the user can bring it back from the conversation receipt; do not try again.",
        ));
    }
    Ok(WriteOutcome::Accepted)
}

/// Kinds that describe the user themselves must cite a message the user wrote.
/// Tool output, file or web content, MCP responses, subagent output, injected
/// instructions, and skill documents are never valid evidence for them, and
/// neither is a message another agent or plugin delivered into the session:
/// those are stored with role `user` too, and only the delivery ledger tells the
/// two apart. A cited message must also belong to a real turn of the session, so
/// a copy that lost its turn reference (a forked prefix, an imported session)
/// cannot stand in for user input either.
pub(crate) fn requires_user_statement(kind: &str) -> bool {
    matches!(kind, KIND_PREFERENCE | KIND_FEEDBACK)
}

/// `verified` is only meaningful for something the agent observed in this
/// session: a fact or a reference (ADR §3.1).
pub(crate) fn allows_verified(kind: &str) -> bool {
    matches!(kind, KIND_FACT | KIND_REFERENCE)
}

/// Whether any cited message belongs to a turn another agent delivered into.
/// A delivered turn is the unit the ledger records, so one delivered message in
/// the set is enough to withhold the claim.
fn cites_delivered_message(conn: &Connection, write: &MemoryWrite) -> Result<bool> {
    let cited = tombstones::encode_ids(&write.source_message_ids);
    let delivered: i64 = conn.query_row(
        "SELECT COUNT(*) FROM messages m
           JOIN session_collaboration_messages delivered ON delivered.turn_id = m.turn_id
          WHERE m.id IN (SELECT value FROM json_each(?1))",
        params![cited],
        |row| row.get(0),
    )?;
    Ok(delivered > 0)
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
    // Every cited message must qualify, not merely one of them. A message an
    // agent or plugin delivered into this session is stored with role `user`, and
    // its turn is the one the delivery ledger claims, so the ledger is what
    // separates it from something the user typed. The message must also belong to
    // a real turn of this session: a forked session copies its prefix with fresh
    // ids and no turn reference, and an imported session may have none either, so
    // such a copy carries no evidence that the user wrote it.
    let cited = tombstones::encode_ids(&write.source_message_ids);
    let (eligible, cited_total): (i64, i64) = conn.query_row(
        "SELECT
           (SELECT COUNT(DISTINCT m.id) FROM messages m
             WHERE m.session_id = ?1 AND m.role = 'user'
               AND m.turn_id IS NOT NULL
               AND m.id IN (SELECT value FROM json_each(?2))
               AND NOT EXISTS (
                 SELECT 1 FROM session_collaboration_messages delivered
                 WHERE delivered.turn_id IS NOT NULL AND delivered.turn_id = m.turn_id
               )),
           (SELECT COUNT(DISTINCT value) FROM json_each(?2))",
        params![session_id, cited],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    if eligible < cited_total {
        return Ok(Some(rejection(
            REJECT_PROVENANCE_REQUIRED,
            "a preference or feedback entry must cite only messages the user wrote",
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
