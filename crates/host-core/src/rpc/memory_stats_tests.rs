//! The device-local counter RPC (`memory.stats`).
//!
//! Split out of `memory_rpc_tests.rs` so the shared contract file stays inside
//! the architecture budget; the harness comes from the parent module.

use super::*;

/// The counters the memory manager shows: the launch path records the index it
/// captured, and a refused write is counted where the tombstone stopped it.
#[tokio::test]
async fn the_manager_counters_follow_the_launch_and_the_write_path() {
    let (dir, state) = open().await;
    let project_dir = dir.path().join("app");
    std::fs::create_dir_all(&project_dir).unwrap();
    let project = canonical_project_path(project_dir.to_str().unwrap()).unwrap();

    let fresh = call(&state, "memory.stats", json!({})).await.unwrap();
    assert_eq!(fresh["stats"]["index"]["entries"], json!(0));
    assert_eq!(fresh["stats"]["index"]["capturedAt"], json!(null));
    assert_eq!(fresh["stats"]["suggestions"]["accepted"], json!(0));
    assert_eq!(fresh["stats"]["tombstones"]["fromExtraction"], json!(0));
    assert_eq!(fresh["stats"]["extraction"]["tokens"], json!(0));

    let created = call(
        &state,
        "memory.create",
        json!({
            "path": project,
            "kind": "fact",
            "content": "The host core is Rust.",
            "origin": "user_ui"
        }),
    )
    .await
    .unwrap();
    let id = created["entry"]["id"].as_str().unwrap().to_string();
    call(&state, "memory.index", json!({ "path": project }))
        .await
        .unwrap();
    let launched = call(&state, "memory.stats", json!({})).await.unwrap();
    assert_eq!(launched["stats"]["index"]["entries"], json!(1));
    assert!(launched["stats"]["index"]["bytes"].as_i64().unwrap() > 0);
    assert!(launched["stats"]["index"]["capturedAt"].as_i64().unwrap() > 0);

    // Forget it, then try to write it again: the write is refused by the
    // tombstone and counted as the user's own path.
    call(&state, "memory.delete", json!({ "id": id }))
        .await
        .unwrap();
    let refused = call(
        &state,
        "memory.create",
        json!({
            "path": project,
            "kind": "fact",
            "content": "The host core is Rust.",
            "origin": "user_ui"
        }),
    )
    .await
    .unwrap();
    assert_eq!(refused["rejected"]["code"], json!("MEMORY_TOMBSTONED"));
    let blocked = call(&state, "memory.stats", json!({})).await.unwrap();
    assert_eq!(blocked["stats"]["tombstones"]["fromCreate"], json!(1));
    assert_eq!(blocked["stats"]["tombstones"]["fromExtraction"], json!(0));
}
