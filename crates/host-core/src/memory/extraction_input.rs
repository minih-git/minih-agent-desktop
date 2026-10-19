//! What one extraction run may read (ADR agent-long-term-memory §4).
//!
//! The host assembles the input so the rule that decides what counts as
//! user-authored input lives beside the provenance rules that trust it: only
//! messages the user wrote, after the session cursor, plus the latest compaction
//! summary, inside a byte budget. Electron main never reads SQLite, and it never
//! learns the ids of messages the user did not write, so a candidate can only
//! cite evidence the run actually sent to the model.

use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use super::model::*;
use crate::db::{ts_to_ms, Database};
use crate::transcripts;

/// Bytes one extraction input may spend in total.
pub(crate) const EXTRACTION_INPUT_MAX_BYTES: usize = 16 * 1024;
/// Bytes the latest compaction summary may spend of that budget.
pub(crate) const EXTRACTION_SUMMARY_MAX_BYTES: usize = 4 * 1024;
/// Accounting overhead per message: the id, the sequence, and the date the
/// prompt prints beside it.
pub(crate) const EXTRACTION_MESSAGE_OVERHEAD_BYTES: usize = 48;

pub(crate) const SKIP_EXCLUDED: &str = "excluded";
pub(crate) const SKIP_SCHEDULED_RUN: &str = "scheduled-run";
pub(crate) const SKIP_IMPORTED: &str = "imported";

/// One user message the extractor may cite.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExtractionMessage {
    pub id: String,
    pub seq: i64,
    pub text: String,
    pub created_at: i64,
    /// True when the message was cut to fit the input budget. The cut is at the
    /// start of the message, so a candidate citing it is grounded in text the
    /// model actually received.
    pub truncated: bool,
}

/// The latest compaction summary, as digest context for the same run.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExtractionSummary {
    pub text: String,
    /// True when the summary exceeded its share of the budget and was cut.
    pub truncated: bool,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExtractionInput {
    pub session_id: String,
    pub scope_kind: String,
    pub scope_key: Option<String>,
    /// The next sequence to read. The caller advances it to one past the last
    /// message it actually sent, so an unsent message stays unread.
    pub cursor_seq: i64,
    pub messages: Vec<ExtractionMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<ExtractionSummary>,
    /// Bytes the returned input spends in the budget.
    pub bytes: usize,
}

