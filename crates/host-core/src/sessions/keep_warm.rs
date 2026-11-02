//! Durable record of session cache keep-warm (ADR 0412).
//!
//! A keep-warm request belongs to no turn. It is a paid provider request the
//! host sends to refresh a session's prompt cache while the user is away, and
//! the turn ledger has nowhere to put it: `turns.usage_json` is keyed by a turn
//! row, `usage.listTurns` reads that ledger, and the transcript is what the user
//! reads. Inventing a turn to hold the cost would put a row in both, which is
//! exactly what this feature must not do.
//!
//! So the spend gets its own table. It is append-only, one row per session
//! attempt with a known outcome, written through the session domain service and
//! never by a plugin. Old databases keep working: the table is created by a
//! migration and an empty one changes no number in any existing query.

use anyhow::{anyhow, Result};
use rusqlite::params;
use serde_json::{json, Value};

use crate::db::{ms_to_ts, now_ms, Database};

/// The name of one keep-warm attempt's outcome, mirrored by the shared contract.
const STATUSES: [&str; 3] = ["warmed", "failed", "skipped"];

/// One attempt as the host reports it to the ledger.
pub struct KeepWarmRecordInput<'a> {
    pub session_id: &'a str,
    pub status: &'a str,
    pub reason: Option<&'a str>,
    pub provider_id: Option<&'a str>,
    pub model_id: Option<&'a str>,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_write_tokens: i64,
    pub cache_read_ratio: Option<f64>,
    pub cost_usd: Option<f64>,
    pub duration_ms: i64,
}

fn non_negative(value: i64) -> i64 {
    value.max(0)
}

/// Append one attempt, or refuse when the session is gone.
///
/// A deleted session must not be recreated by a late write: the row would point
/// at a session nobody can open, and the daily total of a session that no longer
/// exists would still be counted in the application's history. `false` means the
/// attempt was dropped for exactly that reason.
pub fn record(db: &Database, input: &KeepWarmRecordInput<'_>, ts: i64) -> Result<bool> {
    if !STATUSES.contains(&input.status) {
        return Err(anyhow!("unknown keep-warm status"));
    }
    let exists: bool = db
        .conn()
        .query_row(
            "SELECT 1 FROM sessions WHERE id = ?1 AND deleted_at IS NULL",
            params![input.session_id],
            |_| Ok(true),
        )
        .unwrap_or(false);
    if !exists {
        return Ok(false);
    }
    let cost = input
        .cost_usd
        .filter(|value| value.is_finite() && *value >= 0.0);
    db.conn().execute(
        "INSERT INTO keep_warm_usage (
             id, session_id, status, reason, provider_id, model_id,
             input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
             cache_read_ratio, cost_usd, duration_ms, created_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
        params![
            uuid::Uuid::new_v4().to_string(),
            input.session_id,
            input.status,
            input.reason,
            input.provider_id,
            input.model_id,
            non_negative(input.input_tokens),
            non_negative(input.output_tokens),
            non_negative(input.cache_read_tokens),
            non_negative(input.cache_write_tokens),
            input
                .cache_read_ratio
                .filter(|value| value.is_finite())
                .map(|value| value.clamp(0.0, 1.0)),
            cost,
            non_negative(input.duration_ms),
            ts,
        ],
    )?;
    Ok(true)
}

/// What one session spent on keep-warm between two instants, inclusive.
///
/// The plugin's daily ceiling is checked against this, so the answer counts only
/// requests that actually reached a provider: a skipped attempt has no cost and
/// a failed one is reported as what the provider charged before it failed.
pub fn session_totals(db: &Database, session_id: &str, from_ms: i64, to_ms: i64) -> Result<Value> {
    let conn = db.conn();
    let mut stmt = conn.prepare_cached(
        "SELECT
             COUNT(*),
             COALESCE(SUM(cache_read_tokens + cache_write_tokens + input_tokens), 0),
             COALESCE(SUM(output_tokens), 0),
             COALESCE(SUM(cost_usd), 0.0),
             COALESCE(MAX(created_at), 0)
         FROM keep_warm_usage
         WHERE session_id = ?1 AND created_at >= ?2 AND created_at <= ?3
           AND status <> 'skipped'",
    )?;
    let (attempts, prompt_tokens, output_tokens, cost_usd, last_at) =
        stmt.query_row(params![session_id, from_ms, to_ms], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, f64>(3)?,
                row.get::<_, i64>(4)?,
            ))
        })?;
    Ok(json!({
        "sessionId": session_id,
        "fromMs": from_ms,
        "toMs": to_ms,
        "attempts": attempts,
        "promptTokens": prompt_tokens,
        "outputTokens": output_tokens,
        "costUsd": cost_usd,
        "lastAt": if last_at > 0 { Value::String(ms_to_ts(last_at)) } else { Value::Null },
    }))
}

