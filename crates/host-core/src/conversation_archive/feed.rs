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
//!   `conversation_archive_tombstones` until a reader has passed it.
//!
//! A removal is delivered **at least once**. Reading never deletes a tombstone:
//! a plugin that receives the page and then crashes before it deletes the file
//! still finds the notice on its next request with the same cursor, so content
//! the user deleted cannot survive in a synced folder. A tombstone is cleared
//! only when a request proves the notice was handled — either its cursor has
//! moved past the notice (a later read uses that position), or the session id
//! exists again, so the live row speaks for itself.
//!
//! A session that has no summary yet is listed too, with `summaryRevision:
//! null`: the transcript does not depend on a model, so a plugin may write L3
//! while the budget-paced summary catches up.

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

/// One candidate row of the feed: a session, or a removal notice.
struct FeedRow {
    session_id: String,
    changed_at: i64,
    /// `Some` for a live session, `None` for a tombstone.
    session: Option<SessionRow>,
}

struct SessionRow {
    title: String,
    created_at: i64,
    project_id: Option<i64>,
    last_seq: i64,
    revision: Option<i64>,
    removed: bool,
}

/// `sessions` rows that changed after `after`, newest page first: the cursor
/// predicate is in SQL so the scan stops at the page instead of walking every
/// session and filtering in Rust.
fn session_rows(conn: &Connection, after: &(i64, String), remaining: i64) -> Result<Vec<FeedRow>> {
    let mut statement = conn.prepare_cached(
        "WITH feed AS (
             SELECT s.id,
                    s.title,
                    s.created_at,
                    s.project_id,
                    s.last_seq,
                    cs.revision,
                    CASE
                      WHEN s.deleted_at IS NOT NULL THEN 1
                      WHEN IFNULL(ms.excluded, 0) = 1 THEN 1
                      ELSE 0
                    END AS removed,
                    MAX(s.updated_at, IFNULL(cs.updated_at, s.updated_at)) AS changed_at
               FROM sessions s
               LEFT JOIN conversation_summaries cs ON cs.session_id = s.id
               LEFT JOIN memory_session_state ms ON ms.session_id = s.id
         )
         SELECT id, title, created_at, project_id, last_seq, revision, removed, changed_at
           FROM feed
          WHERE changed_at > ?1 OR (changed_at = ?1 AND id > ?2)
          ORDER BY changed_at ASC, id ASC
          LIMIT ?3",
    )?;
    let rows = statement
        .query_map(params![after.0, after.1, remaining], |row| {
            Ok(FeedRow {
                session_id: row.get(0)?,
                changed_at: row.get(7)?,
                session: Some(SessionRow {
                    title: row.get(1)?,
                    created_at: row.get(2)?,
                    project_id: row.get(3)?,
                    last_seq: row.get(4)?,
                    revision: row.get(5)?,
                    removed: row.get::<_, i64>(6)? == 1,
                }),
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// `conversation_archive_tombstones` rows after `after`, bounded per page.
fn tombstone_rows(
    conn: &Connection,
    after: &(i64, String),
    remaining: i64,
) -> Result<Vec<FeedRow>> {
    let mut statement = conn.prepare_cached(
        "SELECT session_id, deleted_at
           FROM conversation_archive_tombstones
          WHERE deleted_at > ?1 OR (deleted_at = ?1 AND session_id > ?2)
          ORDER BY deleted_at ASC, session_id ASC
          LIMIT ?3",
    )?;
    let rows = statement
        .query_map(params![after.0, after.1, remaining], |row| {
            Ok(FeedRow {
                session_id: row.get(0)?,
                changed_at: row.get(1)?,
                session: None,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// Drop the tombstones the requester has provably handled.
///
/// `at` is the cursor position this request starts from: everything at or
/// before it was on an earlier page, so those notices are done. `answered`
/// holds the live sessions this request is returning: a session that exists
/// again contradicts its own notice, and the plugin's read of the live row is
/// the newest word either way.
fn clear_handled_tombstones(
    conn: &Connection,
    at: &(i64, String),
    answered: &[&str],
) -> Result<()> {
    conn.execute(
        "DELETE FROM conversation_archive_tombstones
          WHERE deleted_at < ?1 OR (deleted_at = ?1 AND session_id <= ?2)",
        params![at.0, at.1],
    )?;
    for session_id in answered {
        // Only a session that is still alive clears its own notice; a tombstone
        // written while a row existed (a purge that has not finished) stays.
        conn.execute(
            "DELETE FROM conversation_archive_tombstones
              WHERE session_id = ?1
                AND EXISTS (SELECT 1 FROM sessions s WHERE s.id = ?1)",
            params![session_id],
        )?;
    }
    Ok(())
}

/// One page of the change feed.
///
/// The cursor the caller presents is the last position it handled. This read
/// therefore (a) clears what that cursor proves was handled, and (b) answers
/// everything after it, merging sessions and removal notices into one ordered
/// stream so pages never interleave two sequences.
pub(crate) fn changes_page(db: &Database, cursor: Option<&str>, limit: i64) -> Result<Value> {
    let limit = limit.clamp(1, CHANGES_MAX_LIMIT);
    let conn = db.conn();
    let parsed = cursor.and_then(parse_cursor);
    let after = parsed.clone().unwrap_or((0, String::new()));

    // A first request has acknowledged nothing; any other request has handled
    // everything up to its cursor.
    let acknowledged = parsed.as_ref();

    let mut candidates = session_rows(conn, &after, limit)?;
    candidates.extend(tombstone_rows(conn, &after, limit)?);
    candidates.sort_by(|a, b| {
        (a.changed_at, a.session_id.as_str()).cmp(&(b.changed_at, b.session_id.as_str()))
    });

    let mut items: Vec<ConversationChange> = Vec::new();
    let mut last_cursor: Option<(i64, String)> = None;
    for row in candidates {
        if items.len() as i64 >= limit {
            break;
        }
        let item = match row.session {
            None => ConversationChange {
                session_id: row.session_id.clone(),
                title: String::new(),
                created_at: 0,
                updated_at: row.changed_at,
                project: None,
                last_seq: 0,
                summary_revision: None,
                removed: true,
            },
            Some(session) => ConversationChange {
                session_id: row.session_id.clone(),
                title: session.title,
                created_at: session.created_at,
                updated_at: row.changed_at,
                project: if session.removed {
                    None
                } else {
                    project_value(conn, session.project_id)
                },
                last_seq: session.last_seq,
                // `null` means "no summary yet": the transcript is still the
                // plugin's to write, and the summary arrives on a later page.
                // A row that exists but has never been written carries revision
                // zero, which is the same answer.
                summary_revision: if session.removed {
                    None
                } else {
                    session.revision.filter(|revision| *revision > 0)
                },
                removed: session.removed,
            },
        };
        items.push(item);
        last_cursor = Some((row.changed_at, row.session_id));
    }

    if let Some(acknowledged) = acknowledged {
        let answered: Vec<&str> = items
            .iter()
            .filter(|item| !item.removed)
            .map(|item| item.session_id.as_str())
            .collect();
        clear_handled_tombstones(conn, acknowledged, &answered)?;
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
