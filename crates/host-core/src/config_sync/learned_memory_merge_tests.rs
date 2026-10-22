//! Two devices, one learned-memory scope (ADR agent-long-term-memory §7).
//!
//! A scope travels as one entity, so these are the tests that prove the engine
//! merges it note by note instead of offering a whole-scope conflict. Split out
//! of `learned_memory_tests.rs` to stay inside the architecture budget; the
//! shared fixtures come from the parent module.

use super::*;

// ---- one scope, two devices (ADR §7) ------------------------------------

/// One note in the user scope, written the way the manager writes one.
fn learned_user_note(state: &AppState, content: &str) -> Result<crate::memory::MemoryEntryRecord> {
    let outcome = state
        .db
        .create_memory_entry(crate::memory::CreateMemoryRequest {
            scope: MemoryScope::user(),
            kind: "fact".into(),
            content: content.into(),
            rationale: None,
            origin: "user_ui".into(),
            evidence: "verified".into(),
            status: "active".into(),
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

/// The notes one device holds in a scope, by content.
async fn notes_of(device: &Arc<Mutex<AppState>>, scope: &MemoryScope) -> Result<Vec<String>> {
    let state = device.lock().await;
    Ok(state
        .db
        .list_memory_entries(scope, None, None, 50, 0)?
        .into_iter()
        .map(|entry| entry.content)
        .collect())
}

async fn user_notes(device: &Arc<Mutex<AppState>>) -> Result<Vec<String>> {
    notes_of(device, &MemoryScope::user()).await
}

/// The tombstones one device holds in the user scope.
async fn user_tombstones(device: &Arc<Mutex<AppState>>) -> Result<i64> {
    let state = device.lock().await;
    Ok(state.db.conn().query_row(
        "SELECT COUNT(*) FROM memory_tombstones WHERE scope_kind = 'user'",
        [],
        |row| row.get(0),
    )?)
}

/// The entities a device is being asked to choose between. A whole-scope
/// conflict is exactly what these tests must never see: a scope travels as one
/// entity, so its notes would be lost as a pair.
fn conflict_ids(state: &Value) -> Vec<String> {
    state["pendingApprovals"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|item| item["reason"] == "conflict")
        .filter_map(|item| item["entityId"].as_str().map(str::to_string))
        .collect()
}

/// Two devices that each write a user-scope note between two syncs end up with
/// both notes. The user scope is one entity, so a whole-entity conflict would
/// ask the user to choose between two notes that never disagreed.
#[tokio::test]
async fn user_notes_written_on_two_devices_between_two_syncs_converge() -> Result<()> {
    if run_in_isolated_process(
        "config_sync::engine::router_tests::learned_memory_tests::learned_memory_merge_tests::user_notes_written_on_two_devices_between_two_syncs_converge",
    )? {
        return Ok(());
    }
    let fixture = fixture(false).await;
    let directory_a = tempfile::tempdir()?;
    let directory_b = tempfile::tempdir()?;
    let device_a = configure_memory_device(directory_a.path(), &fixture.endpoint).await?;
    let device_b = configure_memory_device(directory_b.path(), &fixture.endpoint).await?;
    let (tx, _rx) = mpsc::unbounded_channel();

    // Both devices start from the same user scope.
    {
        let state = device_a.lock().await;
        learned_user_note(&state, "The deploy window is Friday.")?;
    }
    sync_now(device_a.clone(), tx.clone()).await?;
    let received = sync_now(device_b.clone(), tx.clone()).await?;
    assert!(conflict_ids(&received).is_empty(), "{received}");
    assert_eq!(user_notes(&device_b).await?.len(), 1);

    // Each device writes its own note before the next sync.
    {
        let state = device_a.lock().await;
        learned_user_note(&state, "Prefers terse Chinese replies.")?;
    }
    {
        let state = device_b.lock().await;
        learned_user_note(&state, "Reviews the diff before merging.")?;
    }
    sync_now(device_a.clone(), tx.clone()).await?;
    let received = sync_now(device_b.clone(), tx.clone()).await?;
    assert!(conflict_ids(&received).is_empty(), "{received}");
    sync_now(device_b.clone(), tx.clone()).await?;
    sync_now(device_a.clone(), tx.clone()).await?;

    for device in [&device_a, &device_b] {
        let notes = user_notes(device).await?;
        assert_eq!(notes.len(), 3, "{notes:?}");
    }
    fixture.task.abort();
    Ok(())
}

/// Neither device has a baseline and both already hold a user-scope note: the
/// first sync adopts both instead of opening a conflict.
#[tokio::test]
async fn a_first_sync_with_a_note_on_each_device_adopts_both() -> Result<()> {
    if run_in_isolated_process(
        "config_sync::engine::router_tests::learned_memory_tests::learned_memory_merge_tests::a_first_sync_with_a_note_on_each_device_adopts_both",
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
        learned_user_note(&state, "Uses pnpm, not npm.")?;
    }
    {
        let state = device_b.lock().await;
        learned_user_note(&state, "Commits in two paragraphs.")?;
    }
    sync_now(device_a.clone(), tx.clone()).await?;
    let received = sync_now(device_b.clone(), tx.clone()).await?;
    assert!(conflict_ids(&received).is_empty(), "{received}");
    sync_now(device_b.clone(), tx.clone()).await?;
    sync_now(device_a.clone(), tx.clone()).await?;

    for device in [&device_a, &device_b] {
        let notes = user_notes(device).await?;
        assert_eq!(notes.len(), 2, "{notes:?}");
    }
    fixture.task.abort();
    Ok(())
}

/// A delete beats an edit made after it, on both devices, and the user's own
/// "remember again" is the only thing that brings the note back.
#[tokio::test]
async fn a_delete_beats_a_later_edit_and_remember_again_restores_the_note() -> Result<()> {
    if run_in_isolated_process(
        "config_sync::engine::router_tests::learned_memory_tests::learned_memory_merge_tests::a_delete_beats_a_later_edit_and_remember_again_restores_the_note",
    )? {
        return Ok(());
    }
    let fixture = fixture(false).await;
    let directory_a = tempfile::tempdir()?;
    let directory_b = tempfile::tempdir()?;
    let device_a = configure_memory_device(directory_a.path(), &fixture.endpoint).await?;
    let device_b = configure_memory_device(directory_b.path(), &fixture.endpoint).await?;
    let (tx, _rx) = mpsc::unbounded_channel();
    let content = "Deploys on Fridays.";

    let note = {
        let state = device_a.lock().await;
        learned_user_note(&state, content)?
    };
    sync_now(device_a.clone(), tx.clone()).await?;
    sync_now(device_b.clone(), tx.clone()).await?;
    assert_eq!(user_notes(&device_b).await?.len(), 1);

    // A forgets the note; B edits it before it hears about the delete. An edit
    // keeps the note's identity and only moves `updated_at`, so it must not
    // A forgets the note first, then B edits it before it hears about the
    // delete. An edit keeps the note's identity and only moves `updated_at`,
    // so the two devices disagree about which is newer: the delete is newer
    // than the note, the edit is newer than the delete. The delete must still
    // win on both devices.
    assert!(device_a.lock().await.db.delete_memory_entry(&note.id)?);
    std::thread::sleep(std::time::Duration::from_millis(5));
    {
        // B holds its own row for the note: the id is local to each device and
        // the fingerprint is what they share.
        let state = device_b.lock().await;
        let row = state
            .db
            .live_memory_entry_by_fingerprint(&MemoryScope::user(), &note.fingerprint)?
            .expect("B holds the note");
        let outcome = state
            .db
            .update_memory_entry(crate::memory::UpdateMemoryRequest {
                id: row.id.clone(),
                revision: row.revision,
                content: None,
                rationale: Some("Reviewed on B.".into()),
                kind: None,
                scope: None,
            })?;
        assert!(
            matches!(outcome, crate::memory::UpdateMemoryOutcome::Updated(_)),
            "the edit must land on B"
        );
    }
    {
        // The precondition of the divergence, asserted rather than assumed.
        let scope = MemoryScope::user();
        let fingerprint = note.fingerprint.clone();
        let tombstone = device_a
            .lock()
            .await
            .db
            .memory_tombstone(&scope, &fingerprint)?
            .expect("A holds the delete");
        let edited = device_b
            .lock()
            .await
            .db
            .live_memory_entry_by_fingerprint(&scope, &fingerprint)?
            .expect("B still holds the note");
        assert!(
            edited.updated_at > tombstone.created_at,
            "B edited after the delete"
        );
        assert!(
            edited.created_at < tombstone.created_at,
            "and did not recreate it"
        );
    }
    sync_now(device_a.clone(), tx.clone()).await?;
    let received = sync_now(device_b.clone(), tx.clone()).await?;
    assert!(conflict_ids(&received).is_empty(), "{received}");
    sync_now(device_a.clone(), tx.clone()).await?;
    sync_now(device_b.clone(), tx.clone()).await?;

    for device in [&device_a, &device_b] {
        assert!(
            user_notes(device).await?.is_empty(),
            "the delete stands on both devices"
        );
        assert_eq!(
            user_tombstones(device).await?,
            1,
            "and both devices remember it"
        );
    }

    // The receipt's "remember again" writes a new note with a newer
    // `created_at`, which is what clears the delete on both devices.
    {
        let state = device_a.lock().await;
        let outcome = state
            .db
            .create_memory_entry(crate::memory::CreateMemoryRequest {
                scope: MemoryScope::user(),
                kind: "fact".into(),
                content: content.into(),
                rationale: None,
                origin: "explicit".into(),
                evidence: "verified".into(),
                status: "active".into(),
                source_session_id: None,
                source_message_ids: Vec::new(),
                override_tombstone: true,
            })?;
        assert!(matches!(
            outcome,
            crate::memory::CreateMemoryOutcome::Created(_)
        ));
    }
    sync_now(device_a.clone(), tx.clone()).await?;
    let received = sync_now(device_b.clone(), tx.clone()).await?;
    assert!(conflict_ids(&received).is_empty(), "{received}");
    sync_now(device_a.clone(), tx.clone()).await?;
    for device in [&device_a, &device_b] {
        assert_eq!(user_notes(device).await?, vec![content.to_string()]);
    }
    fixture.task.abort();
    Ok(())
}
