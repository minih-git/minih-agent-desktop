//! Editing an account keeps the secrets the user did not retype.
//!
//! An app password from Gmail or QQ is displayed once, when it is generated, and
//! never again — and this host never hands a stored secret back to a form. So the
//! edit form shows an empty box for it, and the user who only wants to add a proxy
//! is not asked for a password they no longer have. The rule these tests pin is
//! that empty means "keep what is saved", never "store a blank".
//!
//! Both write paths are covered, because both replace a whole value: a
//! single-value slot (`credentials::set` over an existing blob) and one instance
//! of a multi-instance slot (`credentials::update`). The proxy adds a switch and
//! a pair on top: choosing no type forgets the saved login, and two empty boxes
//! keep it.
//!
//! A sibling of `credential_instances_tests` and `credential_proxy_tests`, sharing
//! the fixtures in `credentials_tests`.

use super::tests::{field, install, mailbox_slot};
use super::*;
use crate::secrets::SecretStore;
use serde_json::{json, Map, Value};
use tempfile::tempdir;

/// A mailbox slot that holds several accounts and names them by address.
fn multi_mailbox_slot() -> Value {
    json!({
        "id": "mailbox",
        "title": { "en": "Mailbox", "zh-CN": "邮箱" },
        "kind": "imap",
        "fields": [field("username", "Address", false), field("password", "Password", true)],
        "scope": { "domains": ["imap.example.com"] },
        "multiple": { "max": 3 },
        "labelField": "username",
    })
}

/// A mailbox slot whose owner may name a server, a proxy and an outgoing server.
fn proxied_mailbox_slot() -> Value {
    json!({
        "id": "mailbox",
        "title": { "en": "Mailbox", "zh-CN": "邮箱" },
        "kind": "imap",
        "fields": [field("username", "Address", false), field("password", "Password", true)],
        "multiple": { "max": 3 },
        "labelField": "username",
        "userEndpoint": { "protocols": ["imap", "pop3"] },
        "userProxy": { "types": ["http", "socks5"] },
        "userSend": { "security": ["tls", "starttls"] },
    })
}

fn account(username: &str, password: &str) -> Map<String, Value> {
    let mut fields = Map::new();
    fields.insert("username".into(), json!(username));
    fields.insert("password".into(), json!(password));
    fields
}

/// The same account with a custom server (`server`/`port`/`protocol`/`security`)
/// and whatever else the test adds.
fn account_with(username: &str, password: &str, extra: &[(&str, &str)]) -> Map<String, Value> {
    let mut fields = account(username, password);
    fields.insert("server".into(), json!("imap.example.com"));
    fields.insert("port".into(), json!("993"));
    fields.insert("protocol".into(), json!("imap"));
    fields.insert("security".into(), json!("tls"));
    for (key, value) in extra {
        fields.insert((*key).to_string(), json!(value));
    }
    fields
}

fn local_http_proxy() -> Vec<(&'static str, &'static str)> {
    vec![
        ("proxyType", "http"),
        ("proxyHost", "127.0.0.1"),
        ("proxyPort", "7897"),
        ("proxyUsername", "tunnel"),
        ("proxyPassword", "s3cret"),
    ]
}

/// Install one plugin whose manifest declares `slot`, and open its store.
fn fixture(dir: &tempfile::TempDir, plugin_id: &str, slot: Value) -> (PluginSummary, SecretStore) {
    let (_plugins, plugin, _root) =
        install(dir.path(), plugin_id, json!({ "credentials": [slot] }));
    let secrets = SecretStore::open(dir.path()).unwrap();
    (plugin, secrets)
}

#[test]
fn editing_an_account_keeps_the_password_it_was_not_asked_for() {
    let dir = tempdir().unwrap();
    let (plugin, secrets) = fixture(&dir, "demo.keep", multi_mailbox_slot());
    let id = set(
        &secrets,
        &plugin,
        "mailbox",
        account("alice@example.com", "hunter2"),
        None,
    )
    .unwrap()
    .expect("a multi-instance slot answers the id it created");

    // The form never shows a stored secret, so an edit submits an empty box —
    // here for a rename, which is the smallest possible edit.
    update(
        &secrets,
        &plugin,
        "mailbox",
        &id,
        account("alice@work.example.com", ""),
        None,
    )
    .unwrap();

    let fields = resolve(&secrets, &plugin, &format!("mailbox#{id}"), None).unwrap();
    assert_eq!(fields.get("password").map(String::as_str), Some("hunter2"));
    assert_eq!(
        fields.get("username").map(String::as_str),
        Some("alice@work.example.com")
    );
    // A blank box is not a stored blank: the value is still there, once.
    assert_eq!(fields.len(), 2);
}

