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
        // Start a task the startup fence interrupted, again (slice 3). It writes
        // a new delivery from the same mandate and re-points the task at it.
        "task.restart" => super::restart::restart(db, input),
        _ => Err(anyhow!("NOT_FOUND: unknown task operation")),
    }
}
