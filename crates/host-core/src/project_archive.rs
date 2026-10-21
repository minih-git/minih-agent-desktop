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

use crate::agent_capabilities::CapabilityLevel;
use crate::state::AppState;
use anyhow::{anyhow, bail, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::fs::{self, File};
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::{Component, Path, PathBuf};
use unicode_normalization::UnicodeNormalization;
use uuid::Uuid;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

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

fn required_path(params: &Value, key: &str) -> Result<PathBuf> {
    let value = params
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| invalid(format!("{key} is required")))?;
    let path = PathBuf::from(value);
    if !path.is_absolute() {
        return Err(invalid(format!("{key} must be an absolute path")));
    }
    Ok(path)
}

fn canonical_directory(raw: &Path, key: &str) -> Result<PathBuf> {
    let path =
        fs::canonicalize(raw).map_err(|error| invalid(format!("{key} is unavailable: {error}")))?;
    if !path.is_dir() {
        return Err(invalid(format!("{key} is not a folder")));
    }
    Ok(path)
}

/// A single path segment taken from an archive, so an entry name can never
/// escape the folder it is extracted into.
fn safe_segment(name: &str) -> Option<String> {
    let trimmed = name.trim();
    if trimmed.is_empty()
        || trimmed.chars().count() > MAX_ROOT_NAME_CHARS
        || trimmed == "."
        || trimmed == ".."
        || trimmed.contains('/')
        || trimmed.contains('\\')
        || trimmed.chars().any(char::is_control)
    {
        return None;
    }
    Some(trimmed.to_string())
}

/// A portable relative path inside a root.
fn safe_relative(path: &str) -> Option<PathBuf> {
    if path.is_empty() || path.contains('\\') || path.chars().any(char::is_control) {
        return None;
    }
    let candidate = Path::new(path);
    let mut depth = 0usize;
    for component in candidate.components() {
        match component {
            Component::Normal(_) => depth += 1,
            _ => return None,
        }
    }
    if depth == 0 {
        return None;
    }
    Some(candidate.to_path_buf())
}

/// The identity one archive path has on a case-insensitive, normalization-
/// insensitive volume.
///
/// Archives travel between platforms. macOS and Windows commonly use a
/// case-insensitive volume, and the same name can be stored composed (NFC) or
/// decomposed (NFD). Two entries that differ only that way would land on one
/// file there, and the second would silently replace the first — data loss
/// dressed up as a successful import. Both sides therefore compare names by this
/// key: a collision is refused instead of overwritten, even where the local
/// volume would happen to keep them apart.
fn archive_path_key(path: &str) -> String {
    path.nfc().collect::<String>().to_lowercase()
}

fn portable_components(path: &Path) -> Option<String> {
    let mut parts = Vec::new();
    for component in path.components() {
        match component {
            Component::Normal(value) => parts.push(value.to_string_lossy().to_string()),
            _ => return None,
        }
    }
    if parts.is_empty() {
        return None;
    }
    Some(parts.join("/"))
}

/// Whether one project file belongs to the app-managed MCP definitions, which
/// hold secret values and are replaced by the sanitized manifest copy.
///
/// The comparison ignores ASCII case: a case-insensitive volume can name the
/// folder `.AGENTS/Servers`, and that file still holds the same values.
fn is_app_managed_secret(relative: &Path) -> bool {
    let parts = relative
        .components()
        .map(|component| component.as_os_str().to_string_lossy().to_string())
        .collect::<Vec<_>>();
    parts.len() >= 2
        && parts[0].eq_ignore_ascii_case(AGENTS_DIR)
        && parts[1].eq_ignore_ascii_case(MCP_DIR)
}