#[test]
fn a_password_the_user_types_replaces_the_saved_one() {
    let dir = tempdir().unwrap();
    let (plugin, secrets) = fixture(&dir, "demo.rotate", multi_mailbox_slot());
    let id = set(
        &secrets,
        &plugin,
        "mailbox",
        account("alice@example.com", "hunter2"),
        None,
    )
    .unwrap()
    .unwrap();

    update(
        &secrets,
        &plugin,
        "mailbox",
        &id,
        account("alice@example.com", "rotated"),
        None,
    )
    .unwrap();

    let fields = resolve(&secrets, &plugin, &format!("mailbox#{id}"), None).unwrap();
    assert_eq!(fields.get("password").map(String::as_str), Some("rotated"));
}

#[test]
fn adding_a_proxy_to_a_saved_account_keeps_its_password() {
    let dir = tempdir().unwrap();
    let (plugin, secrets) = fixture(&dir, "demo.proxy-add", proxied_mailbox_slot());
    let id = set(
        &secrets,
        &plugin,
        "mailbox",
        account_with("alice", "hunter2", &[]),
        None,
    )
    .unwrap()
    .unwrap();

    // The user edits only the proxy section: the password box stays empty.
    update(
        &secrets,
        &plugin,
        "mailbox",
        &id,
        account_with("alice", "", &local_http_proxy()),
        None,
    )
    .unwrap();

    let fields = resolve(&secrets, &plugin, &format!("mailbox#{id}"), None).unwrap();
    assert_eq!(fields.get("password").map(String::as_str), Some("hunter2"));
    assert_eq!(fields.get("proxyType").map(String::as_str), Some("http"));
    assert_eq!(
        fields.get("proxyHost").map(String::as_str),
        Some("127.0.0.1")
    );
    assert_eq!(
        fields.get("proxyPassword").map(String::as_str),
        Some("s3cret")
    );

    // What the plugin reads back still stops at the address it dials.
    let listed = status(&secrets, &plugin, "en", None).unwrap();
    let public = &listed["slots"][0]["instances"][0]["publicFields"];
    assert_eq!(public["proxyHost"], json!("127.0.0.1"));
    assert_eq!(public.get("proxyPassword"), None);
    assert_eq!(public.get("password"), None);
}

#[test]
fn a_proxy_that_was_on_keeps_its_login_when_both_boxes_are_empty() {
    let dir = tempdir().unwrap();
    let (plugin, secrets) = fixture(&dir, "demo.proxy-keep", proxied_mailbox_slot());
    let id = set(
        &secrets,
        &plugin,
        "mailbox",
        account_with("alice", "hunter2", &local_http_proxy()),
        None,
    )
    .unwrap()
    .unwrap();

    // A new port, the same login: the two credential boxes were offered empty
    // because the host never shows them back.
    let moved = [
        ("proxyType", "http"),
        ("proxyHost", "127.0.0.1"),
        ("proxyPort", "7898"),
    ];
    update(
        &secrets,
        &plugin,
        "mailbox",
        &id,
        account_with("alice", "", &moved),
        None,
    )
    .unwrap();

    let fields = resolve(&secrets, &plugin, &format!("mailbox#{id}"), None).unwrap();
    assert_eq!(fields.get("proxyPort").map(String::as_str), Some("7898"));
    assert_eq!(
        fields.get("proxyUsername").map(String::as_str),
        Some("tunnel")
    );
    assert_eq!(
        fields.get("proxyPassword").map(String::as_str),
        Some("s3cret")
    );
}

#[test]
fn choosing_no_proxy_forgets_its_login_and_keeps_the_password() {
    let dir = tempdir().unwrap();
    let (plugin, secrets) = fixture(&dir, "demo.proxy-off", proxied_mailbox_slot());
    let id = set(
        &secrets,
        &plugin,
        "mailbox",
        account_with("alice", "hunter2", &local_http_proxy()),
        None,
    )
    .unwrap()
    .unwrap();

    // "No proxy" is a complete statement, so the address the form still holds is
    // dropped instead of being refused as a half-filled proxy.
    let mut submitted = account_with("alice", "", &[]);
    submitted.insert("proxyType".into(), json!(""));
    submitted.insert("proxyHost".into(), json!("127.0.0.1"));
    submitted.insert("proxyPort".into(), json!("7897"));
    update(&secrets, &plugin, "mailbox", &id, submitted, None).unwrap();

    let fields = resolve(&secrets, &plugin, &format!("mailbox#{id}"), None).unwrap();
    assert_eq!(fields.get("password").map(String::as_str), Some("hunter2"));
    for key in [
        "proxyType",
        "proxyHost",
        "proxyPort",
        "proxyUsername",
        "proxyPassword",
    ] {
        assert_eq!(
            fields.get(key),
            None,
            "{key} survived turning the proxy off"
        );
    }
}

