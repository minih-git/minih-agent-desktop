//! Term-ranked learned-memory search (ADR learned-memory-recall §1).
//!
//! The storage module owns the rows; this one owns what a query means. A query
//! is split into terms (`search_terms`), an active entry matches when any term
//! is contained in its content or rationale, and the result is ranked: most
//! distinct terms first, then the whole query as a verbatim phrase, then recency
//! of use, then recency of change. The literal rule is
//! `to_lowercase().contains` — the same one `pi_search_contains` applies — and
//! ranking therefore happens in Rust, because SQLite's `LIKE` cannot express a
//! non-ASCII case mapping.
//!
//! It lives apart from `repository` for two reasons a reader needs: ranking is
//! domain logic rather than storage, and the storage module is already at the
//! size budget the repository enforces.

use anyhow::Result;
use rusqlite::params;

use crate::db::{now_ms, Database};

use super::model::*;
use super::repository::{entry_from_row, qualified_columns, scope_slots};
use super::search_terms;
use super::tombstones;

pub(crate) struct SearchMemoryRequest<'a> {
    pub scopes: &'a [MemoryScope],
    pub query: &'a str,
    pub kinds: &'a [String],
    pub limit: i64,
    pub record_use: bool,
    /// Ids the caller already carries in another form — today the frozen
    /// session-start index — which the search must never return again.
    pub exclude_ids: &'a [String],
    /// Fewest distinct query terms a hit must match. A per-turn recall asks for
    /// a real overlap; the tool defaults to one term, which is today's behavior.
    pub min_match_terms: usize,
}

/// One search hit: the entry, and the terms that made it a hit.
///
/// The terms belong to the search, not to the entry, so they travel in this
/// wrapper instead of on `MemoryEntryRecord`: a list or an update has no terms
/// to report, and a field that is empty on every other path would invite a
/// caller to read a meaning that is not there.
#[derive(Debug, Clone)]
pub(crate) struct MemorySearchHit {
    pub entry: MemoryEntryRecord,
    pub matched_terms: Vec<String>,
}

