use super::*;
use serde_json::json;

fn register(state: &mut AppState, root: &std::path::Path, id: &str) {
    let plugin_dir = root.join(format!("fixture-{id}"));
    std::fs::create_dir(&plugin_dir).unwrap();
    std::fs::write(
        plugin_dir.join("manifest.json"),
        json!({
            "schemaVersion": 1,
            "id": id,
            "name": "Fixture",
            "version": "1.0.0",
            "main": "main.js",
            "permissions": ["scheduler"],
            "engines": { "minihAgent": ">=1.0.0" }
        })
        .to_string(),
    )
    .unwrap();
    std::fs::write(plugin_dir.join("main.js"), "").unwrap();
    state
        .plugins
        .load_dev(plugin_dir.to_str().unwrap())
        .unwrap();
}

fn open() -> (tempfile::TempDir, AppState) {
    let dir = tempfile::tempdir().unwrap();
    let mut state = AppState::open(dir.path()).unwrap();
    register(&mut state, dir.path(), "acme.timer");
    register(&mut state, dir.path(), "other.timer");
    (dir, state)
}

fn call(state: &AppState, method: &str, params: Value) -> Result<Value, JsonRpcError> {
    handle(state, method, params)
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

fn schedules(state: &AppState) -> Value {
    call(state, "plugins.schedules.list", json!({})).unwrap()["schedules"].clone()
}

#[test]
fn update_rejects_disabled_revoked_and_uninstalled_plugins() {
    let (_dir, mut state) = open();
    let row = json!({ "pluginId": "acme.timer", "scheduleId": "nightly" });
    call(&state, "plugins.schedules.update", row.clone()).unwrap();
    state.plugins.set_enabled("acme.timer", false).unwrap();
    let error = call(&state, "plugins.schedules.update", row.clone()).unwrap_err();
    assert_eq!(error_code(&error), "PERMISSION_DENIED");
    assert_eq!(schedules(&state).as_array().unwrap().len(), 1);
    state.plugins.set_enabled("acme.timer", true).unwrap();
    state
        .plugins
        .revoke_permissions("acme.timer", vec!["scheduler".into()])
        .unwrap();
    let error = call(&state, "plugins.schedules.update", row.clone()).unwrap_err();
    assert_eq!(error_code(&error), "PERMISSION_DENIED");
    state.plugins.uninstall("acme.timer").unwrap();
    clear_for_plugin(&state, "acme.timer").unwrap();
    let error = call(&state, "plugins.schedules.update", row).unwrap_err();
    assert_eq!(error_code(&error), "NOT_FOUND");
    assert!(schedules(&state).as_array().unwrap().is_empty());
}

#[test]
fn reconcile_keeps_installed_rows_and_removes_only_orphans() {
    let (dir, mut state) = open();
    register(&mut state, dir.path(), "test.installed");
    call(
        &state,
        "plugins.schedules.update",
        json!({ "pluginId": "test.installed", "scheduleId": "timer" }),
    )
    .unwrap();
    state
        .db
        .conn()
        .execute(
            "INSERT INTO plugin_schedules (plugin_id, schedule_id) VALUES ('test.removed', 'timer')",
            [],
        )
        .unwrap();
    let result = call(&state, "plugins.schedules.reconcile", json!({})).unwrap();
    assert_eq!(result["removedPlugins"], json!(["test.removed"]));
    assert_eq!(schedules(&state)[0]["pluginId"], "test.installed");
}

#[test]
fn an_attempt_round_trips_through_the_row() {
    let (_dir, state) = open();
    assert_eq!(schedules(&state), json!([]), "a fresh file has no timers");

    let first = call(
        &state,
        "plugins.schedules.update",
        json!({
            "pluginId": "acme.timer",
            "scheduleId": "nightly",
            "lastRunAt": 1_700_000_000_000i64,
            "lastOk": true,
            "attempts": 0,
            "paused": false
        }),
    )
    .unwrap();
    assert_eq!(
        first["schedule"],
        json!({
            "pluginId": "acme.timer",
            "scheduleId": "nightly",
            "lastRunAt": 1_700_000_000_000i64,
            "lastOk": true,
            "attempts": 0,
            "paused": false
        })
    );
    assert_eq!(
        schedules(&state),
        json!([first["schedule"].clone()]),
        "the row the update wrote is the row the list returns"
    );

    // The failure path: a later attempt that failed, with `lastOk: null`
    // clearing the previous success and the host's brake on.
    let failed = call(
        &state,
        "plugins.schedules.update",
        json!({
            "pluginId": "acme.timer",
            "scheduleId": "nightly",
            "lastRunAt": 1_700_000_600_000i64,
            "lastOk": null,
            "attempts": 3,
            "paused": true
        }),
    )
    .unwrap();
    assert_eq!(
        failed["schedule"],
        json!({
            "pluginId": "acme.timer",
            "scheduleId": "nightly",
            "lastRunAt": 1_700_000_600_000i64,
            "lastOk": Value::Null,
            "attempts": 3,
            "paused": true
        })
    );
}

#[test]
fn an_omitted_field_keeps_its_stored_value() {
    let (_dir, state) = open();
    call(
        &state,
        "plugins.schedules.update",
        json!({
            "pluginId": "acme.timer",
            "scheduleId": "nightly",
            "lastRunAt": 42i64,
            "lastOk": true,
            "attempts": 1,
            "paused": false
        }),
    )
    .unwrap();

    // Resuming a paused timer only has to say so.
    let resumed = call(
        &state,
        "plugins.schedules.update",
        json!({ "pluginId": "acme.timer", "scheduleId": "nightly", "paused": false }),
    )
    .unwrap();
    assert_eq!(
        resumed["schedule"],
        json!({
            "pluginId": "acme.timer",
            "scheduleId": "nightly",
            "lastRunAt": 42i64,
            "lastOk": true,
            "attempts": 1,
            "paused": false
        }),
        "the untouched columns survive a partial write"
    );

    // A row created by a partial write starts at the schema defaults.
    let created = call(
        &state,
        "plugins.schedules.update",
        json!({ "pluginId": "acme.timer", "scheduleId": "hourly", "paused": true }),
    )
    .unwrap();
    assert_eq!(
        created["schedule"],
        json!({
            "pluginId": "acme.timer",
            "scheduleId": "hourly",
            "lastRunAt": Value::Null,
            "lastOk": Value::Null,
            "attempts": 0,
            "paused": true
        })
    );
}

#[test]
fn delete_drops_one_timer_and_clear_drops_one_plugin() {
    let (_dir, state) = open();
    for (plugin, schedule) in [
        ("acme.timer", "nightly"),
        ("acme.timer", "hourly"),
        ("other.timer", "nightly"),
    ] {
        call(
            &state,
            "plugins.schedules.update",
            json!({ "pluginId": plugin, "scheduleId": schedule, "attempts": 2 }),
        )
        .unwrap();
    }
    assert_eq!(schedules(&state).as_array().unwrap().len(), 3);

    let deleted = call(
        &state,
        "plugins.schedules.delete",
        json!({ "pluginId": "acme.timer", "scheduleId": "nightly" }),
    )
    .unwrap();
    assert_eq!(deleted, json!({ "deleted": 1 }));
    assert_eq!(
        schedules(&state),
        json!([
            {
                "pluginId": "acme.timer",
                "scheduleId": "hourly",
                "lastRunAt": Value::Null,
                "lastOk": Value::Null,
                "attempts": 2,
                "paused": false
            },
            {
                "pluginId": "other.timer",
                "scheduleId": "nightly",
                "lastRunAt": Value::Null,
                "lastOk": Value::Null,
                "attempts": 2,
                "paused": false
            }
        ])
    );

    // A second delete is a no-op rather than an error: the timer's state is
    // already gone, which is what the caller asked for.
    assert_eq!(
        call(
            &state,
            "plugins.schedules.delete",
            json!({ "pluginId": "acme.timer", "scheduleId": "nightly" }),
        )
        .unwrap(),
        json!({ "deleted": 0 })
    );

    assert_eq!(
        call(
            &state,
            "plugins.schedules.clear",
            json!({ "pluginId": "acme.timer" }),
        )
        .unwrap(),
        json!({ "deleted": 1 })
    );
    assert_eq!(
        schedules(&state),
        json!([{
            "pluginId": "other.timer",
            "scheduleId": "nightly",
            "lastRunAt": Value::Null,
            "lastOk": Value::Null,
            "attempts": 2,
            "paused": false
        }]),
        "only the named plugin lost its rows"
    );
}

#[test]
fn invalid_requests_are_refused_before_the_row_is_written() {
    let (_dir, state) = open();
    let base = json!({ "pluginId": "acme.timer", "scheduleId": "nightly" });

    for (params, key) in [
        (json!({ "scheduleId": "nightly" }), "pluginId"),
        (json!({ "pluginId": "acme.timer" }), "scheduleId"),
        (
            json!({ "pluginId": "  ", "scheduleId": "nightly" }),
            "pluginId",
        ),
        (
            json!({ "pluginId": "acme.timer", "scheduleId": "x".repeat(257) }),
            "scheduleId",
        ),
    ] {
        let error = call(&state, "plugins.schedules.update", params).unwrap_err();
        assert_eq!(error_code(&error), "INVALID_PARAMS");
        assert!(
            error.message.contains(key),
            "the message names the rejected field: {}",
            error.message
        );
    }
    for (field, value) in [
        ("lastRunAt", json!(-1)),
        ("lastRunAt", json!("now")),
        ("lastRunAt", json!(1.5)),
        ("lastOk", json!("true")),
        ("attempts", json!(-2)),
        ("attempts", json!(Value::Null)),
        ("paused", json!(Value::Null)),
        ("paused", json!(1)),
    ] {
        let mut params = base.clone();
        params[field] = value.clone();
        let error = call(&state, "plugins.schedules.update", params).unwrap_err();
        assert_eq!(
            error_code(&error),
            "INVALID_PARAMS",
            "{field} = {value} was accepted"
        );
    }
    assert_eq!(schedules(&state), json!([]), "nothing was written");
    assert_eq!(
        call(
            &state,
            "plugins.schedules.delete",
            json!({ "pluginId": "acme.timer" }),
        )
        .unwrap_err()
        .data
        .unwrap()["errorCode"],
        "INVALID_PARAMS",
        "delete needs both ids, not just the plugin"
    );
}

#[test]
fn the_row_outlives_a_restart() {
    let dir = tempfile::tempdir().unwrap();
    {
        let mut state = AppState::open(dir.path()).unwrap();
        register(&mut state, dir.path(), "acme.timer");
        call(
            &state,
            "plugins.schedules.update",
            json!({
                "pluginId": "acme.timer",
                "scheduleId": "nightly",
                "lastRunAt": 7i64,
                "lastOk": false,
                "attempts": 2,
                "paused": true
            }),
        )
        .unwrap();
    }
    let reopened = AppState::open(dir.path()).unwrap();
    assert_eq!(
        schedules(&reopened),
        json!([{
            "pluginId": "acme.timer",
            "scheduleId": "nightly",
            "lastRunAt": 7i64,
            "lastOk": false,
            "attempts": 2,
            "paused": true
        }]),
        "the attempt state is durable, not in-memory bookkeeping"
    );
}
