//! Read-only projections of one session's delegations.
//!
//! Two different questions need two different answers:
//!
//! * "Which subagents ran in this session?" must cover the whole persisted
//!   transcript, because the renderer's reading window is bounded on purpose.
//!   That answer is a *summary*: identifiers, agent, brief, status and timing.
//!   Returning delegate conversation here would make the roster payload scale
//!   with everything every delegate ever printed.
//! * "What did this one delegate do?" needs its conversation, so it is read
//!   separately, per delegation, with a hard budget.
//!
//! The renderer owns delegation semantics: `Task` starts a subagent, lifecycle
//! tools report on existing ones, and `resume` joins later calls into the same
//! chain. Re-implementing status or naming rules here would create a second
//! source of truth, so these projections keep only what the renderer cannot
//! derive without the full file.

use std::collections::{HashMap, HashSet};

use anyhow::Result;
use serde_json::{Map, Value};

use crate::db::Database;
use crate::sessions::{dedupe_records, record_to_ui, UiMessage};
use crate::transcripts::{self, MessageRecord};

/// Brief kept in a roster row. A task description is one sentence in practice;
/// anything longer is a prompt, and the roster only needs to identify it.
const SUMMARY_TEXT_LIMIT: usize = 2 * 1024;
/// Lifecycle rows report many delegations at once; the roster only needs the
/// ones that still exist, and a pathological registry must not become the
/// largest object on the wire.
const MAX_LIFECYCLE_ENTRIES: usize = 200;
/// Any one text field of a delegation conversation.
const DETAIL_FIELD_LIMIT: usize = 64 * 1024;
/// Whole-response budget for one delegation conversation. A delegate that
/// printed hundreds of megabytes must not cross the IPC boundary in one frame.
const DETAIL_TOTAL_LIMIT: usize = 6 * 1024 * 1024;

/// Normalize a tool name exactly like the renderer's `bareToolName`: take the
/// last provider-namespaced segment, lowercase it, and drop punctuation.
fn bare_tool_name(name: &str) -> String {
    name.split('.')
        .next_back()
        .unwrap_or(name)
        .to_ascii_lowercase()
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .collect()
}

fn is_start_tool_name(name: &str) -> bool {
    matches!(bare_tool_name(name).as_str(), "task" | "subagent")
}

fn is_lifecycle_tool_name(name: &str) -> bool {
    matches!(
        bare_tool_name(name).as_str(),
        "taskwait" | "tasklist" | "taskstop"
    )
}

/// A bounded string. Trimming happens on a character boundary so the result is
/// always valid UTF-8 for a caller that re-serializes it.
fn capped_text(text: &str, limit: usize) -> String {
    if text.len() <= limit {
        return text.to_string();
    }
    let mut cut = limit.min(text.len());
    while cut > 0 && !text.is_char_boundary(cut) {
        cut -= 1;
    }
    format!("{}…", &text[..cut])
}

fn start_call(record: &MessageRecord) -> Option<&Value> {
    let name = record.tool_name.as_deref()?;
    if record.role != "tool" || !is_start_tool_name(name) {
        return None;
    }
    let details = record
        .blocks
        .as_array()?
        .iter()
        .find_map(|block| block.get("result")?.get("details"))?;
    let delegation_id = details.get("delegationId").and_then(Value::as_str)?;
    (!delegation_id.is_empty()).then_some(details)
}

fn tool_call_id(record: &MessageRecord) -> Option<&str> {
    record
        .blocks
        .as_array()?
        .iter()
        .find_map(|block| block.get("callId").and_then(Value::as_str))
}

fn resume_of(record: &MessageRecord) -> Option<String> {
    let args = record
        .blocks
        .as_array()?
        .iter()
        .find_map(|block| block.get("args"))?;
    let resume = args.get("resume").and_then(Value::as_str)?.trim();
    (!resume.is_empty()).then(|| resume.to_string())
}

/// Keep only scalar leaves, capped. Objects and arrays outside `keep_objects`
/// are dropped: a summary never needs a nested payload.
fn scalar_only(value: &Value, limit: usize, depth: usize) -> Value {
    if depth > 3 {
        return Value::Null;
    }
    match value {
        Value::String(text) => Value::String(capped_text(text, limit)),
        Value::Number(_) | Value::Bool(_) => value.clone(),
        Value::Array(items) => Value::Array(
            items
                .iter()
                .filter(|item| item.is_string() || item.is_number() || item.is_boolean())
                .take(64)
                .map(|item| scalar_only(item, limit, depth + 1))
                .collect(),
        ),
        Value::Object(map) => Value::Object(
            map.iter()
                .filter(|(_, item)| {
                    item.is_string() || item.is_number() || item.is_boolean() || item.is_null()
                })
                .map(|(key, item)| (key.clone(), scalar_only(item, limit, depth + 1)))
                .collect(),
        ),
        Value::Null => Value::Null,
    }
}

