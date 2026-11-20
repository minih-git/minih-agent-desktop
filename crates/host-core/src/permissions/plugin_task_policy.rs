//! Runtime safety policy for a task a plugin created (`tasks.plugin_id`).
//!
//! A plugin-started task is an ordinary task session with a narrower trust
//! story: the plugin wrote the brief, so nothing inside the task may approve
//! itself. The policy is a set of narrowing rules layered on the existing
//! permission manager, never a second gate of its own:
//!
//! - a `plugin_*` tool always takes the approval path, whatever risk its
//!   manifest declares and however often it ran before;
//! - the host's own read-only tools keep their registered low risk, so Ask,
//!   Accept-edits and Auto treat `Read`, `Grep`, `Glob` and the other free
//!   reads exactly as they do everywhere else;
//! - a session grant is ignored: a plugin task asks every time, because the
//!   person approved one call of one task, not a standing licence for a plugin
//!   that keeps rewriting its own brief;
//! - `Write`/`Edit` inside the workspace and scratch roots are answered without
//!   a card only in an `accept-edits` task; a path outside those roots always
//!   prompts, and a narrower task never lets the file tools run free;
//! - a subagent's own permission scope (ADR 0089) and every derived session
//!   (a worker spawned from the task, ADR 0239) may narrow the task's mode but
//!   never widen it: `accept-edits` in an `ask` task resolves as `ask`, and a
//!   worker whose own row says `auto` resolves at its task's ceiling.
//!
//! Everything here is scoped to sessions that belong to such a task, and to
//! their descendants along the session parent chain
//! (`session_collaboration_links.created_by_session_id`). For every other
//! session [`PluginTaskPolicy::for_session`] returns `None` and both gate sites
//! in `rpc` fall back to the unchanged permission manager.

use std::collections::HashSet;

use anyhow::Result;
use rusqlite::OptionalExtension;

use super::PermissionDecision;
use crate::db::Database;

/// Prefix every plugin-provided tool name carries.
pub const PLUGIN_TOOL_PREFIX: &str = "plugin_";

/// The one mode in which a plugin task's own file edits need no card.
const FILE_EDIT_MODE: &str = "accept-edits";

/// Capability rank of a concrete permission mode; higher is wider.
///
/// Mirrors `session_collaboration::permissions::rank`: `inherit` never reaches
/// it (the gate resolves it against the global default first), and any
/// unrecognized value ranks as the narrowest so a malformed mode can only
/// reduce authority.
pub fn rank(mode: &str) -> u8 {
    match mode {
        "auto" => 2,
        "accept-edits" => 1,
        _ => 0,
    }
}

/// The narrower of two concrete permission modes.
///
/// `min`, never "replace": this is what keeps a subagent's scope, or a derived
/// session's own row, from becoming a way around the task's own mode.
pub fn narrower(left: &str, right: &str) -> String {
    if rank(left) <= rank(right) {
        left.to_string()
    } else {
        right.to_string()
    }
}

/// A concrete mode, never `inherit`: anything unrecognized fails closed to the
/// narrowest one.
fn concrete(mode: &str) -> &str {
    match mode {
        "ask" | "accept-edits" | "auto" => mode,
        _ => "ask",
    }
}

/// The global default, collapsed the same way the gate collapses `inherit`.
fn default_mode(db: &Database) -> String {
    db.get_setting("app")
        .ok()
        .flatten()
        .and_then(|settings| {
            settings
                .get("defaultPermissionMode")
                .and_then(|value| value.as_str())
                .map(str::to_owned)
        })
        .filter(|mode| crate::sessions::is_valid_permission_mode(mode) && mode != "inherit")
        .unwrap_or_else(|| "ask".into())
}

/// A session's stored mode, resolved: `inherit` against the global default,
/// anything malformed to the narrowest mode.
fn resolved_mode(db: &Database, session_id: &str) -> Result<String> {
    let stored = crate::sessions::session_permission_mode(db, session_id)?;
    Ok(match stored.as_deref().filter(|mode| *mode != "inherit") {
        Some(mode) => concrete(mode).to_string(),
        None => concrete(&default_mode(db)).to_string(),
    })
}

