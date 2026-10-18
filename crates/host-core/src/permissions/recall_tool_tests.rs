//! Risk and mode policy for the two recall reads.
//!
//! They change nothing, so they are free reads in every mode — including the
//! read-only contract modes, where the session-start index points at
//! `MemorySearch`. The argument that widens one of them carries its own risk;
//! see `rpc/memory_tools.rs`.

use super::*;

#[test]
fn recall_reads_are_low_risk_and_allowed_in_every_mode() {
    let manager = PermissionManager::default();
    let grants = HashMap::new();
    for tool in ["SessionHistorySearch", "MemorySearch"] {
        assert!(
            matches!(
                PermissionManager::tool_risk_with_declared(tool, None),
                Risk::Low
            ),
            "{tool} must stay a free read"
        );
        for mode in ["agent", "plan", "goal"] {
            assert_eq!(
                manager.evaluate_auto_with_permission_mode("s", tool, mode, "ask", &grants),
                Some(PermissionDecision::AllowOnce),
                "{tool} must run without a card in {mode}"
            );
        }
    }
}

/// The explicit write is not a free read: it is medium risk, it takes the normal
/// approval path in Agent, and the read-only contract modes deny it outright.
#[test]
fn remembering_is_medium_risk_and_never_free() {
    let manager = PermissionManager::default();
    let grants = HashMap::new();
    assert!(
        matches!(
            PermissionManager::tool_risk_with_declared("MemoryRemember", None),
            Risk::Medium
        ),
        "a write must not be classified as a free read"
    );
    assert!(
        !PermissionManager::plan_mode_allows("MemoryRemember"),
        "a contract mode must not admit a write"
    );
    for permission_mode in ["ask", "accept-edits"] {
        assert_eq!(
            manager.evaluate_auto_with_permission_mode(
                "s",
                "MemoryRemember",
                "agent",
                permission_mode,
                &grants
            ),
            None,
            "an Agent turn needs the card in {permission_mode}"
        );
    }
    assert_eq!(
        manager.evaluate_auto_with_permission_mode("s", "MemoryRemember", "agent", "auto", &grants),
        Some(PermissionDecision::AllowOnce),
        "auto is the resolved policy for a medium-risk call"
    );
    for mode in ["plan", "goal"] {
        for permission_mode in ["ask", "auto"] {
            assert_eq!(
                manager.evaluate_auto_with_permission_mode(
                    "s",
                    "MemoryRemember",
                    mode,
                    permission_mode,
                    &grants
                ),
                Some(PermissionDecision::Deny),
                "{mode}/{permission_mode} must deny the write"
            );
        }
    }
}
