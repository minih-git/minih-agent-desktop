//! Stored summaries and the summary generator's state (ADR
//! conversation-archive §§3, 6).
//!
//! Everything the generator needs to be idempotent lives here: the cursor that
//! says how far a summary reaches, the lease that makes one run the only writer
//! of that range, the attempt counter that stops a session from retrying
//! forever, and the revision that tells a plugin whether the file it wrote is
//! still current. A restart, a duplicate trigger, and a renderer reload all read
//! the same rows, so none of them can repeat a range or lose one.
//!
//! The summary itself is a fixed set of fields rather than free prose: the
//! plugin writes them into a note's sections, and a shape the model cannot vary
//! is a shape the host can validate.

use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::db::{now_ms, Database};

use super::projection::project_transcript;

/// Bytes one summary run may spend on the new conversation text. Above this the
/// run keeps the newest part and says so, because the previous summary already
/// carries the older meaning.
pub(crate) const ARCHIVE_INPUT_MAX_BYTES: usize = 24 * 1024;
/// Longest error code stored on a row; codes only, never content.
const MAX_ARCHIVE_ERROR_CHARS: usize = 64;
/// Entries one summary field may carry.
const MAX_SUMMARY_ITEMS: usize = 40;
/// Longest one summary entry may be.
const MAX_SUMMARY_ITEM_CHARS: usize = 400;
/// Longest goal, tag, or file entry the host stores.
const MAX_SUMMARY_TEXT_CHARS: usize = 2_000;

pub(crate) const SKIP_EXCLUDED: &str = "excluded";
pub(crate) const SKIP_SCHEDULED_RUN: &str = "scheduled-run";
pub(crate) const SKIP_IMPORTED: &str = "imported";
pub(crate) const SKIP_MISSING: &str = "missing";

/// The fixed-field summary of one conversation.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct ConversationSummary {
    pub goal: String,
    pub decisions: Vec<String>,
    pub outcomes: Vec<String>,
    pub files: Vec<String>,
    pub open_items: Vec<String>,
    pub tags: Vec<String>,
}

fn bounded_entry(text: &str, limit: usize) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= limit {
        return trimmed.to_string();
    }
    trimmed.chars().take(limit).collect::<String>() + "…"
}

fn bounded_list(values: &[String], limit: usize) -> Vec<String> {
    let mut out = Vec::new();
    for value in values.iter().take(MAX_SUMMARY_ITEMS) {
        let entry = bounded_entry(value, limit);
        if !entry.is_empty() && !out.contains(&entry) {
            out.push(entry);
        }
    }
    out
}

impl ConversationSummary {
    /// Project whatever the model answered onto the stored shape.
    ///
    /// The model is asked for exactly these fields; this is where an extra
    /// field, a missing field, or an oversized entry is reduced to something the
    /// store and the note format can hold.
    pub(crate) fn from_model_value(value: &Value) -> Self {
        let text = |key: &str| {
            value
                .get(key)
                .and_then(Value::as_str)
                .map(|text| bounded_entry(text, MAX_SUMMARY_TEXT_CHARS))
                .unwrap_or_default()
        };
        let list = |key: &str, limit: usize| -> Vec<String> {
            value
                .get(key)
                .and_then(Value::as_array)
                .map(|items| {
                    let strings: Vec<String> = items
                        .iter()
                        .filter_map(|item| match item {
                            Value::String(text) => Some(text.clone()),
                            Value::Null => None,
                            other => Some(other.to_string()),
                        })
                        .collect();
                    bounded_list(&strings, limit)
                })
                .unwrap_or_default()
        };
        Self {
            goal: text("goal"),
            decisions: list("decisions", MAX_SUMMARY_ITEM_CHARS),
            outcomes: list("outcomes", MAX_SUMMARY_ITEM_CHARS),
            files: list("files", 240),
            open_items: list("openItems", MAX_SUMMARY_ITEM_CHARS),
            tags: list("tags", 48),
        }
    }

    /// A summary that says nothing is not worth a revision or a file rewrite.
    pub(crate) fn is_empty(&self) -> bool {
        self.goal.is_empty()
            && self.decisions.is_empty()
            && self.outcomes.is_empty()
            && self.files.is_empty()
            && self.open_items.is_empty()
            && self.tags.is_empty()
    }
}

