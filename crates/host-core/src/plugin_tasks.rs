//! The host data layer behind a plugin's `tasks.read` / `tasks.manage`
//! capabilities (ADR plugin-host-capabilities, spec 07-plugins/03 §"tasks").
//!
//! A plugin-created task is an ordinary task: the row, the session and the
//! inheritance rules all belong to [`crate::tasks`]. This module owns only what
//! is different about one a plugin started, and every rule here is a rule about
//! *who may do what*, never a second task lifecycle:
//!
//! - **Provenance beside the origin.** `tasks.origin` keeps its two values; the
//!   plugin is recorded in `tasks.plugin_id`, written in the same transaction
//!   that creates the row, so a task can never exist without saying who started
//!   it. `origin` is `direct`: a plugin call arrives through the same surface a
//!   person uses, not through a confirmed card.
//! - **Ownership is the whole authorization.** `get`, `send` and `stop` answer
//!   `NOT_FOUND` for a task this plugin did not create, exactly like a task that
//!   does not exist, so the surface cannot be used to enumerate other people's
//!   work. Only reads over the roster (`roster`, `list`) are wider, and they are
//!   redacted: no prompt, no waiting question, no transcript, no report.
//! - **A ceiling, never a grant.** The mode a task runs at is the narrowest of
//!   four things: what the call asked for (`accept-edits` when it asked for
//!   nothing), what the manifest declared (`tasks.manage.maxPermission`,
//!   `accept-edits` when it declared nothing), the employee's own resolved mode,
//!   and the host's own [`HOST_PERMISSION_CEILING`]. An explicit `auto` request
//!   is refused rather than clamped, because a plugin asking for the person's
//!   approval step to be removed is not the same request as one asking to edit
//!   files.
//! - **Two quotas, both measured durably.** At most
//!   [`MAX_OPEN_TASKS_PER_PLUGIN`] unarchived tasks across every employee, and at
//!   most [`HOURLY_CREATE_LIMIT`] new tasks per rolling hour. The hourly budget
//!   is counted from the audit log, not from the tasks table: archiving a task,
//!   or uninstalling the plugin (which clears `plugin_id`), must not be a way to
//!   refill it, and a restart has to read the same evidence.
//! - **The person is told once, by the host.** Creating a task writes one
//!   `plugin.alert` inbox row that the person can act on. That row is the
//!   host's own announcement, so it spends none of the plugin's
//!   `notify.center` budget and writes no `plugin_notification_delivered`
//!   evidence (which is what that budget is counted from). Its `body` is a
//!   stable JSON document, not prose — see [`NOTIFICATION_BODY_SCHEMA`] — and
//!   it keeps `session_id` NULL like every other plugin row, so the bell's
//!   per-conversation merge cannot hide it beside a conversation's own rows.
//!   The task's conversation travels as a host-written `link_json`
//!   (`{"session": "<task session>"}`) instead, which is the only field that
//!   names a destination and which no plugin ever supplies.

use crate::db::{now_ms, Database, NOTIFICATION_KEEP};
use crate::tasks;
use anyhow::{anyhow, Result};
use rusqlite::{params, OptionalExtension, Transaction};
use serde_json::json;
use uuid::Uuid;

/// The read-only views of the person's team and of its tasks: plain queries
/// over rows this module writes, kept in their own files so this one stays the
/// create and drive path.
mod ledger;
mod roster;

pub use ledger::{get, list, owner, LedgerQuery};
pub use roster::{employee, roster, Employee};

#[cfg(test)]
#[path = "plugin_tasks_tests.rs"]
mod tests;

/// How many tasks one plugin may hold open (unarchived) at once, across every
/// employee. A bound, not a workflow: a plugin with more than this is not
/// tracking its own work.
pub const MAX_OPEN_TASKS_PER_PLUGIN: i64 = 10;

/// New tasks one plugin may create per rolling hour.
pub const HOURLY_CREATE_LIMIT: i64 = 20;

/// Rolling window the hourly budget is measured over.
const HOURLY_WINDOW_MS: i64 = 60 * 60 * 1_000;

/// The mode a plugin task runs at when the call names none.
pub const DEFAULT_PERMISSION: &str = "accept-edits";

/// The widest mode any plugin-created task may run at, whatever else says
/// otherwise. `auto` is therefore never an effective mode for this surface.
pub const HOST_PERMISSION_CEILING: &str = "accept-edits";

