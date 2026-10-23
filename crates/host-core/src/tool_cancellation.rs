//! Typed cancellation registry for tool calls that do not own a process.
//!
//! `Bash` and `GenerateImages` keep the legacy process registry in
//! `AppState::active_bash_cancellations` because their abort path must
//! terminate a process tree. Every other `tools.execute` call — including
//! permission waits, queued admission, and local read-only work — registers
//! here instead, keyed by session, tool call id, and tool name so an early
//! abort for one tool cannot cancel a different tool that reuses the call id
//! (ADR tool-stop-side-effect-boundaries).

use std::collections::HashMap;
use std::time::{Duration, Instant};

use tokio::sync::watch;

const TOOL_ABORT_TOMBSTONE_TTL: Duration = Duration::from_secs(60);
const MAX_TOOL_ABORT_TOMBSTONES: usize = 1024;

/// (session_id, tool_call_id, tool_name)
type ToolKey = (String, String, String);

#[derive(Default)]
pub(crate) struct ToolCancellationRegistry {
    active: HashMap<ToolKey, watch::Sender<bool>>,
    /// Aborts that raced ahead of `tools.execute`. A short-lived tombstone
    /// makes the later request start already cancelled instead of executing
    /// after Stop was acknowledged.
    pending_aborts: HashMap<ToolKey, Instant>,
}

impl ToolCancellationRegistry {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    fn prune_tombstones(&mut self) {
        self.pending_aborts
            .retain(|_, requested_at| requested_at.elapsed() < TOOL_ABORT_TOMBSTONE_TTL);
        while self.pending_aborts.len() > MAX_TOOL_ABORT_TOMBSTONES {
            let Some(oldest) = self
                .pending_aborts
                .iter()
                .min_by_key(|(_, requested_at)| **requested_at)
                .map(|(key, _)| key.clone())
            else {
                break;
            };
            self.pending_aborts.remove(&oldest);
        }
    }

    pub(crate) fn register(
        &mut self,
        shutting_down: bool,
        session_id: &str,
        tool_call_id: &str,
        tool_name: &str,
    ) -> Result<watch::Receiver<bool>, String> {
        if shutting_down {
            return Err("HOST_SHUTTING_DOWN".into());
        }
        self.prune_tombstones();
        let key = (
            session_id.to_string(),
            tool_call_id.to_string(),
            tool_name.to_string(),
        );
        if self.active.contains_key(&key) {
            return Err("TOOL_BUSY".into());
        }
        let initially_aborted = self.pending_aborts.remove(&key).is_some();
        let (sender, receiver) = watch::channel(initially_aborted);
        self.active.insert(key, sender);
        Ok(receiver)
    }

    /// Signal an in-flight call, or record a tombstone when the abort arrived
    /// before `tools.execute`. Returns `(found_active, queued_tombstone)`.
    pub(crate) fn abort_or_queue(
        &mut self,
        session_id: &str,
        tool_call_id: &str,
        tool_name: &str,
    ) -> (bool, bool) {
        self.prune_tombstones();
        let key = (
            session_id.to_string(),
            tool_call_id.to_string(),
            tool_name.to_string(),
        );
        let active = self
            .active
            .get(&key)
            .is_some_and(|sender| sender.send(true).is_ok());
        if active {
            (true, false)
        } else {
            self.pending_aborts.insert(key, Instant::now());
            (false, true)
        }
    }

    /// Abort whatever tool currently holds the call id in this session,
    /// regardless of its name. This is the legacy `tools.abort` path for
    /// callers that do not send `toolName`.
    pub(crate) fn abort_active(&mut self, session_id: &str, tool_call_id: &str) -> bool {
        self.active
            .iter()
            .find(|((active_session, active_call, _), _)| {
                active_session == session_id && active_call == tool_call_id
            })
            .is_some_and(|(_, sender)| sender.send(true).is_ok())
    }

    /// Remove the execution owner's registration in every outcome, including
    /// the tombstone so a retry with the same identity starts clean.
    pub(crate) fn clear(&mut self, session_id: &str, tool_call_id: &str, tool_name: &str) {
        let key = (
            session_id.to_string(),
            tool_call_id.to_string(),
            tool_name.to_string(),
        );
        self.active.remove(&key);
        self.pending_aborts.remove(&key);
    }

