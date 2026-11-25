//! The per-account proxy of a credential slot (`userProxy`): what is stored with
//! an account, what a plugin may read back, and what is refused at save time.
//!
//! A sibling of `credential_instances_tests`, sharing its fixtures: the same
//! installed plugin, the same encrypted store, the same reader functions.

use super::tests::{field, install, manifest};
use super::*;
use crate::secrets::SecretStore;
use serde_json::{json, Map, Value};
use tempfile::tempdir;

/// One account with two declared fields, as the multi-instance tests build it.
fn account(username: &str, password: &str) -> Map<String, Value> {
    let mut fields = Map::new();
    fields.insert("username".into(), json!(username));
    fields.insert("password".into(), json!(password));
    fields
}

fn instances_of(slots: &Value) -> &Vec<Value> {
    slots["slots"][0]["instances"]
        .as_array()
        .expect("an instance list")
}

/// A mailbox slot whose owner may name both a server and a proxy.
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
    })
}

/// One account with a custom server and, optionally, a proxy.
fn proxied_account(username: &str, proxy: &[(&str, &str)]) -> Map<String, Value> {
    let mut fields = account(username, "hunter2");
    fields.insert("server".into(), json!("imap.example.com"));
    fields.insert("port".into(), json!("993"));
    fields.insert("protocol".into(), json!("imap"));
    fields.insert("security".into(), json!("tls"));
    for (key, value) in proxy {
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

#[test]
fn a_proxy_is_stored_with_the_account_and_never_published() {
    let dir = tempdir().unwrap();
    let (_plugins, plugin, _root) = install(
        dir.path(),
        "demo.proxy",
        json!({ "credentials": [proxied_mailbox_slot()] }),
    );
    let secrets = SecretStore::open(dir.path()).unwrap();
    let id = set(
        &secrets,
        &plugin,
        "mailbox",
        proxied_account("alice", &local_http_proxy()),
        None,
    )
    .unwrap()
    .expect("a multi-instance slot answers the id it created");

    let slots = status(&secrets, &plugin, "en", None).unwrap();
    let entry = &slots["slots"][0];
    assert_eq!(entry["userProxy"], json!({ "types": ["http", "socks5"] }));
    let public = &instances_of(&slots)[0]["publicFields"];
    assert_eq!(public["proxyType"], json!("http"));
    assert_eq!(public["proxyHost"], json!("127.0.0.1"));
    assert_eq!(public["proxyPort"], json!("7897"));
    // Who the proxy logs in as is host-only: a plugin reads where, never who.
    assert_eq!(public.get("proxyUsername"), None);
    assert_eq!(public.get("proxyPassword"), None);

    // The dialer resolves through the same store, so the proxy values have to be
    // in the host-side map; it never reaches a plugin.
    let fields = resolve(&secrets, &plugin, &format!("mailbox#{id}"), None).unwrap();
    assert_eq!(fields["proxyType"], "http");
    assert_eq!(fields["proxyHost"], "127.0.0.1");
    assert_eq!(fields["proxyPort"], "7897");
    assert_eq!(fields["proxyPassword"], "s3cret");
    assert_eq!(fields["password"], "hunter2");
}

#[test]
fn a_proxy_that_is_left_empty_is_dropped_rather_than_stored() {
    let dir = tempdir().unwrap();
    let (_plugins, plugin, _root) = install(
        dir.path(),
        "demo.proxy-empty",
        json!({ "credentials": [proxied_mailbox_slot()] }),
    );
    let secrets = SecretStore::open(dir.path()).unwrap();
    let id = set(
        &secrets,
        &plugin,
        "mailbox",
        proxied_account("alice", &[("proxyType", "")]),
        None,
    )
    .unwrap()
    .unwrap();

    let fields = resolve(&secrets, &plugin, &format!("mailbox#{id}"), None).unwrap();
    assert!(!fields.contains_key("proxyType"));
    assert!(
        fields.contains_key("server"),
        "the custom server still applies"
    );
}

#[test]
fn a_half_filled_proxy_is_refused_at_save_time() {
    let dir = tempdir().unwrap();
    let (_plugins, plugin, _root) = install(
        dir.path(),
        "demo.proxy-invalid",
        json!({ "credentials": [proxied_mailbox_slot()] }),
    );
    let secrets = SecretStore::open(dir.path()).unwrap();
    let long = "x".repeat(256);
    let cases: Vec<(Vec<(&str, &str)>, &str)> = vec![
        (
            vec![("proxyType", "http"), ("proxyPort", "7897")],
            "needs a hostname or IP address and a port",
        ),
        (
            vec![("proxyType", "http"), ("proxyHost", "127.0.0.1")],
            "needs a hostname or IP address and a port",
        ),
        (
            vec![("proxyHost", "127.0.0.1"), ("proxyPort", "7897")],
            "a proxy needs a type",
        ),
        (
            vec![
                ("proxyType", "http"),
                ("proxyHost", "127.0.0.1"),
                ("proxyPort", "7897"),
                ("proxyUsername", "only-a-name"),
            ],
            "both a user name and a password",
        ),
        (
            vec![
                ("proxyType", "socks4"),
                ("proxyHost", "127.0.0.1"),
                ("proxyPort", "7897"),
            ],
            "not one this slot allows",
        ),
        (
            vec![
                ("proxyType", "http"),
                ("proxyHost", "http://127.0.0.1"),
                ("proxyPort", "7897"),
            ],
            "not a valid hostname or IP address",
        ),
        (
            vec![
                ("proxyType", "http"),
                ("proxyHost", "169.254.169.254"),
                ("proxyPort", "7897"),
            ],
            "must not be a cloud metadata endpoint",
        ),
        (
            vec![
                ("proxyType", "http"),
                ("proxyHost", "127.0.0.1"),
                ("proxyPort", "70000"),
            ],
            "must be a number from 1 to 65535",
        ),
        (
            vec![
                ("proxyType", "socks5"),
                ("proxyHost", "127.0.0.1"),
                ("proxyPort", "7897"),
                ("proxyUsername", "tunnel"),
                ("proxyPassword", "p\r\nX"),
            ],
            "cannot carry a line break or a NUL",
        ),
        (
            vec![
                ("proxyType", "socks5"),
                ("proxyHost", "127.0.0.1"),
                ("proxyPort", "7897"),
                ("proxyUsername", "tunnel"),
                ("proxyPassword", long.as_str()),
            ],
            "at most 255 bytes",
        ),
    ];
    for (proxy, expected) in cases {
        let error = set(
            &secrets,
            &plugin,
            "mailbox",
            proxied_account("alice", &proxy),
            None,
        )
        .expect_err(&format!("{proxy:?} must be refused"));
        let message = format!("{error:?}");
        assert!(message.contains(expected), "{proxy:?}: {message}");
    }
    // Nothing was stored by any of the refusals.
    assert!(resolve(&secrets, &plugin, "mailbox#acc_00000001", None).is_err());
}

#[test]
fn a_loopback_proxy_is_exactly_what_this_is_for() {
    let dir = tempdir().unwrap();
    let (_plugins, plugin, _root) = install(
        dir.path(),
        "demo.proxy-loopback",
        json!({ "credentials": [proxied_mailbox_slot()] }),
    );
    let secrets = SecretStore::open(dir.path()).unwrap();
    let id = set(
        &secrets,
        &plugin,
        "mailbox",
        proxied_account("alice", &local_http_proxy()),
        None,
    )
    .unwrap()
    .unwrap();
    let fields = resolve(&secrets, &plugin, &format!("mailbox#{id}"), None).unwrap();
    assert_eq!(fields["proxyHost"], "127.0.0.1");
}

#[test]
fn an_account_saved_before_the_proxy_existed_keeps_working() {
    let dir = tempdir().unwrap();
    let mut slot = proxied_mailbox_slot();
    // One account, stored the way 1.10.0 did it: no instance list, no proxy.
    slot.as_object_mut().unwrap().remove("multiple");
    slot.as_object_mut().unwrap().remove("labelField");
    let (_plugins, plugin, _root) = install(
        dir.path(),
        "demo.proxy-upgrade",
        json!({ "credentials": [slot] }),
    );
    let secrets = SecretStore::open(dir.path()).unwrap();
    let stored = json!({ "fields": {
        "username": "old@example.com",
        "password": "hunter2",
        "server": "imap.example.com",
        "port": "993",
        "protocol": "imap",
        "security": "tls",
    }});
    secrets
        .set(
            &slot_ref(&plugin.id, "mailbox"),
            &serde_json::to_string(&stored).unwrap(),
        )
        .unwrap();

    let status = status(&secrets, &plugin, "en", None).unwrap();
    assert_eq!(status["slots"][0]["configured"], json!(true));
    let fields = resolve(&secrets, &plugin, "mailbox", None).unwrap();
    assert_eq!(fields["password"], "hunter2");
    assert_eq!(fields["server"], "imap.example.com");
    // No proxy is invented for an account that never had one.
    assert!(!fields.contains_key("proxyType"));
}
