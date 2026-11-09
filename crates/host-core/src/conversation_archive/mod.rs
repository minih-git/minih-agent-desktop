//! Conversation archive: the redacted projection a plugin may read
//! (ADR conversation-archive).
//!
//! The archive is not a second copy of the conversation. It is a read-only view
//! of the transcript in force — never a discarded regenerate branch — reduced
//! to what a later reader can use:
//!
//! - the user's text and the agent's text, from `text` blocks only,
//! - one line per tool call, from `tool_call` blocks,
//! - one marker per compaction checkpoint.
//!
//! Thinking, attachments, tool results, hosted-search payloads and system
//! messages are dropped here rather than filtered later, so no downstream
//! consumer can accidentally forward them. Every produced line also passes the
//! credential redactor, because a tool argument is exactly where a token sits
//! next to ordinary text.
//!
//! The module owns nothing durable: `repo` and `feed` keep the summary rows and
//! the change cursor, `rpc` serves the plugin contract.

mod feed;
pub(crate) mod project_identity;
pub(crate) mod projection;
pub(crate) mod repo;
mod rpc;

pub(crate) use rpc::{handle, record_deletion};

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