/// The stored state of one session's summary: cursor, lease, attempts.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConversationSummaryState {
    pub session_id: String,
    pub covered_seq: i64,
    pub revision: i64,
    pub attempts: i64,
    pub last_error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<ConversationSummary>,
}

/// What one summary run may read.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConversationArchiveInput {
    pub session_id: String,
    pub title: String,
    /// The next message sequence to read.
    pub cursor_seq: i64,
    pub revision: i64,
    /// The previous summary, when there is one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous: Option<ConversationSummary>,
    /// The new conversation text, one line per tool call, oldest first.
    pub text: String,
    /// True when older new text was dropped to fit the byte budget.
    pub truncated: bool,
    pub bytes: usize,
    /// Messages this run covered (one past the last sequence it read).
    pub next_cursor_seq: i64,
}

// The input is the payload of interest and the skip code is a pointer-sized
// marker; boxing the range would add an allocation per read for no gain.
#[allow(clippy::large_enum_variant)]
pub(crate) enum ConversationArchiveInputOutcome {
    Input(ConversationArchiveInput),
    Skipped(&'static str),
}

const STATE_COLUMNS: &str = "session_id, covered_seq, revision, summary_json, model_key, \
     lease_owner, lease_until, attempts, last_error, updated_at";

fn state_from_row(row: &Row<'_>) -> rusqlite::Result<ConversationSummaryState> {
    let raw: Option<String> = row.get(3)?;
    Ok(ConversationSummaryState {
        session_id: row.get(0)?,
        covered_seq: row.get(1)?,
        revision: row.get(2)?,
        attempts: row.get(7)?,
        last_error: row.get(8)?,
        summary: raw.and_then(|text| serde_json::from_str::<ConversationSummary>(&text).ok()),
    })
}

fn state(conn: &Connection, session_id: &str) -> Result<Option<ConversationSummaryState>> {
    let sql = format!("SELECT {STATE_COLUMNS} FROM conversation_summaries WHERE session_id = ?1");
    conn.query_row(&sql, params![session_id], state_from_row)
        .optional()
        .map_err(Into::into)
}

fn ensure_state(conn: &Connection, session_id: &str) -> Result<()> {
    conn.execute(
        "INSERT OR IGNORE INTO conversation_summaries (session_id, updated_at)
         VALUES (?1, ?2)",
        params![session_id, now_ms()],
    )?;
    Ok(())
}

fn bounded_error(error: &str) -> String {
    error.chars().take(MAX_ARCHIVE_ERROR_CHARS).collect()
}

/// One line of the projection, for the summary prompt.
fn transcript_lines(turns: &[super::projection::ConversationTurn]) -> Vec<String> {
    let mut lines = Vec::new();
    for turn in turns {
        if let Some(marker) = &turn.compaction {
            lines.push(format!("[{}]", marker));
        }
        lines.push(format!("### user\n{}", turn.user));
        if !turn.assistant.trim().is_empty() {
            lines.push(format!("### assistant\n{}", turn.assistant));
        }
        for tool in &turn.tools {
            lines.push(format!("- {}", tool.line));
        }
    }
    lines
}

impl Database {
    /// One session's stored summary, or `None` when it has never been written.
    pub(crate) fn conversation_summary_state(
        &self,
        session_id: &str,
    ) -> Result<Option<ConversationSummaryState>> {
        state(self.conn(), session_id)
    }

