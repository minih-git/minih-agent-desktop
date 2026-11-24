//! A skill folder larger than one portable package. A real skill (`ppt-master`)
//! carries twelve thousand icon and sound files, so every package bound refused
//! it — which failed the capture, and with it the sync of every domain
//! (ADR 0303 amendment 2). These tests pin the behaviour that replaced that
//! failure: nothing of such a skill syncs until the user decides, `document`
//! syncs its `SKILL.md` alone, `skip` leaves it out of the synced set, and apply
//! never touches a package it cannot reconcile.
use super::connection::config_from_input;
use super::tests::run_in_isolated_process;
use super::{apply_bundle, PendingBundle};
use crate::config_sync::domains::{
    self, CategorySelection, LocalSnapshot, PortableEntity, RevisionManifest, DOMAIN_SKILLS,
};
use crate::config_sync::{create_vault, object_id, VaultKey};
use crate::state::AppState;
use crate::user_skills::{UserSkillInput, MAX_SKILL_PACKAGE_FILES};
use anyhow::Result;
use serde_json::json;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::Mutex;
use uuid::Uuid;

/// A global, directory-shaped skill with `files` resources beside its document.
fn oversized_skill(
    state: &mut AppState,
    id: &str,
    body: &str,
    files: usize,
) -> Result<(crate::user_skills::UserSkillRecord, PathBuf)> {
    let record = state.user_skills.create(UserSkillInput {
        id: Some(id.into()),
        name: Some("Oversized".into()),
        level: Some("global".into()),
        body: Some(body.into()),
        enabled: Some(true),
        shape: Some("dir".into()),
        ..UserSkillInput::default()
    })?;
    let root = Path::new(&record.path)
        .parent()
        .expect("package root")
        .to_path_buf();
    fs::create_dir_all(root.join("assets"))?;
    for index in 0..files {
        fs::write(root.join(format!("assets/{index}.txt")), b"x")?;
    }
    Ok((record, root))
}

/// Capture the way a sync does: with the choices the user has already recorded.
async fn capture_snapshot(state: &Arc<Mutex<AppState>>, key: &VaultKey) -> Result<LocalSnapshot> {
    let mut st = state.lock().await;
    let config = super::load_config(&st)?.expect("configured device");
    domains::capture(
        &mut st,
        key,
        &CategorySelection::all_selected(),
        false,
        &config.plugin_intents,
        &config.oversized_skills,
    )
}

fn skill_entities(snapshot: &LocalSnapshot) -> Vec<&PortableEntity> {
    snapshot
        .manifest
        .entities
        .iter()
        .filter(|entity| entity.domain == DOMAIN_SKILLS)
        .collect()
}

#[tokio::test]
async fn an_oversized_skill_syncs_only_after_the_user_decides() -> Result<()> {
    const NAME: &str =
        "config_sync::engine::skill_package_tests::an_oversized_skill_syncs_only_after_the_user_decides";
    if run_in_isolated_process(NAME)? {
        return Ok(());
    }
    let data_dir = tempfile::tempdir()?;
    let state = Arc::new(Mutex::new(AppState::open(data_dir.path())?));
    let (header, key) = create_vault("portable-backup-password", &Uuid::new_v4().to_string())?;
    let config = config_from_input(
        None,
        &json!({ "deviceLabel": "device-a" }),
        header,
        "account",
    )?;
    {
        let st = state.lock().await;
        super::save_config(&st, &config)?;
    }
    let (record, root) = {
        let mut st = state.lock().await;
        oversized_skill(&mut st, "oversized", "Use it.", MAX_SKILL_PACKAGE_FILES + 1)?
    };

    // Undecided: the folder is reported, and nothing of it is captured.
    let undecided = capture_snapshot(&state, &key).await?;
    assert!(
        skill_entities(&undecided).is_empty(),
        "an undecided skill stays out of the synced set"
    );
    assert_eq!(
        undecided.skipped_packages,
        vec![domains::SkippedSkillPackage {
            id: "oversized".into(),
            name: "Oversized".into(),
            reason: "files".into(),
            actual: (MAX_SKILL_PACKAGE_FILES + 1) as u64,
            limit: MAX_SKILL_PACKAGE_FILES as u64,
            choice: None,
        }]
    );

    // "Sync the document": the skill travels as its document alone.
    super::set_skill_choice(
        state.clone(),
        json!({ "skillId": "oversized", "choice": "document" }),
    )
    .await?;
    let document = capture_snapshot(&state, &key).await?;
    let entities = skill_entities(&document);
    let entity = entities.first().expect("the chosen document is captured");
    assert!(
        entity.payload.get("packageFiles").is_none(),
        "resources that cannot travel stay on this device"
    );
    assert_eq!(entity.payload["packageSkipped"]["reason"], "files");
    assert_eq!(
        entity.resource_ids.len(),
        1,
        "only the document resource travels"
    );
    assert!(document.resources.contains_key(&entity.resource_ids[0]));
    assert_eq!(
        document.skipped_packages[0].choice.as_deref(),
        Some("document")
    );

    // "Do not sync it": nothing of it is captured, and nothing is deleted.
    super::set_skill_choice(
        state.clone(),
        json!({ "skillId": "oversized", "choice": "skip" }),
    )
    .await?;
    let skipped = capture_snapshot(&state, &key).await?;
    assert!(skill_entities(&skipped).is_empty());
    assert_eq!(skipped.skipped_packages[0].choice.as_deref(), Some("skip"));
    assert!(root.join("assets/0.txt").exists());
    assert!(record.path.ends_with("SKILL.md"));

    // A decision the host cannot honour is refused instead of stored.
    assert!(super::set_skill_choice(
        state.clone(),
        json!({ "skillId": "oversized", "choice": "everything" })
    )
    .await
    .is_err());
    assert!(super::set_skill_choice(
        state.clone(),
        json!({ "skillId": "missing", "choice": "document" })
    )
    .await
    .is_err());
    Ok(())
}

