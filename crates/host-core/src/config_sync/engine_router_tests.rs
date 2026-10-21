use super::remote::{revision_path, serialize_json};
use super::tests::{
    configure_test_device, configure_test_device_mode, pending_approvals, run_in_isolated_process,
};
use super::*;
use crate::config_sync::domains::{entity as portable_entity, DOMAIN_LEARNED_MEMORY};
use crate::config_sync::transport::tests::fixture;
use crate::memory::MemoryScope;

fn theme(state: &AppState) -> Result<Value> {
    Ok(state.db.get_setting("app")?.unwrap_or_else(|| json!({}))["theme"].clone())
}

fn app_settings(state: &AppState) -> Result<Value> {
    Ok(state.db.get_setting("app")?.unwrap_or_else(|| json!({})))
}

async fn approve_all(
    state: &Arc<Mutex<AppState>>,
    tx: &mpsc::UnboundedSender<String>,
) -> Result<()> {
    let value = get_state(state.clone()).await?;
    for (id, digest, _) in pending_approvals(&value) {
        approve(
            state.clone(),
            json!({"approvalId":id,"digest":digest}),
            tx.clone(),
        )
        .await?;
    }
    assert!(pending_approvals(&get_state(state.clone()).await?).is_empty());
    Ok(())
}

#[test]
fn unconfigured_device_reports_no_account() -> Result<()> {
    let directory = tempfile::tempdir()?;
    let mut state = AppState::open(directory.path())?;
    let public = public_state(&mut state)?;
    assert_eq!(public["configured"], false);
    assert_eq!(public["mode"], "sync");
    assert_eq!(public["accountConnected"], false);
    assert!(load_config(&state)?.is_none());
    Ok(())
}

#[tokio::test]
async fn backup_does_not_apply_remote_settings_and_restore_is_local_only() -> Result<()> {
    if run_in_isolated_process(
        "config_sync::engine::router_tests::backup_does_not_apply_remote_settings_and_restore_is_local_only",
    )? {
        return Ok(());
    }
    let fixture = fixture(false).await;
    let directory_a = tempfile::tempdir()?;
    let directory_b = tempfile::tempdir()?;
    let device_a = configure_test_device(directory_a.path(), &fixture.endpoint).await?;
    let device_b =
        configure_test_device_mode(directory_b.path(), &fixture.endpoint, "backup").await?;
    device_a
        .lock()
        .await
        .db
        .set_setting("app", &json!({"theme":"light"}))?;
    device_b
        .lock()
        .await
        .db
        .set_setting("app", &json!({"theme":"dark"}))?;
    let (tx, _rx) = mpsc::unbounded_channel();
    let sync_revision = sync_now(device_a.clone(), tx.clone()).await?["lastRevisionId"].clone();
    let first_backup = sync_now(device_b.clone(), tx.clone()).await?["lastRevisionId"].clone();
    assert_eq!(theme(&*device_b.lock().await)?, "dark");
    assert_eq!(
        list_history(device_a.clone()).await?[0]["revisionId"],
        sync_revision
    );
    assert_eq!(
        list_history(device_b.clone()).await?[0]["revisionId"],
        first_backup
    );
    device_b
        .lock()
        .await
        .db
        .set_setting("app", &json!({"theme":"system"}))?;
    let second_backup = sync_now(device_b.clone(), tx.clone()).await?["lastRevisionId"].clone();
    assert_ne!(first_backup, second_backup);
    restore(
        device_b.clone(),
        json!({"revisionId": first_backup}),
        tx.clone(),
    )
    .await?;
    assert_eq!(theme(&*device_b.lock().await)?, "dark");
    assert_eq!(
        list_history(device_b.clone()).await?[0]["revisionId"],
        second_backup
    );
    assert_eq!(
        list_history(device_a.clone()).await?[0]["revisionId"],
        sync_revision
    );
    sync_now(device_a.clone(), tx).await?;
    assert_eq!(theme(&*device_a.lock().await)?, "light");
    assert!(!load_config(&*device_b.lock().await)?
        .unwrap()
        .recovery_points
        .is_empty());
    Ok(())
}