/// Count one root and refuse a shape this build could not import again.
///
/// The export and the import share the same bounds, so an export never produces
/// an archive that `stage_import` would reject.
fn count_root(root: &Path) -> Result<ArchiveRoot> {
    let mut files = 0u64;
    let mut bytes = 0u64;
    let mut symlinks = 0u64;
    let mut secrets = 0u64;
    let mut names = BTreeSet::new();
    for entry in walkdir::WalkDir::new(root)
        .follow_links(false)
        .sort_by_file_name()
    {
        let Ok(entry) = entry else { continue };
        if entry.depth() == 0 {
            continue;
        }
        let file_type = entry.file_type();
        if file_type.is_symlink() {
            symlinks += 1;
            continue;
        }
        if !file_type.is_file() {
            continue;
        }
        let relative = match entry.path().strip_prefix(root) {
            Ok(relative) => relative,
            Err(_) => continue,
        };
        if is_app_managed_secret(relative) {
            secrets += 1;
            continue;
        }
        let portable = portable_components(relative).ok_or_else(|| {
            invalid(format!(
                "project file {} cannot be archived",
                relative.display()
            ))
        })?;
        if !names.insert(archive_path_key(&portable)) {
            return Err(invalid(format!(
                "project has two files that differ only by case or unicode normal form: {portable}"
            )));
        }
        let size = entry.metadata().map(|value| value.len()).unwrap_or(0);
        if size > MAX_ENTRY_BYTES {
            return Err(limit_exceeded(format!(
                "{} is too large to archive",
                relative.display()
            )));
        }
        files += 1;
        if files.saturating_add(1) > MAX_ENTRIES as u64 {
            return Err(limit_exceeded("project has too many files to archive"));
        }
        bytes = bytes.saturating_add(size);
        if bytes > MAX_TOTAL_BYTES {
            return Err(limit_exceeded("project is too large to archive"));
        }
    }
    Ok(ArchiveRoot {
        index: 0,
        name: root
            .file_name()
            .and_then(|value| value.to_str())
            .and_then(safe_segment)
            .unwrap_or_else(|| "project".into()),
        file_count: files,
        total_bytes: bytes,
        skipped_symlinks: symlinks,
        skipped_secret_files: secrets,
    })
}

/// Portable MCP definition: identity and transport shape, never the secret
/// values (`env`/`headers` are dropped and only their keys are named).
fn portable_mcp(record: &crate::mcp_servers::McpServerRecord) -> Value {
    let mut payload = json!({
        "id": record.id,
        "label": record.label,
        "description": record.description,
        "transport": record.transport,
        "command": record.command,
        "args": record.args,
        "url": record.url,
        "timeoutSeconds": record.timeout_seconds,
        // Import always starts disabled; the user decides when it runs.
        "enabled": false,
    });
    if let Some(object) = payload.as_object_mut() {
        if !record.env.is_empty() {
            object.insert(
                "envKeys".into(),
                Value::Array(record.env.keys().cloned().map(Value::String).collect()),
            );
        }
        if !record.headers.is_empty() {
            object.insert(
                "headerKeys".into(),
                Value::Array(record.headers.keys().cloned().map(Value::String).collect()),
            );
        }
    }
    payload
}

fn memory_payload(memory: &crate::db::ProjectMemoryRecord) -> Option<Value> {
    if memory.content.trim().is_empty() && memory.entries.is_none() {
        return None;
    }
    Some(json!({ "content": memory.content, "entries": memory.entries }))
}

fn portable_automations(st: &AppState, project_path: &str) -> Result<Vec<Value>> {
    let mut result = Vec::new();
    for task in crate::scheduled::list_tasks(&st.db)? {
        if task.workspace_path.as_deref() != Some(project_path) {
            continue;
        }
        let mut payload = serde_json::to_value(&task)?;
        if let Some(object) = payload.as_object_mut() {
            object.remove("workspacePath");
            object.insert("enabled".into(), Value::Bool(false));
        }
        result.push(payload);
    }
    Ok(result)
}

