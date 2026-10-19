use super::remote::{revision_path, serialize_json};
use super::tests::{
    configure_test_device, configure_test_device_mode, pending_approvals, run_in_isolated_process,
};
use super::*;
use crate::config_sync::domains::{
    entity as portable_entity, ProjectIdentityOverrides, DOMAIN_LEARNED_MEMORY,
};
use crate::config_sync::transport::tests::fixture;

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
async fn resource_updates_and_packaged_skill_deletion_reach_the_other_device() -> Result<()> {
    if run_in_isolated_process(
        "config_sync::engine::router_tests::resource_updates_and_packaged_skill_deletion_reach_the_other_device",
    )? {
        return Ok(());
    }
    let fixture = fixture(false).await;
    let directory_a = tempfile::tempdir()?;
    let directory_b = tempfile::tempdir()?;
    let device_a = configure_test_device(directory_a.path(), &fixture.endpoint).await?;
    let device_b = configure_test_device(directory_b.path(), &fixture.endpoint).await?;
    let project_a = directory_a.path().join("project");
    let project_b = directory_b.path().join("project");
    fs::create_dir_all(&project_a)?;
    fs::create_dir_all(&project_b)?;
    let project_a = project_a.canonicalize()?.to_string_lossy().into_owned();
    let project_b = project_b.canonicalize()?.to_string_lossy().into_owned();
    // Project registration is device-local; scoped capability capture requires
    // the receiving device to have registered its own mapped project.
    device_b.lock().await.db.ensure_project(&project_b, false)?;
    {
        let mut state = device_a.lock().await;
        state.db.ensure_project(&project_a, false)?;
        state
            .user_skills
            .create(crate::user_skills::UserSkillInput {
                id: Some("changing-skill".into()),
                name: Some("Changing skill".into()),
                level: Some("project".into()),
                project_path: Some(project_a.clone()),
                body: Some("Fixture instructions".into()),
                shape: Some("dir".into()),
                ..Default::default()
            })?;
        state.user_skills.write_package_files(
            "changing-skill",
            CapabilityLevel::Project,
            Some(&project_a),
            &[("data.txt".into(), b"first".to_vec())],
        )?;
    }
    let (tx, _rx) = mpsc::unbounded_channel();
    sync_now(device_a.clone(), tx.clone()).await?;
    let received = sync_now(device_b.clone(), tx.clone()).await?;
    let mapping = received["pendingApprovals"]
        .as_array()
        .unwrap()
        .iter()
        .find_map(|item| item["mappingKey"].as_str())
        .unwrap();
    map_project(
        device_b.clone(),
        json!({"logicalId":mapping,"paths":[project_b]}),
    )
    .await?;
    approve_all(&device_b, &tx).await?;
    {
        let mut state = device_a.lock().await;
        let skill = state
            .user_skills
            .list(CapabilityLevel::Project, Some(&project_a))?
            .remove(0);
        fs::write(
            Path::new(&skill.path).parent().unwrap().join("data.txt"),
            b"updated",
        )?;
    }
    sync_now(device_a.clone(), tx.clone()).await?;
    sync_now(device_b.clone(), tx.clone()).await?;
    approve_all(&device_b, &tx).await?;
    {
        let mut state = device_b.lock().await;
        assert_eq!(
            state.user_skills.package_files(
                "changing-skill",
                CapabilityLevel::Project,
                Some(&project_b)
            )?,
            vec![("data.txt".into(), b"updated".to_vec())]
        );
    }
    device_a.lock().await.user_skills.remove(
        "changing-skill",
        Some(CapabilityLevel::Project),
        Some(&project_a),
    )?;
    sync_now(device_a.clone(), tx.clone()).await?;
    sync_now(device_b.clone(), tx.clone()).await?;
    approve_all(&device_b, &tx).await?;
    assert!(device_b
        .lock()
        .await
        .user_skills
        .list(CapabilityLevel::Project, Some(&project_b))?
        .is_empty());
    sync_now(device_b.clone(), tx).await?;
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
            &identity_overrides(&config),
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
            &identity_overrides(&config),
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

// ---- learned memory in configuration sync (ADR §7) ---------------------

/// One note written the way the manager writes one, in the project's scope.
fn learned_note(
    state: &AppState,
    path: &str,
    content: &str,
    status: &str,
) -> Result<crate::memory::MemoryEntryRecord> {
    let scope = state.db.learned_memory_scope_for_path(path)?;
    let outcome = state
        .db
        .create_memory_entry(crate::memory::CreateMemoryRequest {
            scope,
            kind: "fact".into(),
            content: content.into(),
            rationale: None,
            origin: "user_ui".into(),
            evidence: "verified".into(),
            status: status.into(),
            source_session_id: None,
            source_message_ids: Vec::new(),
            override_tombstone: false,
        })?;
    match outcome {
        crate::memory::CreateMemoryOutcome::Created(entry)
        | crate::memory::CreateMemoryOutcome::Duplicate(entry) => Ok(*entry),
        crate::memory::CreateMemoryOutcome::Rejected(rejection) => {
            Err(anyhow!("rejected: {}", rejection.code))
        }
    }
}

fn learned_entities(state: &mut AppState) -> Result<Vec<PortableEntity>> {
    crate::config_sync::learned_memory::capture_learned_memory(
        state,
        &ProjectIdentityOverrides::default(),
    )
}

/// A device's stored sync config, with one project mapped to a local folder.
fn map_project_folder(config: &mut StoredConfig, logical_id: &str, path: &str) {
    config
        .project_mappings
        .insert(logical_id.to_string(), path.to_string());
}

#[tokio::test]
async fn learned_memory_round_trips_with_its_tombstones_and_never_its_suggestions() -> Result<()> {
    if run_in_isolated_process(
            "config_sync::engine::router_tests::learned_memory_round_trips_with_its_tombstones_and_never_its_suggestions",
        )? {
            return Ok(());
        }
    let fixture = fixture(false).await;
    let directory_a = tempfile::tempdir()?;
    let directory_b = tempfile::tempdir()?;
    let device_a = configure_test_device(directory_a.path(), &fixture.endpoint).await?;
    let device_b = configure_test_device(directory_b.path(), &fixture.endpoint).await?;
    let project_a = directory_a.path().join("app");
    let project_b = directory_b.path().join("app");
    std::fs::create_dir_all(&project_a)?;
    std::fs::create_dir_all(&project_b)?;
    let path_a = crate::db::canonical_project_path(project_a.to_str().unwrap())
        .expect("canonical project path");
    let path_b = crate::db::canonical_project_path(project_b.to_str().unwrap())
        .expect("canonical project path");

    let entities = {
        let mut state = device_a.lock().await;
        state.db.ensure_project(&path_a, false)?;
        learned_note(&state, &path_a, "The host core is Rust.", "active")?;
        let archived = learned_note(&state, &path_a, "Deploys on Fridays.", "active")?;
        state.db.set_memory_entry_status(&archived.id, "archived")?;
        // A suggestion is device-local: it must never leave this machine.
        let scope = state.db.learned_memory_scope_for_path(&path_a)?;
        state
            .db
            .create_memory_entry(crate::memory::CreateMemoryRequest {
                scope: scope.clone(),
                kind: "fact".into(),
                content: "Maybe the deploy is on Friday.".into(),
                rationale: None,
                origin: "extracted".into(),
                evidence: "inferred".into(),
                status: "suggested".into(),
                source_session_id: None,
                source_message_ids: Vec::new(),
                override_tombstone: false,
            })?;
        // A forgotten note leaves a tombstone that must travel with the rest.
        let forgotten = learned_note(&state, &path_a, "Old rule nobody wants.", "active")?;
        state.db.delete_memory_entry(&forgotten.id)?;
        // Pinned memory is a different layer: it must be untouched here.
        state
            .db
            .set_project_memory(&path_a, "Keep project memory")?;
        learned_entities(&mut state)?
    };
    assert_eq!(entities.len(), 1, "one project identity");
    let entity = &entities[0];
    assert_eq!(entity.domain, DOMAIN_LEARNED_MEMORY);
    let payload = entity.payload.to_string();
    assert!(payload.contains("The host core is Rust."));
    assert!(payload.contains("Deploys on Fridays."));
    // A tombstone is content-free by design, so only its identity travels.
    assert!(!payload.contains("Old rule nobody wants."));
    assert_eq!(
        entity.payload["scope"]["tombstones"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert!(
        !payload.contains("Maybe the deploy is on Friday."),
        "a suggestion is device-local: {payload}"
    );
    // Device-local counters never travel either, so two devices that only
    // read their notes never diverge.
    assert!(!payload.contains("useCount") && !payload.contains("lastUsedAt"));
    let logical_id = entity.payload["projectLogicalId"]
        .as_str()
        .unwrap()
        .to_string();

    {
        let mut state = device_b.lock().await;
        let mut config = load_config(&state)?.expect("configured");
        map_project_folder(&mut config, &logical_id, &path_b);
        crate::config_sync::learned_memory::apply_learned_memory(&mut state, &mut config, entity)?;

        let scope = state.db.learned_memory_scope_for_path(&path_b)?;
        let listed = state.db.list_memory_entries(&scope, None, None, 50, 0)?;
        let contents = listed
            .iter()
            .map(|entry| (entry.content.clone(), entry.status.clone()))
            .collect::<Vec<_>>();
        assert!(contents.contains(&("The host core is Rust.".into(), "active".into())));
        assert!(contents.contains(&("Deploys on Fridays.".into(), "archived".into())));
        assert!(
            !contents
                .iter()
                .any(|(content, _)| content.contains("Maybe the deploy")),
            "a suggestion never arrives: {contents:?}"
        );
        // The tombstone arrived, so the same evidence cannot come back here.
        assert!(state
            .db
            .memory_tombstone(
                &scope,
                &crate::memory::tombstones::fingerprint("fact", "Old rule nobody wants.")
            )?
            .is_some());
        // Pinned memory on this device is its own; learned memory never
        // writes it.
        assert!(state
            .db
            .get_project_memory(&path_b)?
            .content
            .trim()
            .is_empty());

        // Applying the same entity again changes nothing: the fingerprint is
        // the merge key, not the id.
        let before = state
            .db
            .list_memory_entries(&scope, None, None, 50, 0)?
            .len();
        crate::config_sync::learned_memory::apply_learned_memory(&mut state, &mut config, entity)?;
        assert_eq!(
            state
                .db
                .list_memory_entries(&scope, None, None, 50, 0)?
                .len(),
            before
        );
    }

    fixture.task.abort();
    Ok(())
}

#[tokio::test]
async fn a_synced_delete_and_a_remember_again_both_propagate() -> Result<()> {
    if run_in_isolated_process(
        "config_sync::engine::router_tests::a_synced_delete_and_a_remember_again_both_propagate",
    )? {
        return Ok(());
    }
    let fixture = fixture(false).await;
    let directory_a = tempfile::tempdir()?;
    let directory_b = tempfile::tempdir()?;
    let device_a = configure_test_device(directory_a.path(), &fixture.endpoint).await?;
    let device_b = configure_test_device(directory_b.path(), &fixture.endpoint).await?;
    let project_a = directory_a.path().join("app");
    let project_b = directory_b.path().join("app");
    std::fs::create_dir_all(&project_a)?;
    std::fs::create_dir_all(&project_b)?;
    let path_a = crate::db::canonical_project_path(project_a.to_str().unwrap())
        .expect("canonical project path");
    let path_b = crate::db::canonical_project_path(project_b.to_str().unwrap())
        .expect("canonical project path");

    // Both devices start with the same note, and B holds it by fingerprint.
    let (logical_id, shared) = {
        let mut state = device_a.lock().await;
        state.db.ensure_project(&path_a, false)?;
        let entry = learned_note(&state, &path_a, "Uses pnpm, not npm.", "active")?;
        let entities = learned_entities(&mut state)?;
        (
            entities[0].payload["projectLogicalId"]
                .as_str()
                .unwrap()
                .to_string(),
            entry,
        )
    };
    let initial = {
        let mut state = device_a.lock().await;
        learned_entities(&mut state)?[0].clone()
    };
    {
        let mut state = device_b.lock().await;
        let mut config = load_config(&state)?.expect("configured");
        map_project_folder(&mut config, &logical_id, &path_b);
        crate::config_sync::learned_memory::apply_learned_memory(
            &mut state,
            &mut config,
            &initial,
        )?;
        let scope = state.db.learned_memory_scope_for_path(&path_b)?;
        assert_eq!(
            state
                .db
                .list_memory_entries(&scope, None, None, 50, 0)?
                .len(),
            1
        );
    }

    // A deletes it here. The tombstone must erase B's copy.
    let deleted = {
        let mut state = device_a.lock().await;
        state.db.delete_memory_entry(&shared.id)?;
        let entities = learned_entities(&mut state)?;
        assert!(entities[0].payload["scope"]["entries"]
            .as_array()
            .unwrap()
            .is_empty());
        entities[0].clone()
    };
    {
        let mut state = device_b.lock().await;
        let mut config = load_config(&state)?.expect("configured");
        map_project_folder(&mut config, &logical_id, &path_b);
        crate::config_sync::learned_memory::apply_learned_memory(
            &mut state,
            &mut config,
            &deleted,
        )?;
        let scope = state.db.learned_memory_scope_for_path(&path_b)?;
        assert!(
            state
                .db
                .list_memory_entries(&scope, None, None, 50, 0)?
                .is_empty(),
            "the delete reached this device"
        );
        // And the same content cannot be re-created here from the same
        // evidence while the tombstone stands.
        let refused = state
            .db
            .create_memory_entry(crate::memory::CreateMemoryRequest {
                scope: scope.clone(),
                kind: "fact".into(),
                content: "Uses pnpm, not npm.".into(),
                rationale: None,
                origin: "user_ui".into(),
                evidence: "verified".into(),
                status: "active".into(),
                source_session_id: None,
                source_message_ids: Vec::new(),
                override_tombstone: false,
            })?;
        match refused {
            crate::memory::CreateMemoryOutcome::Rejected(rejection) => {
                assert_eq!(rejection.code, "MEMORY_TOMBSTONED")
            }
            _ => panic!("expected a tombstone refusal"),
        }
    }

    // The user presses "remember again" on A: the tombstone is cleared and a
    // new note is created. Both facts must reach B, which still holds the
    // delete.
    let remembered = {
        let mut state = device_a.lock().await;
        let scope = state.db.learned_memory_scope_for_path(&path_a)?;
        let fingerprint = crate::memory::tombstones::fingerprint("fact", "Uses pnpm, not npm.");
        state.db.conn().execute(
            "DELETE FROM memory_tombstones
                      WHERE scope_kind = ?1 AND IFNULL(scope_key, '') = ?2 AND fingerprint = ?3",
            rusqlite::params![scope.kind, scope.stored_key(), fingerprint],
        )?;
        learned_note(&state, &path_a, "Uses pnpm, not npm.", "active")?;
        let entities = learned_entities(&mut state)?;
        assert!(entities[0].payload["scope"]["tombstones"]
            .as_array()
            .unwrap()
            .is_empty());
        entities[0].clone()
    };
    {
        let mut state = device_b.lock().await;
        let mut config = load_config(&state)?.expect("configured");
        map_project_folder(&mut config, &logical_id, &path_b);
        crate::config_sync::learned_memory::apply_learned_memory(
            &mut state,
            &mut config,
            &remembered,
        )?;
        let scope = state.db.learned_memory_scope_for_path(&path_b)?;
        let listed = state.db.list_memory_entries(&scope, None, None, 50, 0)?;
        assert_eq!(listed.len(), 1, "the newer note wins over the older delete");
        assert_eq!(listed[0].content, "Uses pnpm, not npm.");
        assert!(state
            .db
            .memory_tombstone(&scope, &listed[0].fingerprint)?
            .is_none());
    }

    fixture.task.abort();
    Ok(())
}

#[tokio::test]
async fn two_devices_that_wrote_the_same_note_merge_into_one() -> Result<()> {
    if run_in_isolated_process(
        "config_sync::engine::router_tests::two_devices_that_wrote_the_same_note_merge_into_one",
    )? {
        return Ok(());
    }
    let fixture = fixture(false).await;
    let directory_a = tempfile::tempdir()?;
    let directory_b = tempfile::tempdir()?;
    let device_a = configure_test_device(directory_a.path(), &fixture.endpoint).await?;
    let device_b = configure_test_device(directory_b.path(), &fixture.endpoint).await?;
    let project_a = directory_a.path().join("app");
    let project_b = directory_b.path().join("app");
    std::fs::create_dir_all(&project_a)?;
    std::fs::create_dir_all(&project_b)?;
    let path_a = crate::db::canonical_project_path(project_a.to_str().unwrap())
        .expect("canonical project path");
    let path_b = crate::db::canonical_project_path(project_b.to_str().unwrap())
        .expect("canonical project path");

    // Each device wrote the same sentence on its own, so the two rows have
    // different ids and the same fingerprint.
    let (logical_id, entity) = {
        let mut state = device_a.lock().await;
        state.db.ensure_project(&path_a, false)?;
        learned_note(&state, &path_a, "The gateway deploys on Fridays.", "active")?;
        let entities = learned_entities(&mut state)?;
        (
            entities[0].payload["projectLogicalId"]
                .as_str()
                .unwrap()
                .to_string(),
            entities[0].clone(),
        )
    };
    {
        let mut state = device_b.lock().await;
        state.db.ensure_project(&path_b, false)?;
        let own = learned_note(&state, &path_b, "The gateway deploys on Fridays.", "active")?;
        let mut config = load_config(&state)?.expect("configured");
        map_project_folder(&mut config, &logical_id, &path_b);
        crate::config_sync::learned_memory::apply_learned_memory(&mut state, &mut config, &entity)?;
        let scope = state.db.learned_memory_scope_for_path(&path_b)?;
        let listed = state.db.list_memory_entries(&scope, None, None, 50, 0)?;
        assert_eq!(listed.len(), 1, "the fingerprint is the merge key");
        // The row this device already had keeps its identity, so an open
        // manager and any receipt keep pointing at it.
        assert_eq!(listed[0].id, own.id);
    }

    fixture.task.abort();
    Ok(())
}

#[tokio::test]
async fn an_unmapped_project_defers_one_entity_and_never_fails_the_revision() -> Result<()> {
    if run_in_isolated_process(
            "config_sync::engine::router_tests::an_unmapped_project_defers_one_entity_and_never_fails_the_revision",
        )? {
            return Ok(());
        }
    let fixture = fixture(false).await;
    let directory_a = tempfile::tempdir()?;
    let directory_b = tempfile::tempdir()?;
    let device_a = configure_test_device(directory_a.path(), &fixture.endpoint).await?;
    let device_b = configure_test_device(directory_b.path(), &fixture.endpoint).await?;
    let project_a = directory_a.path().join("app");
    std::fs::create_dir_all(&project_a)?;
    let path_a = crate::db::canonical_project_path(project_a.to_str().unwrap())
        .expect("canonical project path");
    let entity = {
        let mut state = device_a.lock().await;
        state.db.ensure_project(&path_a, false)?;
        learned_note(&state, &path_a, "Only on this machine.", "active")?;
        learned_entities(&mut state)?[0].clone()
    };

    // B has no folder mapped for that project. The entity must be deferred
    // with the code the engine turns into a pending item, not a hard error:
    // one unmapped folder cannot stop the rest of a revision.
    let mut state = device_b.lock().await;
    let mut config = load_config(&state)?.expect("configured");
    let error =
        crate::config_sync::learned_memory::apply_learned_memory(&mut state, &mut config, &entity)
            .expect_err("an unmapped project defers");
    assert!(
        error
            .to_string()
            .starts_with("CONFIG_SYNC_MAPPING_REQUIRED"),
        "{error}"
    );
    // The user-scope entity needs no mapping at all, so it always applies.
    let user_entity = {
        let mut a = device_a.lock().await;
        let scope = crate::memory::MemoryScope::user();
        a.db.create_memory_entry(crate::memory::CreateMemoryRequest {
            scope,
            kind: "fact".into(),
            content: "Prefers terse replies.".into(),
            rationale: None,
            origin: "user_ui".into(),
            evidence: "verified".into(),
            status: "active".into(),
            source_session_id: None,
            source_message_ids: Vec::new(),
            override_tombstone: false,
        })?;
        learned_entities(&mut a)?
            .into_iter()
            .find(|entity| entity.payload["scopeKind"] == "user")
            .expect("the user scope is captured")
    };
    crate::config_sync::learned_memory::apply_learned_memory(
        &mut state,
        &mut config,
        &user_entity,
    )?;
    let user_scope = crate::memory::MemoryScope::user();
    assert_eq!(
        state
            .db
            .list_memory_entries(&user_scope, None, None, 50, 0)?
            .len(),
        1
    );

    fixture.task.abort();
    Ok(())
}

/// The old-version boundary, proven at the gate a released build runs first.
///
/// A revision carrying an entity whose domain has no adapter is **refused**
/// outright (`CONFIG_SYNC_UNSUPPORTED`), not skipped: a released build cannot
/// read a revision that carries the new domain at all, so its head read — and
/// with it every later sync and restore — fails. A domain that does not exist
/// yet stands in for any domain a released build does not know, because the gate
/// only asks whether an adapter exists.
#[test]
fn a_revision_carrying_an_unknown_domain_is_refused_not_skipped() {
    let future = portable_entity(
        "aDomainFromTheFuture",
        "future:one",
        "Future domain",
        json!({}),
        false,
        false,
        false,
        Vec::new(),
    );
    let mut manifest = RevisionManifest {
        format: REVISION_FORMAT.into(),
        version: 1,
        revision_id: "rev-1".into(),
        parents: Vec::new(),
        created_at: String::new(),
        entities: vec![future],
        resource_ids: Vec::new(),
    };
    let error = super::remote::validate_remote_manifest(&mut manifest, "rev-1")
        .expect_err("an unknown domain is refused");
    assert!(
        error
            .to_string()
            .starts_with("CONFIG_SYNC_UNSUPPORTED: remote domain aDomainFromTheFuture"),
        "{error}"
    );

    // The very same revision is accepted once the domain has an adapter, which
    // is exactly how this build differs from a released one.
    let learned = portable_entity(
        DOMAIN_LEARNED_MEMORY,
        "learned-memory:user",
        "Learned memory",
        json!({ "scopeKind": "user" }),
        false,
        true,
        false,
        Vec::new(),
    );
    let mut known = RevisionManifest {
        entities: vec![learned],
        ..manifest.clone()
    };
    super::remote::validate_remote_manifest(&mut known, "rev-1")
        .expect("this build reads the domain it knows");
}
