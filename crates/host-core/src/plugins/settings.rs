//! The fixed plugin settings file, shared by SDK writes and configuration sync.
//! Callers hold AppState's mutex so imports cannot race SDK read/modify/write.
use anyhow::{bail, Context, Result};
use serde_json::{Map, Value};
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use uuid::Uuid;

pub(crate) const MAX_SETTINGS_BYTES: usize = 512 * 1024;

fn settings_path(data_dir: &Path, plugin_id: &str, create: bool) -> Result<Option<PathBuf>> {
    if plugin_id.is_empty()
        || matches!(plugin_id, "." | "..")
        || !plugin_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
    {
        bail!("PLUGIN_INVALID: invalid plugin settings identity");
    }
    let mut path = data_dir.to_path_buf();
    for part in ["plugins", "data", plugin_id] {
        path.push(part);
        match fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
            Ok(_) => bail!("PLUGIN_INVALID: plugin settings directory must not be a link"),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound && create => {
                fs::create_dir(&path).context("create plugin settings directory")?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error).context("inspect plugin settings directory"),
        }
    }
    path.push("settings.json");
    if let Ok(metadata) = fs::symlink_metadata(&path) {
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            bail!("PLUGIN_INVALID: plugin settings must be a regular file");
        }
    }
    Ok(Some(path))
}

pub(crate) fn exists(data_dir: &Path, plugin_id: &str) -> Result<bool> {
    match settings_path(data_dir, plugin_id, false)? {
        Some(path) => path.try_exists().context("inspect plugin settings file"),
        None => Ok(false),
    }
}

pub(crate) fn read(data_dir: &Path, plugin_id: &str) -> Result<Map<String, Value>> {
    let Some(path) = settings_path(data_dir, plugin_id, false)? else {
        return Ok(Map::new());
    };
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let file = match options.open(&path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Map::new()),
        Err(error) => return Err(error).context("read plugin settings"),
    };
    let mut bytes = Vec::new();
    file.take(MAX_SETTINGS_BYTES as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > MAX_SETTINGS_BYTES {
        bail!("PLUGIN_INVALID: plugin settings exceed the size limit");
    }
    // Never report JSON input: a plugin may have stored private data here.
    serde_json::from_slice::<Map<String, Value>>(&bytes)
        .map_err(|_| anyhow::anyhow!("PLUGIN_INVALID: plugin settings must contain a JSON object"))
}

pub(crate) fn write(data_dir: &Path, plugin_id: &str, settings: &Map<String, Value>) -> Result<()> {
    let bytes = serde_json::to_vec_pretty(settings)?;
    if bytes.len() > MAX_SETTINGS_BYTES {
        bail!("PLUGIN_INVALID: plugin settings exceed the size limit");
    }
    let path = settings_path(data_dir, plugin_id, true)?.ok_or_else(|| {
        anyhow::anyhow!("PLUGIN_INVALID: plugin settings directory is unavailable")
    })?;
    let temporary = path.with_file_name(format!(".settings-{}.tmp", Uuid::new_v4()));
    let result = (|| -> Result<()> {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&temporary)
            .context("create plugin settings replacement")?;
        file.write_all(&bytes)
            .context("write plugin settings replacement")?;
        file.sync_all()
            .context("flush plugin settings replacement")?;
        fs::rename(&temporary, &path).context("replace plugin settings")?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

pub(crate) fn update(
    data_dir: &Path,
    plugin_id: &str,
    defaults: Map<String, Value>,
    patch: Map<String, Value>,
) -> Result<Map<String, Value>> {
    let mut settings = defaults;
    settings.extend(read(data_dir, plugin_id)?);
    settings.extend(patch);
    write(data_dir, plugin_id, &settings)?;
    Ok(settings)
}

#[cfg(test)]
#[path = "settings_tests.rs"]
mod tests;