/// Gather one project's archive input. Runs under the host state lock; the
/// returned plan is owned, so the streaming write happens without it.
pub(crate) fn export_plan(
    st: &mut AppState,
    params: &Value,
    progress: ArchiveProgress<'_>,
) -> Result<ExportPlan> {
    let project_path = required_path(params, "projectPath")?;
    let target = required_path(params, "targetPath")?;
    let project_path = crate::db::canonical_project_path(&project_path.to_string_lossy())
        .map(PathBuf::from)
        .ok_or_else(|| invalid("projectPath is unavailable"))?;
    let projects = st.db.list_projects()?;
    let project = projects
        .iter()
        .find(|project| Path::new(&project.path) == project_path.as_path())
        .ok_or_else(|| invalid("projectPath is not a registered project"))?;

    let group = st.db.project_group_for_path(&project.path)?;
    let mut roots = Vec::new();
    let mut root_names = Vec::new();
    match group.as_ref() {
        Some(group) if !group.legacy && !group.roots.is_empty() => {
            for root in &group.roots {
                let path = PathBuf::from(&root.path);
                if !path.is_dir() {
                    bail!(
                        "PROJECT_ARCHIVE_IO: project folder {} is missing",
                        root.path
                    );
                }
                roots.push(path);
                root_names.push(root.name.clone());
            }
        }
        _ => {
            roots.push(project_path.clone());
            root_names.push(project.name.clone());
        }
    }
    if roots.len() > MAX_ROOTS {
        return Err(limit_exceeded("project group has too many folders"));
    }
    let mut root_keys = BTreeSet::new();
    for name in &root_names {
        let name = safe_segment(name).unwrap_or_else(|| "project".into());
        if !root_keys.insert(archive_path_key(&name)) {
            return Err(invalid(format!(
                "project group has two folders with equivalent names: {name}"
            )));
        }
    }

    // A symlinked parent can point back into a project; check the real path,
    // not the lexical one, before anything is written.
    let target = resolved_export_target(&target, &roots)?;
    let mut manifest = ArchiveManifest {
        format: ARCHIVE_FORMAT.into(),
        version: ARCHIVE_VERSION,
        created_at: chrono::Utc::now().to_rfc3339(),
        name: project.name.clone(),
        roots: Vec::new(),
        group: None,
        projects: Vec::new(),
    };
    for (index, root) in roots.iter().enumerate() {
        let mut captured = count_root(root)?;
        captured.index = index;
        captured.name = safe_segment(&root_names[index]).unwrap_or_else(|| format!("root-{index}"));
        progress("export", 0, captured.total_bytes);
        manifest.roots.push(captured);
    }
    if let Some(group) = group.as_ref().filter(|group| !group.legacy) {
        manifest.name = group.name.clone();
        manifest.group = Some(ArchiveGroupConfig {
            instructions: st.db.get_project_group_instructions(&group.id)?,
            memory: st
                .db
                .get_project_group_memory(&group.id)
                .ok()
                .as_ref()
                .and_then(memory_payload),
        });
    }
    for (index, root) in roots.iter().enumerate() {
        let path = root.to_string_lossy().into_owned();
        manifest.projects.push(ArchiveProjectConfig {
            root: index,
            memory: st
                .db
                .get_project_memory(&path)
                .ok()
                .as_ref()
                .and_then(memory_payload),
            mcp: st
                .mcp_servers
                .list(CapabilityLevel::Project, Some(&path))?
                .iter()
                .map(portable_mcp)
                .collect(),
            automations: portable_automations(st, &path)?,
        });
    }

    let total_bytes: u64 = manifest
        .roots
        .iter()
        .map(|root| root.total_bytes)
        .fold(0u64, u64::saturating_add);
    if total_bytes > MAX_TOTAL_BYTES {
        return Err(limit_exceeded("project is too large to archive"));
    }
    let entries: u64 = manifest
        .roots
        .iter()
        .map(|root| root.file_count)
        .fold(0u64, u64::saturating_add);
    if entries.saturating_add(1) > MAX_ENTRIES as u64 {
        return Err(limit_exceeded("project has too many files to archive"));
    }
    Ok(ExportPlan {
        target,
        manifest,
        roots,
    })
}

/// Resolve where the archive will really be written and refuse a target inside
/// any source root, including a parent that reaches one through a symbolic link.
fn resolved_export_target(target: &Path, roots: &[PathBuf]) -> Result<PathBuf> {
    let parent = target
        .parent()
        .ok_or_else(|| invalid("targetPath has no parent folder"))?;
    let canonical_parent = fs::canonicalize(parent)
        .map_err(|error| invalid(format!("targetPath parent is unavailable: {error}")))?;
    let filename = target
        .file_name()
        .ok_or_else(|| invalid("targetPath is invalid"))?;
    let resolved = canonical_parent.join(filename);
    for root in roots {
        let canonical_root = fs::canonicalize(root)
            .map_err(|error| invalid(format!("project folder is unavailable: {error}")))?;
        if resolved.starts_with(&canonical_root) {
            return Err(invalid("targetPath is inside a project folder"));
        }
    }
    Ok(resolved)
}

fn zip_options() -> SimpleFileOptions {
    SimpleFileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .unix_permissions(0o644)
}

fn start_entry(writer: &mut ZipWriter<BufWriter<File>>, name: &str) -> Result<()> {
    writer
        .start_file(name, zip_options())
        .map_err(|error| anyhow!("PROJECT_ARCHIVE_IO: create archive entry {name}: {error}"))
}

fn copy_into_zip<R: Read>(
    writer: &mut ZipWriter<BufWriter<File>>,
    reader: &mut R,
    bytes: &mut u64,
) -> Result<()> {
    let mut buffer = vec![0u8; COPY_BUFFER_BYTES];
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|error| io_error("read project file", error))?;
        if read == 0 {
            return Ok(());
        }
        writer
            .write_all(&buffer[..read])
            .map_err(|error| io_error("write archive entry", error))?;
        *bytes = bytes.saturating_add(read as u64);
    }
}