#[tokio::test]
async fn application_show_thinking_roundtrips_and_keeps_local_only_settings() -> Result<()> {
    if run_in_isolated_process(
        "config_sync::engine::router_tests::application_show_thinking_roundtrips_and_keeps_local_only_settings",
    )? {
        return Ok(());
    }
    let fixture = fixture(false).await;
    let directory_a = tempfile::tempdir()?;
    let directory_b = tempfile::tempdir()?;
    let device_a = configure_test_device(directory_a.path(), &fixture.endpoint).await?;
    let device_b = configure_test_device(directory_b.path(), &fixture.endpoint).await?;
    // The source device carries the explicit reasoning-display boolean (a
    // false value must stay false), the legacy display mode, and a device-local
    // permission mode that must never travel through a revision.
    device_a.lock().await.db.set_setting(
        "app",
        &json!({
            "theme": "light",
            "showThinking": false,
            "thinkingDisplayMode": "detailed",
            "transcriptDensity": "compact",
            "learnedMemoryRead": false,
            // Automatic extraction is device-local: the model has to be
            // reachable from this machine, and the switch spends this machine's
            // quota, so none of it may ride a revision to another device.
            "learnedMemory": {
                "learn": true,
                "model": "p1/m1",
                "dailyTokenBudget": 50000
            },
            "defaultPermissionMode": "accept-edits",
        }),
    )?;
    let (tx, _rx) = mpsc::unbounded_channel();
    sync_now(device_a.clone(), tx.clone()).await?;
    let received = sync_now(device_b.clone(), tx.clone()).await?;
    assert!(pending_approvals(&received).is_empty());
    {
        let state = device_b.lock().await;
        let settings = app_settings(&state)?;
        assert_eq!(settings["theme"], "light");
        // A false boolean survives capture and apply instead of reading as absent.
        assert_eq!(settings["showThinking"], false);
        // The legacy field is still exported so older readers keep working.
        assert_eq!(settings["thinkingDisplayMode"], "detailed");
        // The transcript density is a portable presentation preference.
        assert_eq!(settings["transcriptDensity"], "compact");
        // Reading learned memory is portable too, and a false value stays false.
        assert_eq!(settings["learnedMemoryRead"], false);
        // Local-only settings do not travel: the source value never appears.
        assert!(settings.get("defaultPermissionMode").is_none());
        assert!(settings.get("learnedMemory").is_none());
    }
    // The receiving device now adopts its own local-only value. Its portable
    // fields stay exactly as synced, so only the local-only value differs.
    device_b.lock().await.db.set_setting(
        "app",
        &json!({
            "theme": "light",
            "showThinking": false,
            "thinkingDisplayMode": "detailed",
            "transcriptDensity": "compact",
            "learnedMemoryRead": false,
            "defaultPermissionMode": "ask",
        }),
    )?;
    // A later portable edit still syncs while the device-local value is untouched.
    device_a.lock().await.db.set_setting(
        "app",
        &json!({
            "theme": "light",
            "showThinking": true,
            "thinkingDisplayMode": "detailed",
            "transcriptDensity": "detailed",
            "learnedMemoryRead": true,
            "defaultPermissionMode": "accept-edits",
        }),
    )?;
    sync_now(device_a.clone(), tx.clone()).await?;
    sync_now(device_b.clone(), tx).await?;
    let state = device_b.lock().await;
    let settings = app_settings(&state)?;
    assert_eq!(settings["showThinking"], true);
    assert_eq!(settings["thinkingDisplayMode"], "detailed");
    assert_eq!(settings["transcriptDensity"], "detailed");
    assert_eq!(settings["learnedMemoryRead"], true);
    assert_eq!(settings["defaultPermissionMode"], "ask");
    Ok(())
}

#[tokio::test]
async fn sync_restore_requires_acknowledgement_and_propagates_as_a_new_revision() -> Result<()> {
    if run_in_isolated_process(
        "config_sync::engine::router_tests::sync_restore_requires_acknowledgement_and_propagates_as_a_new_revision",
    )? {
        return Ok(());
    }
    let fixture = fixture(false).await;
    let directory_a = tempfile::tempdir()?;
    let directory_b = tempfile::tempdir()?;
    let device_a = configure_test_device(directory_a.path(), &fixture.endpoint).await?;
    let device_b = configure_test_device(directory_b.path(), &fixture.endpoint).await?;
    let (tx, _rx) = mpsc::unbounded_channel();
    device_a
        .lock()
        .await
        .db
        .set_setting("app", &json!({"theme":"light"}))?;
    let first = sync_now(device_a.clone(), tx.clone()).await?["lastRevisionId"].clone();
    sync_now(device_b.clone(), tx.clone()).await?;
    device_a
        .lock()
        .await
        .db
        .set_setting("app", &json!({"theme":"dark"}))?;
    sync_now(device_a.clone(), tx.clone()).await?;
    sync_now(device_b.clone(), tx.clone()).await?;
    assert_eq!(theme(&*device_b.lock().await)?, "dark");
    assert!(
        restore(device_a.clone(), json!({"revisionId":first}), tx.clone())
            .await
            .is_err()
    );
    assert_eq!(theme(&*device_a.lock().await)?, "dark");
    let restored = restore(
        device_a.clone(),
        json!({"revisionId":first,"acknowledgePropagation":true}),
        tx.clone(),
    )
    .await?;
    assert_ne!(restored["lastRevisionId"], first);
    assert_eq!(theme(&*device_a.lock().await)?, "light");
    sync_now(device_b.clone(), tx).await?;
    assert_eq!(theme(&*device_b.lock().await)?, "light");
    Ok(())
}