/// The three modes a manifest (and a call) may name.
const PLUGIN_PERMISSION_MODES: [&str; 3] = ["ask", "accept-edits", "auto"];

/// Longest title a plugin-created task may carry; the same bound `task.create`
/// applies.
pub const MAX_TITLE_CHARS: usize = 200;

/// Longest work request a call may carry. The prompt is checked and never
/// stored: delivery is the caller's, and the ledger shows no plugin prose. The
/// number matches the bound Electron Main applies before it calls
/// (`plugin-tasks-api.ts`, `MAX_PROMPT_CHARS`), so a prompt the broker accepted
/// is not refused one hop later.
pub const MAX_PROMPT_CHARS: usize = 100_000;

/// Longest plugin, task or employee id this module accepts.
const MAX_ID_CHARS: usize = 256;

/// The durable evidence of one created task: the hourly budget is counted from
/// these rows. One kind, so the notification family's own audit kind cannot be
/// confused with it.
pub const AUDIT_CREATED: &str = "plugin_task_created";

/// Prefix of the dedupe key the host owns for these rows. A key starting with
/// it is a host announcement, which is how the renderer can tell a localized
/// host row from a plugin's own body without trusting the text.
pub const NOTIFICATION_DEDUPE_PREFIX: &str = "__minih_plugin_task__:";

/// Marker of the structured body the host writes.
pub const NOTIFICATION_BODY_SCHEMA: &str = "minih.hostNotification";

/// Version of [`NOTIFICATION_BODY_SCHEMA`].
pub const NOTIFICATION_BODY_VERSION: u32 = 1;

/// The i18n key the renderer localizes this row with; the row's `i18n.params`
/// are its parameters.
pub const NOTIFICATION_I18N_KEY: &str = "notifications.pluginTaskCreated";

/// Rows a ledger read returns when the call names no limit, and its cap.
pub const LIST_MAX_LIMIT: i64 = 200;

/// What the host authorized for one plugin.
///
/// The RPC layer resolves it from the registry and the installed manifest
/// before any row is written; the data layer only ever narrows from here, so a
/// manifest edit or a stale caller cannot widen what a task runs at.
pub struct Grant {
    pub plugin_id: String,
    /// `manifest.tasks.manage.maxPermission`; [`DEFAULT_PERMISSION`] when the
    /// manifest declares none.
    pub max_permission: String,
}

impl Grant {
    pub fn new(plugin_id: &str, max_permission: Option<&str>) -> Result<Self> {
        let plugin_id = plugin_id.trim();
        if plugin_id.is_empty() || plugin_id.chars().count() > MAX_ID_CHARS {
            return Err(anyhow!("INVALID_ARGUMENT: pluginId required"));
        }
        let max_permission = match max_permission
            .map(str::trim)
            .filter(|mode| !mode.is_empty())
        {
            None => DEFAULT_PERMISSION.to_string(),
            Some(mode) if PLUGIN_PERMISSION_MODES.contains(&mode) => mode.to_string(),
            Some(mode) => {
                return Err(anyhow!(
                    "INVALID_ARGUMENT: unknown task permission ceiling '{mode}'"
                ))
            }
        };
        Ok(Self {
            plugin_id: plugin_id.to_string(),
            max_permission,
        })
    }
}

/// Capability rank of a mode; higher is wider. Mirrors
/// `session_collaboration::permissions::rank`, which is not reachable from
/// here; an unknown mode ranks as the narrowest so a malformed value can only
/// reduce authority.
fn rank(mode: &str) -> u8 {
    match mode {
        "auto" => 2,
        "accept-edits" => 1,
        _ => 0,
    }
}

fn narrower<'a>(left: &'a str, right: &'a str) -> &'a str {
    if rank(left) <= rank(right) {
        left
    } else {
        right
    }
}