/// Stream the archive to disk. Writes a temporary file first, so a failed
/// export never destroys an archive that already existed.
pub(crate) fn export_write(plan: &ExportPlan, progress: ArchiveProgress<'_>) -> Result<Value> {
    let parent = plan
        .target
        .parent()
        .ok_or_else(|| invalid("targetPath has no parent folder"))?;
    fs::create_dir_all(parent)
        .map_err(|error| invalid(format!("targetPath parent is unavailable: {error}")))?;
    let filename = plan
        .target
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| invalid("targetPath is invalid"))?;
    let temporary = parent.join(format!(".{filename}.{}.tmp", Uuid::new_v4()));
    let total_bytes: u64 = plan
        .manifest
        .roots
        .iter()
        .map(|root| root.total_bytes)
        .fold(0u64, u64::saturating_add);
    let result = (|| -> Result<()> {
        let file = File::create(&temporary).map_err(|error| {
            anyhow!(
                "PROJECT_ARCHIVE_IO: create {}: {error}",
                temporary.display()
            )
        })?;
        let mut writer = ZipWriter::new(BufWriter::new(file));
        start_entry(&mut writer, MANIFEST_ENTRY)?;
        let manifest_bytes = serde_json::to_vec_pretty(&plan.manifest)?;
        writer
            .write_all(&manifest_bytes)
            .map_err(|error| io_error("write manifest", error))?;

        let mut written = 0u64;
        for (index, root) in plan.roots.iter().enumerate() {
            let prefix = format!("{ROOTS_PREFIX}/{index}");
            let mut root_files = 0u64;
            let mut root_bytes = 0u64;
            for entry in walkdir::WalkDir::new(root)
                .follow_links(false)
                .sort_by_file_name()
            {
                let entry = entry
                    .map_err(|error| walk_error(&format!("scan {}", root.display()), error))?;
                if entry.depth() == 0 || !entry.file_type().is_file() {
                    continue;
                }
                if entry.path() == temporary.as_path() || entry.path() == plan.target.as_path() {
                    // Never read the archive being written back into itself.
                    continue;
                }
                let relative = entry
                    .path()
                    .strip_prefix(root)
                    .map_err(|_| invalid("project file escaped its project folder"))?;
                if is_app_managed_secret(relative) {
                    // Replaced by the sanitized definition in the manifest.
                    continue;
                }
                let portable = portable_components(relative)
                    .ok_or_else(|| invalid("project file path is not portable"))?;
                let mut source = File::open(entry.path()).map_err(|error| {
                    io_error(&format!("open {}", entry.path().display()), error)
                })?;
                start_entry(&mut writer, &format!("{prefix}/{portable}"))?;
                let mut bytes = 0u64;
                copy_into_zip(&mut writer, &mut source, &mut bytes)?;
                root_files = root_files.saturating_add(1);
                root_bytes = root_bytes.saturating_add(bytes);
                written = written.saturating_add(bytes);
                progress("export", written, total_bytes);
            }
            // The manifest states what the archive holds; the import verifies it
            // against these same counts, so a file that changed while the export
            // ran must fail here instead of shipping a stale statement.
            let expected = &plan.manifest.roots[index];
            if root_files != expected.file_count || root_bytes != expected.total_bytes {
                bail!(
                    "PROJECT_ARCHIVE_IO: project folder changed while exporting: {}",
                    root.display()
                );
            }
        }
        writer
            .finish()
            .map_err(|error| anyhow!("PROJECT_ARCHIVE_IO: finish archive: {error}"))?;
        Ok(())
    })();
    if let Err(error) = result {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    fs::rename(&temporary, &plan.target).map_err(|error| {
        let _ = fs::remove_file(&temporary);
        io_error(&format!("publish {}", plan.target.display()), error)
    })?;
    Ok(json!({
        "targetPath": plan.target.to_string_lossy(),
        "name": plan.manifest.name,
        "roots": plan.manifest.roots.len(),
        "files": plan.manifest.roots.iter().map(|root| root.file_count).sum::<u64>(),
        "bytes": total_bytes,
        "skippedSymlinks": plan.manifest.roots.iter().map(|root| root.skipped_symlinks).sum::<u64>(),
        "skippedSecretFiles": plan.manifest.roots.iter().map(|root| root.skipped_secret_files).sum::<u64>(),
    }))
}

