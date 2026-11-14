//! Team norms: the rules every employee follows, written by the person
//! (employee mode 0.5 slice 6).
//!
//! Stored in the local key–value table rather than in the application settings
//! record: a norm set is what this computer's employees run under, not a
//! portable preference another build's whole-settings write can overwrite with a
//! stale copy. The stored value carries a version so a later shape can be
//! migrated instead of guessed at, and "empty" is stored as **absence** — a
//! person who clears all three sections has no norms, not three blank ones.
//!
//! Bounds are characters, not bytes: the person's rule is written in their own
//! language, and a limit that bites twice as early in Chinese is not the limit
//! the page shows.

use crate::db::Database;
use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const NAMESPACE: &str = "team";
const KEY: &str = "norms";

/// The shape this module writes. A later shape bumps it and migrates.
pub const NORMS_VERSION: i64 = 1;
/// Characters one section may hold.
pub const MAX_SECTION_CHARS: usize = 1_000;
/// Characters all three sections may hold together.
pub const MAX_TOTAL_CHARS: usize = 2_500;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TeamNorms {
    pub version: i64,
    #[serde(default)]
    pub communication: String,
    #[serde(default)]
    pub scope: String,
    #[serde(default)]
    pub delivery: String,
}

impl TeamNorms {
    fn empty() -> Self {
        Self {
            version: NORMS_VERSION,
            communication: String::new(),
            scope: String::new(),
            delivery: String::new(),
        }
    }

    fn is_empty(&self) -> bool {
        self.communication.trim().is_empty()
            && self.scope.trim().is_empty()
            && self.delivery.trim().is_empty()
    }
}

fn text(value: Option<&Value>) -> String {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default()
        .to_owned()
}

/// Read a stored value, tolerating a shape written by an older or newer build:
/// unknown fields are dropped, a missing section is empty, and a broken row
/// reads as "no norms" instead of failing a whole task turn.
fn read(stored: Option<Value>) -> TeamNorms {
    let Some(value) = stored else {
        return TeamNorms::empty();
    };
    if !value.is_object() {
        return TeamNorms::empty();
    }
    // A version this build does not know is read as far as the fields it shares
    // rather than thrown away: refusing would silently stop injecting a rule the
    // person still expects.
    TeamNorms {
        version: value
            .get("version")
            .and_then(Value::as_i64)
            .unwrap_or(NORMS_VERSION),
        communication: text(value.get("communication")),
        scope: text(value.get("scope")),
        delivery: text(value.get("delivery")),
    }
}

fn checked(value: &Value) -> Result<TeamNorms> {
    if !value.is_object() {
        return Err(anyhow!("INVALID_ARGUMENT: norms must be an object"));
    }
    let norms = TeamNorms {
        version: NORMS_VERSION,
        communication: text(value.get("communication")),
        scope: text(value.get("scope")),
        delivery: text(value.get("delivery")),
    };
    for (name, section) in [
        ("communication", &norms.communication),
        ("scope", &norms.scope),
        ("delivery", &norms.delivery),
    ] {
        if section.chars().count() > MAX_SECTION_CHARS {
            return Err(anyhow!("LIMIT_EXCEEDED: norms.{name} too long"));
        }
    }
    let total = norms.communication.chars().count()
        + norms.scope.chars().count()
        + norms.delivery.chars().count();
    if total > MAX_TOTAL_CHARS {
        return Err(anyhow!("LIMIT_EXCEEDED: norms too long"));
    }
    Ok(norms)
}

/// The stored norms, or an empty set. Never an error: the read rides along every
/// task turn, and a missing row is the initial state, not a failure.
pub fn get(db: &Database) -> Result<Value> {
    let norms = read(db.kv_get(NAMESPACE, KEY)?);
    Ok(json!({ "norms": norms }))
}

/// Replace the norms. An all-blank submission clears the row, which is what the
/// page's "save" does when the person deletes every section.
pub fn set(db: &Database, input: &Value) -> Result<Value> {
    let raw = input
        .get("norms")
        .ok_or_else(|| anyhow!("INVALID_ARGUMENT: norms required"))?;
    let norms = checked(raw)?;
    if norms.is_empty() {
        db.kv_delete(NAMESPACE, KEY)?;
    } else {
        db.kv_set(NAMESPACE, KEY, &serde_json::to_value(&norms)?)?;
    }
    Ok(json!({ "norms": norms }))
}
