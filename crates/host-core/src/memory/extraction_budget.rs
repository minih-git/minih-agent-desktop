//! The extractor's daily token ledger (ADR agent-long-term-memory §4).
//!
//! One local `kv` row holds how much of the user's quota this machine spent
//! today. It sits in its own namespace rather than in the application settings
//! record, so it is neither portable configuration nor a value a renderer's
//! whole-settings snapshot can overwrite with a stale copy, and a local day that
//! has rolled over is not spent — which is what makes "paused until tomorrow"
//! clear itself without a background reset.

use anyhow::Result;
use serde::{Deserialize, Serialize};

use crate::db::Database;

/// The namespace and key the counter lives under.
const BUDGET_NAMESPACE: &str = "memory";
const BUDGET_KEY: &str = "extractionBudget";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractionBudget {
    /// Local calendar day (`YYYY-MM-DD`) the counter belongs to.
    pub day: String,
    /// Tokens this device spent on extraction that day.
    pub tokens: i64,
    /// Runs that spent any tokens that day.
    pub runs: i64,
}

impl Database {
    pub fn memory_extraction_budget(&self) -> Result<ExtractionBudget> {
        let stored = self.kv_get(BUDGET_NAMESPACE, BUDGET_KEY)?;
        match stored {
            Some(value) => Ok(serde_json::from_value(value).unwrap_or_default()),
            None => Ok(ExtractionBudget::default()),
        }
    }

    /// Add one run's usage and return the counter as stored afterwards. A new
    /// local day starts a fresh count instead of carrying yesterday's total.
    pub fn record_memory_extraction_usage(
        &self,
        day: &str,
        tokens: i64,
    ) -> Result<ExtractionBudget> {
        let current = self.memory_extraction_budget()?;
        let same_day = current.day == day;
        let next = ExtractionBudget {
            day: day.to_string(),
            tokens: if same_day {
                current.tokens.saturating_add(tokens.max(0))
            } else {
                tokens.max(0)
            },
            runs: if same_day {
                current.runs.saturating_add(1)
            } else {
                1
            },
        };
        self.kv_set(BUDGET_NAMESPACE, BUDGET_KEY, &serde_json::to_value(&next)?)?;
        Ok(next)
    }
}
