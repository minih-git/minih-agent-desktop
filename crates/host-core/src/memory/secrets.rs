//! Credential detector for learned-memory writes (ADR agent-long-term-memory).
//!
//! This is a *decision* (store or refuse), not a redactor: the audit redactor in
//! `crate::audit` always rewrites its input and also strips absolute paths, so
//! reusing it would refuse a memory that merely mentions a path. The patterns
//! below are deliberately high-confidence shapes only, because a false positive
//! costs the user a refused memory.
//!
//! A match is reported as a code and never as text: the refused content must not
//! reach a log, an error message, or a test snapshot.

use std::sync::OnceLock;

use regex::Regex;

/// `(name, pattern)`. The name is diagnostic only; it never leaves the host.
const PATTERNS: &[(&str, &str)] = &[
    // PEM private-key blocks and OpenSSH keys.
    ("pem_private_key", r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    // Provider-prefixed API keys and personal access tokens.
    (
        "provider_token",
        r"\b(?:sk|rk|pk)-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}\b",
    ),
    (
        "git_token",
        r"\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}\b",
    ),
    ("gitlab_token", r"\bglpat-[A-Za-z0-9_-]{20,}\b"),
    ("slack_token", r"\bxox[abprs]-[A-Za-z0-9-]{10,}\b"),
    ("google_token", r"\b(?:AIza|ya29\.)[A-Za-z0-9._-]{16,}\b"),
    ("aws_access_key", r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b"),
    ("registry_token", r"\b(?:hf_|npm_)[A-Za-z0-9]{20,}\b"),
    // JSON Web Tokens.
    (
        "jwt",
        r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}",
    ),
    // Authorization headers.
    (
        "authorization_scheme",
        r"(?i)\b(?:bearer|basic)\s+[A-Za-z0-9+/_=.-]{20,}",
    ),
    // Named credentials with a credential-shaped value.
    (
        "secret_assignment",
        r"(?i)\b(?:api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|auth[_-]?token|client[_-]?secret|secret[_-]?key)\b\s*[:=]\s*[A-Za-z0-9+/=_.-]{16,}",
    ),
    (
        "password_assignment",
        r"(?i)\bpass(?:word|wd|phrase)\b\s*[:=]\s*[A-Za-z0-9+/=_.!@#$%^&*-]{10,}",
    ),
    // Credentials embedded in a URL: scheme://user:secret@host.
    (
        "url_credentials",
        r"(?i)\b[a-z][a-z0-9+.-]*://[^\s/@:]{1,64}:[^\s/@]{3,}@",
    ),
];

fn detectors() -> &'static [(&'static str, Regex)] {
    static DETECTORS: OnceLock<Vec<(&'static str, Regex)>> = OnceLock::new();
    DETECTORS.get_or_init(|| {
        PATTERNS
            .iter()
            .map(|(name, pattern)| {
                (
                    *name,
                    Regex::new(pattern).expect("credential detector pattern is valid"),
                )
            })
            .collect()
    })
}

/// The name of the first matching shape, or `None` for text the host may store.
/// Callers must not log or return the inspected text.
pub(crate) fn detect(text: &str) -> Option<&'static str> {
    detectors()
        .iter()
        .find(|(_, pattern)| pattern.is_match(text))
        .map(|(name, _)| *name)
}

pub(crate) fn looks_like_credential(text: &str) -> bool {
    detect(text).is_some()
}
