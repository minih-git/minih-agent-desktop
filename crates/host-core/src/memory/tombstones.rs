//! Entry identity and the tombstones that make forgetting durable
//! (ADR agent-long-term-memory §6).
//!
//! A tombstone is scope-local and content-free: it records the fingerprint of a
//! forgotten entry plus the source messages that produced it, so neither
//! extraction nor any create path can resurrect the same memory from the same
//! evidence.

use anyhow::{anyhow, Result};
use rusqlite::{params, Connection, OptionalExtension};
use sha2::{Digest, Sha256};
use unicode_normalization::UnicodeNormalization;

use super::model::MemoryScope;

/// Fold content to the form the fingerprint hashes: NFKC, Unicode lowercase,
/// and collapsed whitespace. Two entries that differ only in fullwidth forms,
/// case, or spacing are the same memory.
pub(crate) fn normalize(content: &str) -> String {
    let folded: String = content.nfkc().collect::<String>().to_lowercase();
    let mut normalized = String::with_capacity(folded.len());
    let mut pending_space = false;
    for ch in folded.chars() {
        if ch.is_whitespace() {
            pending_space = !normalized.is_empty();
            continue;
        }
        if pending_space {
            normalized.push(' ');
            pending_space = false;
        }
        normalized.push(ch);
    }
    normalized
}

/// SHA-256 over the kind and the normalized content. The scope is part of the
/// uniqueness key in SQLite rather than of the hash, so the same sentence in two
/// projects is two independent memories.
pub(crate) fn fingerprint(kind: &str, content: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(kind.as_bytes());
    hasher.update(b"\n");
    hasher.update(normalize(content).as_bytes());
    hex::encode(hasher.finalize())
}

/// Message ids stored in one JSON column.
pub(crate) fn parse_ids(raw: &str) -> Vec<String> {
    serde_json::from_str::<Vec<String>>(raw).unwrap_or_default()
}

pub(crate) fn encode_ids(ids: &[String]) -> String {
    serde_json::to_string(ids).unwrap_or_else(|_| "[]".to_string())
}

/// Whether a tombstone already covers this write: the same fingerprint in the
/// same scope, or any cited source message a tombstone already recorded.
pub(crate) fn blocks(
    conn: &Connection,
    scope: &MemoryScope,
    fingerprint: &str,
    source_message_ids: &[String],
) -> Result<bool> {
    let fingerprint_hit: bool = conn.query_row(
        "SELECT EXISTS(
           SELECT 1 FROM memory_tombstones
           WHERE scope_kind = ?1 AND IFNULL(scope_key, '') = ?2 AND fingerprint = ?3
         )",
        params![scope.kind, scope.stored_key(), fingerprint],
        |row| row.get(0),
    )?;
    if fingerprint_hit {
        return Ok(true);
    }
    if source_message_ids.is_empty() {
        return Ok(false);
    }
    let message_hit: bool = conn.query_row(
        "SELECT EXISTS(
           SELECT 1 FROM memory_tombstones, json_each(memory_tombstones.source_message_ids)
           WHERE memory_tombstones.scope_kind = ?1
             AND IFNULL(memory_tombstones.scope_key, '') = ?2
             AND json_each.value IN (SELECT value FROM json_each(?3))
         )",
        params![
            scope.kind,
            scope.stored_key(),
            encode_ids(source_message_ids)
        ],
        |row| row.get(0),
    )?;
    Ok(message_hit)
}

/// Record a tombstone, keeping every source message the scope has already
/// blocked so a later write cannot cite its way past an earlier delete.
pub(crate) fn write(
    conn: &Connection,
    scope: &MemoryScope,
    fingerprint: &str,
    source_session_id: Option<&str>,
    source_message_ids: &[String],
    created_at: i64,
) -> Result<()> {
    let existing: Option<String> = conn
        .query_row(
            "SELECT source_message_ids FROM memory_tombstones
             WHERE scope_kind = ?1 AND IFNULL(scope_key, '') = ?2 AND fingerprint = ?3",
            params![scope.kind, scope.stored_key(), fingerprint],
            |row| row.get(0),
        )
        .optional()?;
    let mut ids = existing.map(|raw| parse_ids(&raw)).unwrap_or_default();
    for id in source_message_ids {
        if !ids.iter().any(|known| known == id) {
            ids.push(id.clone());
        }
    }
    conn.execute(
        "INSERT INTO memory_tombstones
           (scope_kind, scope_key, fingerprint, source_session_id, source_message_ids, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT DO UPDATE SET
           source_message_ids = excluded.source_message_ids,
           source_session_id = COALESCE(excluded.source_session_id,
                                        memory_tombstones.source_session_id)",
        params![
            scope.kind,
            scope.key.as_deref(),
            fingerprint,
            source_session_id,
            encode_ids(&ids),
            created_at
        ],
    )?;
    Ok(())
}

/// Drop the tombstone for one fingerprint. Only an explicit user request to
/// remember the same content again may clear it (ADR §6).
pub(crate) fn clear(conn: &Connection, scope: &MemoryScope, fingerprint: &str) -> Result<()> {
    conn.execute(
        "DELETE FROM memory_tombstones
         WHERE scope_kind = ?1 AND IFNULL(scope_key, '') = ?2 AND fingerprint = ?3",
        params![scope.kind, scope.stored_key(), fingerprint],
    )?;
    Ok(())
}

/// Guard used by the create path: the stored scope key must never be empty for a
/// project scope, or two projects would share one identity.
pub(crate) fn require_scope_key(scope: &MemoryScope) -> Result<()> {
    if scope.kind == super::model::SCOPE_PROJECT && scope.stored_key().is_empty() {
        return Err(anyhow!("project memory scope requires a key"));
    }
    Ok(())
}