/// Read and validate the manifest of an archive before trusting any of it.
fn read_manifest(archive: &mut ZipArchive<BufReader<File>>) -> Result<ArchiveManifest> {
    let entry = archive
        .by_name(MANIFEST_ENTRY)
        .map_err(|_| invalid("archive has no manifest"))?;
    if entry.size() > MAX_MANIFEST_BYTES {
        return Err(limit_exceeded("archive manifest is too large"));
    }
    let mut bytes = Vec::new();
    entry
        .take(MAX_MANIFEST_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| invalid(format!("archive manifest is unreadable: {error}")))?;
    if bytes.len() as u64 > MAX_MANIFEST_BYTES {
        return Err(limit_exceeded("archive manifest is too large"));
    }
    let manifest: ArchiveManifest = serde_json::from_slice(&bytes)
        .map_err(|error| invalid(format!("archive manifest is malformed: {error}")))?;
    if manifest.format != ARCHIVE_FORMAT || manifest.version != ARCHIVE_VERSION {
        return Err(invalid("archive format or version is not supported"));
    }
    if manifest.roots.is_empty() || manifest.roots.len() > MAX_ROOTS {
        return Err(invalid("archive root list is invalid"));
    }
    let mut names = BTreeSet::new();
    for (index, root) in manifest.roots.iter().enumerate() {
        if root.index != index {
            return Err(invalid("archive root order is invalid"));
        }
        let name =
            safe_segment(&root.name).ok_or_else(|| invalid("archive root name is invalid"))?;
        // Two roots whose names collide on a case-insensitive volume would be
        // extracted into one folder; refuse them before anything is written.
        if !names.insert(archive_path_key(&name)) {
            return Err(invalid(
                "archive repeats a root folder name after normalization",
            ));
        }
    }
    let mut configured = BTreeSet::new();
    for project in &manifest.projects {
        if project.root >= manifest.roots.len() || !configured.insert(project.root) {
            return Err(invalid("archive project refers to an unknown root"));
        }
    }
    Ok(manifest)
}

fn entry_name_allowed(name: &str, manifest: &ArchiveManifest) -> Option<PathBuf> {
    let relative = safe_relative(name)?;
    let components = relative
        .components()
        .map(|component| component.as_os_str().to_string_lossy().to_string())
        .collect::<Vec<_>>();
    let index = components.get(1)?.parse::<usize>().ok()?;
    (components.first().map(String::as_str) == Some(ROOTS_PREFIX)
        && index < manifest.roots.len()
        && components.len() > 2)
        .then_some(relative)
}

fn remove_staging(staging: &Path) {
    let _ = fs::remove_dir_all(staging);
    // The per-import folder is one level below a shared parent; drop the parent
    // once it is empty so a failed import leaves nothing behind.
    if let Some(parent) = staging.parent() {
        let _ = fs::remove_dir(parent);
    }
}