#[test]
fn half_a_proxy_login_is_still_refused() {
    let dir = tempdir().unwrap();
    let (plugin, secrets) = fixture(&dir, "demo.proxy-half", proxied_mailbox_slot());
    let id = set(
        &secrets,
        &plugin,
        "mailbox",
        account_with("alice", "hunter2", &local_http_proxy()),
        None,
    )
    .unwrap()
    .unwrap();

    // A user name without a password is not "keep the saved one": the pair is
    // all or nothing, exactly as before.
    let mut submitted = account_with("alice", "hunter2", &[]);
    submitted.insert("proxyType".into(), json!("http"));
    submitted.insert("proxyHost".into(), json!("127.0.0.1"));
    submitted.insert("proxyPort".into(), json!("7897"));
    submitted.insert("proxyUsername".into(), json!("someone-else"));
    let error = update(&secrets, &plugin, "mailbox", &id, submitted, None).unwrap_err();
    assert!(
        error
            .to_string()
            .contains("both a user name and a password"),
        "{error}"
    );
}

#[test]
fn changing_the_server_keeps_the_saved_password_and_stores_the_new_server() {
    let dir = tempdir().unwrap();
    let (plugin, secrets) = fixture(&dir, "demo.server-move", proxied_mailbox_slot());
    let id = set(
        &secrets,
        &plugin,
        "mailbox",
        account_with("alice", "hunter2", &[]),
        None,
    )
    .unwrap()
    .unwrap();

    let moved = [
        ("server", "imap.other.example"),
        ("port", "143"),
        ("protocol", "imap"),
        ("security", "starttls"),
        ("sendServer", "smtp.other.example"),
        ("sendPort", "587"),
        ("sendSecurity", "starttls"),
    ];
    update(
        &secrets,
        &plugin,
        "mailbox",
        &id,
        account_with("alice", "", &moved),
        None,
    )
    .unwrap();

    let fields = resolve(&secrets, &plugin, &format!("mailbox#{id}"), None).unwrap();
    // The saved password follows the account to the server the user just named:
    // the login is the user's own act in the host's own form, never a plugin's.
    assert_eq!(fields.get("password").map(String::as_str), Some("hunter2"));
    assert_eq!(
        fields.get("server").map(String::as_str),
        Some("imap.other.example")
    );
    assert_eq!(fields.get("security").map(String::as_str), Some("starttls"));
    assert_eq!(
        fields.get("sendServer").map(String::as_str),
        Some("smtp.other.example")
    );
}

#[test]
fn a_new_account_still_has_to_type_its_secret() {
    let dir = tempdir().unwrap();
    let (plugin, secrets) = fixture(&dir, "demo.new", multi_mailbox_slot());

    // Nothing is stored, so there is nothing an empty box could keep.
    let error = set(
        &secrets,
        &plugin,
        "mailbox",
        account("alice@example.com", ""),
        None,
    )
    .unwrap_err();
    assert!(
        error.to_string().contains("field password is empty"),
        "{error}"
    );
    assert!(
        list(&secrets, &plugin, None).unwrap()["slots"][0]["instances"]
            .as_array()
            .map(|instances| instances.is_empty())
            .unwrap_or(true),
        "a refused save must not create an account"
    );
}

#[test]
fn a_single_value_slot_keeps_its_saved_secret_when_it_is_saved_again() {
    let dir = tempdir().unwrap();
    let (plugin, secrets) = fixture(&dir, "demo.single", mailbox_slot());

    set(
        &secrets,
        &plugin,
        "mailbox",
        account("alice", "hunter2"),
        None,
    )
    .unwrap();
    // The released form for a single slot shows no stored value either, so the
    // same rule has to hold on this path.
    set(&secrets, &plugin, "mailbox", account("bob", ""), None).unwrap();

    let fields = resolve(&secrets, &plugin, "mailbox", None).unwrap();
    assert_eq!(fields.get("username").map(String::as_str), Some("bob"));
    assert_eq!(fields.get("password").map(String::as_str), Some("hunter2"));
}