/// The plugin that created the task `session_id` runs, when there is one.
///
/// An archived task keeps its policy: the session outlives the archive, and a
/// turn that is still writing must not be widened by it.
fn plugin_task_of(db: &Database, session_id: &str) -> Result<Option<String>> {
    let plugin_id: Option<Option<String>> = db
        .conn()
        .prepare_cached(
            "SELECT plugin_id FROM tasks WHERE session_id = ?1 AND plugin_id IS NOT NULL",
        )?
        .query_row(rusqlite::params![session_id], |row| row.get(0))
        .optional()?;
    Ok(plugin_id
        .flatten()
        .filter(|plugin_id| !plugin_id.trim().is_empty()))
}

/// The session that spawned `session_id`, for a derived one.
fn parent_of(db: &Database, session_id: &str) -> Result<Option<String>> {
    Ok(db
        .conn()
        .prepare_cached(
            "SELECT created_by_session_id FROM session_collaboration_links WHERE session_id = ?1",
        )?
        .query_row(rusqlite::params![session_id], |row| row.get::<_, String>(0))
        .optional()?)
}

/// One tool call as the gate sees it, before the policy narrows the decision.
pub struct PluginTaskCall<'a> {
    pub tool_name: &'a str,
    /// The mode this call resolved under, i.e. the value
    /// [`PluginTaskPolicy::resolve_mode`] answered.
    pub mode: &'a str,
    /// The call names a path outside the session's workspace and scratch roots.
    pub requires_external_path_permission: bool,
}

/// The policy of one plugin-created task, as it applies to one session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PluginTaskPolicy {
    plugin_id: String,
    /// The narrowest resolved mode of any plugin task on this session's parent
    /// chain; every call is capped by it.
    ceiling: String,
}

impl PluginTaskPolicy {
    /// The policy that applies to this session, or `None` when neither it nor
    /// any session above it was created by a plugin.
    ///
    /// `tasks.session_id` is unique, so a session belongs to at most one task.
    /// A session spawned from a plugin task (a worker, ADR 0239) carries the
    /// same policy: its `session_collaboration_links` row is its parent, and
    /// the task that owns the work is the parent's own. A task a person or the
    /// employee started keeps `plugin_id` NULL and is untouched by this module.
    pub fn for_session(db: &Database, session_id: &str) -> Result<Option<Self>> {
        let mut current = Some(session_id.to_string());
        let mut seen: HashSet<String> = HashSet::new();
        let mut plugin_id: Option<String> = None;
        let mut ceiling: Option<String> = None;
        while let Some(id) = current {
            // Visit every ancestor; a visited set terminates malformed cycles.
            if !seen.insert(id.clone()) {
                break;
            }
            if let Some(found) = plugin_task_of(db, &id)? {
                let mode = narrower(&resolved_mode(db, &id)?, FILE_EDIT_MODE);
                ceiling = Some(match ceiling {
                    // Two plugin tasks on one chain can only narrow.
                    Some(existing) => narrower(&existing, &mode),
                    None => mode,
                });
                // The nearest task names the policy; the ceiling above already
                // accounts for the rest of the chain.
                plugin_id.get_or_insert(found);
            }
            current = parent_of(db, &id)?;
        }
        Ok(plugin_id.map(|plugin_id| Self {
            plugin_id,
            ceiling: ceiling.unwrap_or_else(|| "ask".into()),
        }))
    }

    /// The plugin whose brief this work carries.
    pub fn plugin_id(&self) -> &str {
        &self.plugin_id
    }

    /// The narrowest mode a call of this session may resolve at.
    pub fn ceiling(&self) -> &str {
        &self.ceiling
    }

    /// Tools that always take the approval path in this task.
    pub fn always_prompts(&self, tool_name: &str) -> bool {
        tool_name.starts_with(PLUGIN_TOOL_PREFIX) || matches!(tool_name, "TodoWrite" | "TaskReport")
    }