/// Extract and validate an archive beside the destination. Nothing under the
/// destination is touched until this returns successfully.
pub(crate) fn stage_import(
    data_dir: &Path,
    params: &Value,
    progress: ArchiveProgress<'_>,
) -> Result<StagedImport> {
    let archive_path = required_path(params, "archivePath")?;
    let target_parent = required_path(params, "targetParentPath")?;
    let archive_path = fs::canonicalize(&archive_path)
        .map_err(|error| invalid(format!("archivePath is unavailable: {error}")))?;
    if !archive_path.is_file() {
        return Err(invalid("archivePath is not a file"));
    }
    let target_parent = canonical_directory(&target_parent, "targetParentPath")?;

    let file = File::open(&archive_path)
        .map_err(|error| io_error(&format!("open {}", archive_path.display()), error))?;
    let mut archive = ZipArchive::new(BufReader::new(file))
        .map_err(|error| invalid(format!("archive is not a readable ZIP: {error}")))?;
    if archive.len() > MAX_ENTRIES {
        return Err(limit_exceeded("archive has too many entries"));
    }
    let manifest = read_manifest(&mut archive)?;
    let staging = data_dir
        .join("project-import")
        .join(Uuid::new_v4().to_string());
    fs::create_dir_all(&staging)
        .map_err(|error| io_error(&format!("create {}", staging.display()), error))?;

    let result = (|| -> Result<u64> {
        let mut seen = BTreeSet::new();
        let mut expanded = 0u64;
        let mut per_root: Vec<(u64, u64)> = vec![(0, 0); manifest.roots.len()];
        let total = archive.len() as u64;
        for index in 0..archive.len() {
            let mut entry = archive
                .by_index(index)
                .map_err(|error| invalid(format!("archive entry is unreadable: {error}")))?;
            if entry.is_dir() {
                continue;
            }
            let name = entry.name().to_string();
            if name == MANIFEST_ENTRY {
                // Already read and validated above.
                continue;
            }
            // Symbolic links are never produced by an export, so an archive
            // carrying one is not one this build wrote.
            if entry
                .unix_mode()
                .is_some_and(|mode| mode & 0o170000 == 0o120000)
            {
                return Err(invalid(format!("archive entry {name} is a symbolic link")));
            }
            let Some(relative) = entry_name_allowed(&name, &manifest) else {
                return Err(invalid(format!("archive entry {name} is not allowed")));
            };
            // App-managed MCP definitions keep their secret values in the tree;
            // an archive never carries them, so a file that claims to be one is
            // refused instead of written back into a project.
            if is_app_managed_secret(&relative) {
                return Err(invalid(format!(
                    "archive entry {name} is an app-managed secret file"
                )));
            }
            // Compare normalized paths: `a//b` and `a/b` land on one file, and
            // so do names that differ only by letter case or Unicode normal
            // form on a case-insensitive volume.
            let normalized = portable_components(&relative)
                .ok_or_else(|| invalid(format!("archive entry {name} is not portable")))?;
            if !seen.insert(archive_path_key(&normalized)) {
                return Err(invalid(format!(
                    "archive repeats entry {normalized} after normalization"
                )));
            }
            let declared = entry.size();
            if declared > MAX_ENTRY_BYTES {
                return Err(limit_exceeded(format!("archive entry {name} is too large")));
            }
            expanded = expanded.saturating_add(declared);
            if expanded > MAX_TOTAL_BYTES {
                return Err(limit_exceeded("archive expands to too many bytes"));
            }
            let destination = staging.join(&relative);
            if let Some(parent) = destination.parent() {
                fs::create_dir_all(parent)
                    .map_err(|error| io_error(&format!("create {}", parent.display()), error))?;
            }
            let mut out = File::create(&destination)
                .map_err(|error| io_error(&format!("create {}", destination.display()), error))?;
            let mut copied = 0u64;
            let mut buffer = vec![0u8; COPY_BUFFER_BYTES];
            loop {
                let read = entry.read(&mut buffer).map_err(|error| {
                    invalid(format!("archive entry {name} is corrupt: {error}"))
                })?;
                if read == 0 {
                    break;
                }
                copied = copied.saturating_add(read as u64);
                if copied > declared || copied > MAX_ENTRY_BYTES {
                    return Err(invalid(format!(
                        "archive entry {name} is larger than declared"
                    )));
                }
                out.write_all(&buffer[..read]).map_err(|error| {
                    io_error(&format!("write {}", destination.display()), error)
                })?;
            }
            if copied != declared {
                return Err(invalid(format!("archive entry {name} is truncated")));
            }
            if let Some(root_index) = relative
                .components()
                .nth(1)
                .and_then(|component| component.as_os_str().to_str())
                .and_then(|value| value.parse::<usize>().ok())
            {
                if let Some(counter) = per_root.get_mut(root_index) {
                    counter.0 = counter.0.saturating_add(1);
                    counter.1 = counter.1.saturating_add(copied);
                }
            }
            progress("import", index as u64 + 1, total);
        }
        // The manifest counts are the archive's integrity statement: a root that
        // does not match was truncated, padded, or hand-edited.
        for (index, root) in manifest.roots.iter().enumerate() {
            let (files, bytes) = per_root[index];
            if files != root.file_count || bytes != root.total_bytes {
                return Err(invalid(format!(
                    "archive root {} does not match the manifest",
                    root.name
                )));
            }
        }
        Ok(expanded)
    })();
    let expanded = match result {
        Ok(expanded) => expanded,
        Err(error) => {
            remove_staging(&staging);
            return Err(error);
        }
    };
    Ok(StagedImport {
        staging,
        manifest,
        target_parent,
        total_bytes: expanded,
    })
}

/// A destination root must either not exist yet or be a real, empty directory.
///
/// `Path::exists` follows symbolic links, so a link placed under the chosen
/// parent would pass an "is it empty" test and then redirect every write to its
/// target — which can be anywhere, including outside the destination. The check
/// therefore looks at the link itself and refuses a symbolic link, or anything
/// else that is not a directory, instead of only asking whether it is empty.
fn verify_destination_root(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(io_error(&format!("read {}", path.display()), error)),
        Ok(metadata) if metadata.file_type().is_symlink() => {
            Err(conflict(format!("{} is a symbolic link", path.display())))
        }
        Ok(metadata) if !metadata.is_dir() => {
            Err(conflict(format!("{} is not a folder", path.display())))
        }
        Ok(_) => {
            let mut entries = fs::read_dir(path)
                .map_err(|error| io_error(&format!("read {}", path.display()), error))?;
            if entries.next().is_some() {
                return Err(conflict(format!(
                    "{} already exists and is not empty",
                    path.display()
                )));
            }
            Ok(())
        }
    }
}

/// Re-check a directory this import just created, so a link swapped in between
/// the check and the create cannot receive the extracted tree.
fn ensure_real_directory(path: &Path) -> Result<()> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| io_error(&format!("read {}", path.display()), error))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(conflict(format!("{} is not a real folder", path.display())));
    }
    Ok(())
}