fn start_args(record: &MessageRecord) -> Value {
    let args = record
        .blocks
        .as_array()
        .into_iter()
        .flatten()
        .find_map(|block| block.get("args"));
    let mut out = Map::new();
    let Some(args) = args else {
        return Value::Object(out);
    };
    for key in ["agent", "resume"] {
        if let Some(value) = args.get(key).and_then(Value::as_str) {
            out.insert(
                key.into(),
                Value::String(capped_text(value, SUMMARY_TEXT_LIMIT)),
            );
        }
    }
    if let Some(task) = args.get("task").and_then(Value::as_str) {
        out.insert(
            "task".into(),
            Value::String(capped_text(task, SUMMARY_TEXT_LIMIT)),
        );
    }
    Value::Object(out)
}

fn start_details(details: &Value) -> Value {
    // `result` carries the delegate's report; the roster never shows it and the
    // detail read is what serves the conversation.
    let mut out = Map::new();
    if let Value::Object(map) = details {
        for (key, value) in map {
            if key == "result" {
                continue;
            }
            if value.is_string() || value.is_number() || value.is_boolean() || value.is_null() {
                out.insert(key.clone(), scalar_only(value, SUMMARY_TEXT_LIMIT, 0));
            } else if key == "error" {
                out.insert(key.clone(), scalar_only(value, SUMMARY_TEXT_LIMIT, 0));
            }
        }
    }
    Value::Object(out)
}

/// One roster row: a delegation start summarized down to identity, brief,
/// status and timing.
fn summary_record(record: &MessageRecord, details: &Value) -> MessageRecord {
    let call_id = tool_call_id(record).unwrap_or_default().to_string();
    MessageRecord {
        id: record.id.clone(),
        role: "tool".into(),
        tool_name: record.tool_name.clone(),
        is_error: false,
        blocks: Value::Array(vec![serde_json::json!({
            "type": "tool_call",
            "callId": call_id,
            "name": record.tool_name.clone().unwrap_or_else(|| "Task".into()),
            "args": start_args(record),
            "result": { "details": start_details(details) },
        })]),
        meta: None,
        created_at: record.created_at.clone(),
    }
}

fn lifecycle_entries(entries: &Value) -> Value {
    let Value::Array(items) = entries else {
        return Value::Array(Vec::new());
    };
    Value::Array(
        items
            .iter()
            .filter_map(|entry| {
                let record = entry.as_object()?;
                let mut out = Map::new();
                for key in ["delegationId", "agent", "status"] {
                    if let Some(value) = record.get(key).and_then(Value::as_str) {
                        out.insert(
                            key.into(),
                            Value::String(capped_text(value, SUMMARY_TEXT_LIMIT)),
                        );
                    }
                }
                for key in ["startedAt", "completedAt"] {
                    if let Some(value) = record.get(key).and_then(Value::as_i64) {
                        out.insert(key.into(), Value::from(value));
                    }
                }
                if let Some(error) = record.get("error") {
                    out.insert("error".into(), scalar_only(error, SUMMARY_TEXT_LIMIT, 0));
                }
                (!out.is_empty()).then_some(Value::Object(out))
            })
            .take(MAX_LIFECYCLE_ENTRIES)
            .collect(),
    )
}

/// A lifecycle row reduced to the counters the roster reads: which delegates
/// exist, and how they finished.
fn lifecycle_summary(record: &MessageRecord) -> Option<MessageRecord> {
    let name = record.tool_name.clone()?;
    if record.role != "tool" || !is_lifecycle_tool_name(&name) {
        return None;
    }
    let details = record
        .blocks
        .as_array()
        .into_iter()
        .flatten()
        .find_map(|block| block.get("result")?.get("details"))?;
    let mut out = Map::new();
    for key in ["delegations", "stopped"] {
        if let Some(entries) = details.get(key) {
            out.insert(key.into(), lifecycle_entries(entries));
        }
    }
    if out.is_empty() {
        return None;
    }
    Some(MessageRecord {
        id: record.id.clone(),
        role: "tool".into(),
        tool_name: Some(name.clone()),
        is_error: false,
        blocks: Value::Array(vec![serde_json::json!({
            "type": "tool_call",
            "callId": tool_call_id(record).unwrap_or_default(),
            "name": name,
            "args": {},
            "result": { "details": Value::Object(out) },
        })]),
        meta: None,
        created_at: record.created_at.clone(),
    })
}