#[tokio::test]
async fn credentials_opt_out_survives_approval_and_remote_deletion_converges() -> Result<()> {
    if run_in_isolated_process(
        "config_sync::engine::router_tests::credentials_opt_out_survives_approval_and_remote_deletion_converges",
    )? {
        return Ok(());
    }
    let fixture = fixture(false).await;
    let directory_a = tempfile::tempdir()?;
    let directory_b = tempfile::tempdir()?;
    let device_a = configure_test_device(directory_a.path(), &fixture.endpoint).await?;
    let device_b = configure_test_device(directory_b.path(), &fixture.endpoint).await?;
    configure(device_b.clone(), json!({"includeSecrets":false})).await?;
    let provider_id = {
        let state = device_a.lock().await;
        providers::create_provider(&state.db, &state.secrets, serde_json::from_value(json!({
            "name":"Router regression", "type":"openai_compatible", "protocol":"openai_compatible",
            "baseUrl":"https://provider.example.test/v1", "authKind":"api_key_and_base_url",
            "secretValue":"source-only-key", "models":[]
        }))?)?.id
    };
    let (tx, _rx) = mpsc::unbounded_channel();
    sync_now(device_a.clone(), tx.clone()).await?;
    let received = sync_now(device_b.clone(), tx.clone()).await?;
    assert!(!pending_approvals(&received).is_empty());
    {
        let state = device_b.lock().await;
        assert!(providers::get_provider(&state.db, &state.secrets, &provider_id)?.is_none());
    }
    approve_all(&device_b, &tx).await?;
    {
        let state = device_b.lock().await;
        let imported = providers::get_provider(&state.db, &state.secrets, &provider_id)?.unwrap();
        assert!(!imported.has_secret);
        assert!(!imported.enabled);
    }
    // The publishing device acknowledges the receiver's secret-free metadata
    // before deletion, without losing its own device-local credential.
    sync_now(device_a.clone(), tx.clone()).await?;
    approve_all(&device_a, &tx).await?;
    {
        let state = device_a.lock().await;
        assert!(
            providers::get_provider(&state.db, &state.secrets, &provider_id)?
                .unwrap()
                .has_secret
        );
        providers::delete_provider(&state.db, &state.secrets, &provider_id)?;
    }
    sync_now(device_a.clone(), tx.clone()).await?;
    sync_now(device_b.clone(), tx.clone()).await?;
    approve_all(&device_b, &tx).await?;
    for _ in 0..2 {
        sync_now(device_b.clone(), tx.clone()).await?;
        sync_now(device_a.clone(), tx.clone()).await?;
    }
    let state = device_b.lock().await;
    assert!(providers::get_provider(&state.db, &state.secrets, &provider_id)?.is_none());
    Ok(())
}

#[tokio::test]
async fn global_skill_and_its_resources_are_published_and_tombstoned() -> Result<()> {
    if run_in_isolated_process(
        "config_sync::engine::router_tests::global_skill_and_its_resources_are_published_and_tombstoned",
    )? {
        return Ok(());
    }
    let fixture = fixture(false).await;
    let directory = tempfile::tempdir()?;
    let device = configure_test_device(directory.path(), &fixture.endpoint).await?;
    {
        let mut state = device.lock().await;
        state
            .user_skills
            .create(crate::user_skills::UserSkillInput {
                id: Some("changing-skill".into()),
                name: Some("Changing skill".into()),
                level: Some("global".into()),
                body: Some("Fixture instructions".into()),
                shape: Some("dir".into()),
                ..Default::default()
            })?;
        state.user_skills.write_package_files(
            "changing-skill",
            CapabilityLevel::Global,
            None,
            &[("data.txt".into(), b"first".to_vec())],
        )?;
    }
    let (tx, _rx) = mpsc::unbounded_channel();
    let published_skill = async |device: &Arc<Mutex<AppState>>| -> Result<Option<PortableEntity>> {
        let state = device.lock().await;
        let config = load_config(&state)?.expect("configured device");
        let key = local_vault_key(&state, &config)?.expect("unlocked device");
        let account = configured_account(&state, &config)?;
        let transport = account_transport(&account).await?;
        let (head, _) = read_remote_head(&transport, &config, &key)
            .await?
            .expect("remote head");
        let (manifest, _) = read_remote_revision(
            &transport,
            &config,
            &key,
            &head.revision_id,
            &NoSyncProgress,
        )
        .await?;
        Ok(manifest
            .entities
            .into_iter()
            .find(|entity| entity.entity_id.starts_with("skill:")))
    };
    sync_now(device.clone(), tx.clone()).await?;
    let published = published_skill(&device).await?.expect("published skill");
    assert!(!published.deleted);
    assert!(!published.mapping_required);
    assert!(
        published.payload.get("projectLogicalId").is_none(),
        "a global skill must not carry a project identity"
    );
    assert!(
        !published.resource_ids.is_empty(),
        "the document and its resources are immutable objects"
    );

    {
        let mut state = device.lock().await;
        let skill = state
            .user_skills
            .list(CapabilityLevel::Global, None)?
            .remove(0);
        fs::write(
            Path::new(&skill.path).parent().unwrap().join("data.txt"),
            b"updated",
        )?;
        state.user_skills.replace_package_files(
            "changing-skill",
            CapabilityLevel::Global,
            None,
            &[("data.txt".into(), b"first".to_vec())],
            &[("data.txt".into(), b"updated".to_vec())],
        )?;
    }
    sync_now(device.clone(), tx.clone()).await?;
    let updated = published_skill(&device).await?.expect("updated skill");
    assert!(!updated.deleted);
    assert_ne!(updated.digest, published.digest);

    device.lock().await.user_skills.remove(
        "changing-skill",
        Some(CapabilityLevel::Global),
        None,
    )?;
    sync_now(device.clone(), tx.clone()).await?;
    let deleted = published_skill(&device).await?.expect("deleted skill");
    assert!(
        deleted.deleted,
        "removing a global skill must publish a tombstone"
    );
    assert!(deleted.resource_ids.is_empty());
    // A repeated sync keeps the tombstone instead of reviving the skill.
    sync_now(device.clone(), tx).await?;
    let repeated = published_skill(&device).await?.expect("tombstone");
    assert!(repeated.deleted);
    Ok(())
}

