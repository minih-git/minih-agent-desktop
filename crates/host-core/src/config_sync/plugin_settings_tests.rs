use super::*;
use serde_json::json;
use std::fs;

pub(super) fn install(st: &mut AppState) -> Result<()> {
    let root = st.data_dir.join("settings-fixture-plugin");
    fs::create_dir_all(&root)?;
    fs::write(root.join("main.js"), "export function onLoad() {}")?;
    fs::write(
        root.join("manifest.json"),
        serde_json::to_vec(&json!({
            "schemaVersion": 1, "id": "example.settings", "name": "Settings fixture",
            "version": "1.0.0", "main": "main.js", "permissions": [],
            "contributes": {"settings": [
                {"key": "enabled", "title": "Enabled", "type": "boolean", "default": false},
                {"key": "title", "title": "Title", "type": "string"},
                {"key": "options", "title": "Options", "type": "json"},
                {"key": "folder", "title": "Folder", "type": "string"},
                {"key": "apiKey", "title": "Key", "type": "string"},
                {"key": "model", "title": "Model", "type": "model", "default": ""}
            ]}
        }))?,
    )?;
    st.plugins.load_dev(root.to_str().unwrap())?;
    Ok(())
}

fn fixture() -> Result<(tempfile::TempDir, AppState)> {
    let directory = tempfile::tempdir()?;
    let mut state = AppState::open(directory.path())?;
    install(&mut state)?;
    Ok((directory, state))
}

fn save(st: &AppState, value: Value) -> Result<()> {
    settings::write(&st.data_dir, "example.settings", value.as_object().unwrap())
}

#[test]
fn saved_declared_values_round_trip_and_resets_preserve_private_fields() -> Result<()> {
    let (_a, source) = fixture()?;
    let (_b, target) = fixture()?;
    save(
        &source,
        json!({"enabled": true, "title": "portable", "options": {"count": 3}, "folder": "/device-a/notes", "apiKey": "local-only", "undeclared": "private"}),
    )?;
    save(
        &target,
        json!({"enabled": false, "folder": "/device-b/notes", "apiKey": "keep-key", "undeclared": "keep", "__themeVariables": {"color": 2}}),
    )?;
    let record = capture(&source)?.remove(0);
    assert_eq!(
        record.payload["values"],
        json!({"enabled": true, "title": "portable", "options": {"count": 3}})
    );
    assert!(!record.payload["keys"]
        .as_array()
        .unwrap()
        .contains(&json!("folder")));
    apply(&target, &record)?;
    let actual = settings::read(&target.data_dir, "example.settings")?;
    assert_eq!(actual["enabled"], true);
    assert_eq!(actual["title"], "portable");
    assert_eq!(actual["folder"], "/device-b/notes");
    assert_eq!(actual["apiKey"], "keep-key");
    assert_eq!(actual["undeclared"], "keep");
    assert_eq!(actual["__themeVariables"], json!({"color": 2}));
    save(&source, json!({"enabled": true}))?;
    apply(&target, &capture(&source)?.remove(0))?;
    assert!(!settings::read(&target.data_dir, "example.settings")?.contains_key("title"));
    Ok(())
}

#[test]
fn fresh_installations_and_project_scopes_do_not_publish_empty_settings() -> Result<()> {
    let (_directory, mut state) = fixture()?;
    assert!(capture(&state)?.is_empty());
    save(&state, json!({"enabled": true}))?;
    assert_eq!(capture(&state)?.len(), 1);
    state.plugins.set_scope(
        "example.settings",
        crate::activation::ActivationScope {
            mode: crate::activation::ActivationMode::Projects,
            projects: vec!["/local/project".into()],
        },
    )?;
    assert!(capture(&state)?.is_empty());
    Ok(())
}

#[test]
fn credentials_paths_and_nested_private_values_stay_local() -> Result<()> {
    let (_directory, state) = fixture()?;
    for value in [
        json!("C:\\Users\\local\\notes"),
        json!("~/notes"),
        json!("sk-1234567890abcdefghijklmnop"),
        json!({"accessToken": "private"}),
        json!(["/local/notes"]),
    ] {
        save(&state, json!({"enabled": true, "options": value}))?;
        let record = capture(&state)?.remove(0);
        assert!(!record.payload["values"]
            .as_object()
            .unwrap()
            .contains_key("options"));
        assert!(!record.payload["keys"]
            .as_array()
            .unwrap()
            .contains(&json!("options")));
    }
    Ok(())
}

#[test]
fn invalid_remote_settings_cannot_bypass_approval_or_partially_write() -> Result<()> {
    let (_directory, state) = fixture()?;
    save(&state, json!({"enabled": false, "title": "before"}))?;
    let record = capture(&state)?.remove(0);
    for change in 0..4 {
        let mut invalid = record.clone();
        match change {
            0 => invalid.requires_approval = false,
            1 => invalid.payload["pluginId"] = json!("another.plugin"),
            2 => invalid.payload["values"]["enabled"] = json!("not a boolean"),
            _ => invalid.payload["values"]["title"] = json!("/device/private"),
        }
        assert!(apply(&state, &invalid).is_err());
        assert_eq!(
            settings::read(&state.data_dir, "example.settings")?,
            json!({"enabled": false, "title": "before"})
                .as_object()
                .unwrap()
                .clone()
        );
    }
    Ok(())
}

#[test]
fn missing_plugins_are_deferred_and_cloud_deletion_keeps_local_settings() -> Result<()> {
    let (_directory, state) = fixture()?;
    save(&state, json!({"enabled": true}))?;
    let mut record = capture(&state)?.remove(0);
    let empty = tempfile::tempdir()?;
    let target = AppState::open(empty.path())?;
    assert!(apply(&target, &record)
        .unwrap_err()
        .to_string()
        .starts_with("CONFIG_SYNC_DEPENDENCY"));
    record.deleted = true;
    apply(&state, &record)?;
    assert_eq!(
        settings::read(&state.data_dir, "example.settings")?["enabled"],
        true
    );
    Ok(())
}

#[test]
fn plugin_category_opt_out_excludes_settings_and_preview_uses_plugin_category() -> Result<()> {
    let (_directory, state) = fixture()?;
    save(&state, json!({"enabled": true}))?;
    let mut selection = super::super::domains::CategorySelection::all_selected();
    assert!(selection.is_selected(DOMAIN_PLUGIN_SETTINGS));
    selection.0.insert("plugins".into(), false);
    assert!(!selection.is_selected(DOMAIN_PLUGIN_SETTINGS));
    let snapshot = super::super::domains::LocalSnapshot {
        manifest: super::super::domains::RevisionManifest {
            format: "test".into(),
            version: 1,
            revision_id: "test".into(),
            parents: vec![],
            created_at: String::new(),
            entities: capture(&state)?,
            resource_ids: vec![],
        },
        resources: Default::default(),
    };
    let preview = super::super::domains::preview(&snapshot, &selection);
    assert_eq!(preview.excluded, 1);
    assert_eq!(preview.categories[0].category, "plugins");
    Ok(())
}