    /// A plugin cannot label its own calls low risk in a plugin task.
    pub fn declared_risk<'a>(&self, tool_name: &str, declared: Option<&'a str>) -> Option<&'a str> {
        if tool_name.starts_with(PLUGIN_TOOL_PREFIX) && declared != Some("high") {
            Some("medium")
        } else {
            declared
        }
    }

    /// The mode one call of this session resolves under.
    ///
    /// `session_mode` is the session's already-resolved effective mode
    /// (`inherit` collapsed against the global default). The task's ceiling and
    /// a subagent's declared scope may both narrow it and neither may widen it.
    pub fn resolve_mode(&self, session_mode: &str, subagent_scope: Option<&str>) -> String {
        let base = narrower(concrete(session_mode), &self.ceiling);
        match subagent_scope
            .filter(|scope| crate::sessions::is_valid_permission_mode(scope) && *scope != "inherit")
        {
            Some(scope) => narrower(&base, concrete(scope)),
            None => base,
        }
    }

    /// Whether a `Write`/`Edit` inside the workspace or scratch roots may be
    /// answered without a card.
    ///
    /// Only an `accept-edits` task does that. `ask` prompts, and `auto` — which
    /// a plugin-created task never runs at (`plugin_tasks::HOST_PERMISSION_CEILING`)
    /// — is not treated as permission to edit a file nobody asked about.
    pub fn auto_allows_file_edits(&self, mode: &str) -> bool {
        mode == FILE_EDIT_MODE
    }

    /// What this task actually permits for one call.
    ///
    /// The decision arrives from the permission manager exactly as it would
    /// for any other session; this only ever removes authority.
    pub fn enforce(
        &self,
        call: PluginTaskCall<'_>,
        decision: Option<PermissionDecision>,
    ) -> Option<PermissionDecision> {
        // The contract modes' hard deny sits above this policy: narrowing must
        // never turn a deny into a card the person could then approve.
        if matches!(decision, Some(PermissionDecision::Deny)) {
            return decision;
        }
        let denied_because = if self.always_prompts(call.tool_name) {
            Some("plugin tool")
        } else if call.requires_external_path_permission {
            Some("outside path")
        } else if matches!(decision, Some(PermissionDecision::AllowSession)) {
            Some("session grant")
        } else if matches!(call.tool_name, "Write" | "Edit")
            && !self.auto_allows_file_edits(call.mode)
        {
            Some("file edit outside accept-edits")
        } else {
            None
        };
        if denied_because.is_some() {
            tracing::info!(
                plugin_id = %self.plugin_id(),
                tool = %call.tool_name,
                mode = %call.mode,
                ceiling = %self.ceiling(),
                external_path = call.requires_external_path_permission,
                reason = denied_because.unwrap_or_default(),
                "plugin task requires approval"
            );
            return None;
        }
        decision
    }
}

/// Apply the policy when there is one, and leave the decision untouched when
/// there is not.
pub fn apply(
    policy: Option<&PluginTaskPolicy>,
    call: PluginTaskCall<'_>,
    decision: Option<PermissionDecision>,
) -> Option<PermissionDecision> {
    match policy {
        Some(policy) => policy.enforce(call, decision),
        None => decision,
    }
}

/// A policy for a caller that already knows the plugin id and the ceiling
/// (this module's tests; every production site resolves the task row itself).
#[cfg(test)]
impl PluginTaskPolicy {
    fn for_plugin(plugin_id: &str) -> Self {
        Self {
            plugin_id: plugin_id.to_string(),
            ceiling: "accept-edits".to_string(),
        }
    }