#[tokio::test]
async fn chosen_conflict_is_published_without_reopening_old_candidates() -> Result<()> {
    if run_in_isolated_process(
        "config_sync::engine::router_tests::chosen_conflict_is_published_without_reopening_old_candidates",
    )? {
        return Ok(());
    }
    let fixture = fixture(false).await;
    let directory_a = tempfile::tempdir()?;
    let directory_b = tempfile::tempdir()?;
    let a = configure_test_device(directory_a.path(), &fixture.endpoint).await?;
    let b = configure_test_device(directory_b.path(), &fixture.endpoint).await?;
    let (tx, _rx) = mpsc::unbounded_channel();
    a.lock()
        .await
        .db
        .set_setting("app", &json!({"theme":"dark"}))?;
    sync_now(a.clone(), tx.clone()).await?;
    sync_now(b.clone(), tx.clone()).await?;
    a.lock()
        .await
        .db
        .set_setting("app", &json!({"theme":"light"}))?;
    b.lock()
        .await
        .db
        .set_setting("app", &json!({"theme":"system"}))?;
    sync_now(a.clone(), tx.clone()).await?;
    let conflict = sync_now(b.clone(), tx.clone()).await?;
    let item = conflict["pendingApprovals"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["entityId"].as_str().unwrap().ends_with(":local"))
        .unwrap();
    approve(
        b.clone(),
        json!({"approvalId":item["id"],"digest":item["digest"]}),
        tx.clone(),
    )
    .await?;
    assert_eq!(theme(&*b.lock().await)?, "system");
    assert!(pending_approvals(&sync_now(b.clone(), tx.clone()).await?).is_empty());
    let received = sync_now(a.clone(), tx.clone()).await?;
    assert!(pending_approvals(&received).is_empty());
    assert_eq!(theme(&*a.lock().await)?, "system");
    for _ in 0..2 {
        assert!(pending_approvals(&sync_now(b.clone(), tx.clone()).await?).is_empty());
        assert!(pending_approvals(&sync_now(a.clone(), tx.clone()).await?).is_empty());
    }
    Ok(())
}

fn legacy_project(entity_id: &str, payload: Value, deleted: bool) -> PortableEntity {
    PortableEntity {
        domain: "projects".into(),
        entity_id: entity_id.into(),
        label: "Legacy project".into(),
        deleted,
        requires_approval: true,
        secret_bearing: false,
        mapping_required: true,
        digest: format!("legacy-{entity_id}-{deleted}"),
        payload,
        resource_ids: Vec::new(),
    }
}