/// The receiving device already holds the resources; a revision whose skill
/// carries the skip marker updates the document and leaves them alone.
#[tokio::test]
async fn applying_a_skipped_package_keeps_the_local_resources() -> Result<()> {
    const NAME: &str =
        "config_sync::engine::skill_package_tests::applying_a_skipped_package_keeps_the_local_resources";
    if run_in_isolated_process(NAME)? {
        return Ok(());
    }
    let data_dir = tempfile::tempdir()?;
    let state = Arc::new(Mutex::new(AppState::open(data_dir.path())?));
    let (header, key) = create_vault("portable-backup-password", &Uuid::new_v4().to_string())?;
    let mut config = config_from_input(
        None,
        &json!({ "deviceLabel": "device-a" }),
        header,
        "account",
    )?;
    {
        let st = state.lock().await;
        super::save_config(&st, &config)?;
    }
    let (record, root) = {
        let mut st = state.lock().await;
        oversized_skill(&mut st, "oversized", "Old body.", 2)?
    };
    let local_before = {
        let mut st = state.lock().await;
        let choices = BTreeMap::from([("oversized".to_string(), "document".to_string())]);
        domains::capture(
            &mut st,
            &key,
            &CategorySelection::all_selected(),
            false,
            &BTreeMap::new(),
            &choices,
        )?
        .manifest
    };
    let before = local_before
        .entities
        .iter()
        .find(|entity| entity.domain == DOMAIN_SKILLS)
        .cloned()
        .expect("the local skill is captured");

    let body = "New body.";
    let body_id = object_id(&key, body.as_bytes());
    let mut payload = before.payload.clone();
    let object = payload.as_object_mut().expect("skill payload");
    object.insert("bodyResourceId".into(), json!(body_id));
    object.remove("packageFiles");
    object.insert(
        "packageSkipped".into(),
        json!({ "reason": "files", "actual": 257, "limit": MAX_SKILL_PACKAGE_FILES }),
    );
    let mut entity = PortableEntity {
        payload,
        resource_ids: vec![body_id.clone()],
        ..before.clone()
    };
    domains::refresh_digest(&mut entity);
    let mut resources = BTreeMap::new();
    resources.insert(body_id, body.as_bytes().to_vec());
    let bundle = PendingBundle {
        manifest: RevisionManifest {
            format: "minih-agent-desktop-config-revision".into(),
            version: 1,
            revision_id: "remote-revision".into(),
            parents: Vec::new(),
            created_at: "2026-01-01T00:00:00Z".into(),
            entities: vec![entity],
            resource_ids: resources.keys().cloned().collect(),
        },
        local_before: Some(local_before.clone()),
        resources,
        approvals: Vec::new(),
        conflicts: Vec::new(),
        journal_state: "staged".into(),
        remote_revision_id: "remote-revision".into(),
    };

    apply_bundle(&state, &mut config, &key, None, &local_before, &bundle).await?;

    let document = fs::read_to_string(&record.path)?;
    assert!(
        document.contains(body),
        "the document is what a document-only decision syncs: {document}"
    );
    assert_eq!(fs::read(root.join("assets/0.txt"))?, b"x");
    assert_eq!(fs::read(root.join("assets/1.txt"))?, b"x");
    Ok(())
}