    fn with_ceiling(plugin_id: &str, ceiling: &str) -> Self {
        Self {
            plugin_id: plugin_id.to_string(),
            ceiling: ceiling.to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn allow() -> Option<PermissionDecision> {
        Some(PermissionDecision::AllowOnce)
    }

    fn call<'a>(tool_name: &'a str, mode: &'a str, external: bool) -> PluginTaskCall<'a> {
        PluginTaskCall {
            tool_name,
            mode,
            requires_external_path_permission: external,
        }
    }

    #[test]
    fn a_subagent_scope_can_only_narrow_the_task_mode() {
        let policy = PluginTaskPolicy::with_ceiling("acme", "accept-edits");
        assert_eq!(policy.resolve_mode("ask", Some("auto")), "ask");
        assert_eq!(policy.resolve_mode("ask", Some("accept-edits")), "ask");
        assert_eq!(
            policy.resolve_mode("accept-edits", Some("auto")),
            "accept-edits"
        );
        assert_eq!(policy.resolve_mode("auto", Some("ask")), "ask");
        assert_eq!(policy.resolve_mode("auto", None), "accept-edits");
        // `inherit` carries no override (ADR 0089), and an unknown mode cannot
        // widen anything.
        assert_eq!(
            policy.resolve_mode("accept-edits", Some("inherit")),
            "accept-edits"
        );
        assert_eq!(policy.resolve_mode("ask", Some("yolo")), "ask");
        // A resolved mode is expected; anything else fails closed.
        assert_eq!(policy.resolve_mode("inherit", Some("auto")), "ask");
    }

    #[test]
    fn a_derived_session_cannot_claim_more_than_its_task() {
        let policy = PluginTaskPolicy::with_ceiling("acme", "ask");
        // A worker whose own row (or the global default behind `inherit`)
        // says `auto` still resolves at the task it works for.
        assert_eq!(policy.resolve_mode("auto", None), "ask");
        assert_eq!(policy.resolve_mode("accept-edits", Some("auto")), "ask");
        // The ceiling narrows a scope too, never the other way round.
        let narrow = PluginTaskPolicy::with_ceiling("acme", "accept-edits");
        assert_eq!(narrow.resolve_mode("auto", Some("auto")), "accept-edits");
    }

    #[test]
    fn a_plugin_tool_never_decides_itself_even_at_low_risk() {
        let policy = PluginTaskPolicy::for_plugin("acme");
        assert!(policy.always_prompts("plugin_acme_run"));

        assert_eq!(
            policy.enforce(call("plugin_acme_run", "accept-edits", false), allow()),
            None
        );
        // Host built-in reads keep their free path.
        assert!(!policy.always_prompts("Read"));
        assert_eq!(policy.enforce(call("Read", "ask", false), allow()), allow());
        // An MCP tool is not a plugin tool and keeps the normal path.
        assert_eq!(
            policy.enforce(call("mcp_srv_tool", "ask", false), allow()),
            allow()
        );
    }

    #[test]
    fn a_session_grant_does_not_become_a_standing_licence() {
        let policy = PluginTaskPolicy::for_plugin("acme");
        let granted = Some(PermissionDecision::AllowSession);
        assert_eq!(
            policy.enforce(call("Bash", "accept-edits", false), granted.clone()),
            None
        );
        assert_eq!(
            policy.enforce(call("plugin_acme_run", "accept-edits", false), granted),
            None
        );
        // The host's own answer is never upgraded either.
        assert_eq!(
            policy.enforce(call("Bash", "accept-edits", false), None),
            None
        );
    }

    #[test]
    fn an_outside_path_prompts_even_under_auto() {
        let policy = PluginTaskPolicy::with_ceiling("acme", "auto");
        assert_eq!(policy.enforce(call("Read", "auto", true), allow()), None);
        assert_eq!(policy.enforce(call("Write", "auto", true), allow()), None);
        // Inside the roots, Accept-edits still auto-allows the file tools.
        assert_eq!(
            policy.enforce(call("Write", "accept-edits", false), allow()),
            allow()
        );
    }

    #[test]
    fn a_file_edit_is_automatic_only_at_accept_edits() {
        let policy = PluginTaskPolicy::with_ceiling("acme", "auto");
        assert!(policy.auto_allows_file_edits("accept-edits"));
        assert!(!policy.auto_allows_file_edits("ask"));
        // `auto` is not permission to edit a file in a task a plugin wrote.
        assert!(!policy.auto_allows_file_edits("auto"));
        assert_eq!(policy.enforce(call("Write", "auto", false), allow()), None);
        assert_eq!(policy.enforce(call("Edit", "ask", false), allow()), None);
        // A read is not a file edit and keeps its answer.
        assert_eq!(policy.enforce(call("Read", "ask", false), allow()), allow());
    }

    #[test]
    fn a_hard_deny_is_never_turned_into_a_card() {
        let policy = PluginTaskPolicy::with_ceiling("acme", "auto");
        let deny = Some(PermissionDecision::Deny);
        for tool in ["plugin_acme_run", "Write", "Read"] {
            for external in [false, true] {
                assert_eq!(
                    policy.enforce(call(tool, "ask", external), deny.clone()),
                    deny,
                    "{tool}"
                );
            }
        }
    }

    #[test]
    fn a_session_without_a_plugin_task_is_untouched() {
        let decision = Some(PermissionDecision::AllowSession);
        assert_eq!(
            apply(None, call("plugin_acme_run", "ask", true), decision.clone()),
            decision
        );
        assert_eq!(
            apply(None, call("Write", "ask", false), decision.clone()),
            decision
        );
    }

    fn database() -> (tempfile::TempDir, Database) {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
        (dir, db)
    }

    fn session(db: &Database, title: &str) -> String {
        crate::sessions::create_session(
            db,
            Some(title.into()),
            Some("agent".into()),
            None,
            None,
            None,
        )
        .unwrap()
        .id
    }

    fn task(db: &Database, employee: &str, task_session: &str, plugin_id: Option<&str>) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        db.conn()
            .execute(
                "INSERT INTO tasks (id, employee_session_id, session_id, title, origin, stage,
                                    created_at, plugin_id)
                 VALUES (?1, ?2, ?3, 'plugin task', 'steward', 'queued', ?4, ?5)",
                rusqlite::params![id, employee, task_session, crate::db::now_ms(), plugin_id],
            )
            .unwrap();
        id
    }

