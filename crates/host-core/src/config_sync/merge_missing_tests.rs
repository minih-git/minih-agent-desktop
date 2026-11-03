//! Three-way merge when one side of the acknowledged base lost an entity.
//!
//! `snapshot_with_tombstones` normally turns a local disappearance into an
//! explicit tombstone, but a remote revision can omit an entity the base still
//! holds, and a legacy baseline can omit it locally. These merges used to abort
//! with "remote merge state missing" / "local merge state missing"; they must
//! surface as delete-versus-edit conflicts or canonical tombstones instead of
//! silently picking a destructive side.
use super::*;
use crate::config_sync::domains::{refresh_digest, PortableEntity, RevisionManifest};

fn entity(id: &str, value: &str) -> PortableEntity {
    PortableEntity {
        domain: "test".into(),
        entity_id: id.into(),
        label: id.into(),
        deleted: false,
        requires_approval: false,
        secret_bearing: false,
        mapping_required: false,
        digest: value.into(),
        payload: serde_json::json!({ "value": value }),
        resource_ids: vec![],
    }
}

fn manifest(values: Vec<PortableEntity>) -> RevisionManifest {
    RevisionManifest {
        format: "test".into(),
        version: 1,
        revision_id: "r".into(),
        parents: vec![],
        created_at: "2026-01-01T00:00:00Z".into(),
        entities: values,
        resource_ids: vec![],
    }
}

/// A live entity with a user-owned resource reference and a real digest.
fn synced_entity(id: &str, value: &str, resource: &str) -> PortableEntity {
    let mut value_entity = entity(id, value);
    value_entity.resource_ids = vec![resource.into()];
    refresh_digest(&mut value_entity);
    value_entity
}

/// The canonical deletion tombstone for an acknowledged entity: the deletion
/// flag set, no live resource references, and a digest covering that state.
fn canonical_tombstone(base: &PortableEntity) -> PortableEntity {
    let mut tombstone = base.clone();
    tombstone.deleted = true;
    tombstone.resource_ids.clear();
    refresh_digest(&mut tombstone);
    tombstone
}

fn empty_manifest() -> RevisionManifest {
    manifest(vec![])
}

fn candidate<'a>(merged: &'a MergeResult, entity_id: &str) -> &'a PortableEntity {
    merged
        .entities
        .iter()
        .find(|candidate| candidate.entity_id == entity_id)
        .unwrap_or_else(|| panic!("conflict candidate {entity_id} missing"))
}

#[test]
fn edited_local_with_missing_remote_is_a_delete_versus_edit_conflict() {
    let base_entity = synced_entity("a", "0", "resource:shared");
    let edited = synced_entity("a", "local-edit", "resource:local");
    let merged = three_way(
        Some(&manifest(vec![base_entity.clone()])),
        &manifest(vec![edited.clone()]),
        Some(&empty_manifest()),
    )
    .expect("a missing remote entity must not abort the merge");

    assert_eq!(merged.conflicts.len(), 1);
    assert_eq!(merged.conflicts[0].entity_id, "a");
    assert_eq!(merged.conflicts[0].reason, "delete-versus-edit");

    let edit = candidate(&merged, "a:local");
    assert!(!edit.deleted);
    assert_eq!(edit.digest, edited.digest);
    assert_eq!(edit.resource_ids, edited.resource_ids);

    let deletion = candidate(&merged, "a:remote");
    assert!(deletion.deleted);
    assert!(deletion.resource_ids.is_empty());
    assert_eq!(deletion.digest, canonical_tombstone(&base_entity).digest);
}

#[test]
fn edited_remote_with_missing_local_is_the_mirrored_conflict() {
    let base_entity = synced_entity("a", "0", "resource:shared");
    let edited = synced_entity("a", "remote-edit", "resource:remote");
    let merged = three_way(
        Some(&manifest(vec![base_entity.clone()])),
        &empty_manifest(),
        Some(&manifest(vec![edited.clone()])),
    )
    .expect("a missing local entity must not abort the merge");

    assert_eq!(merged.conflicts.len(), 1);
    assert_eq!(merged.conflicts[0].entity_id, "a");
    assert_eq!(merged.conflicts[0].reason, "delete-versus-edit");

    let edit = candidate(&merged, "a:remote");
    assert!(!edit.deleted);
    assert_eq!(edit.digest, edited.digest);
    assert_eq!(edit.resource_ids, edited.resource_ids);

    let deletion = candidate(&merged, "a:local");
    assert!(deletion.deleted);
    assert!(deletion.resource_ids.is_empty());
    assert_eq!(deletion.digest, canonical_tombstone(&base_entity).digest);
}

