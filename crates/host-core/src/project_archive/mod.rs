//! One logical project or project group, packaged as a versioned ZIP archive.
//!
//! Cloud sync transports global configuration only: a project's files, its
//! `AGENTS.md`, pinned memory, MCP servers, skills and folder-bound automations
//! belong to the machine that owns the folder (see `config_sync::domains`).
//! Moving a project to another machine is therefore an explicit, one-time
//! export and import rather than a continuous sync relationship: after the
//! import both copies are independent.
//!
//! What travels: every file under each ordered root, including hidden files and
//! `.git`, plus the app-managed configuration that is not stored in the tree
//! (project and group memory, the group's instruction text, and the automations
//! bound to the project). Project skills, subagents and MCP definitions are
//! files inside `<project>/.agents/`, so they ride with the tree and are
//! re-scanned by the receiving Host.
//!
//! What never travels: chat history, the global settings and account, API keys,
//! MCP `env`/`headers` values, OAuth state, plugin binaries and grants, and
//! runtime or device state. Because `<project>/.agents/mcp/` stores MCP
//! definitions *with* their secret values, those files are excluded from the
//! tree copy and the archive carries a sanitized definition instead, imported
//! disabled. An imported automation stays disabled, and imported content is
//! never executed or granted a permission by this module.
//!
//! The archive is streamed: entries are copied through a bounded buffer and the
//! full tree is never held in memory. Import fully validates a staged copy
//! outside the destination before anything is published, and refuses to
//! overwrite an existing non-empty folder, so a failed import leaves no
//! half-imported project behind.

use anyhow::anyhow;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;

pub(crate) const ARCHIVE_FORMAT: &str = "minih-agent-desktop-project-archive";
pub(crate) const ARCHIVE_VERSION: u32 = 1;

const MANIFEST_ENTRY: &str = "manifest.json";
const ROOTS_PREFIX: &str = "roots";

/// App-managed capability folder inside one project. MCP definitions are stored
/// here together with their `env`/`headers` values, so this subtree is the one
/// part of a project that must be replaced by sanitized manifest data.
const AGENTS_DIR: &str = crate::agent_capabilities::AGENTS_DIR;
const MCP_DIR: &str = "servers";

/// Most folder roots one archive may carry. A stored group cannot exceed this,
/// and an archive claiming more is not something this build produced.
const MAX_ROOTS: usize = 32;
/// Most ZIP entries one import may declare.
const MAX_ENTRIES: usize = 200_000;
/// Most uncompressed bytes one import may expand to.
const MAX_TOTAL_BYTES: u64 = 8 * 1024 * 1024 * 1024;
/// Largest single expanded file.
const MAX_ENTRY_BYTES: u64 = 2 * 1024 * 1024 * 1024;
/// Largest manifest document.
const MAX_MANIFEST_BYTES: u64 = 8 * 1024 * 1024;
/// Longest root folder name taken from an archive.
const MAX_ROOT_NAME_CHARS: usize = 128;
/// Buffer used while streaming entries in either direction.
const COPY_BUFFER_BYTES: usize = 256 * 1024;

/// Reports transferred work. The renderer shows it while one request runs.
pub(crate) type ArchiveProgress<'a> = &'a (dyn Fn(&'static str, u64, u64) + Sync);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ArchiveManifest {
    pub format: String,
    pub version: u32,
    pub created_at: String,
    pub name: String,
    pub roots: Vec<ArchiveRoot>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<ArchiveGroupConfig>,
    #[serde(default)]
    pub projects: Vec<ArchiveProjectConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ArchiveRoot {
    pub index: usize,
    /// Folder name only. The source machine's absolute path never travels.
    pub name: String,
    pub file_count: u64,
    pub total_bytes: u64,
    /// Symbolic links are not archived; the count tells the user what a copy
    /// could not carry.
    #[serde(default)]
    pub skipped_symlinks: u64,
    /// App-managed MCP definition files left out of the tree copy because they
    /// keep their secret values; the manifest carries a sanitized definition.
    #[serde(default)]
    pub skipped_secret_files: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ArchiveGroupConfig {
    #[serde(default)]
    pub instructions: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memory: Option<Value>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ArchiveProjectConfig {
    /// Index of the root this configuration belongs to.
    pub root: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memory: Option<Value>,
    /// MCP definitions without their secret values.
    #[serde(default)]
    pub mcp: Vec<Value>,
    /// Automation definitions, always imported disabled.
    #[serde(default)]
    pub automations: Vec<Value>,
}

/// Everything one export needs, gathered under the host state lock.
pub(crate) struct ExportPlan {
    pub target: PathBuf,
    pub manifest: ArchiveManifest,
    pub roots: Vec<PathBuf>,
}

/// A validated archive extracted beside the destination, ready to publish.
pub(crate) struct StagedImport {
    pub staging: PathBuf,
    pub manifest: ArchiveManifest,
    pub target_parent: PathBuf,
    pub total_bytes: u64,
}

fn invalid(message: impl Into<String>) -> anyhow::Error {
    anyhow!("PROJECT_ARCHIVE_INVALID: {}", message.into())
}

fn limit_exceeded(message: impl Into<String>) -> anyhow::Error {
    anyhow!("PROJECT_ARCHIVE_LIMIT_EXCEEDED: {}", message.into())
}

fn conflict(message: impl Into<String>) -> anyhow::Error {
    anyhow!("PROJECT_ARCHIVE_CONFLICT: {}", message.into())
}

fn io_error(context: &str, error: std::io::Error) -> anyhow::Error {
    anyhow!("PROJECT_ARCHIVE_IO: {context}: {error}")
}

fn walk_error(context: &str, error: walkdir::Error) -> anyhow::Error {
    anyhow!("PROJECT_ARCHIVE_IO: {context}: {error}")
}

mod export;
mod import;
mod paths;

pub(crate) use export::{export_plan, export_write};
pub(crate) use import::{apply_import, stage_import};

#[cfg(test)]
#[path = "../project_archive_tests.rs"]
mod tests;