fn read_records(db: &Database, session_id: &str) -> Result<Vec<MessageRecord>> {
    Ok(dedupe_records(
        transcripts::read_transcript_with_compactions(db.data_dir(), session_id)?.messages,
    ))
}

/// Roster rows for the whole session: delegation starts plus lifecycle
/// counters, with no delegate conversation.
pub fn read_session_delegation_rows(db: &Database, session_id: &str) -> Result<Vec<UiMessage>> {
    let records = read_records(db, session_id)?;
    let mut rows = Vec::new();
    for record in &records {
        if let Some(details) = start_call(record) {
            rows.push(summary_record(record, details));
            continue;
        }
        if let Some(summary) = lifecycle_summary(record) {
            rows.push(summary);
        }
    }
    Ok(rows.into_iter().map(record_to_ui).collect())
}

struct TaskCall {
    call_id: String,
    delegation_id: String,
    resume: Option<String>,
}

fn task_calls(records: &[MessageRecord]) -> Vec<TaskCall> {
    records
        .iter()
        .filter_map(|record| {
            let details = start_call(record)?;
            let delegation_id = details.get("delegationId")?.as_str()?.to_string();
            let call_id = tool_call_id(record).unwrap_or_default().to_string();
            Some(TaskCall {
                call_id,
                delegation_id,
                resume: resume_of(record),
            })
        })
        .collect()
}

/// The `Task` calls belonging to one delegation chain.
///
/// A chain is the connected component of `resume` links around the requested
/// delegation. Links may name a prior delegation id (the runtime's shape) or a
/// bare call id (tolerated so a chain stays legible before results land).
fn chain_call_ids(calls: &[TaskCall], target: &str) -> Option<HashSet<String>> {
    let by_delegation: HashMap<&str, usize> = calls
        .iter()
        .enumerate()
        .map(|(index, call)| (call.delegation_id.as_str(), index))
        .collect();
    let by_call: HashMap<&str, usize> = calls
        .iter()
        .enumerate()
        .filter(|(_, call)| !call.call_id.is_empty())
        .map(|(index, call)| (call.call_id.as_str(), index))
        .collect();

    let start = calls
        .iter()
        .position(|call| call.delegation_id == target)
        .or_else(|| {
            by_call
                .get(target)
                .copied()
                .filter(|_| calls.iter().any(|call| call.call_id == target))
        })?;

    let mut parents: Vec<Vec<usize>> = vec![Vec::new(); calls.len()];
    let mut children: Vec<Vec<usize>> = vec![Vec::new(); calls.len()];
    for (index, call) in calls.iter().enumerate() {
        let Some(resume) = call.resume.as_deref() else {
            continue;
        };
        let parent = by_delegation
            .get(resume)
            .copied()
            .or_else(|| by_call.get(resume).copied());
        if let Some(parent) = parent {
            if parent == index {
                continue;
            }
            parents[index].push(parent);
            children[parent].push(index);
        }
    }

    let mut seen = HashSet::from([start]);
    let mut queue = vec![start];
    while let Some(index) = queue.pop() {
        for next in parents[index].iter().chain(children[index].iter()) {
            if seen.insert(*next) {
                queue.push(*next);
            }
        }
    }
    Some(
        seen.into_iter()
            .map(|index| calls[index].call_id.clone())
            .filter(|call_id| !call_id.is_empty())
            .collect(),
    )
}

/// Cap every leaf string of a record and report the bytes it will occupy.
fn cap_record(record: &mut MessageRecord, limit: usize) -> usize {
    fn cap_value(value: &mut Value, limit: usize, used: &mut usize) {
        match value {
            Value::String(text) => {
                if text.len() > limit {
                    *text = capped_text(text, limit);
                }
                *used += text.len();
            }
            Value::Array(items) => {
                for item in items {
                    cap_value(item, limit, used);
                }
            }
            Value::Object(map) => {
                for (_, item) in map.iter_mut() {
                    cap_value(item, limit, used);
                }
            }
            Value::Number(_) | Value::Bool(_) | Value::Null => {}
        }
    }
    let mut used = 0;
    cap_value(&mut record.blocks, limit, &mut used);
    used + record.id.len() + record.created_at.len()
}

pub struct DelegationDetail {
    pub messages: Vec<UiMessage>,
    /// True when the budget cut the conversation short.
    pub truncated: bool,
}

