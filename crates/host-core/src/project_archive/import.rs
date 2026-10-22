//! Import side: validate a staged copy outside the destination, publish it in
//! one step, and roll back everything the import created on failure.

use super::paths::*;
use super::*;

use crate::state::AppState;
use anyhow::{anyhow, Result};
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::fs::{self, File};
use std::io::{BufReader, Read, Write};
use std::path::{Path, PathBuf};
use uuid::Uuid;
use zip::ZipArchive;

/// Read and validate the manifest of an archive before trusting any of it.
pub(super) fn read_manifest(archive: &mut ZipArchive<BufReader<File>>) -> Result<ArchiveManifest> {
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

pub(super) fn entry_name_allowed(name: &str, manifest: &ArchiveManifest) -> Option<PathBuf> {
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

pub(super) fn remove_staging(staging: &Path) {
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

pub(super) fn move_tree(
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

pub(super) fn apply_project_config(
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

pub(super) fn rollback_import(
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