/// Why one session is not extracted at all. Every variant is a session the
/// user never opted into, so the service simply forgets it.
pub(crate) enum ExtractionInputOutcome {
    Input(ExtractionInput),
    Skipped(&'static str),
}

/// Turn an over-long text into a prefix that ends on a character boundary, so a
/// truncated summary never splits a multi-byte character.
fn truncate_to_bytes(text: &str, limit: usize) -> (String, bool) {
    if text.len() <= limit {
        return (text.to_string(), false);
    }
    let mut end = limit;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    (text[..end].to_string(), true)
}

/// The session's own identity facts, in one read: is it a scheduled run, and
/// was it imported from another tool.
///
/// An isolated worktree session (ADR 0329) is deliberately **not** a skip: it is
/// ordinary project work, and it carries the main project's memory identity, so
/// what it teaches belongs to that project.
fn session_shape(conn: &Connection, session_id: &str) -> Result<Option<(bool, Option<String>)>> {
    conn.query_row(
        "SELECT (SELECT COUNT(*) FROM task_runs r WHERE r.session_id = s.id), s.source
           FROM sessions s
          WHERE s.id = ?1 AND s.deleted_at IS NULL",
        params![session_id],
        |row| Ok((row.get::<_, i64>(0)? > 0, row.get::<_, Option<String>>(1)?)),
    )
    .optional()
    .map_err(Into::into)
}

/// User-authored messages at or after `cursor`, oldest first.
///
/// `cursor` is the next sequence to read, so a fresh session reads from `0` and
/// a finished run stores "one past the last message it sent". A delivered
/// message is stored with role `user` too, and only the delivery ledger
/// separates it from something the user typed (ADR §3), so the same rule the
/// write path trusts decides what the extractor may read.
fn user_messages_after(
    conn: &Connection,
    session_id: &str,
    cursor: i64,
) -> Result<Vec<(String, i64, String, i64)>> {
    let mut statement = conn.prepare_cached(
        "SELECT m.id, m.seq, m.text, m.created_at
           FROM messages m
          WHERE m.session_id = ?1
            AND m.seq >= ?2
            AND m.role = 'user'
            AND m.turn_id IS NOT NULL
            AND m.text IS NOT NULL
            AND TRIM(m.text) <> ''
            AND NOT EXISTS (
                SELECT 1 FROM session_collaboration_messages delivered
                 WHERE delivered.turn_id IS NOT NULL AND delivered.turn_id = m.turn_id
            )
          ORDER BY m.seq ASC",
    )?;
    let rows = statement
        .query_map(params![session_id, cursor], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

impl Database {
    /// Assemble one run's input, or say why the session is out of scope.
    ///
    /// The byte budget is spent summary first, then messages in cursor order.
    /// A message that does not fit is not sent and the cursor stops before it,
    /// so the next run continues exactly where this one ended instead of
    /// silently skipping what it did not read.
    pub(crate) fn memory_extraction_input(
        &self,
        session_id: &str,
    ) -> Result<Option<ExtractionInputOutcome>> {
        let Some((scheduled_run, source)) = session_shape(self.conn(), session_id)? else {
            return Ok(None);
        };
        if scheduled_run {
            return Ok(Some(ExtractionInputOutcome::Skipped(SKIP_SCHEDULED_RUN)));
        }
        if source.is_some() {
            return Ok(Some(ExtractionInputOutcome::Skipped(SKIP_IMPORTED)));
        }
        let Some(scopes) = self.learned_memory_scopes_for_session(session_id)? else {
            return Ok(None);
        };
        let state = self.memory_session_state(session_id)?;
        if state.as_ref().is_some_and(|state| state.excluded) {
            return Ok(Some(ExtractionInputOutcome::Skipped(SKIP_EXCLUDED)));
        }
        let cursor = state.as_ref().map(|state| state.cursor_seq).unwrap_or(0);

        let summary = transcripts::read_compactions(self.data_dir(), session_id)?
            .pop()
            .map(|compaction| {
                let (text, truncated) =
                    truncate_to_bytes(&compaction.summary, EXTRACTION_SUMMARY_MAX_BYTES);
                ExtractionSummary {
                    text,
                    truncated,
                    created_at: ts_to_ms(&compaction.created_at),
                }
            })
            .filter(|summary| !summary.text.trim().is_empty());

        let mut bytes = 0;
        if let Some(summary) = &summary {
            bytes += summary.text.len() + EXTRACTION_MESSAGE_OVERHEAD_BYTES;
        }
        let mut messages = Vec::new();
        for (id, seq, text, created_at) in user_messages_after(self.conn(), session_id, cursor)? {
            let cost = text.len() + EXTRACTION_MESSAGE_OVERHEAD_BYTES;
            if bytes + cost > EXTRACTION_INPUT_MAX_BYTES {
                // A later message that does not fit waits for the next run. The
                // **first** one of a range is different: skipping it would leave
                // the cursor before it forever, so every message after it would
                // never be read either. Cutting it keeps the range moving, and
                // what it says is still citable as far as it was sent.
                if messages.is_empty() {
                    let Some(budget) = EXTRACTION_INPUT_MAX_BYTES
                        .checked_sub(bytes + EXTRACTION_MESSAGE_OVERHEAD_BYTES)
                    else {
                        break;
                    };
                    let (text, _truncated) = truncate_to_bytes(&text, budget);
                    if text.is_empty() {
                        break;
                    }
                    bytes += text.len() + EXTRACTION_MESSAGE_OVERHEAD_BYTES;
                    messages.push(ExtractionMessage {
                        id,
                        seq,
                        text,
                        created_at,
                        truncated: true,
                    });
                }
                break;
            }
            bytes += cost;
            messages.push(ExtractionMessage {
                id,
                seq,
                text,
                created_at,
                truncated: false,
            });
        }

        let scope = scopes
            .into_iter()
            .find(|scope| scope.kind == SCOPE_PROJECT)
            .unwrap_or_else(MemoryScope::user);
        Ok(Some(ExtractionInputOutcome::Input(ExtractionInput {
            session_id: session_id.to_string(),
            scope_kind: scope.kind.to_string(),
            scope_key: scope.key,
            cursor_seq: cursor,
            messages,
            summary,
            bytes,
        })))
    }
}