/// The mode a new task runs at, or the refusal that explains why it cannot.
pub fn effective_permission(
    requested: Option<&str>,
    grant: &Grant,
    employee_mode: &str,
) -> Result<String> {
    let requested = match requested.map(str::trim).filter(|mode| !mode.is_empty()) {
        None => DEFAULT_PERMISSION,
        Some(mode) if PLUGIN_PERMISSION_MODES.contains(&mode) => mode,
        Some(_) => {
            return Err(anyhow!(
                "INVALID_ARGUMENT: maxPermission must be one of ask, accept-edits, auto"
            ))
        }
    };
    // Asking for `auto` is a request to remove the person's approval step from
    // work they did not type. Clamping it silently would answer "granted, but
    // narrower" to a question the person never got to answer.
    if requested == "auto" {
        return Err(anyhow!(
            "PERMISSION_DENIED: a plugin-created task may not run at auto"
        ));
    }
    let mode = narrower(requested, &grant.max_permission);
    let mode = narrower(mode, employee_mode);
    Ok(narrower(mode, HOST_PERMISSION_CEILING).to_string())
}

fn required_id<'a>(raw: &'a str, field: &str) -> Result<&'a str> {
    let value = raw.trim();
    if value.is_empty() || value.chars().count() > MAX_ID_CHARS {
        return Err(anyhow!("INVALID_ARGUMENT: {field} required"));
    }
    Ok(value)
}

fn bounded_text<'a>(raw: &'a str, field: &str, limit: usize) -> Result<&'a str> {
    let value = raw.trim();
    if value.is_empty() {
        return Err(anyhow!("INVALID_ARGUMENT: {field} required"));
    }
    if value.chars().count() > limit {
        return Err(anyhow!("LIMIT_EXCEEDED: {field} too long"));
    }
    Ok(value)
}

/// The prompt a `send` would deliver. Checked here and handed back to the
/// caller; it is never written.
pub fn validate_prompt(prompt: &str) -> Result<&str> {
    bounded_text(prompt, "prompt", MAX_PROMPT_CHARS)
}

fn open_plugin_tasks(conn: &rusqlite::Connection, plugin_id: &str) -> Result<i64> {
    Ok(conn
        .prepare_cached("SELECT COUNT(*) FROM tasks WHERE plugin_id=?1 AND archived_at IS NULL")?
        .query_row(params![plugin_id], |row| row.get(0))?)
}

/// Tasks this plugin created inside the rolling window, read from the audit log
/// so the tasks table cannot be used as a reset switch.
fn created_in_window(conn: &rusqlite::Connection, plugin_id: &str, now: i64) -> Result<i64> {
    Ok(conn
        .prepare_cached(
            "SELECT COUNT(*) FROM audit_log
              WHERE kind = ?1 AND ts >= ?2
                AND CASE WHEN json_valid(payload_json)
                         THEN json_extract(payload_json, '$.pluginId') END = ?3",
        )?
        .query_row(
            params![AUDIT_CREATED, now - HOURLY_WINDOW_MS, plugin_id],
            |row| row.get(0),
        )?)
}

/// Everything a create needs.
pub struct CreateRequest<'a> {
    pub employee_id: &'a str,
    pub title: &'a str,
    /// The work request the caller will deliver. Validated, never stored.
    pub prompt: &'a str,
    /// The repository the task works in; absent means the employee's own.
    pub project_id: Option<i64>,
    /// What the call asked for; absent means [`DEFAULT_PERMISSION`].
    pub max_permission: Option<&'a str>,
}

/// What a create produced.
#[derive(Debug)]
pub struct Created {
    pub task: tasks::Task,
    /// The inbox row that announces it, read back from the transaction that
    /// wrote it so the caller can hand the person's own row to the renderer —
    /// the same `Notification` shape the inbox and `pluginNotification.create`
    /// answer with, not a second projection of it.
    pub notification: crate::notifications::Notification,
    /// The mode the task's session was actually created at.
    pub permission_mode: String,
}

