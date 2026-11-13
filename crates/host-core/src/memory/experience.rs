//! Employee experience: the lessons one task leaves for the next one of its
//! kind (employee mode 0.5 slice 5).
//!
//! The layer sits on the learned-memory rules rather than beside them: a lesson
//! is a `bot`-scoped entry, so the credential detector, the fingerprint
//! deduplication, and the tombstones that make a delete stick all apply
//! unchanged. What is new is *when* it is written and *what it is worth*:
//!
//! - **One run per task, at archive time.** Archiving stamps
//!   `tasks.experience_json = pending` in the same transaction that stamps
//!   `archived_at`, so every archive path — the person's own click, the merge
//!   cleanup of slice 4b, the abandoned blocked card — owes exactly one
//!   extraction. Main drains the pending rows, so a restart between the stamp and
//!   the run loses nothing, and `done` is terminal: a second completion is
//!   refused, not appended to.
//! - **A lesson is reference, never a claim.** Entries are `evidence: inferred`,
//!   `origin: extracted`, `status: active`, and the extractor is told to write
//!   what a next task could use — this repository's trap, the command that
//!   worked, the reason the last attempt failed — not what the task did.
//! - **Failure never touches the archive.** A model error, an exhausted budget,
//!   or a host failure leaves the task archived and records a code plus an
//!   attempt count; the next start tries again, up to
//!   [`EXPERIENCE_MAX_ATTEMPTS`].
//!
//! Only codes and counts are ever logged; the text of a lesson stays in the
//! database the person can read and delete.

use anyhow::{anyhow, Result};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::extraction_input::{truncate_to_bytes, EXTRACTION_INPUT_MAX_BYTES};
use super::model::*;
use super::repository::CreateMemoryOutcome;
use crate::db::{ms_to_ts, now_ms, Database};

/// Consecutive failures after which one task stops being retried.
pub const EXPERIENCE_MAX_ATTEMPTS: i64 = 3;
/// Most lessons one task may leave.
pub const EXPERIENCE_MAX_ENTRIES: usize = 3;
/// Longest one lesson may be, in characters (the brief's 300 字).
pub const EXPERIENCE_MAX_CONTENT_CHARS: usize = 300;
/// Accounting overhead per transcript line, the same idea as the session
/// extractor's per-message overhead.
const MESSAGE_OVERHEAD_BYTES: usize = 48;

pub const EXPERIENCE_PENDING: &str = "pending";
pub const EXPERIENCE_DONE: &str = "done";
pub const EXPERIENCE_RUNNING: &str = "running";
pub const EXPERIENCE_SKIPPED_DISABLED: &str = "skipped:disabled";
pub const EXPERIENCE_EXHAUSTED: &str = "exhausted";
pub const EXPERIENCE_FAILED_PREFIX: &str = "failed:";

/// The stored state of one task's extraction.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExperienceState {
    pub status: String,
    /// Failed runs so far. Reset only by a successful `done`.
    #[serde(default)]
    pub attempts: i64,
    /// The entries this task wrote, so the manager can show where a lesson came
    /// from without a second table.
    #[serde(default)]
    pub entry_ids: Vec<String>,
    /// When the state last moved, epoch milliseconds.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub at: Option<i64>,
    /// A stable code, never text from the transcript.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl ExperienceState {
    pub fn status_of(raw: Option<&str>) -> Self {
        raw.and_then(|raw| serde_json::from_str(raw).ok())
            .unwrap_or_default()
    }

    fn is_pending(&self) -> bool {
        self.status == EXPERIENCE_PENDING
            || self.status == EXPERIENCE_RUNNING
            || (self.status.starts_with(EXPERIENCE_FAILED_PREFIX)
                && self.attempts < EXPERIENCE_MAX_ATTEMPTS)
    }

    pub fn is_done(&self) -> bool {
        self.status == EXPERIENCE_DONE
    }
}

