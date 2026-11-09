//! The plugin-facing feed, summary, and transcript reads (ADR
//! conversation-archive §§4, 5, 8).
//!
//! The feed answers "what changed since my cursor" without a second table: the
//! cursor is `(changed_at, session_id)`, where `changed_at` is the newer of the
//! session row and its summary row. A deletion has to appear there too, so the
//! two sources of "gone" are folded in:
//!
//! - a soft-deleted or excluded session is still in `sessions`, and is reported
//!   with `removed: true`;
//! - a permanently deleted session is not, so its id lives on in
//!   `conversation_archive_tombstones` until a reader has passed it. Clearing
//!   the tombstone from a read is deliberate: it is the only place that knows
//!   the row has been delivered.

use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::{json, Value};

use crate::db::Database;

use super::project_identity::project_identity;
use super::projection::{project_transcript, ConversationTurn};
use super::repo::ConversationSummaryState;

/// Rows one page may carry.
pub(crate) const CHANGES_MAX_LIMIT: i64 = 100;
/// Turns one page may carry.
pub(crate) const TRANSCRIPT_MAX_LIMIT: i64 = 200;
/// Tombstones one read may deliver, so a long-neglected plugin catches up in
/// several pages instead of one oversized answer.
const TOMBSTONES_PER_PAGE: i64 = 100;

/// One archived session, as the change feed lists it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConversationChange {
    pub session_id: String,
    pub title: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub project: Option<Value>,
    pub last_seq: i64,
    pub summary_revision: Option<i64>,
    pub removed: bool,
}

/// The cursor is `(changed_at, session_id)` so two rows written in the same
/// millisecond still order deterministically and neither is skipped.
fn parse_cursor(cursor: &str) -> Option<(i64, String)> {
    let (at, id) = cursor.split_once(':')?;
    Some((at.parse::<i64>().ok()?, id.to_string()))
}

fn format_cursor(at: i64, session_id: &str) -> String {
    format!("{at}:{session_id}")
}