/// Create one task under one employee, atomically.
///
/// The transaction covers the quota checks, the task row, its `plugin_id`, the
/// audit record and the inbox row: a create either lands with all of them or
/// changes nothing. Both quotas are read inside it, so two concurrent calls
/// cannot each see room for the last one.
///
/// The workspace is *not* prepared here: that is git work, it happens after
/// this transaction commits and before the caller delivers the prompt
/// (`task_workspace::prepare`), and this module never starts it.
pub fn create(db: &Database, grant: &Grant, request: CreateRequest<'_>) -> Result<Created> {
    let title = bounded_text(request.title, "title", MAX_TITLE_CHARS)?;
    // The prompt's only job here is to be a prompt: delivery is the caller's,
    // and storing it would put plugin prose into the person's ledger.
    validate_prompt(request.prompt)?;
    let employee = employee(db, request.employee_id)?;
    let permission_mode =
        effective_permission(request.max_permission, grant, &employee.permission_mode)?;
    // A named repository must exist; a typo is not "the employee's own project".
    let project_path = match request.project_id {
        None => None,
        Some(project_id) => match db.project_path(project_id)? {
            Some(path) if !path.trim().is_empty() => Some(path),
            _ => return Err(anyhow!("NOT_FOUND: project")),
        },
    };
    let tx = db.conn().unchecked_transaction()?;
    let open = open_plugin_tasks(&tx, &grant.plugin_id)?;
    if open >= MAX_OPEN_TASKS_PER_PLUGIN {
        return Err(anyhow!(
            "LIMIT_EXCEEDED: this plugin already holds {open} open tasks"
        ));
    }
    let now = now_ms();
    let in_window = created_in_window(&tx, &grant.plugin_id, now)?;
    if in_window >= HOURLY_CREATE_LIMIT {
        return Err(anyhow!(
            "RATE_LIMITED: this plugin already created {in_window} tasks in the last hour"
        ));
    }
    let task = tasks::create_in(
        db,
        &tx,
        tasks::CreateRequest {
            employee_session_id: &employee.id,
            title,
            origin: "direct",
            project_path,
            branch: None,
            source_utterance: None,
            delivery_id: None,
            permission_mode: Some(&permission_mode),
            relay_parent_task_id: None,
            relay_state: None,
        },
    )?;
    // Provenance beside the origin, in the transaction that created the row.
    tx.execute(
        "UPDATE tasks SET plugin_id=?2 WHERE id=?1",
        params![task.id, grant.plugin_id],
    )?;
    crate::audit::append_tx(
        &tx,
        AUDIT_CREATED,
        None,
        json!({
            "pluginId": grant.plugin_id,
            "taskId": task.id,
            "employeeId": employee.id,
            "permissionMode": permission_mode,
        }),
    )?;
    let notification = announce(&tx, grant, &task, &employee, &permission_mode, now)?;
    prune_oldest_notifications(&tx)?;
    tx.commit()?;
    Ok(Created {
        task,
        notification,
        permission_mode,
    })
}

/// Keep the newest [`NOTIFICATION_KEEP`] rows globally.
///
/// The cap is the one `notifications::prune_oldest` applies and that helper is
/// private to its module, so the statement lives here as well; the two must
/// agree, because the cap is what keeps a chatty family from evicting another.
fn prune_oldest_notifications(tx: &Transaction<'_>) -> Result<()> {
    tx.execute(
        "DELETE FROM notifications
          WHERE id IN (
            SELECT id FROM notifications
             ORDER BY created_at DESC, id DESC
             LIMIT -1 OFFSET ?1
          )",
        params![NOTIFICATION_KEEP],
    )?;
    Ok(())
}

