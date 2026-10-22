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
    crate::config_sync::learned_memory::capture_learned_memory(state)
}

/// One note written the way the manager writes one, in the user's own scope.
fn learned_user_note(
    state: &AppState,
    content: &str,
    status: &str,
) -> Result<crate::memory::MemoryEntryRecord> {
    let outcome = state
        .db
        .create_memory_entry(crate::memory::CreateMemoryRequest {
            scope: MemoryScope::user(),
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

/// The user's own learned memory travels: a note written here reaches the other
/// device, and a delete propagates as a tombstone instead of being undone by the
/// next capture.
#[tokio::test]
async fn user_learned_notes_and_their_deletions_propagate() -> Result<()> {
    if run_in_isolated_process(
        "config_sync::engine::router_tests::learned_memory_tests::user_learned_notes_and_their_deletions_propagate",
    )? {
        return Ok(());
    }
    let fixture = fixture(false).await;
    let directory_a = tempfile::tempdir()?;
    let directory_b = tempfile::tempdir()?;
    let device_a = configure_memory_device(directory_a.path(), &fixture.endpoint).await?;
    let device_b = configure_memory_device(directory_b.path(), &fixture.endpoint).await?;
    let (tx, _rx) = mpsc::unbounded_channel();
    {
        let state = device_a.lock().await;
        learned_user_note(&state, "The gateway is Rust.", "active")?;
    }
    sync_now(device_a.clone(), tx.clone()).await?;
    sync_now(device_b.clone(), tx.clone()).await?;
    approve_all(&device_b, &tx).await?;
    sync_now(device_b.clone(), tx.clone()).await?;

    let contents = |state: &AppState| -> Result<Vec<String>> {
        Ok(state
            .db
            .list_memory_entries(&MemoryScope::user(), None, None, 50, 0)?
            .into_iter()
            .map(|entry| entry.content)
            .collect())
    };
    {
        let peer = device_b.lock().await;
        assert!(
            contents(&peer)?
                .iter()
                .any(|note| note == "The gateway is Rust."),
            "the user's note must reach the other device"
        );
    }

    {
        let state = device_a.lock().await;
        let entry = state
            .db
            .list_memory_entries(&MemoryScope::user(), None, None, 50, 0)?
            .into_iter()
            .find(|entry| entry.content == "The gateway is Rust.")
            .expect("written note");
        state.db.delete_memory_entry(&entry.id)?;
    }
    sync_now(device_a.clone(), tx.clone()).await?;
    sync_now(device_b.clone(), tx.clone()).await?;
    approve_all(&device_b, &tx).await?;
    // Repeated syncs must not resurrect a deleted note.
    sync_now(device_b.clone(), tx.clone()).await?;
    sync_now(device_a.clone(), tx.clone()).await?;
    sync_now(device_b.clone(), tx.clone()).await?;
    {
        let peer = device_b.lock().await;
        assert!(
            !contents(&peer)?
                .iter()
                .any(|note| note == "The gateway is Rust."),
            "a synced delete must remove the note and stay removed"
        );
    }
    Ok(())
}

/// A folder's learned notes describe folders this machine owns, so they stay
/// local: capture never produces a project entity, the peer receives nothing,
/// and no approval is staged for a note it could never apply.
#[tokio::test]
async fn project_learned_notes_stay_on_their_device() -> Result<()> {
    if run_in_isolated_process(
        "config_sync::engine::router_tests::learned_memory_tests::project_learned_notes_stay_on_their_device",
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
    std::fs::create_dir_all(&project_a)?;
    std::fs::create_dir_all(&project_b)?;
    let path_a = project_a.canonicalize()?.to_string_lossy().into_owned();
    let path_b = project_b.canonicalize()?.to_string_lossy().into_owned();
    device_b.lock().await.db.ensure_project(&path_b, false)?;

    {
        let mut state = device_a.lock().await;
        state.db.ensure_project(&path_a, false)?;
        learned_note(&state, &path_a, "The gateway is Rust.", "active")?;
        let entities = learned_entities(&mut state)?;
        assert!(
            entities.is_empty(),
            "a project's notes must not be captured: {entities:?}"
        );
    }
    let (tx, _rx) = mpsc::unbounded_channel();
    sync_now(device_a.clone(), tx.clone()).await?;
    let received = sync_now(device_b.clone(), tx.clone()).await?;
    assert_eq!(
        received["pendingApprovals"],
        json!([]),
        "a project note must not become an approval on the other device"
    );
    let state = device_b.lock().await;
    let scope = state.db.learned_memory_scope_for_path(&path_b)?;
    assert!(
        state
            .db
            .list_memory_entries(&scope, None, None, 50, 0)?
            .is_empty(),
        "the other device keeps its own project notes"
    );
    Ok(())
}

#[path = "learned_memory_merge_tests.rs"]
mod learned_memory_merge_tests;