fn project_value(conn: &Connection, project_id: Option<i64>) -> Option<Value> {
    let id = project_id?;
    let row: Option<(String, String)> = conn
        .query_row(
            "SELECT name, path FROM projects WHERE id = ?1",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .ok()
        .flatten();
    let (name, path) = row?;
    serde_json::to_value(project_identity(&name, &path)).ok()
}

/// One page of the change feed.
pub(crate) fn changes_page(db: &Database, cursor: Option<&str>, limit: i64) -> Result<Value> {
    let limit = limit.clamp(1, CHANGES_MAX_LIMIT);
    let after = cursor.and_then(parse_cursor).unwrap_or((0, String::new()));
    let conn = db.conn();

    // A session that the plugin has already been told is gone, and that is still
    // gone, must not reappear at the head of every page: `covered` marks a row
    // whose removal the reader has consumed.
    let mut statement = conn.prepare_cached(
        "SELECT s.id,
                s.title,
                s.created_at,
                MAX(s.updated_at, IFNULL(cs.updated_at, s.updated_at)) AS changed_at,
                s.project_id,
                s.last_seq,
                cs.revision,
                CASE
                  WHEN s.deleted_at IS NOT NULL THEN 1
                  WHEN IFNULL(ms.excluded, 0) = 1 THEN 1
                  WHEN IFNULL(cs.revision, 0) > 0 THEN 0
                  ELSE 2
                END AS state
           FROM sessions s
           LEFT JOIN conversation_summaries cs ON cs.session_id = s.id
           LEFT JOIN memory_session_state ms ON ms.session_id = s.id
          ORDER BY changed_at ASC, s.id ASC",
    )?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, Option<i64>>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, Option<i64>>(6)?,
                row.get::<_, i64>(7)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let mut items: Vec<ConversationChange> = Vec::new();
    let mut last_cursor: Option<(i64, String)> = None;
    for (session_id, title, created_at, changed_at, project_id, last_seq, revision, state) in rows {
        if (changed_at, session_id.as_str()) <= (after.0, after.1.as_str()) {
            continue;
        }
        if items.len() as i64 >= limit {
            break;
        }
        // `state == 2` is a session with neither a summary nor a removal: it is
        // still being summarized, so listing it would hand the plugin a file to
        // write before there is anything to write. Its summary's `updated_at`
        // brings it back on the page that follows the run.
        if state == 2 {
            continue;
        }
        let removed = state == 1;
        items.push(ConversationChange {
            session_id: session_id.clone(),
            title,
            created_at,
            updated_at: changed_at,
            project: if removed {
                None
            } else {
                project_value(conn, project_id)
            },
            last_seq,
            summary_revision: if removed { None } else { revision },
            removed,
        });
        last_cursor = Some((changed_at, session_id));
    }

    // Permanently deleted sessions have no row left to page, so the tombstones
    // are drained here, in their own time order, and then forgotten: the page
    // that carried them to the plugin is the last time anything needs them.
    let mut tombstones = conn.prepare_cached(
        "SELECT session_id, deleted_at FROM conversation_archive_tombstones
          ORDER BY deleted_at ASC, session_id ASC LIMIT ?1",
    )?;
    let pending = tombstones
        .query_map(params![TOMBSTONES_PER_PAGE], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut delivered: Vec<String> = Vec::new();
    for (session_id, deleted_at) in pending {
        if items.len() as i64 >= limit {
            break;
        }
        if (deleted_at, session_id.as_str()) <= (after.0, after.1.as_str()) {
            continue;
        }
        items.push(ConversationChange {
            session_id: session_id.clone(),
            title: String::new(),
            created_at: 0,
            updated_at: deleted_at,
            project: None,
            last_seq: 0,
            summary_revision: None,
            removed: true,
        });
        delivered.push(session_id.clone());
        if last_cursor
            .as_ref()
            .is_none_or(|(at, id)| (deleted_at, session_id.as_str()) > (*at, id.as_str()))
        {
            last_cursor = Some((deleted_at, session_id));
        }
    }
    for session_id in &delivered {
        // Re-created in the meantime? Then the fresh session is a live row and
        // the plugin must not be told it is gone; the tombstone goes anyway.
        conn.execute(
            "DELETE FROM conversation_archive_tombstones WHERE session_id = ?1",
            params![session_id],
        )?;
    }

    let next_cursor = last_cursor.map(|(at, id)| format_cursor(at, &id));
    Ok(json!({
        "enabled": true,
        "items": items,
        "nextCursor": next_cursor,
    }))
}

/// The stored summary of one session, in the plugin's shape.
pub(crate) fn summary_for_plugin(db: &Database, session_id: &str) -> Result<Value> {
    let state: Option<ConversationSummaryState> = db.conversation_summary_state(session_id)?;
    let Some(state) = state else {
        return Ok(Value::Null);
    };
    if state.revision <= 0 {
        return Ok(Value::Null);
    }
    let summary = state.summary.unwrap_or_default();
    Ok(json!({
        "revision": state.revision,
        "coveredSeq": state.covered_seq,
        "summary": summary,
    }))
}

/// One turn-ordered page of the redacted transcript.
pub(crate) fn transcript_page(
    db: &Database,
    session_id: &str,
    from_turn: i64,
    limit: i64,
) -> Result<Option<Value>> {
    let limit = limit.clamp(1, TRANSCRIPT_MAX_LIMIT);
    let exists: Option<i64> = db
        .conn()
        .query_row(
            "SELECT 1 FROM sessions WHERE id = ?1 AND deleted_at IS NULL",
            params![session_id],
            |row| row.get(0),
        )
        .optional()?;
    if exists.is_none() {
        return Ok(None);
    }
    let read = crate::transcripts::read_transcript_with_compactions(db.data_dir(), session_id)?;
    let turns: Vec<ConversationTurn> = project_transcript(&read.messages, &read.compactions);
    let start = usize::try_from(from_turn.max(0))
        .unwrap_or(usize::MAX)
        .min(turns.len());
    let end = start
        .saturating_add(usize::try_from(limit).unwrap_or(0))
        .min(turns.len());
    let page = turns[start..end].to_vec();
    let next_turn = (end < turns.len()).then_some(end);
    let last_seq: i64 = db
        .conn()
        .query_row(
            "SELECT IFNULL(MAX(seq), 0) FROM messages WHERE session_id = ?1",
            params![session_id],
            |row| row.get(0),
        )
        .unwrap_or(0);
    Ok(Some(json!({
        "turns": page,
        "nextTurn": next_turn,
        "lastSeq": last_seq,
    })))
}