impl Database {
    /// Search active entries of the given scopes by the terms of a query
    /// (ADR learned-memory-recall §1). Hits refresh `last_used_at` and
    /// `use_count`; the session-start index alone does not, and a per-turn
    /// recall passes `record_use: false` because it is a view the model did not
    /// ask for.
    ///
    /// The query is split into terms, an entry matches when any term is
    /// contained in its content or rationale, and the result is ranked: most
    /// distinct terms first, then a verbatim phrase, then recency of use, then
    /// recency of change. Ranking happens in Rust because the literal rule is
    /// `to_lowercase().contains` — the same rule `pi_search_contains` applies —
    /// and SQLite's `LIKE` cannot express it for non-ASCII case mappings.
    pub fn search_memory_entries(
        &self,
        request: SearchMemoryRequest<'_>,
    ) -> Result<Vec<MemorySearchHit>> {
        let query = request.query.trim();
        if query.is_empty() {
            return Ok(Vec::new());
        }
        let terms = search_terms::split_terms(query);
        if terms.is_empty() {
            return Ok(Vec::new());
        }
        crate::session_search::register_contains(self)?;
        let (bot_slot, project_slot, user_slot) = scope_slots(request.scopes);
        let kinds = if request.kinds.is_empty() {
            None
        } else {
            Some(tombstones::encode_ids(request.kinds))
        };
        // Trigram FTS stays a prefilter for the terms it can index: three
        // characters or more, and ASCII or uncased text. The literal scan below
        // remains the authority, so no case mapping is lost.
        let match_query = fts_match_query(&terms);
        let fts = if match_query.is_some() {
            "AND m.rowid IN (SELECT rowid FROM memory_entries_fts WHERE memory_entries_fts MATCH ?7)"
        } else {
            // The bound value is never NULL, so this arm filters nothing.
            "AND ?7 IS NOT NULL"
        };
        let sql = format!(
            "SELECT {} FROM memory_entries m
             WHERE m.status = ?1
               AND ((m.scope_kind = ?2 AND IFNULL(m.scope_key, '') = ?3)
                 OR (m.scope_kind = ?4 AND IFNULL(m.scope_key, '') = ?5)
                 OR (m.scope_kind = ?8 AND IFNULL(m.scope_key, '') = ?9))
               AND (?6 IS NULL OR m.kind IN (SELECT value FROM json_each(?6))) {fts}",
            qualified_columns("m.")
        );
        let empty = String::new();
        let mut statement = self.conn().prepare_cached(&sql)?;
        let rows = statement.query_map(
            params![
                STATUS_ACTIVE,
                project_slot.kind,
                project_slot.stored_key(),
                user_slot.kind,
                user_slot.stored_key(),
                kinds,
                match_query.as_ref().unwrap_or(&empty),
                bot_slot.kind,
                bot_slot.stored_key()
            ],
            entry_from_row,
        )?;
        let candidates = rows.collect::<rusqlite::Result<Vec<_>>>()?;
        let mut hits: Vec<MemorySearchHit> = Vec::new();
        for entry in candidates {
            if request.exclude_ids.iter().any(|id| id == &entry.id) {
                continue;
            }
            let scored =
                search_terms::match_count(&entry.content, entry.rationale.as_deref(), &terms);
            if scored.count == 0 || scored.count < request.min_match_terms {
                continue;
            }
            hits.push(MemorySearchHit {
                entry,
                matched_terms: scored.matched,
            });
        }
        // Ranked by relevance, then by the order a user would recognize: a note
        // used recently is more likely the one meant.
        hits.sort_by(|left, right| {
            let left_phrase = phrase_hit(left, &terms);
            let right_phrase = phrase_hit(right, &terms);
            right
                .matched_terms
                .len()
                .cmp(&left.matched_terms.len())
                .then_with(|| right_phrase.cmp(&left_phrase))
                .then_with(|| {
                    right
                        .entry
                        .last_used_at
                        .unwrap_or(i64::MIN)
                        .cmp(&left.entry.last_used_at.unwrap_or(i64::MIN))
                })
                .then_with(|| right.entry.updated_at.cmp(&left.entry.updated_at))
                .then_with(|| left.entry.id.cmp(&right.entry.id))
        });
        hits.truncate(request.limit.clamp(1, MAX_SEARCH_LIMIT) as usize);
        if request.record_use && !hits.is_empty() {
            let now = now_ms();
            for hit in &mut hits {
                self.conn().execute(
                    "UPDATE memory_entries
                     SET last_used_at = ?1, use_count = use_count + 1
                     WHERE id = ?2",
                    params![now, hit.entry.id],
                )?;
                hit.entry.last_used_at = Some(now);
                hit.entry.use_count += 1;
            }
        }
        Ok(hits)
    }
}

/// The trigram-FTS prefilter for a set of terms: one quoted alternative per
/// term the indexer can handle, `OR`-joined. `None` means no term qualifies, so
/// the caller skips the prefilter and keeps the literal scan — the same
/// fallback the whole-query prefilter had.
///
/// Each term is quoted, so words that read like FTS syntax are never
/// interpreted as query syntax. A term that carries a combining dot is left out:
/// the FTS tokenizer folds it while the literal scan does not, which would make
/// the prefilter drop rows the scan would have matched.
fn fts_match_query(terms: &[String]) -> Option<String> {
    let alternatives: Vec<String> = terms
        .iter()
        .filter(|term| term.chars().count() >= search_terms::MIN_FTS_TERM_CHARS)
        .filter(|term| !term.contains('\u{0307}'))
        .map(|term| format!("\"{}\"", term.replace('"', "\"\"")))
        .collect();
    (!alternatives.is_empty()).then(|| alternatives.join(" OR "))
}

/// Whether this hit contains the whole query. The phrase bonus is the one part
/// of the score a reader of the result cannot recompute from the matched terms,
/// so it is decided here rather than stored on the hit.
fn phrase_hit(hit: &MemorySearchHit, terms: &[String]) -> bool {
    search_terms::match_count(&hit.entry.content, hit.entry.rationale.as_deref(), terms).phrase
}