#[tokio::test]
async fn legacy_project_revision_sync_and_restore_preserve_local_projects() -> Result<()> {
    if run_in_isolated_process(
        "config_sync::engine::router_tests::legacy_project_revision_sync_and_restore_preserve_local_projects",
    )? {
        return Ok(());
    }
    let fixture = fixture(false).await;
    let directory_a = tempfile::tempdir()?;
    let directory_b = tempfile::tempdir()?;
    let device_a = configure_test_device(directory_a.path(), &fixture.endpoint).await?;
    let device_b = configure_test_device(directory_b.path(), &fixture.endpoint).await?;
    let project_path = directory_b.path().join("existing-project");
    fs::create_dir_all(&project_path)?;
    let project_path = project_path.canonicalize()?.to_string_lossy().into_owned();
    let (projects_before, groups_before) = {
        let state = device_b.lock().await;
        state.db.ensure_project(&project_path, false)?;
        state
            .db
            .create_project_group("Local group", std::slice::from_ref(&project_path))?;
        let mut config = load_config(&state)?.expect("configured device");
        config
            .project_mappings
            .insert("existing".into(), project_path.clone());
        config
            .project_mappings
            .insert("removed".into(), project_path.clone());
        config.project_group_mappings.insert(
            "project-group:existing-group".into(),
            vec![project_path.clone()],
        );
        save_config(&state, &config)?;
        (
            serde_json::to_value(state.db.list_projects()?)?,
            serde_json::to_value(state.db.list_project_groups()?)?,
        )
    };
    let legacy_revision = {
        let mut state = device_a.lock().await;
        state.db.set_setting("app", &json!({"theme":"light"}))?;
        let config = load_config(&state)?.expect("configured device");
        let key = local_vault_key(&state, &config)?.expect("unlocked device");
        let account = configured_account(&state, &config)?;
        let transport = account_transport(&account).await?;
        let mut snapshot = domains::capture(
            &mut state,
            &key,
            &selection(&config),
            config.include_secrets,
            &config.plugin_intents,
        )?;
        snapshot.manifest.entities.extend([
            legacy_project("project:existing", json!({"logicalId":"existing","name":"Remote name","pinned":true}), false),
            legacy_project("project:removed", json!({"logicalId":"removed"}), true),
            legacy_project("project:new", json!({"logicalId":"new","name":"New remote project"}), false),
            legacy_project("project-group:existing-group", json!({"logicalId":"project-group:existing-group","name":"Remote group","roots":[{"name":"Remote root","position":0}]}), false),
        ]);
        // Write authenticated historical bytes directly: the current exporter
        // must never produce the retired domain, even for compatibility tests.
        let revision_id = snapshot.manifest.revision_id.clone();
        let encrypted = encrypt_object(
            &key,
            &format!("manifest/{revision_id}"),
            &config.vault_id,
            &serialize_json(&snapshot.manifest)?,
        )?;
        assert!(
            transport
                .put_if_none(&revision_path(&config, &revision_id)?, encrypted)
                .await?
        );
        assert!(
            publish_head(
                &transport,
                &config,
                &key,
                &next_head(&revision_id, None),
                None
            )
            .await?
        );
        revision_id
    };
    let (tx, _rx) = mpsc::unbounded_channel();
    let received = sync_now(device_b.clone(), tx.clone()).await?;
    assert!(pending_approvals(&received).is_empty());
    assert_eq!(theme(&*device_b.lock().await)?, "light");
    assert!(list_history(device_b.clone()).await?.as_array().is_some());
    {
        let state = device_b.lock().await;
        assert_eq!(
            serde_json::to_value(state.db.list_projects()?)?,
            projects_before
        );
        assert_eq!(
            serde_json::to_value(state.db.list_project_groups()?)?,
            groups_before
        );
        state.db.set_setting("app", &json!({"theme":"dark"}))?;
    }
    sync_now(device_b.clone(), tx.clone()).await?;
    let restored = restore(
        device_b.clone(),
        json!({"revisionId":legacy_revision,"acknowledgePropagation":true}),
        tx,
    )
    .await?;
    assert!(pending_approvals(&restored).is_empty());
    let state = device_b.lock().await;
    assert_eq!(theme(&state)?, "light");
    assert_eq!(
        serde_json::to_value(state.db.list_projects()?)?,
        projects_before
    );
    assert_eq!(
        serde_json::to_value(state.db.list_project_groups()?)?,
        groups_before
    );
    Ok(())
}

#[tokio::test]
async fn legacy_project_config_and_pending_approval_do_not_block_sync() -> Result<()> {
    if run_in_isolated_process(
        "config_sync::engine::router_tests::legacy_project_config_and_pending_approval_do_not_block_sync",
    )? {
        return Ok(());
    }
    let fixture = fixture(false).await;
    let directory = tempfile::tempdir()?;
    let device = configure_test_device(directory.path(), &fixture.endpoint).await?;
    {
        let mut state = device.lock().await;
        let config = load_config(&state)?.expect("configured device");
        let key = local_vault_key(&state, &config)?.expect("unlocked device");
        let mut raw_config = serde_json::to_value(&config)?;
        raw_config["categories"]["projects"] = json!(true);
        state.db.kv_set(CONFIG_NS, CONFIG_KEY, &raw_config)?;
        assert!(!load_config(&state)?
            .expect("configured device")
            .categories
            .contains_key("projects"));
        let snapshot = domains::capture(
            &mut state,
            &key,
            &selection(&config),
            config.include_secrets,
            &config.plugin_intents,
        )?;
        let entity = legacy_project("project:obsolete", json!({"logicalId":"obsolete"}), false);
        let mut manifest = snapshot.manifest;
        manifest.entities.push(entity.clone());
        store_pending(
            &state,
            &key,
            &PendingBundle {
                remote_revision_id: manifest.revision_id.clone(),
                local_before: Some(manifest.clone()),
                manifest,
                resources: BTreeMap::new(),
                approvals: vec![PendingApproval {
                    approval_id: "legacy-approval".into(),
                    entity,
                    reason: "mapping".into(),
                    approved: false,
                }],
                conflicts: Vec::new(),
                journal_state: "staged".into(),
            },
        )?;
        let pending = load_pending(&state, &key)?.expect("pending journal");
        assert!(pending.approvals.is_empty());
        assert!(pending
            .manifest
            .entities
            .iter()
            .all(|entity| entity.domain != "projects"));
        assert!(pending
            .local_before
            .as_ref()
            .expect("local snapshot")
            .entities
            .iter()
            .all(|entity| entity.domain != "projects"));
    }
    let (tx, _rx) = mpsc::unbounded_channel();
    assert!(pending_approvals(&get_state(device.clone()).await?).is_empty());
    let synced = sync_now(device.clone(), tx).await?;
    assert!(pending_approvals(&synced).is_empty());
    assert!(synced["lastRevisionId"].as_str().is_some());
    assert!(device.lock().await.db.list_projects()?.is_empty());
    Ok(())
}