/// The row is written as `plugin.alert` because the inbox has no other kind for
/// a plugin-side announcement, but it is the *host's* row: no
/// `plugin_notification_delivered` audit record is written, so it never spends
/// the plugin's own rolling budget (that budget is counted from exactly those
/// records).
///
/// `session_id` stays NULL, and the task's conversation travels as an explicit
/// host-trusted link instead: `link_json = {"session": "<task session id>"}`.
/// Setting the session column would make the row a *conversation* row for the
/// shared bell projection (`isSessionNotification`), which merges rows per
/// session and would hide this announcement behind whatever row that
/// conversation produced — so the column stays NULL and the renderer resolves
/// the session link itself.
///
/// The `body` is not a sentence: it is [`NOTIFICATION_BODY_SCHEMA`], so the
/// renderer can localize the row from `i18n.key` + `i18n.params` instead of
/// showing whatever language the plugin happened to write.
fn announce(
    tx: &Transaction<'_>,
    grant: &Grant,
    task: &tasks::Task,
    employee: &Employee,
    permission_mode: &str,
    now: i64,
) -> Result<crate::notifications::Notification> {
    let dedupe_key = format!("{NOTIFICATION_DEDUPE_PREFIX}{}", task.id);
    let body = json!({
        "schema": NOTIFICATION_BODY_SCHEMA,
        "version": NOTIFICATION_BODY_VERSION,
        "i18n": {
            "key": NOTIFICATION_I18N_KEY,
            "params": {
                "taskTitle": task.title,
                "employeeName": employee.name,
                "pluginId": grant.plugin_id,
                "permissionMode": permission_mode,
            },
        },
        "taskId": task.id,
        "sessionId": task.session_id,
        "employeeId": employee.id,
        "pluginId": grant.plugin_id,
        "permissionMode": permission_mode,
    })
    .to_string();
    let link_json = json!({ "session": task.session_id }).to_string();
    let id = Uuid::new_v4().to_string();
    tx.prepare_cached(
        "INSERT INTO notifications
            (id, kind, session_id, session_title, plugin_id, title, body, link_json,
             dedupe_key, created_at)
         VALUES (?1, 'plugin.alert', NULL, NULL, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(plugin_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO UPDATE SET
            title = excluded.title, body = excluded.body, link_json = excluded.link_json,
            created_at = MAX(excluded.created_at, notifications.created_at + 1),
            read_at = NULL",
    )?
    .execute(params![
        id,
        grant.plugin_id,
        task.title,
        body,
        link_json,
        dedupe_key,
        now
    ])?;
    // Read the row back rather than restating it: the upsert keeps the id and
    // moves `created_at` of an earlier row, and the caller hands this object to
    // the renderer as the person's own row.
    announcement(tx, &grant.plugin_id, &dedupe_key)?
        .ok_or_else(|| anyhow!("INTERNAL: the announcement row could not be read back"))
}

/// One announcement row, in the inbox's own `Notification` shape.
///
/// `dedupe_key` addresses it because the host owns that key
/// ([`NOTIFICATION_DEDUPE_PREFIX`]): no plugin can name this row, and no other
/// row of the plugin can collide with it.
fn announcement(
    conn: &rusqlite::Connection,
    plugin_id: &str,
    dedupe_key: &str,
) -> Result<Option<crate::notifications::Notification>> {
    Ok(conn
        .prepare_cached(
            "SELECT id, kind, session_id, session_title, turn_id, request_id, tool_name,
                    error_code, created_at, read_at, plugin_id, title, body, link_json,
                    dedupe_key
               FROM notifications WHERE plugin_id = ?1 AND dedupe_key = ?2",
        )?
        .query_row(params![plugin_id, dedupe_key], |row| {
            Ok(crate::notifications::Notification {
                id: row.get(0)?,
                kind: row.get(1)?,
                session_id: row.get(2)?,
                session_title: row.get(3)?,
                turn_id: row.get(4)?,
                request_id: row.get(5)?,
                tool_name: row.get(6)?,
                error_code: row.get(7)?,
                created_at: crate::db::ms_to_ts(row.get(8)?),
                read_at: row.get::<_, Option<i64>>(9)?.map(crate::db::ms_to_ts),
                plugin_id: row.get(10)?,
                title: row.get(11)?,
                body: row.get(12)?,
                link_json: row.get(13)?,
                dedupe_key: row.get(14)?,
            })
        })
        .optional()?)
}

/// What a `send` or `stop` is allowed to address.
#[derive(Debug)]
pub struct TaskTarget {
    pub task_id: String,
    pub session_id: String,
    pub employee_id: String,
}

/// One task this plugin created and may still drive.
///
/// Archived work is not drivable: it left the task list, and a prompt delivered
/// into it would open a turn nobody is watching. That is a `CONFLICT` rather
/// than `NOT_FOUND` because the plugin does own the task, and "it is over" is
/// the fact it needs.
pub fn owned_open_task(db: &Database, plugin_id: &str, task_id: &str) -> Result<TaskTarget> {
    let plugin_id = required_id(plugin_id, "pluginId")?;
    let task_id = required_id(task_id, "taskId")?;
    let row = db
        .conn()
        .prepare_cached(
            "SELECT session_id, employee_session_id, archived_at FROM tasks
              WHERE id=?1 AND plugin_id=?2",
        )?
        .query_row(params![task_id, plugin_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<i64>>(2)?,
            ))
        })
        .optional()?
        .ok_or_else(|| anyhow!("NOT_FOUND: task"))?;
    if row.2.is_some() {
        return Err(anyhow!("CONFLICT: task is archived"));
    }
    Ok(TaskTarget {
        task_id: task_id.to_string(),
        session_id: row.0,
        employee_id: row.1,
    })
}
