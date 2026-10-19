//! Learned-memory configuration-sync tests (ADR agent-long-term-memory §7).
//!
//! Split out of `engine_router_tests.rs` so one feature's tests do not push a
//! shared file past the architecture budget; the helpers they use come from the
//! parent module.

use super::*;

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
            "config_sync::engine::router_tests::learned_memory_tests::learned_memory_round_trips_with_its_tombstones_and_never_its_suggestions",
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
        "config_sync::engine::router_tests::learned_memory_tests::a_synced_delete_and_a_remember_again_both_propagate",
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
        "config_sync::engine::router_tests::learned_memory_tests::two_devices_that_wrote_the_same_note_merge_into_one",
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
            "config_sync::engine::router_tests::learned_memory_tests::an_unmapped_project_defers_one_entity_and_never_fails_the_revision",
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

/// The counters the memory manager shows are device-local: they never travel,
/// so a second device's own numbers stay its own.
#[tokio::test]
async fn local_counters_never_travel_with_a_revision() -> Result<()> {
    if run_in_isolated_process(
        "config_sync::engine::router_tests::learned_memory_tests::local_counters_never_travel_with_a_revision",
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

    let (logical_id, entity) = {
        let mut state = device_a.lock().await;
        state.db.ensure_project(&path_a, false)?;
        learned_note(&state, &path_a, "The host core is Rust.", "active")?;
        // Every counter this device can move: a launch, both decisions, and a
        // block from each writer.
        state.db.record_memory_index_capture(1, 512, 0, 1_000)?;
        state.db.record_memory_suggestion_decision(true)?;
        state.db.record_memory_suggestion_decision(false)?;
        state.db.record_memory_tombstone_block(true)?;
        state.db.record_memory_tombstone_block(false)?;
        let entities = learned_entities(&mut state)?;
        (
            entities[0].payload["projectLogicalId"]
                .as_str()
                .unwrap()
                .to_string(),
            entities[0].clone(),
        )
    };
    let payload = entity.payload.to_string();
    for field in [
        "localStats",
        "suggestionsAccepted",
        "suggestionsRejected",
        "blockedFrom",
        "indexEntries",
        "indexBytes",
        "indexOmitted",
        "indexCapturedAt",
    ] {
        assert!(
            !payload.contains(field),
            "{field} must not travel: {payload}"
        );
    }

    {
        let mut state = device_b.lock().await;
        let mut config = load_config(&state)?.expect("configured");
        map_project_folder(&mut config, &logical_id, &path_b);
        crate::config_sync::learned_memory::apply_learned_memory(&mut state, &mut config, &entity)?;
        // The note arrived; this device's own numbers are still its own.
        let scope = state.db.learned_memory_scope_for_path(&path_b)?;
        assert_eq!(
            state
                .db
                .list_memory_entries(&scope, None, None, 50, 0)?
                .len(),
            1
        );
        let stats = state.db.memory_local_stats()?;
        assert_eq!(stats.suggestions_accepted, 0);
        assert_eq!(stats.suggestions_rejected, 0);
        assert_eq!(stats.blocked_from_extraction, 0);
        assert_eq!(stats.blocked_from_create, 0);
        assert_eq!(stats.index_captured_at, None);
    }

    fixture.task.abort();
    Ok(())
}

/// A device whose opt-in memory category is on: learned memory only travels
/// when the user has enabled it, exactly like pinned memory.
async fn configure_memory_device(data_dir: &Path, endpoint: &str) -> Result<Arc<Mutex<AppState>>> {
    let device = configure_test_device(data_dir, endpoint).await?;
    configure(
        device.clone(),
        json!({
            "deviceLabel": "test-device",
            "backupPassword": "portable-backup-password",
            "mode": "sync",
            "categories": {
                "application": true,
                "providers": true,
                "credentials": true,
                "mcp": true,
                "skills": true,
                "memory": true,
            },
            "includeSecrets": true,
            "includeMemory": true,
            "automaticSync": false,
        }),
    )
    .await?;
    Ok(device)
}

/// The M5 scenario through a real revision: a note and a delete cross between
/// two devices, while the suggestions and the counters of the device that made
/// them stay where they were (ADR agent-long-term-memory §7).
#[tokio::test]
async fn learned_memory_travels_between_devices_and_its_counters_do_not() -> Result<()> {
    if run_in_isolated_process(
        "config_sync::engine::router_tests::learned_memory_tests::learned_memory_travels_between_devices_and_its_counters_do_not",
    )? {
        return Ok(());
    }
    let fixture = fixture(false).await;
    let directory_a = tempfile::tempdir()?;
    let directory_b = tempfile::tempdir()?;
    let device_a = configure_memory_device(directory_a.path(), &fixture.endpoint).await?;
    let device_b = configure_memory_device(directory_b.path(), &fixture.endpoint).await?;
    let project_a = directory_a.path().join("app");
    let project_b = directory_b.path().join("app");
    fs::create_dir_all(&project_a)?;
    fs::create_dir_all(&project_b)?;
    let path_a = project_a.canonicalize()?.to_string_lossy().into_owned();
    let path_b = project_b.canonicalize()?.to_string_lossy().into_owned();
    device_b.lock().await.db.ensure_project(&path_b, false)?;
    let project_note = "The gateway is written in Rust.";
    let user_note = "The deploy window is Friday afternoon.";
    let suggestion = "Maybe the deploy is on Friday.";
    {
        let state = device_a.lock().await;
        state.db.ensure_project(&path_a, false)?;
        learned_note(&state, &path_a, project_note, "active")?;
        let scope = state.db.learned_memory_scope_for_path(&path_a)?;
        state
            .db
            .create_memory_entry(crate::memory::CreateMemoryRequest {
                scope: MemoryScope::user(),
                kind: "fact".into(),
                content: user_note.into(),
                rationale: None,
                origin: "user_ui".into(),
                evidence: "verified".into(),
                status: "active".into(),
                source_session_id: None,
                source_message_ids: Vec::new(),
                override_tombstone: false,
            })?;
        // A suggestion, and every counter this device can move: none of them
        // belongs to another machine.
        state
            .db
            .create_memory_entry(crate::memory::CreateMemoryRequest {
                scope,
                kind: "fact".into(),
                content: suggestion.into(),
                rationale: None,
                origin: "extracted".into(),
                evidence: "inferred".into(),
                status: "suggested".into(),
                source_session_id: None,
                source_message_ids: Vec::new(),
                override_tombstone: false,
            })?;
        state.db.record_memory_index_capture(2, 900, 0, 1_000)?;
        state.db.record_memory_suggestion_decision(true)?;
        state.db.record_memory_tombstone_block(true)?;
    }
    let (tx, _rx) = mpsc::unbounded_channel();
    sync_now(device_a.clone(), tx.clone()).await?;
    let received = sync_now(device_b.clone(), tx.clone()).await?;
    let mapping = received["pendingApprovals"]
        .as_array()
        .unwrap()
        .iter()
        .find_map(|item| item["mappingKey"].as_str())
        .expect("the project note needs a local folder")
        .to_string();
    map_project(
        device_b.clone(),
        json!({"logicalId": mapping, "paths": [path_b]}),
    )
    .await?;
    approve_all(&device_b, &tx).await?;
    {
        let state = device_b.lock().await;
        let scope = state.db.learned_memory_scope_for_path(&path_b)?;
        let project_rows = state.db.list_memory_entries(&scope, None, None, 50, 0)?;
        assert!(project_rows
            .iter()
            .any(|entry| entry.content == project_note));
        assert!(
            !project_rows.iter().any(|entry| entry.content == suggestion),
            "a suggestion stays on the device that made it"
        );
        let user_rows = state
            .db
            .list_memory_entries(&MemoryScope::user(), None, None, 50, 0)?;
        assert!(user_rows.iter().any(|entry| entry.content == user_note));
        let stats = state.db.memory_local_stats()?;
        assert_eq!(stats.suggestions_accepted, 0);
        assert_eq!(stats.blocked_from_extraction, 0);
        assert_eq!(stats.index_captured_at, None);
    }
    // The user forgets the user-scope note here. The delete travels as a
    // tombstone, so the other device loses the text and cannot write it back.
    let forgotten = {
        let state = device_b.lock().await;
        state
            .db
            .list_memory_entries(&MemoryScope::user(), None, None, 50, 0)?
            .into_iter()
            .find(|entry| entry.content == user_note)
            .expect("the note arrived")
            .id
    };
    assert!(device_b.lock().await.db.delete_memory_entry(&forgotten)?);
    sync_now(device_b.clone(), tx.clone()).await?;
    sync_now(device_a.clone(), tx.clone()).await?;
    approve_all(&device_a, &tx).await?;
    {
        let state = device_a.lock().await;
        let rows = state
            .db
            .list_memory_entries(&MemoryScope::user(), None, None, 50, 0)?;
        assert!(
            !rows.iter().any(|entry| entry.content == user_note),
            "a delete propagates"
        );
        let refused = state
            .db
            .create_memory_entry(crate::memory::CreateMemoryRequest {
                scope: MemoryScope::user(),
                kind: "fact".into(),
                content: user_note.into(),
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
            _ => panic!("the tombstone must refuse the same content"),
        }
        // This device's own numbers are still its own: the refused write is
        // counted here, and the sync never overwrote what was counted before.
        let stats = state.db.memory_local_stats()?;
        assert_eq!(stats.blocked_from_create, 1);
        assert_eq!(stats.blocked_from_extraction, 1);
        assert_eq!(stats.suggestions_accepted, 1);
        assert_eq!(stats.index_entries, 2);
    }
    fixture.task.abort();
    Ok(())
}