/// One delegation chain's conversation, bounded by a per-field and a total
/// budget. `None` means the session has no such delegation.
pub fn read_session_delegation_detail(
    db: &Database,
    session_id: &str,
    delegation_id: &str,
) -> Result<Option<DelegationDetail>> {
    let records = read_records(db, session_id)?;
    let calls = task_calls(&records);
    let Some(chain) = chain_call_ids(&calls, delegation_id) else {
        return Ok(None);
    };
    let chain_delegations: HashSet<&str> = calls
        .iter()
        .filter(|call| chain.contains(&call.call_id))
        .map(|call| call.delegation_id.as_str())
        .collect();

    let mut selected: Vec<MessageRecord> = Vec::new();
    let mut truncated = false;
    let mut used = 0usize;
    for record in records {
        let belongs = match tool_call_id(&record) {
            Some(call_id) if chain.contains(call_id) => true,
            _ => record
                .meta
                .as_ref()
                .and_then(|meta| meta.get("parentToolCallId"))
                .and_then(Value::as_str)
                .is_some_and(|parent| chain.contains(parent)),
        };
        // Lifecycle rows are shared across delegations; only the entries that
        // name this chain are kept, so the detail's status matches the roster.
        let lifecycle = if belongs {
            None
        } else {
            lifecycle_for_chain(&record, &chain_delegations)
        };
        if !belongs && lifecycle.is_none() {
            continue;
        }
        let mut record = lifecycle.unwrap_or(record);
        let bytes = cap_record(&mut record, DETAIL_FIELD_LIMIT);
        if used + bytes > DETAIL_TOTAL_LIMIT {
            truncated = true;
            break;
        }
        used += bytes;
        selected.push(record);
    }

    Ok(Some(DelegationDetail {
        messages: selected.into_iter().map(record_to_ui).collect(),
        truncated,
    }))
}

