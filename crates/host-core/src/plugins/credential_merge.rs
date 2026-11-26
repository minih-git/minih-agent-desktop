//! What an edit means for the values it did not submit.
//!
//! A stored secret never leaves the host, so an edit form shows an empty box for
//! it. Empty therefore means "keep what is saved", not "clear it": an app
//! password from Gmail or QQ is shown once, when it is generated, and a user who
//! is only adding a proxy no longer has it. Deciding that is a step of its own —
//! between the submission and the validation that writes each value — so it
//! lives here rather than inside the storage paths that call it.
//!
//! Only declared `secret` fields and the proxy login are merged. Every other
//! value is authoritative in the submission, which is what keeps the promise
//! that a plugin cannot redirect a password: the servers a save records are the
//! ones the user just typed in the host's own form.

use std::collections::BTreeMap;

use serde_json::{Map, Value};

use super::credentials::DeclaredSlot;
use super::user_proxy;

/// Whether a submitted value is absent or blank.
fn is_blank(field: Option<&Value>) -> bool {
    match field.and_then(Value::as_str) {
        Some(value) => value.trim().is_empty(),
        // A value that is not a string is left for the validator to name.
        None => field.is_none(),
    }
}

/// Carry the saved secrets over the boxes the user left empty.
///
/// The proxy is a switch plus a pair:
///
/// * choosing no type means this account has no proxy, so the other four
///   reserved keys are dropped — which is also how a saved login is cleared;
/// * a chosen type with both credential boxes empty keeps the saved login;
/// * a chosen type with one of the two filled is left alone, so the existing
///   all-or-nothing rule reports it.
pub(crate) fn keep_saved_secrets(
    slot: &DeclaredSlot,
    submitted: &mut Map<String, Value>,
    previous: Option<&BTreeMap<String, String>>,
) {
    // Turning the proxy off is a complete statement about the account's route:
    // the form may still hold the address it showed a moment ago, and the saved
    // login goes with it. A submission that never had a proxy is left alone, so
    // the existing "a proxy needs a type" refusal still applies to it.
    let had_proxy = previous
        .and_then(|fields| fields.get(user_proxy::TYPE))
        .is_some_and(|kind| !kind.trim().is_empty());
    if !slot.user_proxy_types.is_empty() && had_proxy && is_blank(submitted.get(user_proxy::TYPE)) {
        for key in user_proxy::RESERVED_KEYS {
            submitted.remove(key);
        }
    }
    let Some(previous) = previous else {
        return;
    };
    for field in slot.fields.iter().filter(|field| field.secret) {
        if !is_blank(submitted.get(&field.key)) {
            continue;
        }
        let Some(saved) = previous.get(&field.key) else {
            continue;
        };
        if saved.trim().is_empty() {
            continue;
        }
        submitted.insert(field.key.clone(), Value::String(saved.clone()));
    }
    if slot.user_proxy_types.is_empty() || is_blank(submitted.get(user_proxy::TYPE)) {
        return;
    }
    let username_blank = is_blank(submitted.get(user_proxy::USERNAME));
    let password_blank = is_blank(submitted.get(user_proxy::PASSWORD));
    if !(username_blank && password_blank) {
        return;
    }
    let saved_username = previous
        .get(user_proxy::USERNAME)
        .map(|value| value.trim())
        .unwrap_or_default();
    if saved_username.is_empty() {
        return;
    }
    let saved_password = previous
        .get(user_proxy::PASSWORD)
        .cloned()
        .unwrap_or_default();
    submitted.insert(
        user_proxy::USERNAME.to_string(),
        Value::String(saved_username.to_string()),
    );
    submitted.insert(
        user_proxy::PASSWORD.to_string(),
        Value::String(saved_password),
    );
}
