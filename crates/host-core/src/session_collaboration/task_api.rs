//! The `task.*` host surface (ADR bot-sessions-and-steward §7).
//!
//! Four operations, and the same shape as the employee surface: `create` starts
//! one task under one employee, `list` and `get` read, and `archive` ends it.
//! Every one of them is host-owned — a client names *what* it wants, never what
//! the row looks like — so the stage, the origin's meaning, and the archive
//! stamp cannot be forged from the renderer or from a model's tool call.

use crate::db::Database;
use crate::tasks;
use anyhow::{anyhow, Result};
use serde_json::Value;

pub fn handle(db: &Database, method: &str, input: &Value) -> Result<Value> {
    match method {
        "task.create" => tasks::create(db, input),
        "task.list" => tasks::list(db, input),
        "task.get" => tasks::detail(db, input),
        "task.archive" => tasks::archive(db, input),
        // The waiting channel (employee mode 0.5 slice 4a): one structured
        // request at a time, opened by Main when a task session asks something,
        // and closed by whichever surface answered it.
        "task.waiting.open" => tasks::waiting_open(db, input),
        "task.waiting.close" => tasks::waiting_close(db, input),
        // The employee's own structured report that it is stuck.
        "task.report" => tasks::report_blocked(db, input),
        // The same work, as a new card the person can hand to somebody else.
        "task.reassign" => tasks::reassign(db, input),
        // Start a task the startup fence interrupted, again (slice 3). It writes
        // a new delivery from the same mandate and re-points the task at it.
        "task.restart" => super::restart::restart(db, input),
        _ => Err(anyhow!("NOT_FOUND: unknown task operation")),
    }
}