fn lifecycle_for_chain(
    record: &MessageRecord,
    delegations: &HashSet<&str>,
) -> Option<MessageRecord> {
    let name = record.tool_name.clone()?;
    if record.role != "tool" || !is_lifecycle_tool_name(&name) {
        return None;
    }
    let details = record
        .blocks
        .as_array()
        .into_iter()
        .flatten()
        .find_map(|block| block.get("result")?.get("details"))?;
    let mut out = Map::new();
    for key in ["delegations", "stopped"] {
        let Some(Value::Array(items)) = details.get(key) else {
            continue;
        };
        let kept: Vec<Value> = items
            .iter()
            .filter(|entry| {
                entry
                    .get("delegationId")
                    .and_then(Value::as_str)
                    .is_some_and(|id| delegations.contains(id))
            })
            .cloned()
            .collect();
        if !kept.is_empty() {
            out.insert(key.into(), Value::Array(kept));
        }
    }
    if out.is_empty() {
        return None;
    }
    Some(MessageRecord {
        id: record.id.clone(),
        role: "tool".into(),
        tool_name: Some(name.clone()),
        is_error: false,
        blocks: Value::Array(vec![serde_json::json!({
            "type": "tool_call",
            "callId": tool_call_id(record).unwrap_or_default(),
            "name": name,
            "args": {},
            "result": { "details": Value::Object(out) },
        })]),
        meta: None,
        created_at: record.created_at.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const CREATED_AT: &str = "2026-10-18T00:00:00Z";

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
            created_at: CREATED_AT.into(),
        }
    }

    fn task(record_id: &str, call_id: &str, delegation: &str, task: &str) -> MessageRecord {
        record(
            record_id,
            "tool",
            Some("Task"),
            json!([{
                "type": "tool_call",
                "callId": call_id,
                "name": "Task",
                "args": { "agent": "explorer", "task": task },
                "result": { "details": {
                    "delegationId": delegation,
                    "status": "completed",
                    "agent": "explorer"
                } }
            }]),
            None,
        )
    }

    fn resumed(record_id: &str, call_id: &str, delegation: &str, resume: &str) -> MessageRecord {
        record(
            record_id,
            "tool",
            Some("Task"),
            json!([{
                "type": "tool_call",
                "callId": call_id,
                "name": "Task",
                "args": { "agent": "explorer", "task": "Follow up", "resume": resume },
                "result": { "details": { "delegationId": delegation, "status": "running" } }
            }]),
            None,
        )
    }

    fn child(id: &str, parent: &str, text: &str) -> MessageRecord {
        record(
            id,
            "assistant",
            None,
            json!([{ "type": "text", "text": text }]),
            Some(json!({ "parentToolCallId": parent, "agentName": "explorer" })),
        )
    }

    #[test]
    fn a_summary_keeps_identity_and_brief_but_drops_the_report() {
        let mut row = record(
            "row-1",
            "tool",
            Some("Task"),
            json!([{
                "type": "tool_call",
                "callId": "call-1",
                "name": "Task",
                "args": { "agent": "explorer", "task": "Find auth" },
                "result": { "details": {
                    "delegationId": "del-1",
                    "status": "completed",
                    "result": "x".repeat(50_000)
                } },
                "text": "x".repeat(50_000)
            }]),
            None,
        );
        let summary = summary_record(&row, start_call(&row).unwrap());
        let encoded = summary.blocks.to_string();
        assert!(
            encoded.len() < 4_096,
            "summary must stay small: {}",
            encoded.len()
        );
        assert!(encoded.contains("del-1"));
        assert!(encoded.contains("Find auth"));
        // The delegate's report is conversation content, not roster data.
        assert!(!encoded.contains("xxxxxxxxxx"));
        // Nothing else should have mutated the source record.
        let _ = &mut row;
    }

    #[test]
    fn a_long_brief_is_capped() {
        let long = "y".repeat(SUMMARY_TEXT_LIMIT * 2);
        let row = task("row-1", "call-1", "del-1", &long);
        let summary = summary_record(&row, start_call(&row).unwrap());
        let task = summary.blocks[0]["args"]["task"].as_str().unwrap();
        assert!(task.len() <= SUMMARY_TEXT_LIMIT + 4);
    }

    #[test]
    fn lifecycle_rows_keep_only_counters() {
        let row = record(
            "wait-1",
            "tool",
            Some("TaskWait"),
            json!([{
                "type": "tool_call",
                "callId": "wait-1",
                "name": "TaskWait",
                "args": { "delegationIds": ["del-1"] },
                "result": { "details": {
                    "delegations": [
                        { "delegationId": "del-1", "agent": "explorer", "status": "completed",
                          "startedAt": 10, "completedAt": 20, "report": "z".repeat(9_000) }
                    ]
                } },
                "text": "z".repeat(9_000)
            }]),
            None,
        );
        let summary = lifecycle_summary(&row).unwrap();
        let encoded = summary.blocks.to_string();
        assert!(encoded.len() < 1_024, "lifecycle summary must stay small");
        assert!(encoded.contains("completed"));
        assert!(!encoded.contains("zzzz"));
    }

    #[test]
    fn a_rejected_task_is_not_a_roster_row() {
        let row = record(
            "row-1",
            "tool",
            Some("Task"),
            json!([{
                "type": "tool_call",
                "callId": "call-1",
                "name": "Task",
                "args": {},
                "result": { "details": { "status": "error" } }
            }]),
            None,
        );
        assert!(start_call(&row).is_none());
    }

    #[test]
    fn resume_links_join_a_chain_in_both_directions() {
        let records = vec![
            task("r1", "call-1", "del-1", "First"),
            child("c1", "call-1", "first answer"),
            resumed("r2", "call-2", "del-2", "del-1"),
            child("c2", "call-2", "second answer"),
            task("r3", "call-3", "del-other", "Unrelated"),
            child("c3", "call-3", "other answer"),
        ];
        let calls = task_calls(&records);
        let chain = chain_call_ids(&calls, "del-2").unwrap();
        assert!(chain.contains("call-1"));
        assert!(chain.contains("call-2"));
        assert!(!chain.contains("call-3"));
        // Opening the chain's first delegation resolves the same component.
        let chain = chain_call_ids(&calls, "del-1").unwrap();
        assert!(chain.contains("call-2"));
    }

    #[test]
    fn a_bare_call_id_resume_still_links() {
        let records = vec![
            task("r1", "call-1", "del-1", "First"),
            resumed("r2", "call-2", "del-2", "call-1"),
        ];
        let chain = chain_call_ids(&task_calls(&records), "del-2").unwrap();
        assert!(chain.contains("call-1"));
    }

    #[test]
    fn an_unknown_delegation_has_no_detail() {
        let records = vec![task("r1", "call-1", "del-1", "First")];
        assert!(chain_call_ids(&task_calls(&records), "missing").is_none());
    }

    #[test]
    fn detail_caps_each_field_before_it_reaches_the_wire() {
        let mut row = child("c1", "call-1", &"q".repeat(DETAIL_FIELD_LIMIT * 3));
        let bytes = cap_record(&mut row, DETAIL_FIELD_LIMIT);
        assert!(bytes <= DETAIL_FIELD_LIMIT + 256, "capped bytes: {bytes}");
        let text = row.blocks[0]["text"].as_str().unwrap();
        assert!(text.len() <= DETAIL_FIELD_LIMIT + 4);
    }
}