#[test]
fn delete_versus_edit_candidates_are_symmetric_across_sides() {
    let base_entity = synced_entity("a", "0", "resource:shared");
    let base = manifest(vec![base_entity.clone()]);
    let local_edit = synced_entity("a", "local-edit", "resource:local");
    let remote_edit = synced_entity("a", "remote-edit", "resource:remote");

    let local_missing = three_way(
        Some(&base),
        &empty_manifest(),
        Some(&manifest(vec![remote_edit.clone()])),
    )
    .expect("missing local");
    let remote_missing = three_way(
        Some(&base),
        &manifest(vec![local_edit.clone()]),
        Some(&empty_manifest()),
    )
    .expect("missing remote");

    assert_eq!(local_missing.conflicts.len(), 1);
    assert_eq!(remote_missing.conflicts.len(), 1);
    assert_eq!(
        local_missing.conflicts[0].reason,
        remote_missing.conflicts[0].reason
    );
    assert_eq!(
        local_missing.conflicts[0].entity_id,
        remote_missing.conflicts[0].entity_id
    );
    // The deletion tombstone is the same digest on both sides, so the recorded
    // pair only differs by which side still carries the edit.
    assert_eq!(
        local_missing.conflicts[0].local_digest,
        remote_missing.conflicts[0].remote_digest
    );
    assert_eq!(local_missing.conflicts[0].remote_digest, remote_edit.digest);
    assert_eq!(remote_missing.conflicts[0].local_digest, local_edit.digest);

    let canonical = canonical_tombstone(&base_entity).digest;
    for (merged, edited) in [
        (&local_missing, &remote_edit),
        (&remote_missing, &local_edit),
    ] {
        let live = merged
            .entities
            .iter()
            .find(|candidate| !candidate.deleted)
            .expect("edited candidate retained");
        assert_eq!(live.digest, edited.digest);
        assert_eq!(live.resource_ids, edited.resource_ids);
        let deleted = merged
            .entities
            .iter()
            .find(|candidate| candidate.deleted)
            .expect("deletion candidate retained");
        assert!(deleted.resource_ids.is_empty());
        assert_eq!(deleted.digest, canonical);
    }
}

#[test]
fn unchanged_and_missing_sides_share_one_canonical_deletion_tombstone() {
    let base_entity = synced_entity("a", "0", "resource:shared");
    let base = manifest(vec![base_entity.clone()]);
    let expected = canonical_tombstone(&base_entity);
    assert_ne!(expected.digest, base_entity.digest);
    assert!(expected.resource_ids.is_empty());

    let unchanged = manifest(vec![base_entity]);
    let cases = [
        (
            "unchanged local, missing remote",
            three_way(Some(&base), &unchanged, Some(&empty_manifest())),
        ),
        (
            "missing local, unchanged remote",
            three_way(Some(&base), &empty_manifest(), Some(&unchanged)),
        ),
        (
            "both sides missing",
            three_way(Some(&base), &empty_manifest(), Some(&empty_manifest())),
        ),
    ];
    for (name, merged) in cases {
        let merged = merged.unwrap_or_else(|error| panic!("{name}: {error}"));
        assert!(merged.conflicts.is_empty(), "{name}");
        assert_eq!(merged.entities, vec![expected.clone()], "{name}");
    }
}

#[test]
fn an_explicit_tombstone_with_a_missing_remote_stays_a_deletion() {
    let base_entity = synced_entity("a", "0", "resource:shared");
    let tombstone = canonical_tombstone(&base_entity);
    let merged = three_way(
        Some(&manifest(vec![base_entity])),
        &manifest(vec![tombstone.clone()]),
        Some(&empty_manifest()),
    )
    .expect("an explicit tombstone must not abort the merge");

    assert!(merged.conflicts.is_empty());
    assert_eq!(merged.entities, vec![tombstone]);
}

#[test]
fn delete_versus_edit_merge_is_stable_when_repeated() {
    let base = manifest(vec![synced_entity("a", "0", "resource:shared")]);
    let local = manifest(vec![synced_entity("a", "edited", "resource:local")]);
    let first = three_way(Some(&base), &local, Some(&empty_manifest())).expect("first merge");
    assert_eq!(first.entities.len(), 2);
    assert_eq!(first.conflicts.len(), 1);

    let acknowledged = manifest(first.entities.clone());
    let repeat =
        three_way(Some(&acknowledged), &acknowledged, Some(&acknowledged)).expect("repeated merge");
    assert_eq!(repeat.entities, acknowledged.entities);
    assert!(repeat.conflicts.is_empty());

    let again = three_way(Some(&base), &local, Some(&empty_manifest())).expect("same input merge");
    assert_eq!(again.entities, first.entities);
    assert_eq!(again.conflicts.len(), 1);
}
