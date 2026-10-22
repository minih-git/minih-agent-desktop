//! Export side: gather one project's archive input under the state lock, then
//! stream it into a ZIP outside that lock.

use super::paths::*;
use super::*;

use crate::agent_capabilities::CapabilityLevel;
use crate::state::AppState;
use anyhow::{anyhow, bail, Result};
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::fs::{self, File};
use std::io::{BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use uuid::Uuid;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

/// Count one root and refuse a shape this build could not import again.
///
/// The export and the import share the same bounds, so an export never produces
/// an archive that `stage_import` would reject.
pub(super) fn count_root(root: &Path) -> Result<ArchiveRoot> {
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
pub(super) fn portable_mcp(record: &crate::mcp_servers::McpServerRecord) -> Value {
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

pub(super) fn memory_payload(memory: &crate::db::ProjectMemoryRecord) -> Option<Value> {
    if memory.content.trim().is_empty() && memory.entries.is_none() {
        return None;
    }
    Some(json!({ "content": memory.content, "entries": memory.entries }))
}

pub(super) fn portable_automations(st: &AppState, project_path: &str) -> Result<Vec<Value>> {
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

pub(super) fn zip_options() -> SimpleFileOptions {
    SimpleFileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .unix_permissions(0o644)
}

pub(super) fn start_entry(writer: &mut ZipWriter<BufWriter<File>>, name: &str) -> Result<()> {
    writer
        .start_file(name, zip_options())
        .map_err(|error| anyhow!("PROJECT_ARCHIVE_IO: create archive entry {name}: {error}"))
}

pub(super) fn copy_into_zip<R: Read>(
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
