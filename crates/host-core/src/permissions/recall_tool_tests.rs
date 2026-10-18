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
