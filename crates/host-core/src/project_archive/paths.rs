//! Archive paths: portable names, the extraction target, and the folder the
//! import publishes into. Every check here refuses instead of overwriting.

use super::*;

use anyhow::Result;
use serde_json::Value;
use std::fs::{self};
use std::path::{Component, Path, PathBuf};
use unicode_normalization::UnicodeNormalization;

pub(super) fn required_path(params: &Value, key: &str) -> Result<PathBuf> {
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

pub(super) fn canonical_directory(raw: &Path, key: &str) -> Result<PathBuf> {
    let path =
        fs::canonicalize(raw).map_err(|error| invalid(format!("{key} is unavailable: {error}")))?;
    if !path.is_dir() {
        return Err(invalid(format!("{key} is not a folder")));
    }
    Ok(path)
}

/// A single path segment taken from an archive, so an entry name can never
/// escape the folder it is extracted into.
pub(super) fn safe_segment(name: &str) -> Option<String> {
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
pub(super) fn safe_relative(path: &str) -> Option<PathBuf> {
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
pub(super) fn archive_path_key(path: &str) -> String {
    path.nfc().collect::<String>().to_lowercase()
}

pub(super) fn portable_components(path: &Path) -> Option<String> {
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
pub(super) fn is_app_managed_secret(relative: &Path) -> bool {
    let parts = relative
        .components()
        .map(|component| component.as_os_str().to_string_lossy().to_string())
        .collect::<Vec<_>>();
    parts.len() >= 2
        && parts[0].eq_ignore_ascii_case(AGENTS_DIR)
        && parts[1].eq_ignore_ascii_case(MCP_DIR)
}

/// Resolve where the archive will really be written and refuse a target inside
/// any source root, including a parent that reaches one through a symbolic link.
pub(super) fn resolved_export_target(target: &Path, roots: &[PathBuf]) -> Result<PathBuf> {
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

/// A destination root must either not exist yet or be a real, empty directory.
///
/// `Path::exists` follows symbolic links, so a link placed under the chosen
/// parent would pass an "is it empty" test and then redirect every write to its
/// target — which can be anywhere, including outside the destination. The check
/// therefore looks at the link itself and refuses a symbolic link, or anything
/// else that is not a directory, instead of only asking whether it is empty.
pub(super) fn verify_destination_root(path: &Path) -> Result<()> {
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
pub(super) fn ensure_real_directory(path: &Path) -> Result<()> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| io_error(&format!("read {}", path.display()), error))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(conflict(format!("{} is not a real folder", path.display())));
    }
    Ok(())
}
