use super::*;
use serde_json::json;

fn object(value: Value) -> Map<String, Value> {
    value.as_object().unwrap().clone()
}

#[test]
fn sdk_updates_preserve_existing_private_values_and_defaults() -> Result<()> {
    let directory = tempfile::tempdir()?;
    let id = "example.settings";
    write(
        directory.path(),
        id,
        &object(json!({"enabled": false, "private": {"keep": true}})),
    )?;
    let actual = update(
        directory.path(),
        id,
        object(json!({"enabled": true, "density": 2})),
        object(json!({"language": "zh-CN"})),
    )?;
    assert_eq!(
        actual,
        object(
            json!({"enabled": false, "density": 2, "language": "zh-CN", "private": {"keep": true}})
        )
    );
    assert_eq!(read(directory.path(), id)?, actual);
    Ok(())
}

#[test]
fn malformed_or_oversized_settings_are_not_overwritten() -> Result<()> {
    let directory = tempfile::tempdir()?;
    update(directory.path(), "example.settings", Map::new(), Map::new())?;
    let path = directory
        .path()
        .join("plugins/data/example.settings/settings.json");
    for content in [
        b"[1,2]".to_vec(),
        b"{broken".to_vec(),
        vec![b' '; MAX_SETTINGS_BYTES + 1],
    ] {
        fs::write(&path, &content)?;
        assert!(update(
            directory.path(),
            "example.settings",
            Map::new(),
            object(json!({"x": 1}))
        )
        .is_err());
        assert_eq!(fs::read(&path)?, content);
    }
    Ok(())
}

#[test]
fn invalid_identities_cannot_escape_the_plugin_directory() -> Result<()> {
    let directory = tempfile::tempdir()?;
    for id in ["", ".", "..", "../outside", "a/b", "a\\b"] {
        assert!(read(directory.path(), id).is_err());
        assert!(write(directory.path(), id, &Map::new()).is_err());
    }
    assert!(!directory.path().join("plugins").exists());
    Ok(())
}

#[cfg(unix)]
#[test]
fn linked_files_and_parent_directories_are_never_followed() -> Result<()> {
    use std::os::unix::fs::symlink;
    let directory = tempfile::tempdir()?;
    let outside = tempfile::tempdir()?;
    let original = b"{\"private\":true}";
    fs::write(outside.path().join("settings.json"), original)?;
    fs::create_dir_all(directory.path().join("plugins/data"))?;
    symlink(
        outside.path(),
        directory.path().join("plugins/data/example.settings"),
    )?;
    assert!(read(directory.path(), "example.settings").is_err());
    assert!(write(directory.path(), "example.settings", &Map::new()).is_err());
    fs::remove_file(directory.path().join("plugins/data/example.settings"))?;
    fs::create_dir(directory.path().join("plugins/data/example.settings"))?;
    symlink(
        outside.path().join("settings.json"),
        directory
            .path()
            .join("plugins/data/example.settings/settings.json"),
    )?;
    assert!(read(directory.path(), "example.settings").is_err());
    assert!(write(directory.path(), "example.settings", &Map::new()).is_err());
    assert_eq!(fs::read(outside.path().join("settings.json"))?, original);
    Ok(())
}
