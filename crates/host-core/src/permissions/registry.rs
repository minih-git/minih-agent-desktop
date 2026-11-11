//! Registered tool risk and the contract-mode allowlist.
//!
//! Both are flat classification tables: which risk a tool name carries by
//! default, and which names a Plan or Goal turn may reach. They live apart from
//! the permission manager that consumes them so the manager keeps owning
//! pending requests and decisions rather than tool catalogs.

use super::Risk;

impl super::PermissionManager {
    pub fn tool_risk_with_declared(tool_name: &str, declared: Option<&str>) -> Risk {
        match tool_name {
            "Read" | "Glob" | "Grep" | "ScheduledTaskList" | "TodoWrite" | "SessionList"
            | "SessionResult" | "SessionHistorySearch" | "MemorySearch"
            // Reads change nothing; Stop ends a process and keeps Medium.
            | "BackgroundTaskList" | "BackgroundTaskOutput" => Risk::Low,
            // Sending starts another session's Agent and spends its quota;
            // creating one brings a durable session into the user's list.
            "Write" | "Edit" | "Bash" | "GenerateImages" | "SessionSend" | "SessionCreate" => {
                Risk::High
            }
            name if name.starts_with("plugin_") => match declared {
                Some("low") => Risk::Low,
                Some("high") => Risk::High,
                Some("medium") => Risk::Medium,
                // A missing or malformed manifest declaration is not a
                // low-risk grant. Medium preserves the normal approval path.
                _ => Risk::Medium,
            },
            // MCP servers are user-configured but their tools are opaque; a
            // self-declared annotation comes from the server, so it is not
            // trusted and never lowers the approval path.
            name if name.starts_with("mcp_") => Risk::Medium,
            _ => Risk::Medium,
        }
    }

    /// The shared contract-mode allowlist. Plan and Goal expose the same
    /// read/inspect core plus Bash; only their submit tool differs, and that one
    /// is a sidecar-side tool that never reaches this gate. `new_context` and
    /// `ContextUsage` are sidecar-side too, listed so both sides agree.
    pub fn plan_mode_allows(tool_name: &str) -> bool {
        matches!(
            tool_name,
            "Read"
                | "Glob"
                | "Grep"
                | "Bash"
                | "BrowserPreview"
                | "new_context"
                | "ContextUsage"
                // Recall reads host-owned history and learned memory and changes
                // nothing, so a read-only contract negotiation may use it.
                | "SessionHistorySearch"
                | "MemorySearch"
                // A Plan or Goal turn may already be waiting on a dev server
                // this session started, and reading its output changes nothing.
                // Stop stays out: a task started before the mode is not ended
                // by a contract-mode action.
                | "BackgroundTaskList"
                | "BackgroundTaskOutput"
        )
    }
}