#[path = "learned_memory_tests.rs"]
mod learned_memory_tests;

/// The cloud copy transports global configuration only. Everything a project
/// owns stays on the device that owns the folder, and an excluded record never
/// becomes an approval or a deletion.
#[tokio::test]
async fn project_records_are_not_captured_for_the_cloud_copy() -> Result<()> {
    if run_in_isolated_process(
        "config_sync::engine::router_tests::project_records_are_not_captured_for_the_cloud_copy",
    )? {
        return Ok(());
    }
    let fixture = fixture(false).await;
    let directory = tempfile::tempdir()?;
    let device = configure_test_device(directory.path(), &fixture.endpoint).await?;
    let project = directory.path().join("project");
    std::fs::create_dir_all(&project)?;
    let project_path = project.canonicalize()?.to_string_lossy().into_owned();

    {
        let mut st = device.lock().await;
        st.db.ensure_project(&project_path, false)?;
        std::fs::write(project.join("AGENTS.md"), "project guidance\n")?;
        st.db.set_project_memory(&project_path, "pinned note")?;
        st.mcp_servers.upsert(crate::mcp_servers::McpServerInput {
            id: "project-server".into(),
            label: Some("Project MCP".into()),
            level: Some("project".into()),
            project_path: Some(project_path.clone()),
            transport: Some("stdio".into()),
            command: Some("server".into()),
            ..crate::mcp_servers::McpServerInput::default()
        })?;
        st.user_skills.create(crate::user_skills::UserSkillInput {
            id: Some("project-skill".into()),
            name: Some("Project skill".into()),
            level: Some("project".into()),
            project_path: Some(project_path.clone()),
            body: Some("project body".into()),
            shape: Some("dir".into()),
            ..crate::user_skills::UserSkillInput::default()
        })?;
        crate::scheduled::import_tasks(
            &st.db,
            &[json!({
                "id": "project-task",
                "title": "Project task",
                "prompt": "run it",
                "cadence": "daily",
                "workspacePath": project_path,
                "enabled": false,
            })],
        )?;
    }

    let entities = {
        let mut st = device.lock().await;
        let config = load_config(&st)?.expect("configured device");
        let key = local_vault_key(&st, &config)?.expect("unlocked device");
        domains::capture(
            &mut st,
            &key,
            &selection(&config),
            config.include_secrets,
            &config.plugin_intents,
        )?
        .manifest
        .entities
    };
    assert!(
        entities
            .iter()
            .all(|entity| !domains::is_project_scoped(entity)),
        "project records must not be captured: {:?}",
        entities
            .iter()
            .map(|entity| (&entity.domain, &entity.entity_id))
            .collect::<Vec<_>>()
    );
    assert!(
        entities
            .iter()
            .all(|entity| entity.domain != domains::DOMAIN_MEMORY),
        "pinned project memory must not be captured"
    );
    Ok(())
}

/// Uninstalling a plugin clears its retained installation intent, so the next
/// ordinary sync publishes a deletion instead of re-advertising it.
#[tokio::test]
async fn uninstalled_plugin_intent_deletion_reaches_the_peer() -> Result<()> {
    if run_in_isolated_process(
        "config_sync::engine::router_tests::uninstalled_plugin_intent_deletion_reaches_the_peer",
    )? {
        return Ok(());
    }
    let fixture = fixture(false).await;
    let directory_a = tempfile::tempdir()?;
    let directory_b = tempfile::tempdir()?;
    let device_a = configure_test_device(directory_a.path(), &fixture.endpoint).await?;
    let device_b = configure_test_device(directory_b.path(), &fixture.endpoint).await?;
    let (tx, _rx) = mpsc::unbounded_channel();
    {
        let st = device_a.lock().await;
        let mut config = load_config(&st)?.expect("configured device");
        config.plugin_intents.insert(
            "portable-plugin".into(),
            json!({"id":"portable-plugin","name":"Portable plugin"}),
        );
        save_config(&st, &config)?;
    }
    sync_now(device_a.clone(), tx.clone()).await?;
    sync_now(device_b.clone(), tx.clone()).await?;
    approve_all(&device_b, &tx).await?;
    assert!(load_config(&*device_b.lock().await)?
        .expect("configured device")
        .plugin_intents
        .contains_key("portable-plugin"));

    // The same clearing the uninstall RPC performs.
    {
        let st = device_a.lock().await;
        assert!(crate::config_sync::forget_plugin_intent(
            &st,
            "portable-plugin"
        )?);
        assert!(!load_config(&st)?
            .expect("configured device")
            .plugin_intents
            .contains_key("portable-plugin"));
    }
    sync_now(device_a.clone(), tx.clone()).await?;
    sync_now(device_b.clone(), tx.clone()).await?;
    approve_all(&device_b, &tx).await?;
    for _ in 0..3 {
        sync_now(device_b.clone(), tx.clone()).await?;
        sync_now(device_a.clone(), tx.clone()).await?;
    }
    assert!(
        !load_config(&*device_b.lock().await)?
            .expect("configured device")
            .plugin_intents
            .contains_key("portable-plugin"),
        "a deleted installation intent must not revive"
    );
    Ok(())
}