    /// Host shutdown: release every waiter and drop the tombstones.
    pub(crate) fn cancel_all(&mut self) {
        for sender in self.active.values() {
            let _ = sender.send(true);
        }
        self.active.clear();
        self.pending_aborts.clear();
    }

    #[cfg(test)]
    pub(crate) fn contains_active(
        &self,
        session_id: &str,
        tool_call_id: &str,
        tool_name: &str,
    ) -> bool {
        self.active.contains_key(&(
            session_id.to_string(),
            tool_call_id.to_string(),
            tool_name.to_string(),
        ))
    }

    #[cfg(test)]
    pub(crate) fn is_empty(&self) -> bool {
        self.active.is_empty() && self.pending_aborts.is_empty()
    }
}

/// Await the cancellation signal shared by the process registry and this typed
/// registry. A `None` receiver never resolves: the caller has no cancellation
/// and the future must stay neutral inside `tokio::select!`.
pub(crate) async fn wait_for_tool_cancellation(
    receiver: &mut Option<watch::Receiver<bool>>,
) -> bool {
    let Some(receiver) = receiver.as_mut() else {
        return std::future::pending::<bool>().await;
    };
    if *receiver.borrow() {
        return true;
    }
    loop {
        if receiver.changed().await.is_err() {
            return std::future::pending::<bool>().await;
        }
        if *receiver.borrow() {
            return true;
        }
    }
}

/// Poll the same signal without awaiting; a settled check for the moments
/// between an await and a state transition.
pub(crate) fn tool_cancellation_requested(receiver: &Option<watch::Receiver<bool>>) -> bool {
    receiver.as_ref().is_some_and(|receiver| *receiver.borrow())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tombstones_are_scoped_to_the_tool_name() {
        let mut registry = ToolCancellationRegistry::new();
        let mut write = registry
            .register(false, "session-1", "same-id", "Write")
            .unwrap();

        // An abort naming a different tool must not cancel the active Write.
        assert_eq!(
            registry.abort_or_queue("session-1", "same-id", "Edit"),
            (false, true)
        );
        assert!(!*write.borrow_and_update());
        registry.clear("session-1", "same-id", "Write");

        let edit = registry
            .register(false, "session-1", "same-id", "Edit")
            .unwrap();
        assert!(
            *edit.borrow(),
            "the tombstoned Edit starts already cancelled"
        );
        assert!(registry.contains_active("session-1", "same-id", "Edit"));
        registry.clear("session-1", "same-id", "Edit");
        assert!(
            registry.is_empty(),
            "clearing the registered tool empties the registry"
        );
    }

    #[test]
    fn abort_active_matches_any_tool_name_for_legacy_aborts() {
        let mut registry = ToolCancellationRegistry::new();
        let mut session_send = registry
            .register(false, "session-1", "call-1", "SessionSend")
            .unwrap();

        assert!(registry.abort_active("session-1", "call-1"));
        assert!(*session_send.borrow_and_update());
        assert!(!registry.abort_active("session-1", "other-call"));
        assert!(!registry.abort_active("session-2", "call-1"));
    }

    #[test]
    fn cancel_all_releases_waiters_and_drops_tombstones() {
        let mut registry = ToolCancellationRegistry::new();
        let mut receiver = registry
            .register(false, "session-1", "call-1", "Grep")
            .unwrap();
        registry.abort_or_queue("session-1", "call-2", "Read");

        registry.cancel_all();

        assert!(registry.is_empty());
        assert!(*receiver.borrow_and_update());
        assert!(registry
            .register(false, "session-1", "call-2", "Read")
            .is_ok());
    }

    #[test]
    fn duplicate_registration_is_rejected_but_shutdown_is_distinct() {
        let mut registry = ToolCancellationRegistry::new();
        registry
            .register(false, "session-1", "call-1", "Write")
            .unwrap();
        assert!(matches!(
            registry.register(false, "session-1", "call-1", "Write"),
            Err(ref error) if error == "TOOL_BUSY"
        ));
        assert!(matches!(
            registry.register(true, "session-1", "call-2", "Write"),
            Err(ref error) if error == "HOST_SHUTTING_DOWN"
        ));
    }
}