/// Publish a staged import. Every folder is created before any record is
/// written, and a failure removes what this call created.
pub(crate) fn apply_import(
    st: &mut AppState,
    staged: &StagedImport,
    progress: ArchiveProgress<'_>,
) -> Result<Value> {
    let mut destinations = Vec::new();
    let prepared = (|| -> Result<()> {
        for root in &staged.manifest.roots {
            let name =
                safe_segment(&root.name).ok_or_else(|| invalid("archive root name is invalid"))?;
            let destination = staged.target_parent.join(name);
            verify_destination_root(&destination)?;
            destinations.push(destination);
        }
        Ok(())
    })();
    if let Err(error) = prepared {
        remove_staging(&staged.staging);
        return Err(error);
    }

    let mut created_folders: Vec<PathBuf> = Vec::new();
    let mut created_projects: Vec<String> = Vec::new();
    let mut created_tasks: Vec<String> = Vec::new();
    let mut created_group: Option<String> = None;
    let result = (|| -> Result<Value> {
        let mut moved = 0u64;
        for (index, destination) in destinations.iter().enumerate() {
            fs::create_dir_all(destination)
                .map_err(|error| io_error(&format!("create {}", destination.display()), error))?;
            ensure_real_directory(destination)?;
            created_folders.push(destination.clone());
            let source = staged.staging.join(ROOTS_PREFIX).join(index.to_string());
            if source.is_dir() {
                move_tree(
                    &source,
                    destination,
                    &mut moved,
                    &staged.total_bytes,
                    progress,
                )?;
            }
        }

        let mut registered = Vec::new();
        for (index, destination) in destinations.iter().enumerate() {
            let path = destination.to_string_lossy().into_owned();
            st.db
                .ensure_project(&path, false)
                .map_err(|error| anyhow!("PROJECT_ARCHIVE_IO: register project: {error}"))?;
            created_projects.push(path.clone());
            if let Some(project) = staged
                .manifest
                .projects
                .iter()
                .find(|project| project.root == index)
            {
                apply_project_config(st, project, &path, &mut created_tasks)?;
            }
            registered.push(path);
        }

        // The manifest's group record is the marker: a single-root group with no
        // group text is still a group, and its name and identity must survive.
        let uses_group = staged.manifest.roots.len() > 1 || staged.manifest.group.is_some();
        if uses_group {
            let group = st
                .db
                .create_project_group(&staged.manifest.name, &registered)
                .map_err(|error| anyhow!("PROJECT_ARCHIVE_IO: create project group: {error}"))?;
            created_group = Some(group.id.clone());
            if let Some(config) = staged.manifest.group.as_ref() {
                if !config.instructions.trim().is_empty() {
                    st.db
                        .set_project_group_instructions(&group.id, &config.instructions)
                        .map_err(|error| {
                            anyhow!("PROJECT_ARCHIVE_IO: write group instructions: {error}")
                        })?;
                }
                if let Some(entries) = config
                    .memory
                    .as_ref()
                    .and_then(|memory| memory.get("entries"))
                {
                    if entries.is_array() {
                        st.db
                            .set_project_group_memory(&group.id, entries)
                            .map_err(|error| {
                                anyhow!("PROJECT_ARCHIVE_IO: write group memory: {error}")
                            })?;
                    }
                }
            }
        }

        Ok(json!({
            "projectPaths": registered,
            "groupId": created_group,
            "roots": destinations.len(),
            "files": moved,
            "bytes": staged.total_bytes,
            "name": staged.manifest.name,
        }))
    })();
    let summary = match result {
        Ok(summary) => summary,
        Err(error) => {
            rollback_import(
                st,
                &created_projects,
                created_group.as_deref(),
                &created_folders,
                &created_tasks,
            );
            remove_staging(&staged.staging);
            return Err(error);
        }
    };
    remove_staging(&staged.staging);
    Ok(summary)
}

fn move_tree(
    source: &Path,
    destination: &Path,
    moved: &mut u64,
    total_bytes: &u64,
    progress: ArchiveProgress<'_>,
) -> Result<()> {
    for entry in walkdir::WalkDir::new(source)
        .follow_links(false)
        .sort_by_file_name()
    {
        let entry =
            entry.map_err(|error| walk_error(&format!("scan {}", source.display()), error))?;
        if entry.depth() == 0 || !entry.file_type().is_file() {
            continue;
        }
        let portable = entry
            .path()
            .strip_prefix(source)
            .ok()
            .and_then(portable_components)
            .ok_or_else(|| invalid("staged file escaped its root"))?;
        let target = destination.join(&portable);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| io_error(&format!("create {}", parent.display()), error))?;
        }
        if fs::rename(entry.path(), &target).is_err() {
            // A destination on another volume cannot be reached by rename, and
            // a partially copied file must not survive.
            let source_path = entry.path();
            fs::copy(source_path, &target)
                .map_err(|error| io_error(&format!("copy {}", target.display()), error))?;
            fs::remove_file(source_path)
                .map_err(|error| io_error(&format!("remove {}", source_path.display()), error))?;
        }
        *moved = moved.saturating_add(1);
        progress("import", *moved, *total_bytes);
    }
    Ok(())
}