    /// One `spawn` link: `child` was created by `parent`.
    fn spawn_link(db: &Database, child: &str, parent: &str) {
        db.conn()
            .execute(
                "INSERT INTO session_collaboration_links
                    (session_id, created_by_session_id, plugin_id, created_at)
                 VALUES (?1, ?2, 'pi.session-orchestrator', ?3)",
                rusqlite::params![child, parent, crate::db::now_ms()],
            )
            .unwrap();
    }

    fn set_mode(db: &Database, session_id: &str, mode: &str) {
        db.conn()
            .execute(
                "UPDATE sessions SET permission_mode=?2 WHERE id=?1",
                rusqlite::params![session_id, mode],
            )
            .unwrap();
    }

    #[test]
    fn only_a_task_that_names_a_plugin_carries_the_policy() {
        let (_dir, db) = database();
        let employee = session(&db, "employee");
        let plugin_task_session = session(&db, "plugin task");
        let plain_task_session = session(&db, "plain task");
        let ordinary = session(&db, "ordinary");
        task(&db, &employee, &plugin_task_session, Some("acme"));
        task(&db, &employee, &plain_task_session, None);
        task(&db, &employee, &ordinary, Some("   "));

        // A later session setting cannot widen plugin-created work to auto.
        set_mode(&db, &plugin_task_session, "auto");
        let policy = PluginTaskPolicy::for_session(&db, &plugin_task_session)
            .unwrap()
            .expect("a task that names a plugin carries the policy");
        assert_eq!(policy.plugin_id(), "acme");
        assert_eq!(policy.resolve_mode("auto", Some("auto")), "accept-edits");
        assert!(PluginTaskPolicy::for_session(&db, &plain_task_session)
            .unwrap()
            .is_none());
        // A blank id is not a plugin, and a session with no task row is not a
        // task at all.
        assert!(PluginTaskPolicy::for_session(&db, &ordinary)
            .unwrap()
            .is_none());
        assert!(PluginTaskPolicy::for_session(&db, "missing-session")
            .unwrap()
            .is_none());
    }

