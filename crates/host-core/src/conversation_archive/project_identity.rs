//! Project identity for the archive feed (ADR conversation-archive §5).
//!
//! A plugin writes vault files per project, and the same repository must land in
//! the same folder on every computer even though each computer stores it at its
//! own path. The normal form is therefore the git remote when there is one:
//! `host/owner/repo`, with any credential in the URL removed before it can be
//! copied into a synced note.
//!
//! Two shapes have to be handled beyond the ordinary `.git/config`: a worktree,
//! whose `.git` is a file naming the main repository's git directory, and a
//! subdirectory of a repository, where the project path itself has no `.git`.
//! Both are resolved here by walking up, so the identity is a property of the
//! repository rather than of the exact folder the user opened.

use std::path::{Path, PathBuf};

use serde::Serialize;

/// `host/owner/repo`, the cross-computer identity of one repository.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectIdentity {
    pub name: String,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub git_remote: Option<String>,
}

/// The directory that holds `.git/config`, walking up from a project path.
fn repository_root(path: &Path) -> Option<PathBuf> {
    let mut current = Some(path);
    while let Some(dir) = current {
        if dir.join(".git").exists() {
            return Some(dir.to_path_buf());
        }
        current = dir.parent();
    }
    None
}

/// The git directory behind a `.git` entry.
///
/// A worktree or submodule keeps a `.git` *file* holding `gitdir: <path>`; the
/// config that names the remote lives there, not in the checkout.
fn git_dir(root: &Path) -> Option<PathBuf> {
    let dot_git = root.join(".git");
    let metadata = std::fs::metadata(&dot_git).ok()?;
    if metadata.is_dir() {
        return Some(dot_git);
    }
    let content = std::fs::read_to_string(&dot_git).ok()?;
    let target = content.lines().find_map(|line| {
        line.trim()
            .strip_prefix("gitdir:")
            .map(|rest| rest.trim().to_string())
    })?;
    let candidate = Path::new(&target);
    Some(if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        dot_git.parent()?.join(candidate)
    })
}

/// The `origin` URL (or the first remote) recorded in one git config.
fn remote_url(git_dir: &Path) -> Option<String> {
    let config_path = if git_dir.join("config").exists() {
        git_dir.join("config")
    } else {
        // A linked worktree keeps the shared config in the common directory.
        let common = std::fs::read_to_string(git_dir.join("commondir")).ok()?;
        git_dir.join(common.trim()).join("config")
    };
    let config = std::fs::read_to_string(config_path).ok()?;
    let mut section = String::new();
    let mut origin: Option<String> = None;
    let mut first: Option<String> = None;
    for line in config.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            section = trimmed[1..trimmed.len() - 1].trim().to_ascii_lowercase();
            continue;
        }
        if !section.starts_with("remote ") {
            continue;
        }
        let Some((key, value)) = trimmed.split_once('=') else {
            continue;
        };
        if key.trim() != "url" {
            continue;
        }
        let url = value.trim().to_string();
        if first.is_none() {
            first = Some(url.clone());
        }
        if section == "remote \"origin\"" {
            origin = Some(url);
        }
    }
    origin.or(first)
}

/// Reduce a clone URL to `host/owner/repo`.
///
/// Credentials in the URL are dropped, because this string is written into a
/// note that syncs to every computer: `https://user:token@host/o/r.git` and
/// `ssh://git@host/o/r` both become `host/o/r`. A local path remote keeps its
/// last two components, which is the most a sibling computer can use.
pub(crate) fn normalize_remote(url: &str) -> Option<String> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return None;
    }
    let trimmed = trimmed.strip_suffix(".git").unwrap_or(trimmed);
    let without_scheme = match trimmed.split_once("://") {
        Some((_scheme, rest)) => rest,
        None => trimmed,
    };
    // `user:secret@` is a credential either way, and the host is what follows
    // it. Dropping the credential first is what lets the remaining text be read
    // as the two shapes that exist: a URL authority ending at the first `/`, or
    // the scp-like `git@host:owner/repo` whose `:` separates host from path.
    let authority_and_path = without_scheme
        .rsplit_once('@')
        .map(|(_, rest)| rest)
        .unwrap_or(without_scheme);
    let first_slash = authority_and_path.find('/');
    let colon = authority_and_path.find(':');
    let (host_part, path_part) = match (first_slash, colon) {
        (Some(slash), Some(colon)) if colon < slash => (
            &authority_and_path[..colon],
            &authority_and_path[colon + 1..],
        ),
        (Some(slash), _) => (
            &authority_and_path[..slash],
            &authority_and_path[slash + 1..],
        ),
        (None, Some(colon)) => (
            &authority_and_path[..colon],
            &authority_and_path[colon + 1..],
        ),
        (None, None) => (authority_and_path, ""),
    };
    let host = host_part
        .split(':')
        .next()
        .unwrap_or(host_part)
        .trim()
        .to_ascii_lowercase();
    let path: Vec<&str> = path_part
        .split('/')
        .filter(|segment| !segment.is_empty() && *segment != "~")
        .collect();
    if host.is_empty() || path.is_empty() {
        return None;
    }
    let joined = if path.len() >= 2 {
        format!("{}/{}", path[path.len() - 2], path[path.len() - 1])
    } else {
        path[0].to_string()
    };
    Some(format!("{host}/{joined}"))
}

/// The identity of one project folder, as the feed reports it.
pub(crate) fn project_identity(name: &str, path: &str) -> ProjectIdentity {
    let root = Path::new(path);
    let git_remote = repository_root(root)
        .and_then(|root| git_dir(&root))
        .and_then(|dir| remote_url(&dir))
        .and_then(|url| normalize_remote(&url));
    ProjectIdentity {
        name: name.to_string(),
        path: path.to_string(),
        git_remote,
    }
}