    /// Sessions the backfill queue should work on, newest first.
    ///
    /// A session is a candidate when it still exists, was not excluded, is not
    /// an automation run or an imported conversation, and has no summary yet.
    /// Newest first is what the user asked for: recent work is archived before
    /// old work.
    pub(crate) fn conversation_archive_queue(&self, limit: i64) -> Result<Vec<String>> {
        let mut statement = self.conn().prepare_cached(
            "SELECT s.id
               FROM sessions s
               LEFT JOIN conversation_summaries cs ON cs.session_id = s.id
               LEFT JOIN memory_session_state ms ON ms.session_id = s.id
              WHERE s.deleted_at IS NULL
                AND s.source IS NULL
                AND IFNULL(ms.excluded, 0) = 0
                AND IFNULL(cs.revision, 0) = 0
                AND NOT EXISTS (SELECT 1 FROM task_runs r WHERE r.session_id = s.id)
              ORDER BY s.updated_at DESC, s.id DESC
              LIMIT ?1",
        )?;
        let rows = statement
            .query_map(params![limit.max(1)], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// Take the summary lease for one session.
    ///
    /// `None` when another run holds an unexpired lease or the user excluded the
    /// session, so a duplicate trigger coalesces into a no-op.
    pub(crate) fn claim_conversation_summary(
        &self,
        session_id: &str,
        owner: &str,
        lease_ms: i64,
    ) -> Result<Option<ConversationSummaryState>> {
        let tx = self.conn().unchecked_transaction()?;
        let excluded: Option<i64> = tx
            .query_row(
                "SELECT excluded FROM memory_session_state WHERE session_id = ?1",
                params![session_id],
                |row| row.get(0),
            )
            .optional()?;
        if excluded == Some(1) {
            return Ok(None);
        }
        ensure_state(&tx, session_id)?;
        let now = now_ms();
        let changed = tx.execute(
            "UPDATE conversation_summaries
                SET lease_owner = ?1, lease_until = ?2
              WHERE session_id = ?3
                AND (lease_until IS NULL OR lease_until <= ?4)",
            params![owner, now + lease_ms.max(1_000), session_id, now],
        )?;
        if changed == 0 {
            return Ok(None);
        }
        let claimed = state(&tx, session_id)?;
        tx.commit()?;
        Ok(claimed)
    }

    /// Release a lease without recording a failure: nothing to read yet.
    pub(crate) fn release_conversation_summary(
        &self,
        session_id: &str,
        owner: &str,
    ) -> Result<Option<ConversationSummaryState>> {
        let tx = self.conn().unchecked_transaction()?;
        tx.execute(
            "UPDATE conversation_summaries
                SET lease_owner = NULL, lease_until = NULL, updated_at = ?1
              WHERE session_id = ?2 AND lease_owner = ?3",
            params![now_ms(), session_id, owner],
        )?;
        let released = state(&tx, session_id)?;
        tx.commit()?;
        Ok(released)
    }

    /// Store a summary and advance the cursor, only while this run holds the
    /// lease. The revision is the plugin's signal that a file is stale.
    pub(crate) fn complete_conversation_summary(
        &self,
        session_id: &str,
        owner: &str,
        cursor_seq: i64,
        model_key: &str,
        summary: &ConversationSummary,
    ) -> Result<Option<ConversationSummaryState>> {
        let tx = self.conn().unchecked_transaction()?;
        let json = serde_json::to_string(summary)?;
        let changed = tx.execute(
            "UPDATE conversation_summaries
                SET summary_json = ?1, model_key = ?2,
                    covered_seq = MAX(covered_seq, ?3),
                    revision = revision + 1,
                    attempts = 0, last_error = NULL,
                    lease_owner = NULL, lease_until = NULL,
                    updated_at = ?4
              WHERE session_id = ?5 AND lease_owner = ?6",
            params![
                json,
                model_key,
                cursor_seq.max(0),
                now_ms(),
                session_id,
                owner
            ],
        )?;
        if changed == 0 {
            return Ok(None);
        }
        let updated = state(&tx, session_id)?;
        tx.commit()?;
        Ok(updated)
    }

    /// Record a failed run: the cursor stays put, the lease is released.
    pub(crate) fn fail_conversation_summary(
        &self,
        session_id: &str,
        owner: &str,
        error: &str,
    ) -> Result<Option<ConversationSummaryState>> {
        let tx = self.conn().unchecked_transaction()?;
        tx.execute(
            "UPDATE conversation_summaries
                SET attempts = attempts + 1, last_error = ?1,
                    lease_owner = NULL, lease_until = NULL, updated_at = ?2
              WHERE session_id = ?3 AND lease_owner = ?4",
            params![bounded_error(error), now_ms(), session_id, owner],
        )?;
        let updated = state(&tx, session_id)?;
        tx.commit()?;
        Ok(updated)
    }

    /// What one summary run may read, or why the session is out of scope.
    pub(crate) fn conversation_archive_input(
        &self,
        session_id: &str,
    ) -> Result<Option<ConversationArchiveInputOutcome>> {
        let Some((title, deleted, source)) = self
            .conn()
            .query_row(
                "SELECT title, deleted_at, source FROM sessions WHERE id = ?1",
                params![session_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<i64>>(1)?,
                        row.get::<_, Option<String>>(2)?,
                    ))
                },
            )
            .optional()?
        else {
            return Ok(None);
        };
        if deleted.is_some() {
            return Ok(Some(ConversationArchiveInputOutcome::Skipped(SKIP_MISSING)));
        }
        if source.is_some() {
            return Ok(Some(ConversationArchiveInputOutcome::Skipped(
                SKIP_IMPORTED,
            )));
        }
        let scheduled_run = self.conn().query_row(
            "SELECT COUNT(*) FROM task_runs WHERE session_id = ?1",
            params![session_id],
            |row| row.get::<_, i64>(0),
        )? > 0;
        if scheduled_run {
            return Ok(Some(ConversationArchiveInputOutcome::Skipped(
                SKIP_SCHEDULED_RUN,
            )));
        }
        let excluded = self
            .memory_session_state(session_id)?
            .is_some_and(|state| state.excluded);
        if excluded {
            return Ok(Some(ConversationArchiveInputOutcome::Skipped(
                SKIP_EXCLUDED,
            )));
        }
        let current = state(self.conn(), session_id)?;
        let cursor = current.as_ref().map(|state| state.covered_seq).unwrap_or(0);
        let revision = current.as_ref().map(|state| state.revision).unwrap_or(0);
        let previous = current.and_then(|state| state.summary);

        // The transcript in force is the source: a compaction appends a
        // checkpoint and keeps the messages, so nothing the user wrote is
        // hidden behind one (ADR §6).
        let read =
            crate::transcripts::read_transcript_with_compactions(self.data_dir(), session_id)?;
        let turns = project_transcript(&read.messages, &read.compactions);
        let last_seq = self
            .conn()
            .query_row(
                "SELECT IFNULL(MAX(seq), 0) FROM messages WHERE session_id = ?1",
                params![session_id],
                |row| row.get::<_, i64>(0),
            )
            .unwrap_or(cursor);
        if last_seq <= cursor {
            return Ok(Some(ConversationArchiveInputOutcome::Skipped("up-to-date")));
        }

        let lines = transcript_lines(&turns);
        let mut kept: Vec<&String> = Vec::new();
        let mut bytes = 0usize;
        for line in lines.iter().rev() {
            let cost = line.len() + 1;
            if bytes + cost > ARCHIVE_INPUT_MAX_BYTES {
                break;
            }
            bytes += cost;
            kept.push(line);
        }
        kept.reverse();
        let truncated = kept.len() < lines.len();
        let text = kept
            .iter()
            .map(|line| line.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        let next_cursor_seq = last_seq.max(cursor);
        Ok(Some(ConversationArchiveInputOutcome::Input(
            ConversationArchiveInput {
                session_id: session_id.to_string(),
                title,
                cursor_seq: cursor,
                revision,
                previous,
                text,
                truncated,
                bytes,
                next_cursor_seq,
            },
        )))
    }
}

/// Record a permanent deletion so a plugin can delete the file it wrote.
///
/// The row is content-free: an id and a timestamp. It is written before the
/// session row disappears, because after that no other table can name it.
pub(crate) fn record_archive_tombstone(db: &Database, session_id: &str) -> Result<()> {
    db.conn().execute(
        "INSERT OR REPLACE INTO conversation_archive_tombstones (session_id, deleted_at)
         VALUES (?1, ?2)",
        params![session_id, now_ms()],
    )?;
    db.conn().execute(
        "DELETE FROM conversation_summaries WHERE session_id = ?1",
        params![session_id],
    )?;
    Ok(())
}
