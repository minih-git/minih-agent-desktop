//! Where a session came from (ADR persisted-session-origin).
//!
//! The sidebar tells a conversation the person opened apart from one an agent,
//! a plugin, an employee or a scheduler produced. Nothing recorded that: the
//! built-in `SessionCreate`, a plugin's spawn and an employee's task all called
//! the same `session.create`, so a session carried no trace of its creator.
//!
//! The origin lives on the session row because every other source is derived
//! and therefore prunable: `scheduledRun` reads `task_runs`, which keeps 100
//! runs per task, and `session_collaboration_links` is the permission parent
//! chain and worker ledger — writing it for a non-plugin creator would change
//! who may do what. The column is the provenance, one row, no extra table.

use crate::db::{anyhow, params, Database, OptionalExtension, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The origins the `sessions.origin` CHECK accepts, and the only values a
/// trusted writer may stamp.
pub const ORIGIN_USER: &str = "user";
pub const ORIGIN_AGENT: &str = "agent";
pub const ORIGIN_PLUGIN: &str = "plugin";
pub const ORIGIN_TASK: &str = "task";
pub const ORIGIN_SCHEDULED: &str = "scheduled";

pub const ORIGINS: [&str; 5] = [
    ORIGIN_USER,
    ORIGIN_AGENT,
    ORIGIN_PLUGIN,
    ORIGIN_TASK,
    ORIGIN_SCHEDULED,
];

/// A stored origin, falling back to `user`.
///
/// The CHECK constraint makes an unknown value unreachable through this
/// host, but a database written by a newer build and reopened by an older one
/// can carry one. Reporting it as `user` is the only answer that cannot
/// invent a creator the row does not name.
pub fn normalize(raw: Option<&str>) -> &'static str {
    match raw.map(str::trim) {
        Some(ORIGIN_AGENT) => ORIGIN_AGENT,
        Some(ORIGIN_PLUGIN) => ORIGIN_PLUGIN,
        Some(ORIGIN_TASK) => ORIGIN_TASK,
        Some(ORIGIN_SCHEDULED) => ORIGIN_SCHEDULED,
        _ => ORIGIN_USER,
    }
}

/// The session that created another one, resolved for the sidebar tooltip.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OriginSessionRef {
    pub session_id: String,
    pub title: String,
    /// False once the creator session was deleted or archived: the tag stays,
    /// the link does not.
    pub available: bool,
}

/// Resolve a session reference for a tag's tooltip.
///
/// One indexed row: the title the row shows today, and whether that row is
/// still reachable. A deleted creator keeps its title — the transcript is gone,
/// the fact that it made this session is not.
pub fn resolve(db: &Database, session_id: &str) -> Result<Option<OriginSessionRef>> {
    let found: Option<OriginSessionRef> = db
        .conn()
        .prepare_cached(
            "SELECT id, COALESCE(NULLIF(title, ''), id), deleted_at IS NULL
             FROM sessions WHERE id = ?1",
        )?
        .query_row(params![session_id], |row| {
            Ok(OriginSessionRef {
                session_id: row.get(0)?,
                title: row.get(1)?,
                available: row.get(2)?,
            })
        })
        .optional()?;
    // A creator row that no longer exists still created something: keep the
    // reference and report it unavailable, the same shape a deleted session
    // leaves behind.
    Ok(Some(found.unwrap_or_else(|| OriginSessionRef {
        session_id: session_id.to_string(),
        title: String::new(),
        available: false,
    })))
}

/// The origin a trusted writer stamps on a session it creates.
///
/// Built by one constructor per writer so a call site cannot pair an origin
/// with the wrong reference: an `agent` session always names the session it
/// was handed off from, a `scheduled` one always names its task.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionOriginFields {
    pub origin: String,
    pub origin_session_id: Option<String>,
    pub origin_task_id: Option<String>,
}

/// Read the origin columns a summary query projects.
///
/// By column name, so a query that predates the columns (search builds its own
/// list) reports an ordinary conversation instead of failing the read.
pub(crate) fn from_row(
    row: &rusqlite::Row<'_>,
) -> (String, Option<OriginSessionRef>, Option<String>) {
    let column = |name: &str| row.get::<_, Option<String>>(name).ok().flatten();
    let origin = normalize(column("session_origin").as_deref()).to_string();
    let origin_session = column("origin_session_id").map(|session_id| OriginSessionRef {
        // Empty when the creator row is gone: the tag still says where the
        // session came from, and the tooltip falls back to its "deleted"
        // wording rather than inventing a title.
        title: column("origin_session_title").unwrap_or_default(),
        available: row
            .get::<_, Option<bool>>("origin_session_available")
            .ok()
            .flatten()
            .unwrap_or(false),
        session_id,
    });
    (origin, origin_session, column("session_origin_task_id"))
}

impl Default for SessionOriginFields {
    fn default() -> Self {
        Self::user()
    }
}

impl SessionOriginFields {
    /// A conversation the person opened. Also the origin of a branch: forking
    /// is a user action, so the child never inherits the parent's creator.
    pub fn user() -> Self {
        Self {
            origin: ORIGIN_USER.into(),
            origin_session_id: None,
            origin_task_id: None,
        }
    }

    fn from_source(origin: &str, source_session_id: impl Into<String>) -> Self {
        Self {
            origin: origin.into(),
            origin_session_id: Some(source_session_id.into()),
            origin_task_id: None,
        }
    }

    /// A session a plugin created, optionally on behalf of the session whose
    /// turn invoked it.
    pub fn plugin(source_session_id: Option<String>) -> Self {
        Self {
            origin: ORIGIN_PLUGIN.into(),
            origin_session_id: source_session_id.filter(|id| !id.trim().is_empty()),
            origin_task_id: None,
        }
    }

