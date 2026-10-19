//! Device-local usage counters the memory manager shows (plan §1).
//!
//! They answer "how is this feature doing on this machine": how large the
//! session-start index was at the last launch, how many suggestions the user
//! accepted or rejected, how often a tombstone stopped a write, and what
//! extraction cost today. Each of those is a property of one device's own
//! usage, so the counters live in a `kv` row beside the extraction budget and
//! outside every configuration-sync domain: a synced revision never carries
//! them, and a second device never inherits these numbers
//! (ADR agent-long-term-memory §7).

use anyhow::Result;
use serde::{Deserialize, Serialize};

use crate::db::Database;

/// The namespace and key the counters live under.
const STATS_NAMESPACE: &str = "memory";
const STATS_KEY: &str = "localStats";

/// Counters for this device only. A missing row reads as zero, and a counter
/// this build does not know is ignored rather than failing the read.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct MemoryLocalStats {
    /// Suggestions the user accepted and rejected here.
    pub suggestions_accepted: i64,
    pub suggestions_rejected: i64,
    /// Writes a tombstone stopped, split by the writer that attempted them, so
    /// the extractor's refusals stay visible apart from the user's own.
    pub blocked_from_extraction: i64,
    pub blocked_from_create: i64,
    /// The session-start index as this device last captured it; `capturedAt` is
    /// `None` until a session has started since the counters were introduced.
    pub index_entries: i64,
    pub index_bytes: i64,
    pub index_omitted: i64,
    pub index_captured_at: Option<i64>,
}

impl Database {
    pub fn memory_local_stats(&self) -> Result<MemoryLocalStats> {
        match self.kv_get(STATS_NAMESPACE, STATS_KEY)? {
            Some(value) => Ok(serde_json::from_value(value).unwrap_or_default()),
            None => Ok(MemoryLocalStats::default()),
        }
    }

    /// One counter change, written through this database's connection so a
    /// decision and the counter it feeds commit together.
    fn change_memory_local_stats(&self, change: impl FnOnce(&mut MemoryLocalStats)) -> Result<()> {
        let mut stats = self.memory_local_stats()?;
        change(&mut stats);
        self.kv_set(STATS_NAMESPACE, STATS_KEY, &serde_json::to_value(&stats)?)
    }

    /// Record the index the launch path just captured, replacing the previous
    /// launch's numbers: the manager shows the most recent session start.
    pub fn record_memory_index_capture(
        &self,
        entries: i64,
        bytes: i64,
        omitted: i64,
        at: i64,
    ) -> Result<()> {
        self.change_memory_local_stats(|stats| {
            stats.index_entries = entries;
            stats.index_bytes = bytes;
            stats.index_omitted = omitted;
            stats.index_captured_at = Some(at);
        })
    }

    /// One reviewed suggestion. Only a user decision reaches this.
    pub fn record_memory_suggestion_decision(&self, accepted: bool) -> Result<()> {
        self.change_memory_local_stats(|stats| {
            let counter = if accepted {
                &mut stats.suggestions_accepted
            } else {
                &mut stats.suggestions_rejected
            };
            *counter = counter.saturating_add(1);
        })
    }

    /// One write a tombstone stopped. This is the "deleted memories are never
    /// suggested again" measure: a hit is blocked and counted, never surfaced.
    pub fn record_memory_tombstone_block(&self, from_extraction: bool) -> Result<()> {
        self.change_memory_local_stats(|stats| {
            let counter = if from_extraction {
                &mut stats.blocked_from_extraction
            } else {
                &mut stats.blocked_from_create
            };
            *counter = counter.saturating_add(1);
        })
    }
}
