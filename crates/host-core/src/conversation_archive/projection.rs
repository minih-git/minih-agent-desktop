//! Transcript -> turns, with everything that may not leave the device dropped
//! (ADR conversation-archive §2).
//!
//! One pass over the transcript in force produces the turn list. A turn starts
//! at a user message; its assistant text is everything the agent said before
//! the next user message, and its tool lines are the `tool_call` blocks in that
//! range, in order. Thinking and attachment blocks are skipped by kind, never
//! stringified, and a `result` payload is never read.

use serde::Serialize;
use serde_json::Value;

use crate::db::ts_to_ms;
use crate::memory::secrets::redact_fragments;
use crate::transcripts::{CompactionRecord, MessageRecord};

/// Longest argument excerpt a tool line carries before the redactor runs.
pub(crate) const TOOL_ARGUMENT_MAX_CHARS: usize = 160;
/// Longest one projected turn's text may be to stay one page row.
pub(crate) const TRANSCRIPT_TURN_MAX_BYTES: usize = 16 * 1024;

/// One tool call reduced to the single line a reader can scan.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConversationToolLine {
    pub name: String,
    /// Tool name plus its key argument, already redacted and truncated.
    pub line: String,
    pub is_error: bool,
}

/// One user turn of the archived conversation.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationTurn {
    /// 0-based turn index.
    pub index: usize,
    pub started_at: i64,
    pub user: String,
    pub assistant: String,
    pub tools: Vec<ConversationToolLine>,
    /// The latest checkpoint that applies from this turn onward, when one does.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compaction: Option<String>,
}

/// Cut on a character boundary so a truncation never splits a multi-byte
/// character.
pub(crate) fn truncate_to_chars(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_string();
    }
    let mut out: String = text.chars().take(limit).collect();
    out.push('…');
    out
}

/// The compact JSON form of a tool argument value, one line, bounded.
fn argument_excerpt(value: &Value) -> String {
    let raw = match value {
        Value::Null => return String::new(),
        Value::String(text) => text.clone(),
        other => other.to_string(),
    };
    let one_line: String = raw
        .chars()
        .map(|c| if c == '\n' || c == '\r' { ' ' } else { c })
        .collect();
    truncate_to_chars(one_line.trim(), TOOL_ARGUMENT_MAX_CHARS)
}

/// The key argument a reader needs to tell one call from another.
///
/// The mapping is deliberately a short list of the tools the agent actually
/// uses, and the fallback is the argument JSON itself: a tool added later still
/// produces a line that names what it was pointed at.
fn key_argument(block: &Value, name: &str) -> Option<(&'static str, String)> {
    let args = block.get("args")?;
    if args.is_null() {
        return None;
    }
    let field = |names: &[&str]| -> Option<String> {
        names
            .iter()
            .find_map(|name| args.get(*name))
            .map(argument_excerpt)
            .filter(|text| !text.is_empty())
    };
    let picked = match name.to_ascii_lowercase().as_str() {
        "bash" | "shell" | "terminal" => field(&["command", "cmd"]).map(|v| ("command", v)),
        "read" | "write" | "edit" => field(&["path", "file_path", "filePath"]).map(|v| ("path", v)),
        "grep" | "glob" => {
            let pattern = field(&["pattern", "query"]);
            let path = field(&["path", "glob", "cwd"]);
            match (pattern, path) {
                (Some(a), Some(b)) => Some(("pattern", format!("{a} {b}"))),
                (Some(a), None) => Some(("pattern", a)),
                (None, Some(b)) => Some(("path", b)),
                (None, None) => None,
            }
        }
        "skill" => field(&["id", "skill", "name"]).map(|v| ("id", v)),
        _ => Some(("args", argument_excerpt(args))).filter(|(_, text)| !text.is_empty()),
    };
    picked
}

/// One projected tool line, redacted. `None` for a block that is not a call.
fn tool_line(block: &Value, fallback_name: Option<&str>) -> Option<ConversationToolLine> {
    if block.get("type").and_then(Value::as_str) != Some("tool_call") {
        return None;
    }
    let name = block
        .get("name")
        .and_then(Value::as_str)
        .or(fallback_name)
        .unwrap_or("tool")
        .to_string();
    let original = block
        .get("name")
        .and_then(Value::as_str)
        .or(fallback_name)
        .unwrap_or_default()
        .to_string();
    let is_error = block
        .get("isError")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || block.get("status").and_then(Value::as_str) == Some("error")
        || block.get("status").and_then(Value::as_str) == Some("denied");
    let excerpt = key_argument(block, &name);
    let body = match excerpt {
        Some((field, value)) => format!("{field}: {value}"),
        None => String::new(),
    };
    let mut line = format!("{original} `{body}`");
    if body.is_empty() {
        line = format!("{original} ()");
    }
    if is_error {
        line.push_str(" ✗");
    }
    // Every character that leaves the device passes here, including the tool
    // name: a model-generated name is not a privileged string.
    Some(ConversationToolLine {
        name: redact_fragments(&name),
        line: redact_fragments(&line),
        is_error,
    })
}