/// An uninstall on a device without cloud sync is unaffected: there is no
/// intent to clear and nothing to publish.
#[test]
fn forgetting_a_plugin_intent_without_sync_is_a_no_op() -> Result<()> {
    let directory = tempfile::tempdir()?;
    let state = AppState::open(directory.path())?;
    assert!(!crate::config_sync::forget_plugin_intent(
        &state,
        "portable-plugin"
    )?);
    Ok(())
}

/// Deleting a global skill that has already synchronized converges on the peer
/// and stays deleted after repeated syncs.
#[tokio::test]
async fn deleting_a_global_skill_becomes_a_tombstone_the_peer_applies() -> Result<()> {
    if run_in_isolated_process(
        "config_sync::engine::router_tests::deleting_a_global_skill_becomes_a_tombstone_the_peer_applies",
    )? {
        return Ok(());
    }
    let fixture = fixture(false).await;
    let directory_a = tempfile::tempdir()?;
    let directory_b = tempfile::tempdir()?;
    let device_a = configure_test_device(directory_a.path(), &fixture.endpoint).await?;
    let device_b = configure_test_device(directory_b.path(), &fixture.endpoint).await?;
    let (tx, _rx) = mpsc::unbounded_channel();
    {
        let mut state = device_a.lock().await;
        state
            .user_skills
            .create(crate::user_skills::UserSkillInput {
                id: Some("portable-skill".into()),
                name: Some("Portable skill".into()),
                level: Some("global".into()),
                body: Some("global body".into()),
                enabled: Some(true),
                shape: Some("dir".into()),
                ..crate::user_skills::UserSkillInput::default()
            })?;
    }
    let published_skill = async |device: &Arc<Mutex<AppState>>| -> Result<Option<PortableEntity>> {
        let state = device.lock().await;
        let config = load_config(&state)?.expect("configured device");
        let key = local_vault_key(&state, &config)?.expect("unlocked device");
        let account = configured_account(&state, &config)?;
        let transport = account_transport(&account).await?;
        let (head, _) = read_remote_head(&transport, &config, &key)
            .await?
            .expect("remote head");
        let (manifest, _) = read_remote_revision(
            &transport,
            &config,
            &key,
            &head.revision_id,
            &NoSyncProgress,
        )
        .await?;
        Ok(manifest
            .entities
            .into_iter()
            .find(|entity| entity.entity_id.starts_with("skill:")))
    };
    sync_now(device_a.clone(), tx.clone()).await?;
    sync_now(device_b.clone(), tx.clone()).await?;
    approve_all(&device_b, &tx).await?;
    assert!(
        published_skill(&device_a)
            .await?
            .is_some_and(|entity| !entity.deleted),
        "the peer must be able to receive a live skill"
    );

    device_a.lock().await.user_skills.remove(
        "portable-skill",
        Some(CapabilityLevel::Global),
        None,
    )?;
    sync_now(device_a.clone(), tx.clone()).await?;
    let deleted = published_skill(&device_a).await?.expect("tombstone");
    assert!(
        deleted.deleted,
        "removing a global skill must publish a tombstone"
    );
    // The peer applies the tombstone and reports no further work.
    sync_now(device_b.clone(), tx.clone()).await?;
    approve_all(&device_b, &tx).await?;
    assert!(pending_approvals(&get_state(device_b.clone()).await?).is_empty());
    // Alternating repeated syncs must not revive it on either side.
    for _ in 0..3 {
        sync_now(device_b.clone(), tx.clone()).await?;
        sync_now(device_a.clone(), tx.clone()).await?;
    }
    assert!(
        published_skill(&device_a)
            .await?
            .is_some_and(|entity| entity.deleted),
        "a deleted global skill must stay deleted"
    );
    assert!(pending_approvals(&get_state(device_b.clone()).await?).is_empty());
    Ok(())
}

