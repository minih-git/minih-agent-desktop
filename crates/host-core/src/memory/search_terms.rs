//! Query terms for learned-memory search (ADR learned-memory-recall §1).
//!
//! A learned-memory query is written by a person, so it reads like a sentence:
//! `学习记忆 索引 预算`, `OpenViking migration status`, `what did we say about the
//! gateway`. Comparing the whole string as one literal substring, which is what
//! the search did before this module, only matches when the note happens to
//! contain that exact run of characters.
//!
//! This module turns a query into the terms a person would recognize: runs of
//! ASCII letters and digits (a `-` or `_` stays inside a run, so `pi-agent`
//! remains one term), and runs of CJK characters (a run is one term, because
//! Chinese is written without spaces). Whitespace and punctuation separate
//! terms. One-character terms, and a short English stopword list, are dropped
//! because they match nearly every note and would rank noise above the answer.
//!
//! When nothing survives — a query that is only stopwords, only one-character
//! words, or only punctuation — the trimmed whole query is the single term.
//! That is exactly the old behavior, so a caller that passes a distinctive
//! phrase keeps working, and an exact-phrase hit still ranks first.

/// English words too common to say anything about which note is relevant.
pub(crate) const STOPWORDS: [&str; 18] = [
    "the", "a", "an", "of", "to", "for", "in", "on", "and", "or", "is", "are", "was", "be", "this",
    "that", "with", "from",
];

/// A term shorter than this says too little to rank on.
const MIN_TERM_CHARS: usize = 2;
/// A term at least this long may drive the trigram-FTS prefilter.
pub(crate) const MIN_FTS_TERM_CHARS: usize = 3;

/// `true` for a character that counts as part of a CJK run.
///
/// The ranges are the ones a Chinese, Japanese, or Korean note actually uses:
/// CJK punctuation, kana, Hangul, and Han. They are one run whatever the
/// language, because none of them is written with spaces between words.
fn is_cjk(ch: char) -> bool {
    matches!(
        ch as u32,
        0x1100..=0x11ff // Hangul Jamo
            | 0x3000..=0x30ff // CJK punctuation and kana
            | 0x3130..=0x318f // Hangul compatibility Jamo
            | 0x3400..=0x4dbf // Han extension A
            | 0x4e00..=0x9fff // Han
            | 0xac00..=0xd7af // Hangul syllables
            | 0xf900..=0xfaff // CJK compatibility ideographs
            | 0xff01..=0xff60 // full-width forms
            | 0xffe0..=0xffe6
            | 0x20000..=0x2ebef // Han extensions B–F
    )
}

/// `true` for a character that continues an ASCII term.
///
/// `-` and `_` stay inside a run, so `pi-agent` and `read_only` survive as the
/// identifiers the note actually contains. A leading or trailing separator is
/// trimmed afterwards. Every other punctuation character separates terms, the
/// dot included: `v0.1` is `v0` and `1`, and the `1` is dropped as too short.
fn is_ascii_term(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || ch == '-' || ch == '_'
}

/// Trim leading and trailing `-`/`_`, which separate rather than belong.
fn trim_separators(term: &str) -> &str {
    term.trim_matches(|ch| ch == '-' || ch == '_')
}

/// The terms a query is matched by, in the order they appear.
///
/// Deduplicated and lower-cased for ASCII, so `Gateway gateway` counts once and
/// a caller does not have to normalize anything. CJK terms keep their own case
/// (there is none) and are not split further.
pub(crate) fn split_terms(query: &str) -> Vec<String> {
    let trimmed = query.trim();
    let mut terms: Vec<String> = Vec::new();
    let mut run = String::new();
    let mut run_is_cjk = false;
    let mut push = |candidate: &str| {
        let term = trim_separators(candidate);
        if term.chars().count() < MIN_TERM_CHARS {
            return;
        }
        let folded = term.to_lowercase();
        if STOPWORDS.contains(&folded.as_str()) {
            return;
        }
        if !terms.iter().any(|existing| existing == &folded) {
            terms.push(folded);
        }
    };
    for ch in trimmed.chars() {
        let cjk = is_cjk(ch);
        // A CJK run and an ASCII run never continue each other: `部署gateway` is
        // two terms, which is also how the note reads.
        if cjk != run_is_cjk && !run.is_empty() {
            push(&run);
            run.clear();
        }
        if cjk {
            run.push(ch);
            run_is_cjk = true;
        } else if is_ascii_term(ch) {
            run.push(ch);
            run_is_cjk = false;
        } else {
            // Whitespace and punctuation end the run they follow.
            run_is_cjk = false;
            if run.is_empty() {
                continue;
            }
            push(&run);
            run.clear();
        }
    }
    if !run.is_empty() {
        push(&run);
    }
    if terms.is_empty() && !trimmed.is_empty() {
        // Nothing survived, so the whole query is the one term: the previous
        // behavior for a caller that passes a short distinctive phrase.
        terms.push(trimmed.to_lowercase());
    }
    terms
}