fn block_text(block: &Value) -> Option<&str> {
    if block.get("type").and_then(Value::as_str) != Some("text") {
        return None;
    }
    block
        .get("text")
        .and_then(Value::as_str)
        .filter(|text| !text.trim().is_empty())
}

fn block_array(record: &MessageRecord) -> &[Value] {
    match &record.blocks {
        Value::Array(items) => items.as_slice(),
        _ => &[],
    }
}

/// Bound one turn's text so a page row stays readable and bounded.
fn bounded(text: &str) -> String {
    if text.len() <= TRANSCRIPT_TURN_MAX_BYTES {
        return text.to_string();
    }
    let mut end = TRANSCRIPT_TURN_MAX_BYTES;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n[truncated]", &text[..end])
}

/// Which checkpoint applies to a message, given the checkpoints in append order.
fn checkpoint_for(
    compactions: &[(i64, String)],
    occurred_at: &[(String, i64)],
    index: usize,
) -> Option<String> {
    // A checkpoint recorded before this message took effect belongs to it.
    let start = occurred_at.get(index).map(|(_, at)| *at)?;
    let applicable: Vec<&(i64, String)> =
        compactions.iter().filter(|(at, _)| *at <= start).collect();
    let newest = applicable.last()?;
    Some(newest.1.clone())
}

/// Project the transcript in force into turns.
///
/// `messages` is the transcript's message chain; compactions are its
/// checkpoints in append order. Compaction positions are reconstructed from the
/// transcript's own `created_at` values, so an older archive read and the same
/// conversation read now agree on where the markers sit.
pub(crate) fn project_transcript(
    messages: &[MessageRecord],
    compactions: &[CompactionRecord],
) -> Vec<ConversationTurn> {
    let occurred_at: Vec<(String, i64)> = messages
        .iter()
        .map(|record| (record.id.clone(), ts_to_ms(&record.created_at)))
        .collect();
    let markers: Vec<(i64, String)> = compactions
        .iter()
        .map(|compaction| {
            (
                ts_to_ms(&compaction.created_at),
                format!(
                    "compaction {} · kept from {}",
                    compaction
                        .created_at
                        .get(..16)
                        .unwrap_or(&compaction.created_at)
                        .replace('T', " "),
                    compaction
                        .first_kept_message_id
                        .as_deref()
                        .unwrap_or("(none)")
                ),
            )
        })
        .collect();

    let mut turns: Vec<ConversationTurn> = Vec::new();
    for (index, record) in messages.iter().enumerate() {
        let blocks = block_array(record);
        let mut texts: Vec<String> = Vec::new();
        let mut tools: Vec<ConversationToolLine> = Vec::new();
        match record.role.as_str() {
            "user" => {
                for block in blocks {
                    if let Some(text) = block_text(block) {
                        texts.push(redact_fragments(text.trim()));
                    }
                }
                let user = texts.join("\n\n");
                if user.trim().is_empty() {
                    continue;
                }
                turns.push(ConversationTurn {
                    index: turns.len(),
                    started_at: occurred_at[index].1,
                    user,
                    assistant: String::new(),
                    tools,
                    compaction: checkpoint_for(&markers, &occurred_at, index),
                });
                continue;
            }
            "assistant" => {
                for block in blocks {
                    if let Some(text) = block_text(block) {
                        texts.push(redact_fragments(text.trim()));
                    } else if let Some(line) = tool_line(block, record.tool_name.as_deref()) {
                        tools.push(line);
                    }
                }
            }
            "tool" => {
                for block in blocks {
                    if let Some(line) = tool_line(block, record.tool_name.as_deref()) {
                        tools.push(line);
                    }
                }
            }
            // A system message never enters the archive; unknown roles are not
            // something the archive invents an answer for.
            _ => continue,
        }
        let Some(turn) = turns.last_mut() else {
            // Agent work before the first user message is not a turn of its own.
            continue;
        };
        let assistant = texts.join("\n\n");
        if !assistant.trim().is_empty() {
            if turn.assistant.is_empty() {
                turn.assistant = assistant;
            } else {
                turn.assistant.push_str("\n\n");
                turn.assistant.push_str(&assistant);
            }
        }
        turn.tools.extend(tools);
    }
    for turn in turns.iter_mut() {
        turn.user = bounded(&turn.user);
        turn.assistant = bounded(&turn.assistant);
    }
    turns
}