/// An unselected category is a subscription choice, not a deletion: removing the
/// local skill while the category is off publishes nothing, and the delete only
/// propagates once the category is subscribed again.
#[tokio::test]
async fn an_unselected_skills_category_is_not_a_delete() -> Result<()> {
    if run_in_isolated_process(
        "config_sync::engine::router_tests::an_unselected_skills_category_is_not_a_delete",
    )? {
        return Ok(());
    }
    let fixture = fixture(false).await;
    let directory = tempfile::tempdir()?;
    let device = configure_test_device(directory.path(), &fixture.endpoint).await?;
    let (tx, _rx) = mpsc::unbounded_channel();
    {
        let mut state = device.lock().await;
        state
            .user_skills
            .create(crate::user_skills::UserSkillInput {
                id: Some("opt-out-skill".into()),
                name: Some("Opt-out skill".into()),
                level: Some("global".into()),
                body: Some("body".into()),
                enabled: Some(true),
                shape: Some("dir".into()),
                ..crate::user_skills::UserSkillInput::default()
            })?;
    }
    let published_skill = async |device: &Arc<Mutex<AppState>>| -> Result<Option<PortableEntity>> {
        let state = device.lock().await;
        let config = load_config(&state)?.expect("configured device");
        let key = local_vault_key(&state, &config)?.expect("unlocked device");
        let account = configured_account(&state, &config)?;
        let transport = account_transport(&account).await?;
        let (head, _) = read_remote_head(&transport, &config, &key)
            .await?
            .expect("remote head");
        let (manifest, _) = read_remote_revision(
            &transport,
            &config,
            &key,
            &head.revision_id,
            &NoSyncProgress,
        )
        .await?;
        Ok(manifest
            .entities
            .into_iter()
            .find(|entity| entity.entity_id.starts_with("skill:")))
    };
    sync_now(device.clone(), tx.clone()).await?;
    assert!(published_skill(&device)
        .await?
        .is_some_and(|entity| !entity.deleted));

    {
        let st = device.lock().await;
        let mut config = load_config(&st)?.expect("configured device");
        config.categories.insert("skills".into(), false);
        save_config(&st, &config)?;
    }
    device
        .lock()
        .await
        .user_skills
        .remove("opt-out-skill", Some(CapabilityLevel::Global), None)?;
    sync_now(device.clone(), tx.clone()).await?;
    assert!(
        published_skill(&device)
            .await?
            .is_some_and(|entity| !entity.deleted),
        "an unsubscribed category must not publish a deletion"
    );

    {
        let st = device.lock().await;
        let mut config = load_config(&st)?.expect("configured device");
        config.categories.insert("skills".into(), true);
        save_config(&st, &config)?;
    }
    sync_now(device.clone(), tx).await?;
    assert!(
        published_skill(&device)
            .await?
            .is_some_and(|entity| entity.deleted),
        "the delete propagates once the category is subscribed again"
    );
    Ok(())
}

/// An uninstall that lands while a sync is running must not be overwritten by
/// that sync's stale settings, and repeated syncs must not revive the plugin.
#[tokio::test]
async fn uninstall_waits_for_an_in_flight_sync_and_keeps_the_tombstone() -> Result<()> {
    if run_in_isolated_process(
        "config_sync::engine::router_tests::uninstall_waits_for_an_in_flight_sync_and_keeps_the_tombstone",
    )? {
        return Ok(());
    }
    let fixture = fixture(false).await;
    let directory = tempfile::tempdir()?;
    let device = configure_test_device(directory.path(), &fixture.endpoint).await?;
    {
        let st = device.lock().await;
        let mut config = load_config(&st)?.expect("configured device");
        config.plugin_intents.insert(
            "race-plugin".into(),
            json!({"id":"race-plugin","name":"Race plugin"}),
        );
        save_config(&st, &config)?;
    }
    let (tx, _rx) = mpsc::unbounded_channel();
    sync_now(device.clone(), tx.clone()).await?;

    // Play the in-flight sync by holding its lock, then run the uninstall path
    // the RPC handler uses: the same lock, then the same intent clear.
    let sync_lock = { device.lock().await.config_sync_lock.clone() };
    let guard = sync_lock.lock_owned().await;
    // The plugin-manager removal itself is not what races: the intent clear is.
    // The RPC handler performs both under the same lock, so this task mirrors the
    // locked clear and returns whether it changed anything.
    let uninstall = tokio::spawn({
        let device = device.clone();
        async move {
            let (_sync_guard, st) = crate::config_sync::sync_locked_state(&device).await;
            crate::config_sync::forget_plugin_intent(&st, "race-plugin")
        }
    });
    // A scheduling aid, not the oracle: the assertions below decide.
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    assert!(
        !uninstall.is_finished(),
        "the uninstall must wait for the in-flight sync"
    );
    assert!(
        load_config(&*device.lock().await)?
            .expect("configured device")
            .plugin_intents
            .contains_key("race-plugin"),
        "the intent must not be cleared while the sync still owns the lock"
    );

    drop(guard);
    uninstall.await??;
    assert!(!load_config(&*device.lock().await)?
        .expect("configured device")
        .plugin_intents
        .contains_key("race-plugin"));

    // The next syncs publish and keep a deletion instead of re-advertising it.
    for _ in 0..3 {
        sync_now(device.clone(), tx.clone()).await?;
    }
    let state = device.lock().await;
    let config = load_config(&state)?.expect("configured device");
    assert!(!config.plugin_intents.contains_key("race-plugin"));
    let key = local_vault_key(&state, &config)?.expect("unlocked device");
    let account = configured_account(&state, &config)?;
    let transport = account_transport(&account).await?;
    let (head, _) = read_remote_head(&transport, &config, &key)
        .await?
        .expect("remote head");
    let (manifest, _) = read_remote_revision(
        &transport,
        &config,
        &key,
        &head.revision_id,
        &NoSyncProgress,
    )
    .await?;
    let plugin = manifest
        .entities
        .into_iter()
        .find(|entity| entity.entity_id == "plugin:race-plugin")
        .expect("plugin entity");
    assert!(plugin.deleted, "the uninstalled plugin must be tombstoned");
    Ok(())
}