/// One archived task that still owes its lessons.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingExperience {
    pub task_id: String,
    pub employee_session_id: String,
    pub session_id: String,
    pub title: String,
    pub status: String,
    pub attempts: i64,
}

/// One transcript line the extractor may read.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExperienceMessage {
    pub role: String,
    pub text: String,
    pub truncated: bool,
}

/// The facts of one finished task, plus as much of its transcript as fits the
/// same budget the session extractor uses.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExperienceInput {
    pub task_id: String,
    pub short_id: String,
    pub title: String,
    pub employee_session_id: String,
    pub employee_name: String,
    pub session_id: String,
    pub project_path: Option<String>,
    pub branch: Option<String>,
    pub stage: String,
    pub origin: String,
    pub result: Option<serde_json::Value>,
    pub blocker: Option<serde_json::Value>,
    pub messages: Vec<ExperienceMessage>,
    pub bytes: usize,
    /// True when the transcript was cut to fit: the older lines were dropped and
    /// the model is told so, because a lesson drawn from a half-read task is
    /// still useful but must not be trusted blindly.
    pub truncated: bool,
}

/// What the extractor proposes. Kinds are limited to the two that are not about
/// the person: a lesson is never a `preference` or `feedback`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExperienceCandidate {
    pub kind: String,
    pub content: String,
    #[serde(default)]
    pub rationale: Option<String>,
}

/// The outcome of one completion, as a value: a refusal is not an error.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExperienceComplete {
    pub stored: usize,
    pub refused: usize,
    pub duplicate: usize,
    pub entry_ids: Vec<String>,
    /// True when the task was already done and nothing was written.
    pub already_done: bool,
}

