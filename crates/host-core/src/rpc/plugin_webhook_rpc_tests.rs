//! Tests for the `plugin_webhook_rpc` surface.
//!
//! Every test opens its own temporary database, so no test can read or edit the
//! host's own delivery log, and each one exercises the methods through the
//! `plugin.webhook.` entry point the router calls.
use super::handle;
use crate::db::{now_ms, Database};
use crate::rpc::JsonRpcError;
use serde_json::{json, Value};

fn open() -> (tempfile::TempDir, Database) {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    (dir, db)
}

fn call(db: &Database, method: &str, params: Value) -> Result<Value, JsonRpcError> {
    handle(db, method, params)
}

fn error_code(error: &JsonRpcError) -> String {
    error
        .data
        .as_ref()
        .and_then(|data| data.get("errorCode"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn record(db: &Database, plugin_id: &str, webhook_id: &str, extra: Value) -> Value {
    let mut params = json!({ "pluginId": plugin_id, "webhookId": webhook_id });
    for (key, value) in extra.as_object().unwrap() {
        params[key] = value.clone();
    }
    call(db, "plugin.webhook.recordEvent", params).unwrap()
}

fn event_ids(page: &Value) -> Vec<String> {
    page["events"]
        .as_array()
        .unwrap()
        .iter()
        .map(|event| event["eventId"].as_str().unwrap().to_string())
        .collect()
}

#[test]
fn accepted_events_replay_until_acknowledged_and_never_after() {
    let (_dir, db) = open();
    let first = record(
        &db,
        "plugin.one",
        "gitea",
        json!({ "eventId": "evt-1", "receivedAt": 1_000, "sourceIp": "127.0.0.1", "bodyRef": "webhook-1.json" }),
    );
    assert_eq!(first["duplicate"], json!(false));
    assert_eq!(first["event"]["deliveredAt"], Value::Null);
    assert_eq!(first["event"]["bodyRef"], json!("webhook-1.json"));
    let second = record(
        &db,
        "plugin.one",
        "gitea",
        json!({ "eventId": "evt-2", "receivedAt": 2_000 }),
    );
    assert!(second["event"]["eventId"].is_string());

    // Both are owed, oldest first, and the older receipt is the first
    // thing a replay hands out.
    let page = call(
        &db,
        "plugin.webhook.pending",
        json!({ "pluginId": "plugin.one" }),
    )
    .unwrap();
    assert_eq!(event_ids(&page), vec!["evt-1", "evt-2"]);
    assert_eq!(page["hasMore"], json!(false));

    let acked = call(
        &db,
        "plugin.webhook.markDelivered",
        json!({ "eventId": "evt-1", "pluginId": "plugin.one", "deliveredAt": 3_000 }),
    )
    .unwrap();
    assert_eq!(acked["delivered"], json!(true));
    assert_eq!(acked["deliveredAt"], json!(3_000));

    // Acknowledged means excluded from replay.
    let page = call(
        &db,
        "plugin.webhook.pending",
        json!({ "pluginId": "plugin.one" }),
    )
    .unwrap();
    assert_eq!(event_ids(&page), vec!["evt-2"]);

    // A retried acknowledgement keeps the first timestamp.
    let again = call(
        &db,
        "plugin.webhook.markDelivered",
        json!({ "eventId": "evt-1", "deliveredAt": 4_000 }),
    )
    .unwrap();
    assert_eq!(again["delivered"], json!(false));
    assert_eq!(again["deliveredAt"], json!(3_000));
}

#[test]
fn recording_the_same_event_twice_keeps_one_row_and_its_acknowledgement() {
    let (_dir, db) = open();
    let stored = record(
        &db,
        "plugin.one",
        "gitea",
        json!({ "eventId": "evt-1", "bodyRef": "first.json", "receivedAt": 1_000 }),
    );
    assert_eq!(stored["duplicate"], json!(false));
    call(
        &db,
        "plugin.webhook.markDelivered",
        json!({ "eventId": "evt-1" }),
    )
    .unwrap();

    // The accept step is retried after a lost response: still one event,
    // still acknowledged, and the first stored facts are the ones kept.
    let retried = record(
        &db,
        "plugin.one",
        "gitea",
        json!({ "eventId": "evt-1", "bodyRef": "second.json", "receivedAt": 9_000 }),
    );
    assert_eq!(retried["duplicate"], json!(true));
    assert_eq!(retried["event"]["bodyRef"], json!("first.json"));
    assert_eq!(retried["event"]["receivedAt"], json!(1_000));
    assert!(retried["event"]["deliveredAt"].as_i64().is_some());
    let page = call(
        &db,
        "plugin.webhook.pending",
        json!({ "pluginId": "plugin.one" }),
    )
    .unwrap();
    assert_eq!(event_ids(&page), Vec::<String>::new());

    // The same id under another webhook is a collision, not an overwrite.
    let error = call(
        &db,
        "plugin.webhook.recordEvent",
        json!({ "pluginId": "plugin.two", "webhookId": "gitea", "eventId": "evt-1" }),
    )
    .unwrap_err();
    assert_eq!(error_code(&error), "CONFLICT");
}

#[test]
fn pending_narrows_to_one_webhook_and_pages_without_repeating() {
    let (_dir, db) = open();
    for (index, webhook) in ["gitea", "gitea", "github"].iter().enumerate() {
        let received_at = 1_000 + index as i64;
        call(
            &db,
            "plugin.webhook.recordEvent",
            json!({
                "pluginId": "plugin.one",
                "webhookId": webhook,
                "eventId": format!("evt-{index}"),
                "receivedAt": received_at,
            }),
        )
        .unwrap();
    }
    call(
        &db,
        "plugin.webhook.recordEvent",
        json!({ "pluginId": "plugin.two", "webhookId": "gitea", "eventId": "other" }),
    )
    .unwrap();

    let gitea = call(
        &db,
        "plugin.webhook.pending",
        json!({ "pluginId": "plugin.one", "webhookId": "gitea" }),
    )
    .unwrap();
    assert_eq!(event_ids(&gitea), vec!["evt-0", "evt-1"]);

    let first_page = call(
        &db,
        "plugin.webhook.pending",
        json!({ "pluginId": "plugin.one", "limit": 2 }),
    )
    .unwrap();
    assert_eq!(event_ids(&first_page), vec!["evt-0", "evt-1"]);
    assert_eq!(first_page["hasMore"], json!(true));

    // Draining by acknowledging what the page returned moves the window.
    for id in event_ids(&first_page) {
        call(
            &db,
            "plugin.webhook.markDelivered",
            json!({ "eventId": id }),
        )
        .unwrap();
    }
    let next_page = call(
        &db,
        "plugin.webhook.pending",
        json!({ "pluginId": "plugin.one", "limit": 2 }),
    )
    .unwrap();
    assert_eq!(event_ids(&next_page), vec!["evt-2"]);
    assert_eq!(next_page["hasMore"], json!(false));
}

#[test]
fn purge_removes_one_plugin_or_one_webhook_and_leaves_the_rest() {
    let (_dir, db) = open();
    for (plugin, webhook, id) in [
        ("plugin.one", "gitea", "keep-1"),
        ("plugin.one", "github", "keep-2"),
        ("plugin.two", "gitea", "other-1"),
    ] {
        call(
            &db,
            "plugin.webhook.recordEvent",
            json!({ "pluginId": plugin, "webhookId": webhook, "eventId": id }),
        )
        .unwrap();
    }
    call(
        &db,
        "plugin.webhook.markDelivered",
        json!({ "eventId": "keep-1" }),
    )
    .unwrap();

    let one_webhook = call(
        &db,
        "plugin.webhook.purge",
        json!({ "pluginId": "plugin.one", "webhookId": "gitea" }),
    )
    .unwrap();
    assert_eq!(one_webhook["deleted"], json!(1));
    let remaining = call(
        &db,
        "plugin.webhook.pending",
        json!({ "pluginId": "plugin.one" }),
    )
    .unwrap();
    assert_eq!(event_ids(&remaining), vec!["keep-2"]);

    // Uninstalling the plugin takes its remaining rows in one delete.
    let whole_plugin = call(
        &db,
        "plugin.webhook.purge",
        json!({ "pluginId": "plugin.one" }),
    )
    .unwrap();
    assert_eq!(whole_plugin["deleted"], json!(1));
    let empty = call(
        &db,
        "plugin.webhook.pending",
        json!({ "pluginId": "plugin.one" }),
    )
    .unwrap();
    assert_eq!(event_ids(&empty), Vec::<String>::new());
    let untouched = call(
        &db,
        "plugin.webhook.pending",
        json!({ "pluginId": "plugin.two" }),
    )
    .unwrap();
    assert_eq!(event_ids(&untouched), vec!["other-1"]);
}

#[test]
fn retention_prunes_only_delivered_rows_unless_pending_is_opted_in() {
    let (_dir, db) = open();
    for (id, received_at) in [
        ("old-acked", 1_000),
        ("old-pending", 2_000),
        ("new-acked", 9_000),
    ] {
        call(
            &db,
            "plugin.webhook.recordEvent",
            json!({ "pluginId": "plugin.one", "webhookId": "gitea", "eventId": id, "receivedAt": received_at }),
        )
        .unwrap();
    }
    for id in ["old-acked", "new-acked"] {
        call(
            &db,
            "plugin.webhook.markDelivered",
            json!({ "eventId": id, "deliveredAt": 9_500 }),
        )
        .unwrap();
    }

    // The cutoff is exclusive and only acknowledged rows are retention
    // garbage: the older delivered event goes, the one received exactly at
    // the cutoff stays.
    let pruned = call(&db, "plugin.webhook.prune", json!({ "beforeMs": 2_000 })).unwrap();
    assert_eq!(pruned["deleted"], json!(1));
    let pruned = call(&db, "plugin.webhook.prune", json!({ "beforeMs": 5_000 })).unwrap();
    assert_eq!(pruned["deleted"], json!(0));
    assert_eq!(pruned["includePending"], json!(false));

    // A delivery nobody took is still owed, so retention left it alone.
    let page = call(
        &db,
        "plugin.webhook.pending",
        json!({ "pluginId": "plugin.one" }),
    )
    .unwrap();
    assert_eq!(event_ids(&page), vec!["old-pending"]);

    // Opting in drops it, and then nothing is left at all: a second prune
    // at the same cutoff is a no-op rather than an error.
    let pruned = call(
        &db,
        "plugin.webhook.prune",
        json!({ "beforeMs": 5_000, "includePending": true }),
    )
    .unwrap();
    assert_eq!(pruned["deleted"], json!(1));
    let again = call(&db, "plugin.webhook.prune", json!({ "beforeMs": 5_000 })).unwrap();
    assert_eq!(again["deleted"], json!(0));

    // Retention can be scoped to one plugin without touching another's.
    call(
        &db,
        "plugin.webhook.recordEvent",
        json!({ "pluginId": "plugin.two", "webhookId": "gitea", "eventId": "other", "receivedAt": 1_000 }),
    )
    .unwrap();
    call(
        &db,
        "plugin.webhook.markDelivered",
        json!({ "eventId": "other" }),
    )
    .unwrap();
    let scoped = call(
        &db,
        "plugin.webhook.prune",
        json!({ "beforeMs": 5_000, "pluginId": "plugin.one" }),
    )
    .unwrap();
    assert_eq!(scoped["deleted"], json!(0));
    let kept = call(
        &db,
        "plugin.webhook.pending",
        json!({ "pluginId": "plugin.two" }),
    )
    .unwrap();
    assert_eq!(event_ids(&kept), Vec::<String>::new());
}

#[test]
fn boundary_values_are_refused_instead_of_stored() {
    let (_dir, db) = open();
    // The body and the token never enter this table, so a caller that sends
    // them is told at the boundary.
    for forbidden in ["body", "token", "headers"] {
        let error = call(
            &db,
            "plugin.webhook.recordEvent",
            json!({ "pluginId": "plugin.one", "webhookId": "gitea", forbidden: "secret" }),
        )
        .unwrap_err();
        assert_eq!(error_code(&error), "INVALID_PARAMS");
        assert!(error.message.contains(forbidden));
    }
    for params in [
        json!({ "webhookId": "gitea" }),
        json!({ "pluginId": "", "webhookId": "gitea" }),
        json!({ "pluginId": "../escape", "webhookId": "gitea" }),
        json!({ "pluginId": "...", "webhookId": "gitea" }),
        json!({ "pluginId": "plugin.one", "webhookId": "gitea", "bodyRef": "nested/body.json" }),
        json!({ "pluginId": "plugin.one", "webhookId": "gitea", "bodyRef": ".." }),
        json!({ "pluginId": "plugin.one", "webhookId": "gitea", "sourceIp": "not-an-ip" }),
        json!({ "pluginId": "plugin.one", "webhookId": "gitea", "receivedAt": -1 }),
        json!({ "pluginId": "plugin.one", "webhookId": "gitea", "receivedAt": "1000" }),
        json!({ "pluginId": "plugin.one", "webhookId": "gitea", "unexpected": 1 }),
    ] {
        let error = call(&db, "plugin.webhook.recordEvent", params.clone()).unwrap_err();
        assert_eq!(
            error_code(&error),
            "INVALID_PARAMS",
            "expected refusal for {params}"
        );
    }

    // An empty peer address is what the receiver sends when it has none.
    call(
        &db,
        "plugin.webhook.recordEvent",
        json!({ "pluginId": "plugin.one", "webhookId": "gitea", "eventId": "evt-1", "sourceIp": "", "receivedAt": 1_000 }),
    )
    .unwrap();
    let page = call(
        &db,
        "plugin.webhook.pending",
        json!({ "pluginId": "plugin.one" }),
    )
    .unwrap();
    assert_eq!(page["events"][0]["sourceIp"], Value::Null);

    // Acknowledging an id nobody recorded is not a success.
    let error = call(
        &db,
        "plugin.webhook.markDelivered",
        json!({ "eventId": "missing" }),
    )
    .unwrap_err();
    assert_eq!(error_code(&error), "NOT_FOUND");
    // Nor is acknowledging another plugin's event through a cross-checked
    // pluginId; the row stays owed to its own receiver.
    let error = call(
        &db,
        "plugin.webhook.markDelivered",
        json!({ "eventId": "evt-1", "pluginId": "plugin.two" }),
    )
    .unwrap_err();
    assert_eq!(error_code(&error), "NOT_FOUND");
    let error = call(
        &db,
        "plugin.webhook.markDelivered",
        json!({ "eventId": "evt-1", "deliveredAt": 999 }),
    )
    .unwrap_err();
    assert_eq!(error_code(&error), "INVALID_PARAMS");

    // Retention boundaries: a page of zero, a negative or future cutoff.
    let error = call(
        &db,
        "plugin.webhook.pending",
        json!({ "pluginId": "plugin.one", "limit": 0 }),
    )
    .unwrap_err();
    assert_eq!(error_code(&error), "INVALID_PARAMS");
    let error = call(&db, "plugin.webhook.prune", json!({ "beforeMs": -5 })).unwrap_err();
    assert_eq!(error_code(&error), "INVALID_PARAMS");
    let error = call(&db, "plugin.webhook.prune", json!({})).unwrap_err();
    assert_eq!(error_code(&error), "INVALID_PARAMS");
    let error = call(
        &db,
        "plugin.webhook.prune",
        json!({ "beforeMs": now_ms() + 60_000 }),
    )
    .unwrap_err();
    assert_eq!(error_code(&error), "INVALID_PARAMS");
    let error = call(
        &db,
        "plugin.webhook.prune",
        json!({ "beforeMs": 1_000, "includePending": "yes" }),
    )
    .unwrap_err();
    assert_eq!(error_code(&error), "INVALID_PARAMS");

    // A plugin id is never enough by itself to delete nothing silently.
    let error = call(&db, "plugin.webhook.purge", json!({})).unwrap_err();
    assert_eq!(error_code(&error), "INVALID_PARAMS");

    // An unlisted method under the prefix is a routing error, not a guess.
    let error = call(&db, "plugin.webhook.drop", json!({})).unwrap_err();
    assert_eq!(error.code, -32601);
    assert_eq!(error_code(&error), "METHOD_NOT_FOUND");
}

/// The removal references of one cleanup answer, and the proof that nothing
/// else travels with them: an id, the owning plugin, and the file name the
/// caller has to delete — never a body, a header, or a token.
fn removed_refs(events: &Value) -> Vec<(String, String, Option<String>)> {
    events
        .as_array()
        .unwrap()
        .iter()
        .map(|event| {
            let object = event.as_object().unwrap();
            for forbidden in ["body", "bodyText", "headers", "token", "authorization"] {
                assert!(
                    !object.contains_key(forbidden),
                    "a removal reference must not carry {forbidden}"
                );
            }
            assert_eq!(object.len(), 3, "unexpected field in {event}");
            (
                event["eventId"].as_str().unwrap().to_string(),
                event["pluginId"].as_str().unwrap().to_string(),
                event["bodyRef"].as_str().map(str::to_string),
            )
        })
        .collect()
}

fn refs(triples: &[(&str, &str, Option<&str>)]) -> Vec<(String, String, Option<String>)> {
    triples
        .iter()
        .map(|(event_id, plugin_id, body_ref)| {
            (
                event_id.to_string(),
                plugin_id.to_string(),
                body_ref.map(str::to_string),
            )
        })
        .collect()
}

#[test]
fn purge_returns_the_references_of_every_removed_row() {
    let (_dir, db) = open();
    // One acknowledged event and one still owed for plugin.one, plus another
    // plugin whose rows must not appear in the answer at all.
    for (plugin, id, body_ref) in [
        ("plugin.one", "acked", "webhook-acked.json"),
        ("plugin.one", "owed", "webhook-owed.json"),
        ("plugin.two", "other", "webhook-other.json"),
    ] {
        call(
            &db,
            "plugin.webhook.recordEvent",
            json!({
                "pluginId": plugin,
                "webhookId": "gitea",
                "eventId": id,
                "bodyRef": body_ref,
            }),
        )
        .unwrap();
    }
    call(
        &db,
        "plugin.webhook.markDelivered",
        json!({ "eventId": "acked" }),
    )
    .unwrap();

    let purged = call(
        &db,
        "plugin.webhook.purge",
        json!({ "pluginId": "plugin.one" }),
    )
    .unwrap();
    assert_eq!(purged["deleted"], json!(2));
    assert_eq!(
        removed_refs(&purged["events"]),
        refs(&[
            ("acked", "plugin.one", Some("webhook-acked.json")),
            ("owed", "plugin.one", Some("webhook-owed.json")),
        ])
    );
    // The surviving plugin still owns its delivery and its file.
    let untouched = call(
        &db,
        "plugin.webhook.pending",
        json!({ "pluginId": "plugin.two" }),
    )
    .unwrap();
    assert_eq!(event_ids(&untouched), vec!["other"]);
    // Draining again removes nothing and returns no reference to delete.
    let again = call(
        &db,
        "plugin.webhook.purge",
        json!({ "pluginId": "plugin.one" }),
    )
    .unwrap();
    assert_eq!(again["deleted"], json!(0));
    assert_eq!(again["events"], json!([]));

    // Narrowing to one receiver returns only that receiver's references.
    call(
        &db,
        "plugin.webhook.recordEvent",
        json!({ "pluginId": "plugin.one", "webhookId": "github", "eventId": "narrow", "bodyRef": "narrow.json" }),
    )
    .unwrap();
    let narrowed = call(
        &db,
        "plugin.webhook.purge",
        json!({ "pluginId": "plugin.one", "webhookId": "github" }),
    )
    .unwrap();
    assert_eq!(narrowed["deleted"], json!(1));
    assert_eq!(
        removed_refs(&narrowed["events"]),
        refs(&[("narrow", "plugin.one", Some("narrow.json"))])
    );

    // An event that never had an accepted copy answers with a null reference
    // rather than inventing a file name.
    call(
        &db,
        "plugin.webhook.recordEvent",
        json!({ "pluginId": "plugin.one", "webhookId": "gitea", "eventId": "no-body" }),
    )
    .unwrap();
    let without_copy = call(
        &db,
        "plugin.webhook.purge",
        json!({ "pluginId": "plugin.one" }),
    )
    .unwrap();
    assert_eq!(without_copy["deleted"], json!(1));
    assert_eq!(
        removed_refs(&without_copy["events"]),
        refs(&[("no-body", "plugin.one", None)])
    );
}

#[test]
fn retention_returns_the_references_of_expired_rows_only() {
    let (_dir, db) = open();
    for (plugin, id, received_at, body_ref) in [
        ("plugin.one", "old-acked", 1_000, "old-one.json"),
        ("plugin.two", "old-acked-two", 1_500, "old-two.json"),
        ("plugin.one", "old-owed", 2_000, "owed.json"),
        ("plugin.one", "new-acked", 9_000, "new.json"),
    ] {
        call(
            &db,
            "plugin.webhook.recordEvent",
            json!({
                "pluginId": plugin,
                "webhookId": "gitea",
                "eventId": id,
                "receivedAt": received_at,
                "bodyRef": body_ref,
            }),
        )
        .unwrap();
    }
    for id in ["old-acked", "old-acked-two", "new-acked"] {
        call(
            &db,
            "plugin.webhook.markDelivered",
            json!({ "eventId": id }),
        )
        .unwrap();
    }

    // Default retention takes the acknowledged rows behind the cutoff, in
    // every plugin, and names exactly those files.
    let pruned = call(&db, "plugin.webhook.prune", json!({ "beforeMs": 5_000 })).unwrap();
    assert_eq!(pruned["deleted"], json!(2));
    assert_eq!(
        removed_refs(&pruned["events"]),
        refs(&[
            ("old-acked", "plugin.one", Some("old-one.json")),
            ("old-acked-two", "plugin.two", Some("old-two.json")),
        ])
    );
    // The delivered row after the cutoff and the delivery nobody took both
    // stay, so neither file is reported for deletion.
    let pending = call(
        &db,
        "plugin.webhook.pending",
        json!({ "pluginId": "plugin.one" }),
    )
    .unwrap();
    assert_eq!(event_ids(&pending), vec!["old-owed"]);

    // Opting in drops the owed row too, and its reference comes back with it.
    let with_pending = call(
        &db,
        "plugin.webhook.prune",
        json!({ "beforeMs": 5_000, "includePending": true }),
    )
    .unwrap();
    assert_eq!(with_pending["deleted"], json!(1));
    assert_eq!(with_pending["includePending"], json!(true));
    assert_eq!(
        removed_refs(&with_pending["events"]),
        refs(&[("old-owed", "plugin.one", Some("owed.json"))])
    );

    // Nothing left behind the cutoff: no count and no file to delete.
    let empty = call(&db, "plugin.webhook.prune", json!({ "beforeMs": 5_000 })).unwrap();
    assert_eq!(empty["deleted"], json!(0));
    assert_eq!(empty["events"], json!([]));
}

#[test]
fn list_covers_both_kinds_and_never_skips_while_rows_are_deleted() {
    let (_dir, db) = open();
    for index in 0..5 {
        call(
            &db,
            "plugin.webhook.recordEvent",
            json!({
                "pluginId": "plugin.one",
                "webhookId": "gitea",
                "eventId": format!("evt-{index}"),
                "receivedAt": 1_000 + index,
            }),
        )
        .unwrap();
    }
    // Acknowledged events stay in the list: it is the full view of the log, not
    // a replay queue.
    call(
        &db,
        "plugin.webhook.markDelivered",
        json!({ "eventId": "evt-1" }),
    )
    .unwrap();
    call(
        &db,
        "plugin.webhook.recordEvent",
        json!({ "pluginId": "plugin.two", "webhookId": "gitea", "eventId": "foreign", "receivedAt": 500 }),
    )
    .unwrap();

    let everything = call(&db, "plugin.webhook.list", json!({})).unwrap();
    assert_eq!(
        event_ids(&everything),
        vec!["foreign", "evt-0", "evt-1", "evt-2", "evt-3", "evt-4"]
    );
    assert_eq!(everything["hasMore"], json!(false));
    assert_eq!(everything["nextCursor"], Value::Null);
    assert!(everything["events"][2]["deliveredAt"].as_i64().is_some());

    // Both filters are optional and combine; `beforeMs` is the exclusive cutoff
    // retention uses, so the row received exactly at it stays out.
    let narrowed = call(
        &db,
        "plugin.webhook.list",
        json!({ "pluginId": "plugin.one", "beforeMs": 1_003 }),
    )
    .unwrap();
    assert_eq!(event_ids(&narrowed), vec!["evt-0", "evt-1", "evt-2"]);

    // Page, delete exactly what the page returned, then continue from the
    // cursor: a deletion behind the cursor cannot move a row past it.
    let first = call(
        &db,
        "plugin.webhook.list",
        json!({ "pluginId": "plugin.one", "limit": 2 }),
    )
    .unwrap();
    assert_eq!(event_ids(&first), vec!["evt-0", "evt-1"]);
    assert_eq!(first["hasMore"], json!(true));
    let cursor = first["nextCursor"].as_str().unwrap().to_string();
    assert_eq!(cursor, "1001:evt-1");
    call(
        &db,
        "plugin.webhook.deleteByIds",
        json!({ "eventIds": event_ids(&first) }),
    )
    .unwrap();

    let second = call(
        &db,
        "plugin.webhook.list",
        json!({ "pluginId": "plugin.one", "limit": 2, "cursor": cursor }),
    )
    .unwrap();
    assert_eq!(event_ids(&second), vec!["evt-2", "evt-3"]);
    let cursor = second["nextCursor"].as_str().unwrap().to_string();
    call(
        &db,
        "plugin.webhook.deleteByIds",
        json!({ "eventIds": event_ids(&second) }),
    )
    .unwrap();

    let third = call(
        &db,
        "plugin.webhook.list",
        json!({ "pluginId": "plugin.one", "limit": 2, "cursor": cursor }),
    )
    .unwrap();
    assert_eq!(event_ids(&third), vec!["evt-4"]);
    assert_eq!(third["hasMore"], json!(false));
    assert_eq!(third["nextCursor"], Value::Null);

    // A malformed cursor is refused instead of being treated as "from the top".
    let error = call(
        &db,
        "plugin.webhook.list",
        json!({ "cursor": "not-a-cursor" }),
    )
    .unwrap_err();
    assert_eq!(error_code(&error), "INVALID_PARAMS");
}

#[test]
fn delete_by_ids_is_exact_scoped_and_bounded() {
    let (_dir, db) = open();
    for (plugin, id) in [
        ("plugin.one", "own-a"),
        ("plugin.one", "own-b"),
        ("plugin.two", "foreign"),
    ] {
        call(
            &db,
            "plugin.webhook.recordEvent",
            json!({ "pluginId": plugin, "webhookId": "gitea", "eventId": id }),
        )
        .unwrap();
    }

    // An id that was never recorded is reported back, not invented; the ids
    // that do exist go, and only those.
    let deleted = call(
        &db,
        "plugin.webhook.deleteByIds",
        json!({ "eventIds": ["own-a", "ghost"] }),
    )
    .unwrap();
    assert_eq!(deleted["deleted"], json!(1));
    assert_eq!(
        removed_refs(&deleted["events"]),
        refs(&[("own-a", "plugin.one", None)])
    );
    assert_eq!(deleted["missing"], json!(["ghost"]));
    let left = call(
        &db,
        "plugin.webhook.pending",
        json!({ "pluginId": "plugin.one" }),
    )
    .unwrap();
    assert_eq!(event_ids(&left), vec!["own-b"]);

    // `pluginId` bounds the batch: another plugin's id cannot be removed
    // through it, and the refusal is visible instead of silent.
    let scoped = call(
        &db,
        "plugin.webhook.deleteByIds",
        json!({ "eventIds": ["foreign"], "pluginId": "plugin.one" }),
    )
    .unwrap();
    assert_eq!(scoped["deleted"], json!(0));
    assert_eq!(scoped["missing"], json!(["foreign"]));
    let foreign = call(
        &db,
        "plugin.webhook.pending",
        json!({ "pluginId": "plugin.two" }),
    )
    .unwrap();
    assert_eq!(event_ids(&foreign), vec!["foreign"]);

    // Duplicates collapse onto one row and are not counted twice.
    let duplicates = call(
        &db,
        "plugin.webhook.deleteByIds",
        json!({ "eventIds": ["own-b", "own-b"] }),
    )
    .unwrap();
    assert_eq!(duplicates["deleted"], json!(1));
    assert_eq!(duplicates["events"].as_array().unwrap().len(), 1);

    // Empty and oversized batches are caller mistakes, not quiet no-ops.
    let error = call(&db, "plugin.webhook.deleteByIds", json!({ "eventIds": [] })).unwrap_err();
    assert_eq!(error_code(&error), "INVALID_PARAMS");
    let oversized: Vec<String> = (0..501).map(|index| format!("evt-{index}")).collect();
    let error = call(
        &db,
        "plugin.webhook.deleteByIds",
        json!({ "eventIds": oversized }),
    )
    .unwrap_err();
    assert_eq!(error_code(&error), "INVALID_PARAMS");
    let error = call(
        &db,
        "plugin.webhook.deleteByIds",
        json!({ "eventIds": ["../escape"] }),
    )
    .unwrap_err();
    assert_eq!(error_code(&error), "INVALID_PARAMS");
    let error = call(
        &db,
        "plugin.webhook.deleteByIds",
        json!({ "eventIds": [42] }),
    )
    .unwrap_err();
    assert_eq!(error_code(&error), "INVALID_PARAMS");
}

#[test]
fn cleanup_touches_only_the_named_rows_and_repeats_cleanly() {
    let (_dir, db) = open();
    for (plugin, id, received_at) in [
        ("plugin.one", "acked", 1_000),
        ("plugin.one", "owed", 2_000),
        ("plugin.two", "other", 1_000),
    ] {
        call(
            &db,
            "plugin.webhook.recordEvent",
            json!({
                "pluginId": plugin,
                "webhookId": "gitea",
                "eventId": id,
                "receivedAt": received_at,
            }),
        )
        .unwrap();
    }
    for id in ["acked", "other"] {
        call(
            &db,
            "plugin.webhook.markDelivered",
            json!({ "eventId": id }),
        )
        .unwrap();
    }

    // Retention takes the acknowledged row behind the cutoff in every plugin,
    // and only those.
    let pruned = call(&db, "plugin.webhook.prune", json!({ "beforeMs": 5_000 })).unwrap();
    assert_eq!(pruned["deleted"], json!(2));
    assert_eq!(
        removed_refs(&pruned["events"]),
        refs(&[("acked", "plugin.one", None), ("other", "plugin.two", None),])
    );
    let left = call(
        &db,
        "plugin.webhook.list",
        json!({ "pluginId": "plugin.one" }),
    )
    .unwrap();
    assert_eq!(event_ids(&left), vec!["owed"]);

    // A purge of the same plugin takes the rest, and repeating it removes
    // nothing and reports nothing.
    let purged = call(
        &db,
        "plugin.webhook.purge",
        json!({ "pluginId": "plugin.one" }),
    )
    .unwrap();
    assert_eq!(purged["deleted"], json!(1));
    assert_eq!(
        removed_refs(&purged["events"]),
        refs(&[("owed", "plugin.one", None)])
    );
    let again = call(
        &db,
        "plugin.webhook.purge",
        json!({ "pluginId": "plugin.one" }),
    )
    .unwrap();
    assert_eq!(again["deleted"], json!(0));
    assert_eq!(again["events"], json!([]));

    // An id a previous cleanup already removed is reported missing, not deleted
    // twice.
    let missing = call(
        &db,
        "plugin.webhook.deleteByIds",
        json!({ "eventIds": ["acked"] }),
    )
    .unwrap();
    assert_eq!(missing["deleted"], json!(0));
    assert_eq!(missing["missing"], json!(["acked"]));
}

#[test]
fn file_scanning_is_not_part_of_this_surface() {
    let (_dir, db) = open();
    call(
        &db,
        "plugin.webhook.recordEvent",
        json!({ "pluginId": "plugin.one", "webhookId": "gitea", "eventId": "kept", "bodyRef": "kept.json" }),
    )
    .unwrap();

    // The RPC owns rows only: there is no scan of the plugin's files and no
    // filesystem access behind the `plugin.webhook.` prefix.
    let error = call(&db, "plugin.webhook.orphans", json!({})).unwrap_err();
    assert_eq!(error.code, -32601);
    assert_eq!(error_code(&error), "METHOD_NOT_FOUND");

    // Deletion answers with the reference and leaves every file to its owner.
    let deleted = call(
        &db,
        "plugin.webhook.deleteByIds",
        json!({ "eventIds": ["kept"], "pluginId": "plugin.one" }),
    )
    .unwrap();
    assert_eq!(deleted["deleted"], json!(1));
    assert_eq!(
        removed_refs(&deleted["events"]),
        refs(&[("kept", "plugin.one", Some("kept.json"))])
    );
    let left = call(
        &db,
        "plugin.webhook.list",
        json!({ "pluginId": "plugin.one" }),
    )
    .unwrap();
    assert_eq!(event_ids(&left), Vec::<String>::new());
}
