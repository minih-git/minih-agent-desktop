use crate::db::{now_ms, Database};
use anyhow::Result;

fn bound_tasks(db: &Database, path: &str) -> Result<Vec<super::ScheduledTask>> {
    let path = db.stored_project_path(path)?;
    // Display/runtime task records canonicalize workspacePath for execution.
    // Project removal must instead compare the original stored identities, so
    // a historical link retarget cannot select another project's automation.
    let mut statement = db
        .conn()
        .prepare("SELECT id,config_json FROM scheduled_tasks")?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut ids = std::collections::HashSet::new();
    for (id, raw) in rows {
        let config = super::config_json_value(&raw);
        let Some(binding) = config
            .get("workspacePath")
            .and_then(serde_json::Value::as_str)
        else {
            continue;
        };
        if path.is_some() && db.stored_project_path(binding)? == path {
            ids.insert(id);
        }
    }
    Ok(super::list_tasks(db)?
        .into_iter()
        .filter(|task| ids.contains(&task.id))
        .collect())
}

/// Admission owns a task before its session has opened a turn.
pub fn has_running_tasks(db: &Database, path: &str) -> Result<bool> {
    for task in bound_tasks(db, path)? {
        if super::automation::running(db, &task.id)? {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Keep definitions and history, but require explicit user action to run again.
pub fn pause(db: &Database, path: &str) -> Result<()> {
    let tasks = bound_tasks(db, path)?;
    let transaction = db.conn().unchecked_transaction()?;
    for task in tasks {
        transaction.execute(
            "UPDATE scheduled_tasks SET enabled = 0, updated_at = ?1 WHERE id = ?2",
            rusqlite::params![now_ms(), task.id],
        )?;
    }
    transaction.commit()?;
    Ok(())
}