/// How one entry answers one query.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TermMatch {
    /// The terms found in the entry's content or rationale, in query order.
    pub matched: Vec<String>,
    /// How many distinct terms were found.
    pub count: usize,
    /// Whether the whole query appears verbatim (case-insensitive).
    pub phrase: bool,
}

impl TermMatch {
    /// The terms that can drive the trigram-FTS prefilter.
    pub fn fts_terms<'a>(&self, terms: &'a [String]) -> Vec<&'a str> {
        terms
            .iter()
            .filter(|term| term.chars().count() >= MIN_FTS_TERM_CHARS)
            .map(String::as_str)
            .collect()
    }
}

/// Score one entry against the query terms.
///
/// The literal comparison is `to_lowercase().contains`, the same rule the
/// session search's `pi_search_contains` uses, so the two read text the same
/// way: SQLite's ASCII-only `LIKE` would miss every non-ASCII case mapping.
pub(crate) fn match_count(content: &str, rationale: Option<&str>, terms: &[String]) -> TermMatch {
    let haystacks = [
        content.to_lowercase(),
        rationale.unwrap_or_default().to_lowercase(),
    ];
    let mut matched = Vec::with_capacity(terms.len());
    for term in terms {
        if haystacks.iter().any(|text| text.contains(term.as_str())) {
            matched.push(term.clone());
        }
    }
    let count = matched.len();
    // The phrase bonus is only meaningful for a query of two or more terms: a
    // one-term query is its own phrase, and charging that as a bonus would make
    // every hit look like an exact match.
    let phrase = terms.len() > 1 && haystacks.iter().any(|text| text.contains(&terms.join(" ")));
    TermMatch {
        matched,
        count,
        phrase,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_a_mixed_ascii_and_cjk_sentence() {
        assert_eq!(
            split_terms("学习记忆 索引 预算"),
            vec!["学习记忆", "索引", "预算"]
        );
        assert_eq!(
            split_terms("OpenViking migration status"),
            vec!["openviking", "migration", "status"]
        );
        // A CJK run and an ASCII run are separate terms even without a space.
        assert_eq!(split_terms("部署gateway"), vec!["部署", "gateway"]);
    }

    #[test]
    fn punctuation_separates_and_identifiers_stay_whole() {
        assert_eq!(
            split_terms("pi-agent, read_only; v0.1!"),
            vec!["pi-agent", "read_only", "v0"]
        );
        // A separator at either edge is trimmed rather than kept.
        assert_eq!(
            split_terms("-leading and trailing_"),
            vec!["leading", "trailing"]
        );
    }

    #[test]
    fn drops_stopwords_short_terms_and_duplicates() {
        assert_eq!(
            split_terms("the gateway is a gateway of the project"),
            vec!["gateway", "project"]
        );
        // One character tells nothing apart, in either script.
        assert_eq!(split_terms("a b 的 gateway"), vec!["gateway"]);
    }

    #[test]
    fn falls_back_to_the_whole_query_when_nothing_survives() {
        // Only stopwords: the phrase is still what the caller typed.
        assert_eq!(split_terms("the of to"), vec!["the of to"]);
        // Only punctuation: the trimmed query is one term.
        assert_eq!(split_terms("  !!!  "), vec!["!!!"]);
        assert!(split_terms("   ").is_empty());
    }

    #[test]
    fn matches_any_term_in_content_or_rationale() {
        let terms = split_terms("gateway deploy");
        let hit = match_count(
            "The gateway listens on 8787.",
            Some("Deploy on Friday"),
            &terms,
        );
        assert_eq!(hit.matched, vec!["gateway", "deploy"]);
        assert_eq!(hit.count, 2);
        // Two terms in order are not adjacent, so this is not a phrase.
        assert!(!hit.phrase);
    }

    #[test]
    fn a_verbatim_query_earns_the_phrase_bonus() {
        let terms = split_terms("gateway deploy");
        let hit = match_count("The gateway deploy runs nightly.", None, &terms);
        assert!(hit.phrase);
        // A case mapping the SQL `LIKE` could not see is still a phrase.
        let cased = split_terms("Gateway Deploy");
        assert!(match_count("the GATEWAY DEPLOY runs", None, &cased).phrase);
    }

    #[test]
    fn a_single_term_query_is_never_a_phrase_bonus() {
        let terms = split_terms("gateway");
        let hit = match_count("The gateway listens on 8787.", None, &terms);
        assert_eq!(hit.count, 1);
        assert!(!hit.phrase);
    }

    #[test]
    fn cjk_terms_match_within_a_longer_run() {
        let terms = split_terms("学习记忆");
        assert!(match_count("这条学习记忆记录说明了预算。", None, &terms).count == 1);
    }

    #[test]
    fn only_terms_of_three_characters_drive_the_prefilter() {
        let terms = split_terms("索引 gateway a1");
        let hit = match_count("索引 gateway a1", None, &terms);
        // Two-character terms (`索引`, `a1`) still match; they only cannot drive
        // the trigram prefilter, which needs three characters to index.
        assert_eq!(hit.count, 3);
        assert_eq!(hit.fts_terms(&terms), vec!["gateway"]);
    }
}
