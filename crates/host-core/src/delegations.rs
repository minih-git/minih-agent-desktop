//! Read-only projection of one session's delegation rows.
//!
//! The renderer owns the delegation semantics: `Task` is the only tool that
//! starts a subagent, lifecycle tools report on existing ones, and a `resume`
//! link joins later calls into the same chain. Duplicating that vocabulary in
//! Rust would create a second source of truth that can drift from
//! `tool-display.ts` and `subagent-topology.ts`.
//!
//! What the renderer cannot do is see the whole session: its reading window is
//! bounded on purpose, so the oldest `Task` rows fall out of memory. This
//! module supplies exactly those canonical rows for the full transcript, and
//! nothing else: no derived status, no grouping, and no names invented here.

use anyhow::Result;
use serde_json::Value;

use crate::db::Database;
use crate::sessions::{dedupe_records, record_to_ui, UiMessage};
use crate::transcripts::{self, MessageRecord};

/// How many bytes of any one tool payload the roster keeps. The roster needs
/// the `Task` brief and agent, result counters, and a bounded preview of a
/// delegate's latest step; a multi-megabyte patch or log line must not cross
/// the IPC boundary on every refresh.
const TOOL_PAYLOAD_LIMIT: usize = 8 * 1024;

/// Beyond this nesting depth a container keeps only its first entries. Real
/// tool payloads never approach it; this only bounds adversarial JSON.
const MAX_PAYLOAD_DEPTH: usize = 24;

/// Normalize a tool name exactly like the renderer's `bareToolName`: take the
/// last provider-namespaced segment, lowercase it, and drop punctuation. A
/// mismatch here would admit a plugin tool called `CreateTask`, or hide a real
/// `functions.Task`.
fn bare_tool_name(name: &str) -> String {
    name.split('.')
        .next_back()
        .unwrap_or(name)
        .to_ascii_lowercase()
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .collect()
}

/// The tool that starts a delegation plus the three lifecycle tools
/// (ADR 0062, ADR 0089).
pub(crate) fn is_delegation_tool_name(name: &str) -> bool {
    matches!(
        bare_tool_name(name).as_str(),
        "task" | "subagent" | "taskwait" | "tasklist" | "taskstop"
    )
}

fn is_lifecycle_tool_name(name: &str) -> bool {
    matches!(
        bare_tool_name(name).as_str(),
        "taskwait" | "tasklist" | "taskstop"
    )
}

fn bounded_payload(value: Value) -> Value {
    if value.to_string().len() <= TOOL_PAYLOAD_LIMIT {
        return value;
    }
    bounded_value(&value, 0)
}

fn is_scalar(value: &Value) -> bool {
    matches!(
        value,
        Value::String(_) | Value::Number(_) | Value::Bool(_) | Value::Null
    )
}

/// Keep a payload's shape while bounding oversized leaves.
///
/// Only leaf values are trimmed, and a container is always returned as the
/// same container type. Replacing a nested object with a string would make
/// `details.delegationId` unreadable, which is exactly the field the roster
/// needs; bounding must therefore never collapse the path to it.
fn bounded_value(value: &Value, depth: usize) -> Value {
    match value {
        Value::String(text) if text.len() > TOOL_PAYLOAD_LIMIT => {
            let mut cut = TOOL_PAYLOAD_LIMIT.min(text.len());
            while cut > 0 && !text.is_char_boundary(cut) {
                cut -= 1;
            }
            Value::String(format!("{}…", &text[..cut]))
        }
        Value::Array(items) if depth >= MAX_PAYLOAD_DEPTH => Value::Array(
            items
                .iter()
                .take(1)
                .map(|item| {
                    if is_scalar(item) {
                        item.clone()
                    } else {
                        Value::String("[truncated]".into())
                    }
                })
                .collect(),
        ),
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|item| bounded_value(item, depth + 1))
                .collect(),
        ),
        Value::Object(map) if depth >= MAX_PAYLOAD_DEPTH => Value::Object(
            map.iter()
                .take(8)
                .map(|(key, item)| {
                    let kept = if is_scalar(item) {
                        item.clone()
                    } else {
                        Value::String("[truncated]".into())
                    };
                    (key.clone(), kept)
                })
                .collect(),
        ),
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(key, item)| (key.clone(), bounded_value(item, depth + 1)))
                .collect(),
        ),
        other => other.clone(),
    }
}

/// Whether one persisted row belongs to the roster projection.
///
/// A delegate's own rows carry `parentToolCallId`; a start call carries the
/// delegation id in its result; a lifecycle call reports the statuses of
/// delegates whose own rows may be outside this page. Everything else — the
/// ordinary conversation between delegations — is excluded, which is what
/// keeps this payload small in a long session.
fn is_delegation_row(record: &MessageRecord) -> bool {
    if record
        .meta
        .as_ref()
        .and_then(|meta| meta.get("parentToolCallId"))
        .and_then(Value::as_str)
        .is_some_and(|value| !value.is_empty())
    {
        return true;
    }
    let tool_name = match record.tool_name.as_deref() {
        Some(name) => name,
        None => return false,
    };
    if record.role != "tool" || !is_delegation_tool_name(tool_name) {
        return false;
    }
    if is_lifecycle_tool_name(tool_name) {
        return true;
    }
    // A rejected `Task` (unknown agent, empty brief) has no delegation id and
    // must not become a roster entry, matching `rebuildChainsFromTranscript`.
    record
        .blocks
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|block| block.get("result"))
        .filter_map(|result| result.get("details"))
        .any(|details| {
            details
                .get("delegationId")
                .and_then(Value::as_str)
                .is_some_and(|id| !id.is_empty())
        })
}