fn apply_project_config(
    st: &mut AppState,
    project: &ArchiveProjectConfig,
    path: &str,
    created_tasks: &mut Vec<String>,
) -> Result<()> {
    if let Some(memory) = project.memory.as_ref() {
        if let Some(entries) = memory.get("entries").filter(|value| value.is_array()) {
            st.db
                .set_project_memory_entries(path, entries)
                .map_err(|error| anyhow!("PROJECT_ARCHIVE_IO: write project memory: {error}"))?;
        } else {
            let content = memory
                .get("content")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if !content.trim().is_empty() {
                st.db.set_project_memory(path, content).map_err(|error| {
                    anyhow!("PROJECT_ARCHIVE_IO: write project memory: {error}")
                })?;
            }
        }
    }
    for definition in &project.mcp {
        // The manifest is untrusted input. Only the portable fields are read at
        // all, and the secret maps are cleared afterwards, so a hand-edited or
        // malicious archive cannot inject an `env`/`headers` value into this
        // machine's configuration. `envKeys`/`headerKeys` survive as a hint that
        // the definition expects secrets to be re-entered locally.
        let mut portable = definition.clone();
        if let Some(object) = portable.as_object_mut() {
            object.retain(|key, _| {
                matches!(
                    key.as_str(),
                    "id" | "label"
                        | "description"
                        | "transport"
                        | "command"
                        | "args"
                        | "url"
                        | "timeoutSeconds"
                        | "enabled"
                        | "envKeys"
                        | "headerKeys"
                )
            });
        }
        let mut input: crate::mcp_servers::McpServerInput = serde_json::from_value(portable)
            .map_err(|error| invalid(format!("project MCP definition is malformed: {error}")))?;
        input.level = Some("project".into());
        input.project_path = Some(path.to_string());
        // Secret values are never archived, so the definition cannot claim it is
        // ready to send requests until the user configures them here.
        input.env = None;
        input.headers = None;
        input.enabled = Some(false);
        st.mcp_servers
            .upsert(input)
            .map_err(|error| anyhow!("PROJECT_ARCHIVE_IO: write project MCP server: {error}"))?;
    }
    if !project.automations.is_empty() {
        let mut tasks = project.automations.clone();
        for task in &mut tasks {
            if let Some(object) = task.as_object_mut() {
                // Execution ownership is device-local: an imported task stays
                // off until the user enables it here.
                object.insert("enabled".into(), Value::Bool(false));
                // `import_tasks` reads the folder binding from the task's config
                // object, so the restored task is bound to this machine's path.
                let mut config = match object.remove("config") {
                    Some(Value::Object(config)) => config,
                    _ => serde_json::Map::new(),
                };
                config.insert("workspacePath".into(), Value::String(path.to_string()));
                object.insert("config".into(), Value::Object(config));
            }
        }
        // `import_tasks` inserts with `INSERT OR IGNORE`, so a task id that
        // already existed here is not ours to remove if a later step fails.
        let mut preexisting = Vec::new();
        for task in &tasks {
            if let Some(id) = task.get("id").and_then(Value::as_str) {
                if crate::scheduled::get_task(&st.db, id)
                    .map_err(|error| anyhow!("PROJECT_ARCHIVE_IO: read automations: {error}"))?
                    .is_some()
                {
                    preexisting.push(id.to_string());
                }
            }
        }
        crate::scheduled::import_tasks(&st.db, &tasks)
            .map_err(|error| anyhow!("PROJECT_ARCHIVE_IO: write project automations: {error}"))?;
        for task in &tasks {
            if let Some(id) = task.get("id").and_then(Value::as_str) {
                let existed = preexisting.iter().any(|candidate| candidate == id);
                let now_present = crate::scheduled::get_task(&st.db, id)
                    .map_err(|error| anyhow!("PROJECT_ARCHIVE_IO: read automations: {error}"))?
                    .is_some();
                if !existed && now_present {
                    created_tasks.push(id.to_string());
                }
            }
        }
    }
    Ok(())
}

fn rollback_import(
    st: &mut AppState,
    created_projects: &[String],
    created_group: Option<&str>,
    created_folders: &[PathBuf],
    created_tasks: &[String],
) {
    // Automations this import inserted go first: they reference the project that
    // is about to disappear.
    for task_id in created_tasks {
        let _ = crate::scheduled::delete_task(&st.db, task_id);
    }
    for path in created_projects {
        let _ = st.db.delete_project_memory(path);
        let _ = st.db.delete_project(path);
    }
    if let Some(group_id) = created_group {
        let _ = st.db.delete_project_group_record(group_id);
    }
    for folder in created_folders {
        let _ = fs::remove_dir_all(folder);
    }
}

#[cfg(test)]
#[path = "project_archive_tests.rs"]
mod tests;
