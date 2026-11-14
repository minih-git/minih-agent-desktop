#![allow(unused_imports)]

pub(crate) use anyhow::{anyhow, Context, Result};
pub(crate) use rusqlite::{params, Connection, OptionalExtension};
pub(crate) use serde::Serialize;
pub(crate) use serde_json::Value;
pub(crate) use std::path::{Path, PathBuf};

/// Current SQLite schema version.
pub const SCHEMA_VERSION: i64 = 40;

/// Absolute approval deadline for a newly submitted Plan or Goal proposal.
pub const PLAN_APPROVAL_TIMEOUT_MS: i64 = 30 * 60 * 1000;

/// Durable notification rows kept globally.
pub const NOTIFICATION_KEEP: i64 = 200;

mod bot_memory_migration;
mod bot_session_migration;
mod conversation_archive_migration;
mod keep_warm_migration;
mod learned_memory_migration;
mod ledger_kind_migration;
mod migrations;
mod model;
mod plugin_providers_migration;
mod project_groups;
mod project_path_migration;
mod prompt_notification_migration;
mod repositories;
mod schema;
mod session_collaboration_migration;
mod session_title_source_migration;
mod steward_name_migration;
mod task_card_draft_migration;
mod task_delivery_migration;
mod task_migration;
mod task_relay_migration;
mod task_waiting_migration;
mod task_workspace_migration;
mod tool_image_storage_migration;
mod worktree_migration;
pub(crate) use bot_memory_migration::{bot_memory_ddl, TASK_EXPERIENCE_COLUMNS};
pub(crate) use bot_session_migration::migrate_v30_to_v31;
pub(crate) use conversation_archive_migration::{migrate_v28_to_v29, CONVERSATION_ARCHIVE_DDL};
pub(crate) use keep_warm_migration::{migrate_v27_to_v28, KEEP_WARM_DDL};
pub(crate) use learned_memory_migration::{migrate_v25_to_v26, LEARNED_MEMORY_DDL};
pub(crate) use migrations::{
    archive_legacy_db, create_migration_backup, migrate_and_validate_top_level_mode,
    migrate_app_settings, migrate_v10_to_v15, migrate_v11_to_v15, migrate_v12_to_v15,
    migrate_v13_to_v15, migrate_v14_to_v15, migrate_v17_to_v18, migrate_v18_to_v19,
    migrate_v19_to_v20, migrate_v20_to_v21, migrate_v7_to_v8, migrate_v8_to_v15, migrate_v9_to_v15,
    migration_backup_path, validate_session_modes,
};
pub(crate) use model::PlanWorkRow;
pub use model::{Database, ProjectMemoryEntryRecord, ProjectMemoryRecord, ProjectRecord};
pub use project_groups::{
    ProjectGroupContextRecord, ProjectGroupRecord, ProjectGroupRoot, RemoteWorkspace,
    PROJECT_MEMORY_TOO_LARGE, REMOTE_PROJECT_PREFIX,
};
pub(crate) use prompt_notification_migration::{migrate_v24_to_v25, NOTIFICATIONS_DDL};
pub(crate) use repositories::{
    canonical_project_path, normalize_project_path, project_display_name,
    strip_obsolete_plan_approval_permission_mode, upsert_project_row, MAX_PROJECT_MEMORY_BYTES,
    OBSOLETE_PLAN_APPROVAL_PERMISSION_MODE,
};
pub(crate) use schema::{PLAN_APPROVALS_SCHEMA, SCHEMA_LATEST, SESSION_TODO_DDL};
pub(crate) use session_title_source_migration::migrate_v22_to_v23;
pub(crate) use task_card_draft_migration::TASK_CARD_DRAFT_DDL;
pub(crate) use task_delivery_migration::{
    migrate_v37_to_v38_tx, task_delivery_ddl, TASK_CARD_BATCH_COLUMNS, TASK_DELIVERY_COLUMNS,
};
pub(crate) use task_migration::{migrate_v32_to_v33_tx, TASKS_DDL};
pub(crate) use task_relay_migration::{
    task_relay_ddl, task_relay_indexes, TASK_CARD_AFTER_COLUMNS, TASK_RELAY_COLUMNS,
};
pub(crate) use task_waiting_migration::{
    migrate_v36_to_v37_tx, task_waiting_ddl, TASK_WAITING_COLUMNS,
};
pub(crate) use task_workspace_migration::{
    migrate_v33_to_v34_tx, task_workspace_ddl, TASK_WORKSPACE_COLUMNS,
};
pub(crate) use worktree_migration::{migrate_v23_to_v24, WORKTREE_DDL};

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Parse an RFC3339 timestamp into epoch ms, falling back to `now`.
pub fn ts_to_ms(value: &str) -> i64 {
    chrono::DateTime::parse_from_rfc3339(value)
        .map(|dt| dt.timestamp_millis())
        .unwrap_or_else(|_| now_ms())
}

/// Epoch ms -> RFC3339 (UTC, `Z` suffix) for the wire format.
pub fn ms_to_ts(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .unwrap_or_else(chrono::Utc::now)
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests;