/// Begin-of-day in epoch milliseconds for the machine's local calendar.
///
/// The ceiling the plugin enforces is a spending day, not a UTC day: a user in
/// UTC+8 who is told "today" means their own midnight.
pub fn local_day_start_ms(at_ms: i64) -> i64 {
    let Some(local) =
        chrono::DateTime::from_timestamp_millis(at_ms).map(|at| at.with_timezone(&chrono::Local))
    else {
        return now_ms();
    };
    local
        .date_naive()
        .and_hms_opt(0, 0, 0)
        .and_then(|start| start.and_local_timezone(chrono::Local).single())
        .map(|start| start.timestamp_millis())
        .unwrap_or(at_ms)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sessions::{create_session, delete_session};

    fn temp_db() -> (std::path::PathBuf, Database) {
        let dir = std::env::temp_dir().join(format!("pi-keep-warm-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = Database::open(&dir.join("test.sqlite")).unwrap();
        (dir, db)
    }

    fn warmed(session_id: &str, cost: f64) -> KeepWarmRecordInput<'_> {
        KeepWarmRecordInput {
            session_id,
            status: "warmed",
            reason: None,
            provider_id: Some("router"),
            model_id: Some("claude"),
            input_tokens: 120,
            output_tokens: 4,
            cache_read_tokens: 48_000,
            cache_write_tokens: 900,
            cache_read_ratio: Some(0.98),
            cost_usd: Some(cost),
            duration_ms: 640,
        }
    }

    #[test]
    fn attempts_are_counted_per_session_and_day() {
        let (dir, db) = temp_db();
        let session = create_session(&db, None, None, None, None, None).unwrap();
        let other = create_session(&db, None, None, None, None, None).unwrap();
        let now = now_ms();
        assert!(record(&db, &warmed(&session.id, 0.02), now).unwrap());
        assert!(record(&db, &warmed(&session.id, 0.03), now).unwrap());
        assert!(record(&db, &warmed(&other.id, 0.5), now).unwrap());
        let today = session_totals(&db, &session.id, local_day_start_ms(now), now + 1).unwrap();
        assert_eq!(today["attempts"], 2);
        assert_eq!(today["costUsd"], 0.05);
        let yesterday = session_totals(&db, &session.id, 0, now - 1).unwrap();
        assert_eq!(yesterday["attempts"], 0);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_skipped_attempt_costs_nothing_and_a_deleted_session_takes_no_rows() {
        let (dir, db) = temp_db();
        let session = create_session(&db, None, None, None, None, None).unwrap();
        let now = now_ms();
        let mut skipped = warmed(&session.id, 0.0);
        skipped.status = "skipped";
        skipped.reason = Some("prefix_changed");
        skipped.cache_read_tokens = 0;
        skipped.cache_write_tokens = 0;
        skipped.cost_usd = None;
        assert!(record(&db, &skipped, now).unwrap());
        let totals = session_totals(&db, &session.id, 0, now + 1).unwrap();
        assert_eq!(totals["attempts"], 0);
        delete_session(&db, &session.id).unwrap();
        assert!(!record(&db, &warmed(&session.id, 0.1), now).unwrap());
        let rows: i64 = db
            .conn()
            .query_row("SELECT COUNT(*) FROM keep_warm_usage", [], |row| row.get(0))
            .unwrap();
        assert_eq!(rows, 0);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn an_unknown_status_is_refused() {
        let (dir, db) = temp_db();
        let session = create_session(&db, None, None, None, None, None).unwrap();
        let mut bad = warmed(&session.id, 0.1);
        bad.status = "maybe";
        assert!(record(&db, &bad, now_ms()).is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