fn read_state(
    conn: &rusqlite::Connection,
    task_id: &str,
) -> Result<Option<(ExperienceState, String)>> {
    let row: Option<(Option<String>, String)> = conn
        .query_row(
            "SELECT experience_json, employee_session_id FROM tasks WHERE id = ?1",
            params![task_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    Ok(row.map(|(raw, employee)| (ExperienceState::status_of(raw.as_deref()), employee)))
}

fn write_state(conn: &rusqlite::Connection, task_id: &str, state: &ExperienceState) -> Result<()> {
    conn.execute(
        "UPDATE tasks SET experience_json = ?2 WHERE id = ?1",
        params![task_id, serde_json::to_string(state)?],
    )?;
    Ok(())
}

/// Stamp the archive's own promise: this task owes one extraction.
///
/// Called inside the archive transaction, so a task that is archived but not
/// stamped cannot exist.
pub(crate) fn stamp_pending_tx(conn: &rusqlite::Connection, task_id: &str) -> Result<()> {
    let mut state = ExperienceState::status_of(None);
    state.status = EXPERIENCE_PENDING.into();
    state.at = Some(now_ms());
    write_state(conn, task_id, &state)
}

/// Whether a lesson's text is acceptable: a bound and a non-empty body. The
/// content rules themselves stay in `validation`, which every writer shares.
fn normalise_candidate(candidate: &ExperienceCandidate) -> Option<(String, Option<String>)> {
    let content = candidate.content.trim();
    if content.is_empty() {
        return None;
    }
    if !matches!(candidate.kind.as_str(), KIND_FACT | KIND_REFERENCE) {
        return None;
    }
    let cut: String = content.chars().take(EXPERIENCE_MAX_CONTENT_CHARS).collect();
    let rationale = candidate
        .rationale
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.chars().take(MAX_RATIONALE_BYTES).collect::<String>());
    Some((cut, rationale))
}

impl Database {
    /// Every archived task that still owes its lessons, oldest first.
    pub fn experience_pending(&self, limit: i64) -> Result<Vec<PendingExperience>> {
        let mut statement = self.conn().prepare_cached(
            "SELECT id, employee_session_id, session_id, title, experience_json
               FROM tasks
              WHERE archived_at IS NOT NULL AND experience_json IS NOT NULL
              ORDER BY archived_at ASC, id ASC
              LIMIT ?1",
        )?;
        let rows = statement
            .query_map(params![limit.clamp(1, 200)], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<String>>(4)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut pending = Vec::new();
        for (task_id, employee, session_id, title, raw) in rows {
            let state = ExperienceState::status_of(raw.as_deref());
            if !state.is_pending() {
                continue;
            }
            pending.push(PendingExperience {
                task_id,
                employee_session_id: employee,
                session_id,
                title,
                status: state.status.clone(),
                attempts: state.attempts,
            });
        }
        Ok(pending)
    }

    /// Claim one task for this run. A task already `done` is refused, and a
    /// `running` stamp older than the lease is taken over, so a run killed by a
    /// restart does not strand its task.
    pub fn experience_claim(
        &self,
        task_id: &str,
        lease_ms: i64,
    ) -> Result<Option<ExperienceState>> {
        let Some((state, _)) = read_state(self.conn(), task_id)? else {
            return Ok(None);
        };
        if !state.is_pending() {
            return Ok(None);
        }
        if state.status == EXPERIENCE_RUNNING
            && state.at.is_some_and(|at| now_ms() - at < lease_ms.max(0))
        {
            return Ok(None);
        }
        let mut claimed = state;
        claimed.status = EXPERIENCE_RUNNING.into();
        claimed.at = Some(now_ms());
        write_state(self.conn(), task_id, &claimed)?;
        Ok(Some(claimed))
    }

    /// What the extractor may read, or `None` when the task or its employee is
    /// gone.
    pub fn experience_input(&self, task_id: &str) -> Result<Option<ExperienceInput>> {
        let row: Option<(
            String,
            String,
            Option<String>,
            Option<String>,
            String,
            String,
            Option<String>,
            Option<String>,
            String,
            Option<String>,
        )> = self
            .conn()
            .query_row(
                "SELECT t.title, t.session_id, t.branch, t.blocker_json, t.stage, t.origin,
                        t.result_json, p.path, t.employee_session_id, t.experience_json
                   FROM tasks t
                   LEFT JOIN projects p ON p.id = t.project_id
                  WHERE t.id = ?1",
                params![task_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
                        row.get(7)?,
                        row.get(8)?,
                        row.get(9)?,
                    ))
                },
            )
            .optional()?;
        let Some((
            title,
            session_id,
            branch,
            blocker_json,
            stage,
            origin,
            result_json,
            project_path,
            employee,
            _state,
        )) = row
        else {
            return Ok(None);
        };
        // A task with no state and no archive is not this path's business.
        let employee_name: Option<String> = self
            .conn()
            .query_row(
                "SELECT json_extract(bot_profile_json, '$.name') FROM sessions WHERE id = ?1",
                params![employee],
                |row| row.get(0),
            )
            .optional()?
            .flatten();

        let (messages, bytes, truncated) = self.experience_transcript(&session_id)?;
        Ok(Some(ExperienceInput {
            task_id: task_id.to_string(),
            short_id: crate::tasks::short_id(task_id),
            title,
            employee_session_id: employee.clone(),
            employee_name: employee_name.unwrap_or_else(|| "the employee".into()),
            session_id,
            project_path,
            branch,
            stage,
            origin,
            result: result_json.and_then(|raw| serde_json::from_str(&raw).ok()),
            blocker: blocker_json.and_then(|raw| serde_json::from_str(&raw).ok()),
            messages,
            bytes,
            truncated,
        }))
    }

    /// The tail of one task's transcript, inside the session extractor's byte
    /// budget.
    ///
    /// The tail, not the head: a task's most useful lesson is usually why the
    /// last attempt failed and what finally worked, and those are at the end.
    /// Assistant text is included because the agent's own steps are the
    /// material — the person's preference is not what this run is for.
    fn experience_transcript(
        &self,
        session_id: &str,
    ) -> Result<(Vec<ExperienceMessage>, usize, bool)> {
        let mut statement = self.conn().prepare_cached(
            "SELECT role, text FROM messages
              WHERE session_id = ?1
                AND role IN ('user', 'assistant')
                AND text IS NOT NULL AND TRIM(text) <> ''
              ORDER BY seq DESC",
        )?;
        let rows = statement
            .query_map(params![session_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut bytes = 0usize;
        let mut kept: Vec<ExperienceMessage> = Vec::new();
        let mut truncated = false;
        for (role, text) in rows {
            let cost = text.len() + MESSAGE_OVERHEAD_BYTES;
            if bytes + cost > EXTRACTION_INPUT_MAX_BYTES {
                if kept.is_empty() {
                    // The single most recent line may itself be over budget: it is
                    // cut, because sending nothing would spend a model call to
                    // learn nothing.
                    if let Some(budget) =
                        EXTRACTION_INPUT_MAX_BYTES.checked_sub(MESSAGE_OVERHEAD_BYTES)
                    {
                        let (text, _) = truncate_to_bytes(&text, budget);
                        if !text.is_empty() {
                            bytes += text.len() + MESSAGE_OVERHEAD_BYTES;
                            kept.push(ExperienceMessage {
                                role,
                                text,
                                truncated: true,
                            });
                        }
                    }
                }
                truncated = true;
                break;
            }
            bytes += cost;
            kept.push(ExperienceMessage {
                role,
                text,
                truncated: false,
            });
        }
        kept.reverse();
        Ok((kept, bytes, truncated))
    }

    /// Write the lessons one task produced, and mark it done.
    ///
    /// The write goes through [`Database::create_memory_entry`], so secrets,
    /// fingerprints, and tombstones behave exactly as they do for any other
    /// entry. `done` is terminal: a second run finds a finished task and writes
    /// nothing.
    pub fn experience_complete(
        &self,
        task_id: &str,
        candidates: &[ExperienceCandidate],
    ) -> Result<ExperienceComplete> {
        let Some((state, employee)) = read_state(self.conn(), task_id)? else {
            return Err(anyhow!("NOT_FOUND: task"));
        };
        if state.is_done() {
            return Ok(ExperienceComplete {
                stored: 0,
                refused: 0,
                duplicate: 0,
                entry_ids: state.entry_ids,
                already_done: true,
            });
        }
        let session_id: Option<String> = self
            .conn()
            .query_row(
                "SELECT session_id FROM tasks WHERE id = ?1",
                params![task_id],
                |row| row.get(0),
            )
            .optional()?;
        let Some(session_id) = session_id else {
            return Err(anyhow!("NOT_FOUND: task"));
        };
        let scope = MemoryScope::bot(employee);
        let mut complete = ExperienceComplete {
            stored: 0,
            refused: 0,
            duplicate: 0,
            entry_ids: Vec::new(),
            already_done: false,
        };
        for candidate in candidates.iter().take(EXPERIENCE_MAX_ENTRIES) {
            let Some((content, rationale)) = normalise_candidate(candidate) else {
                complete.refused += 1;
                continue;
            };
            let outcome = self.create_memory_entry(super::repository::CreateMemoryRequest {
                scope: scope.clone(),
                kind: candidate.kind.clone(),
                content,
                rationale,
                origin: ORIGIN_EXTRACTED.into(),
                evidence: EVIDENCE_INFERRED.into(),
                status: STATUS_ACTIVE.into(),
                source_session_id: Some(session_id.clone()),
                source_message_ids: Vec::new(),
                override_tombstone: false,
            })?;
            match outcome {
                CreateMemoryOutcome::Created(entry) => {
                    complete.stored += 1;
                    complete.entry_ids.push(entry.id);
                }
                CreateMemoryOutcome::Duplicate(entry) => {
                    // A lesson the employee already holds is not a new one; the
                    // task still cites it, so the section lists it once.
                    complete.duplicate += 1;
                    if !complete.entry_ids.contains(&entry.id) {
                        complete.entry_ids.push(entry.id);
                    }
                }
                CreateMemoryOutcome::Rejected(_) => complete.refused += 1,
            }
        }
        let mut done = state;
        done.status = EXPERIENCE_DONE.into();
        done.at = Some(now_ms());
        done.error = None;
        done.entry_ids.extend(complete.entry_ids.iter().cloned());
        done.entry_ids.sort();
        done.entry_ids.dedup();
        write_state(self.conn(), task_id, &done)?;
        Ok(complete)
    }

    /// Record a failed run: one attempt more, and the reason as a stable code.
    pub fn experience_fail(&self, task_id: &str, code: &str) -> Result<ExperienceState> {
        let Some((state, _)) = read_state(self.conn(), task_id)? else {
            return Err(anyhow!("NOT_FOUND: task"));
        };
        let mut failed = state;
        failed.attempts += 1;
        failed.at = Some(now_ms());
        failed.error = Some(code.chars().take(MAX_EXTRACTION_ERROR_CHARS).collect());
        failed.status = if failed.attempts >= EXPERIENCE_MAX_ATTEMPTS {
            EXPERIENCE_EXHAUSTED.into()
        } else {
            format!("{EXPERIENCE_FAILED_PREFIX}{code}")
        };
        write_state(self.conn(), task_id, &failed)?;
        Ok(failed)
    }

    /// The switch is off: remember that this task was not learned from, and do
    /// not call a model for it.
    pub fn experience_skip(&self, task_id: &str) -> Result<ExperienceState> {
        let Some((state, _)) = read_state(self.conn(), task_id)? else {
            return Err(anyhow!("NOT_FOUND: task"));
        };
        let mut skipped = state;
        if skipped.is_done() {
            return Ok(skipped);
        }
        skipped.status = EXPERIENCE_SKIPPED_DISABLED.into();
        skipped.at = Some(now_ms());
        write_state(self.conn(), task_id, &skipped)?;
        Ok(skipped)
    }

    /// One employee's lessons, newest first, each with the task it came from.
    pub fn experience_list(&self, employee_session_id: &str) -> Result<Vec<serde_json::Value>> {
        let scope = MemoryScope::bot(employee_session_id);
        let entries =
            self.list_memory_entries(&scope, Some(STATUS_ACTIVE), None, MAX_LIST_LIMIT, 0)?;
        let mut items = Vec::with_capacity(entries.len());
        for entry in entries {
            // A lesson's source is the task session it was extracted from; the
            // task row names the short id the person sees.
            let source: Option<(String, String, Option<i64>)> = match entry
                .source_session_id
                .as_deref()
            {
                Some(session_id) => self
                    .conn()
                    .query_row(
                        "SELECT t.id, t.title, t.archived_at FROM tasks t WHERE t.session_id = ?1",
                        params![session_id],
                        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                    )
                    .optional()?,
                None => None,
            };
            let mut value = serde_json::to_value(&entry)?;
            if let Some((task_id, task_title, archived_at)) = source {
                if let Some(object) = value.as_object_mut() {
                    object.insert("sourceTaskId".into(), serde_json::json!(task_id));
                    object.insert(
                        "sourceTaskShortId".into(),
                        serde_json::json!(crate::tasks::short_id(&task_id)),
                    );
                    object.insert("sourceTaskTitle".into(), serde_json::json!(task_title));
                    object.insert(
                        "sourceTaskArchivedAt".into(),
                        serde_json::json!(archived_at.map(ms_to_ts)),
                    );
                }
            }
            items.push(value);
        }
        Ok(items)
    }

    /// An employee left: its lessons go to `archived`, never to the tombstone —
    /// dismissing an employee is not forgetting what it knew, and a re-hired
    /// employee with the same session keeps its history.
    pub fn archive_employee_experience(&self, employee_session_id: &str) -> Result<usize> {
        let changed = self.conn().execute(
            "UPDATE memory_entries SET status = 'archived', updated_at = ?2
              WHERE scope_kind = ?1 AND IFNULL(scope_key, '') = ?3 AND status <> 'archived'",
            params![SCOPE_BOT, now_ms(), employee_session_id],
        )?;
        Ok(changed)
    }
}