    #[test]
    fn a_worker_inherits_the_policy_of_the_task_that_spawned_it() {
        let (_dir, db) = database();
        let employee = session(&db, "employee");
        let task_session = session(&db, "plugin task");
        let worker = session(&db, "worker");
        let grandchild = session(&db, "another plugin's worker");
        let unrelated = session(&db, "unrelated");
        task(&db, &employee, &task_session, Some("acme"));
        set_mode(&db, &task_session, "ask");
        spawn_link(&db, &worker, &task_session);
        spawn_link(&db, &grandchild, &worker);
        // A second plugin task, on its own chain, is its own policy.
        let plain = session(&db, "plain task");
        task(&db, &employee, &plain, None);

        let policy = PluginTaskPolicy::for_session(&db, &worker)
            .unwrap()
            .expect("a worker of a plugin task carries the policy");
        assert_eq!(policy.plugin_id(), "acme");
        assert_eq!(policy.ceiling(), "ask");

        // The chain is followed all the way up, not just one hop.
        let deep = PluginTaskPolicy::for_session(&db, &grandchild)
            .unwrap()
            .expect("a descendant of a worker is a descendant of the task");
        assert_eq!(deep.ceiling(), "ask");

        // Nothing off the chain is affected.
        assert!(PluginTaskPolicy::for_session(&db, &unrelated)
            .unwrap()
            .is_none());
        assert!(PluginTaskPolicy::for_session(&db, &employee)
            .unwrap()
            .is_none());
    }

    #[test]
    fn policy_reaches_ancestors_beyond_eight_levels() {
        let (_dir, db) = database();
        let employee = session(&db, "employee");
        let root = session(&db, "plugin task");
        task(&db, &employee, &root, Some("acme"));
        set_mode(&db, &root, "ask");
        let mut parent = root;
        for _ in 0..10 {
            let child = session(&db, "descendant");
            spawn_link(&db, &child, &parent);
            parent = child;
        }
        let policy = PluginTaskPolicy::for_session(&db, &parent)
            .unwrap()
            .unwrap();
        assert_eq!(policy.plugin_id(), "acme");
        assert_eq!(policy.resolve_mode("auto", Some("auto")), "ask");
    }

    #[test]
    fn a_worker_at_a_wider_mode_still_resolves_at_its_tasks_ceiling() {
        let (_dir, db) = database();
        let employee = session(&db, "employee");
        let task_session = session(&db, "plugin task");
        let worker = session(&db, "worker");
        task(&db, &employee, &task_session, Some("acme"));
        set_mode(&db, &task_session, "accept-edits");
        spawn_link(&db, &worker, &task_session);
        // The worker's own row is the global default, which a person may have
        // set to `auto` (or a stale row may carry): the task still caps it.
        set_mode(&db, &worker, "inherit");

        let policy = PluginTaskPolicy::for_session(&db, &worker)
            .unwrap()
            .unwrap();
        assert_eq!(policy.ceiling(), "accept-edits");
        assert_eq!(policy.resolve_mode("auto", None), "accept-edits");
        assert_eq!(policy.resolve_mode("auto", Some("auto")), "accept-edits");
    }

    #[test]
    fn a_chain_that_loops_stops_instead_of_hanging() {
        let (_dir, db) = database();
        let employee = session(&db, "employee");
        let task_session = session(&db, "plugin task");
        let worker = session(&db, "worker");
        task(&db, &employee, &task_session, Some("acme"));
        spawn_link(&db, &worker, &task_session);
        // Hand-edited nonsense: the task claims the worker as its parent.
        spawn_link(&db, &task_session, &worker);

        let policy = PluginTaskPolicy::for_session(&db, &worker)
            .unwrap()
            .unwrap();
        assert_eq!(policy.plugin_id(), "acme");
    }

    #[test]
    fn two_plugin_tasks_on_one_chain_narrow_to_the_smallest() {
        let (_dir, db) = database();
        let employee = session(&db, "employee");
        let outer = session(&db, "outer plugin task");
        let inner = session(&db, "inner plugin task");
        task(&db, &employee, &outer, Some("acme"));
        set_mode(&db, &outer, "auto");
        spawn_link(&db, &inner, &outer);
        task(&db, &employee, &inner, Some("other"));
        set_mode(&db, &inner, "ask");

        let policy = PluginTaskPolicy::for_session(&db, &inner).unwrap().unwrap();
        // The nearest task names the policy; the ceiling accounts for both.
        assert_eq!(policy.plugin_id(), "other");
        assert_eq!(policy.ceiling(), "ask");
    }
}