    /// An employee's task session; `source_session_id` is the employee.
    pub fn task(source_session_id: impl Into<String>) -> Self {
        Self::from_source(ORIGIN_TASK, source_session_id)
    }

    /// A scheduled task's run transcript.
    pub fn scheduled(task_id: impl Into<String>) -> Self {
        Self {
            origin: ORIGIN_SCHEDULED.into(),
            origin_session_id: None,
            origin_task_id: Some(task_id.into()),
        }
    }

    /// Refuse an origin the CHECK would reject and a reference the origin
    /// cannot carry, before any row is written.
    pub fn validate(&self) -> Result<()> {
        if !ORIGINS.contains(&self.origin.as_str()) {
            return Err(anyhow!(
                "INVALID_ARGUMENT: unknown session origin {}",
                self.origin
            ));
        }
        for (name, value) in [
            ("originSessionId", self.origin_session_id.as_deref()),
            ("originTaskId", self.origin_task_id.as_deref()),
        ] {
            if value.is_some_and(|id| id.trim().is_empty() || id.chars().count() > 256) {
                return Err(anyhow!("INVALID_ARGUMENT: invalid {name}"));
            }
        }
        // A run names its task, never a parent session; every other origin may
        // name the session it came from but has no task to point at.
        if self.origin == ORIGIN_SCHEDULED && self.origin_session_id.is_some() {
            return Err(anyhow!(
                "INVALID_ARGUMENT: a scheduled session names its task, not a session"
            ));
        }
        if self.origin != ORIGIN_SCHEDULED && self.origin_task_id.is_some() {
            return Err(anyhow!(
                "INVALID_ARGUMENT: originTaskId requires the scheduled origin"
            ));
        }
        // A run without its task could not be folded under it in the sidebar,
        // and `task_runs` is pruned — the id is the only lasting link.
        if self.origin == ORIGIN_SCHEDULED && self.origin_task_id.is_none() {
            return Err(anyhow!(
                "INVALID_ARGUMENT: a scheduled session needs its task id"
            ));
        }
        Ok(())
    }

    /// Read the origin out of `session.create` params.
    ///
    /// Omitted fields mean `user`, so every existing caller keeps creating an
    /// ordinary conversation. Only Electron main reaches this operation: the
    /// renderer's IPC handler drops these keys and the RACP catalog builds its
    /// own payload, so the value is a host-side decision, not user input.
    pub fn from_params(params: &Value) -> Result<Self> {
        let string = |key: &str| -> Result<Option<String>> {
            match params.get(key) {
                None | Some(Value::Null) => Ok(None),
                Some(Value::String(value)) => Ok(Some(value.clone())),
                Some(_) => Err(anyhow!("INVALID_ARGUMENT: {key} must be a string")),
            }
        };
        let origin = match string("origin")? {
            Some(origin) => origin,
            None => return Ok(Self::user()),
        };
        let fields = Self {
            origin,
            origin_session_id: string("originSessionId")?,
            origin_task_id: string("originTaskId")?,
        };
        fields.validate()?;
        Ok(fields)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn every_origin_accepts_the_reference_it_can_carry() {
        for fields in [
            SessionOriginFields::user(),
            SessionOriginFields::from_params(
                &json!({ "origin": "agent", "originSessionId": "s1" }),
            )
            .unwrap(),
            SessionOriginFields::plugin(None),
            SessionOriginFields::plugin(Some("s1".into())),
            SessionOriginFields::task("s1"),
            SessionOriginFields::scheduled("t1"),
        ] {
            assert!(fields.validate().is_ok(), "{fields:?}");
        }
    }

    #[test]
    fn an_unknown_origin_is_refused() {
        let fields = SessionOriginFields {
            origin: "steward".into(),
            ..Default::default()
        };
        assert!(fields.validate().is_err());
        assert!(SessionOriginFields::from_params(&json!({ "origin": "steward" })).is_err());
    }

    #[test]
    fn a_reference_the_origin_cannot_carry_is_refused() {
        let scheduled_with_session = SessionOriginFields {
            origin: ORIGIN_SCHEDULED.into(),
            origin_session_id: Some("s1".into()),
            origin_task_id: Some("t1".into()),
        };
        assert!(scheduled_with_session.validate().is_err());
        let agent_with_task = SessionOriginFields {
            origin: ORIGIN_AGENT.into(),
            origin_session_id: Some("s1".into()),
            origin_task_id: Some("t1".into()),
        };
        assert!(agent_with_task.validate().is_err());
        let blank = SessionOriginFields {
            origin: ORIGIN_AGENT.into(),
            origin_session_id: Some("  ".into()),
            origin_task_id: None,
        };
        assert!(blank.validate().is_err());
    }

    #[test]
    fn omitted_fields_mean_a_user_conversation() {
        assert_eq!(
            SessionOriginFields::from_params(&json!({ "title": "New task" })).unwrap(),
            SessionOriginFields::user()
        );
        assert_eq!(
            SessionOriginFields::from_params(&json!({
                "origin": "agent",
                "originSessionId": "s1",
                "originTaskId": null
            }))
            .unwrap(),
            SessionOriginFields::from_params(&json!({
                "origin": "agent",
                "originSessionId": "s1"
            }))
            .unwrap()
        );
        assert!(SessionOriginFields::from_params(&json!({ "origin": 7 })).is_err());
    }

    #[test]
    fn an_unrecognized_stored_origin_reads_as_user() {
        assert_eq!(normalize(Some("plugin")), ORIGIN_PLUGIN);
        assert_eq!(normalize(Some("steward")), ORIGIN_USER);
        assert_eq!(normalize(None), ORIGIN_USER);
    }
}