fn bounded_record(mut record: MessageRecord) -> MessageRecord {
    if let Value::Array(blocks) = &mut record.blocks {
        for block in blocks {
            if let Some(args) = block.get_mut("args") {
                *args = bounded_payload(args.take());
            }
            if let Some(result) = block.get_mut("result") {
                *result = bounded_payload(result.take());
            }
        }
    }
    record
}

/// Rows the delegation roster needs, read from the full persisted transcript.
///
/// `complete` is false when the transcript exists but could not be read end to
/// end. An absent transcript is an ordinary empty session: complete, no rows.
pub fn read_session_delegation_rows(
    db: &Database,
    session_id: &str,
) -> Result<(Vec<UiMessage>, bool)> {
    match transcripts::read_transcript_with_compactions(db.data_dir(), session_id) {
        Ok(read) => {
            let messages = dedupe_records(read.messages)
                .into_iter()
                .filter(is_delegation_row)
                .map(bounded_record)
                .map(record_to_ui)
                .collect();
            Ok((messages, true))
        }
        Err(error) => {
            tracing::warn!(
                session_id,
                %error,
                "delegation roster could not read the full transcript"
            );
            Ok((Vec::new(), false))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn record(
        id: &str,
        role: &str,
        tool_name: Option<&str>,
        blocks: Value,
        meta: Option<Value>,
    ) -> MessageRecord {
        MessageRecord {
            id: id.into(),
            role: role.into(),
            tool_name: tool_name.map(str::to_string),
            is_error: false,
            blocks,
            meta,
            created_at: "2026-10-18T00:00:00Z".into(),
        }
    }

    fn task_call(id: &str, delegation: &str) -> MessageRecord {
        record(
            id,
            "tool",
            Some("Task"),
            json!([{
                "type": "tool_call",
                "callId": id,
                "name": "Task",
                "arguments": { "agent": "explorer", "task": "Find auth entry points" },
                "result": { "details": { "delegationId": delegation, "status": "running" } }
            }]),
            None,
        )
    }

    #[test]
    fn task_rows_with_a_delegation_join_the_roster() {
        assert!(is_delegation_row(&task_call("c1", "del-1")));
    }

    #[test]
    fn rejected_task_rows_stay_out() {
        let row = record(
            "c1",
            "tool",
            Some("Task"),
            json!([{
                "type": "tool_call",
                "callId": "c1",
                "name": "Task",
                "arguments": {},
                "result": { "details": { "status": "error" } }
            }]),
            None,
        );
        assert!(!is_delegation_row(&row));
    }

    #[test]
    fn delegate_rows_are_recognized_by_parent_call() {
        let row = record(
            "step-1",
            "tool",
            Some("Read"),
            json!([{ "type": "tool_call", "callId": "s1", "name": "Read", "arguments": {} }]),
            Some(json!({ "parentToolCallId": "call-1", "agentName": "explorer" })),
        );
        assert!(is_delegation_row(&row));
    }

    #[test]
    fn ordinary_conversation_rows_are_excluded() {
        let row = record(
            "m1",
            "assistant",
            None,
            json!([{ "type": "text", "text": "Hello" }]),
            None,
        );
        assert!(!is_delegation_row(&row));
    }

    #[test]
    fn lifecycle_rows_are_kept_even_without_a_parent() {
        let wait = record(
            "w1",
            "tool",
            Some("TaskWait"),
            json!([{
                "type": "tool_call",
                "callId": "w1",
                "name": "TaskWait",
                "arguments": { "delegationIds": ["del-1"] },
                "result": { "details": { "delegations": [{ "delegationId": "del-1", "status": "completed" }] } }
            }]),
            None,
        );
        assert!(is_delegation_row(&wait));
    }

    #[test]
    fn tool_names_are_matched_with_the_renderer_normalization() {
        assert!(is_delegation_tool_name("Task"));
        assert!(is_delegation_tool_name("functions.Task"));
        assert!(is_delegation_tool_name("TaskWait"));
        assert!(is_delegation_tool_name("subagent"));
        assert!(!is_delegation_tool_name("CreateTask"));
        assert!(!is_delegation_tool_name("Read"));
    }

    #[test]
    fn oversized_tool_payloads_are_bounded_but_keep_their_shape() {
        let huge = "x".repeat(TOOL_PAYLOAD_LIMIT * 2);
        let row = record(
            "c1",
            "tool",
            Some("Task"),
            json!([{
                "type": "tool_call",
                "callId": "c1",
                "name": "Task",
                "args": { "task": huge },
                "result": { "details": { "delegationId": "del-1", "result": "done" } }
            }]),
            None,
        );
        let bounded = bounded_record(row);
        let args = bounded.blocks[0]["args"].as_object().unwrap();
        let task = args["task"].as_str().unwrap();
        assert!(task.len() <= TOOL_PAYLOAD_LIMIT + 4);
        assert!(bounded.blocks[0]["result"].is_object());
        assert_eq!(
            bounded.blocks[0]["result"]["details"]["delegationId"],
            "del-1"
        );
    }
}
