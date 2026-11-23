//! Multi-instance credential slots (`multiple` / `labelField`): instances in the
//! secret store, the single→multi migration, the fold-back of a manifest that
//! dropped `multiple`, and the instance references the egress paths resolve.
//!
//! A sibling of `credentials_tests`, sharing its fixtures: the declarations, the
//! installed plugin and the store are the same objects, and one file per concern
//! keeps both readable.

use super::tests::{
    field, filled, install, mailbox_slot, manifest, smtp_fields, smtp_slot, write_manifest,
};
use super::*;
use crate::secrets::SecretStore;
use serde_json::{json, Value};
use tempfile::tempdir;

// ---------------------------------------------------------------------------
// Multi-instance slots (`multiple` / `labelField`)
// ---------------------------------------------------------------------------

/// A mailbox slot that holds several accounts and names them by address.
fn multi_mailbox_slot() -> Value {
    json!({
        "id": "mailbox",
        "title": { "en": "Mailbox", "zh-CN": "邮箱" },
        "kind": "imap",
        "fields": [field("username", "Address", false), field("password", "Password", true)],
        "scope": { "domains": ["imap.example.com"] },
        "multiple": { "max": 2 },
        "labelField": "username",
    })
}

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

#[test]
fn a_multi_instance_slot_lists_instances_without_any_secret() {
    let dir = tempdir().unwrap();
    let (_plugins, plugin, _root) = install(
        dir.path(),
        "demo.multi",
        json!({ "credentials": [multi_mailbox_slot()] }),
    );
    let secrets = SecretStore::open(dir.path()).unwrap();
    let first = set(
        &secrets,
        &plugin,
        "mailbox",
        account("alice@example.com", "hunter2"),
        None,
    )
    .unwrap()
    .expect("a multi-instance slot answers the id it created");
    let second = set(
        &secrets,
        &plugin,
        "mailbox",
        account("bob@example.com", "swordfish"),
        None,
    )
    .unwrap()
    .expect("a multi-instance slot answers the id it created");
    assert_ne!(first, second);
    assert!(first.starts_with("acc_") && first.len() == 12, "{first}");

    let listed = list(&secrets, &plugin, None).unwrap();
    assert_eq!(listed["slots"][0]["multiple"], json!(true));
    assert_eq!(listed["slots"][0]["max"], json!(2));
    assert_eq!(listed["slots"][0]["configured"], json!(true));
    let instances = instances_of(&listed);
    assert_eq!(instances.len(), 2);
    assert_eq!(instances[0]["instanceId"], json!(first));
    assert_eq!(instances[0]["label"], json!("alice@example.com"));
    assert_eq!(
        instances[0]["publicFields"],
        json!({ "username": "alice@example.com" })
    );
    // The list is the plugin-facing answer: no password may appear anywhere in it.
    assert!(!listed.to_string().contains("hunter2"), "{listed}");
    assert!(!listed.to_string().contains("swordfish"), "{listed}");
}

#[test]
fn a_multi_instance_slot_refuses_more_than_its_maximum() {
    let dir = tempdir().unwrap();
    let (_plugins, plugin, _root) = install(
        dir.path(),
        "demo.multi-max",
        json!({ "credentials": [multi_mailbox_slot()] }),
    );
    let secrets = SecretStore::open(dir.path()).unwrap();
    set(
        &secrets,
        &plugin,
        "mailbox",
        account("a@example.com", "one"),
        None,
    )
    .unwrap();
    set(
        &secrets,
        &plugin,
        "mailbox",
        account("b@example.com", "two"),
        None,
    )
    .unwrap();
    let error = set(
        &secrets,
        &plugin,
        "mailbox",
        account("c@example.com", "three"),
        None,
    )
    .unwrap_err();
    assert!(error.to_string().starts_with(CREDENTIAL_LIMIT), "{error}");
    // The refusal left the two stored accounts alone.
    assert_eq!(
        instances_of(&list(&secrets, &plugin, None).unwrap()).len(),
        2
    );
}

#[test]
fn two_accounts_do_not_share_a_value() {
    let dir = tempdir().unwrap();
    let (_plugins, plugin, _root) = install(
        dir.path(),
        "demo.multi-isolated",
        json!({ "credentials": [multi_mailbox_slot()] }),
    );
    let secrets = SecretStore::open(dir.path()).unwrap();
    let first = set(
        &secrets,
        &plugin,
        "mailbox",
        account("a@example.com", "one"),
        None,
    )
    .unwrap()
    .unwrap();
    let second = set(
        &secrets,
        &plugin,
        "mailbox",
        account("b@example.com", "two"),
        None,
    )
    .unwrap()
    .unwrap();
    let first_fields = resolve(&secrets, &plugin, &format!("mailbox#{first}"), None).unwrap();
    let second_fields = resolve(&secrets, &plugin, &format!("mailbox#{second}"), None).unwrap();
    assert_eq!(first_fields["password"], "one");
    assert_eq!(first_fields["username"], "a@example.com");
    assert_eq!(second_fields["password"], "two");
    assert_eq!(second_fields["username"], "b@example.com");
}

#[test]
fn an_instance_reference_is_required_and_validated() {
    let dir = tempdir().unwrap();
    let (_plugins, plugin, _root) = install(
        dir.path(),
        "demo.multi-ref",
        json!({ "credentials": [multi_mailbox_slot()] }),
    );
    let secrets = SecretStore::open(dir.path()).unwrap();
    set(
        &secrets,
        &plugin,
        "mailbox",
        account("a@example.com", "one"),
        None,
    )
    .unwrap();

    let missing = resolve(&secrets, &plugin, "mailbox", None).unwrap_err();
    assert!(
        missing
            .to_string()
            .starts_with(credential_instances::CREDENTIAL_INSTANCE_REQUIRED),
        "{missing}"
    );
    let unknown = resolve(&secrets, &plugin, "mailbox#acc_01234567", None).unwrap_err();
    assert!(
        unknown.to_string().starts_with(CREDENTIAL_NOT_CONFIGURED),
        "{unknown}"
    );
    let malformed = resolve(&secrets, &plugin, "mailbox#not-an-id", None).unwrap_err();
    assert!(
        malformed.to_string().starts_with(CREDENTIAL_INVALID),
        "{malformed}"
    );
    let undeclared = resolve(&secrets, &plugin, "nope#acc_01234567", None).unwrap_err();
    assert!(
        undeclared
            .to_string()
            .starts_with(CREDENTIAL_SLOT_NOT_DECLARED),
        "{undeclared}"
    );
}

#[test]
fn a_multi_instance_reference_is_refused_by_a_single_instance_slot() {
    let dir = tempdir().unwrap();
    let (_plugins, plugin, _root) = install(
        dir.path(),
        "demo.single-ref",
        json!({ "credentials": [mailbox_slot()] }),
    );
    let secrets = SecretStore::open(dir.path()).unwrap();
    set(&secrets, &plugin, "mailbox", filled(), None).unwrap();
    let error = resolve(&secrets, &plugin, "mailbox#acc_01234567", None).unwrap_err();
    assert!(error.to_string().starts_with(CREDENTIAL_INVALID), "{error}");
}

#[test]
fn a_slot_that_becomes_multi_instance_keeps_the_stored_account() {
    let dir = tempdir().unwrap();
    let (_plugins, plugin, root) = install(
        dir.path(),
        "demo.upgrade",
        json!({ "credentials": [mailbox_slot()] }),
    );
    let secrets = SecretStore::open(dir.path()).unwrap();
    set(&secrets, &plugin, "mailbox", filled(), None).unwrap();
    assert!(secrets.has(&slot_ref(&plugin.id, "mailbox")));

    // The manifest now declares the same slot, with instances.
    write_manifest(
        &root,
        manifest(
            "demo.upgrade",
            json!({ "credentials": [multi_mailbox_slot()] }),
        ),
    );

    let listed = list(&secrets, &plugin, None).unwrap();
    let instances = instances_of(&listed);
    assert_eq!(
        instances.len(),
        1,
        "the stored value becomes the first instance"
    );
    assert_eq!(instances[0]["label"], json!("alice"));
    assert_eq!(instances[0]["publicFields"], json!({ "username": "alice" }));
    // The released reference is gone, and the value is reachable as the instance.
    assert!(!secrets.has(&slot_ref(&plugin.id, "mailbox")));
    let instance_id = instances[0]["instanceId"].as_str().unwrap();
    let fields = resolve(&secrets, &plugin, &format!("mailbox#{instance_id}"), None).unwrap();
    assert_eq!(fields["password"], "hunter2");

    // Migrating again is a no-op: same id, one instance.
    let again = list(&secrets, &plugin, None).unwrap();
    assert_eq!(instances_of(&again).len(), 1);
    assert_eq!(instances_of(&again)[0]["instanceId"], json!(instance_id));
}

#[test]
fn a_slot_that_drops_multiple_keeps_the_first_instance_and_audits() {
    let dir = tempdir().unwrap();
    let (_plugins, plugin, root) = install(
        dir.path(),
        "demo.downgrade",
        json!({ "credentials": [multi_mailbox_slot()] }),
    );
    let secrets = SecretStore::open(dir.path()).unwrap();
    let first = set(
        &secrets,
        &plugin,
        "mailbox",
        account("a@example.com", "one"),
        None,
    )
    .unwrap()
    .unwrap();
    let second = set(
        &secrets,
        &plugin,
        "mailbox",
        account("b@example.com", "two"),
        None,
    )
    .unwrap()
    .unwrap();
    let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();

    write_manifest(
        &root,
        manifest("demo.downgrade", json!({ "credentials": [mailbox_slot()] })),
    );

    let listed = list(&secrets, &plugin, Some(&db)).unwrap();
    assert_eq!(listed["slots"][0]["configured"], json!(true));
    assert!(
        listed["slots"][0].get("instances").is_none(),
        "a single-instance slot carries no instance list"
    );
    // The first account is the slot's value again; the second one is gone.
    let fields = resolve(&secrets, &plugin, "mailbox", Some(&db)).unwrap();
    assert_eq!(fields["username"], "a@example.com");
    assert_eq!(fields["password"], "one");
    assert!(!secrets.has(&credential_instances::instance_ref(
        &plugin.id, "mailbox", &first
    )));
    assert!(!secrets.has(&credential_instances::instance_ref(
        &plugin.id, "mailbox", &second
    )));

    // One audit row, naming ids and no value.
    let payload: String = db
        .conn()
        .query_row(
            "SELECT payload_json FROM audit_log WHERE kind = ?1 ORDER BY id DESC LIMIT 1",
            rusqlite::params![credential_instances::AUDIT_KIND],
            |row| row.get(0),
        )
        .unwrap();
    assert!(payload.contains("\"foldBack\""), "{payload}");
    assert!(payload.contains(&first), "{payload}");
    assert!(!payload.contains("hunter2"), "{payload}");
    assert!(!payload.contains("a@example.com"), "{payload}");
}

#[test]
fn an_uninstall_removes_every_instance_and_the_index() {
    let dir = tempdir().unwrap();
    let (mut plugins, plugin, _root) = install(
        dir.path(),
        "demo.multi-purge",
        json!({ "credentials": [multi_mailbox_slot()] }),
    );
    let secrets = SecretStore::open(dir.path()).unwrap();
    let first = set(
        &secrets,
        &plugin,
        "mailbox",
        account("a@example.com", "one"),
        None,
    )
    .unwrap()
    .unwrap();
    let second = set(
        &secrets,
        &plugin,
        "mailbox",
        account("b@example.com", "two"),
        None,
    )
    .unwrap()
    .unwrap();

    assert!(plugins.uninstall(&plugin.id).unwrap());
    for instance in [&first, &second] {
        assert!(!secrets.has(&credential_instances::instance_ref(
            &plugin.id, "mailbox", instance
        )));
    }
    assert!(!secrets.has(&index_ref(&plugin.id)));
}

#[test]
fn a_second_account_with_the_same_label_is_refused() {
    let dir = tempdir().unwrap();
    let (_plugins, plugin, _root) = install(
        dir.path(),
        "demo.multi-dup",
        json!({ "credentials": [multi_mailbox_slot()] }),
    );
    let secrets = SecretStore::open(dir.path()).unwrap();
    set(
        &secrets,
        &plugin,
        "mailbox",
        account("a@example.com", "one"),
        None,
    )
    .unwrap();
    let error = set(
        &secrets,
        &plugin,
        "mailbox",
        account("a@example.com", "two"),
        None,
    )
    .unwrap_err();
    assert!(error.to_string().starts_with(CREDENTIAL_INVALID), "{error}");
    assert_eq!(
        instances_of(&list(&secrets, &plugin, None).unwrap()).len(),
        1
    );
}

#[test]
fn clearing_one_instance_leaves_the_others() {
    let dir = tempdir().unwrap();
    let (_plugins, plugin, _root) = install(
        dir.path(),
        "demo.multi-clear",
        json!({ "credentials": [multi_mailbox_slot()] }),
    );
    let secrets = SecretStore::open(dir.path()).unwrap();
    let first = set(
        &secrets,
        &plugin,
        "mailbox",
        account("a@example.com", "one"),
        None,
    )
    .unwrap()
    .unwrap();
    set(
        &secrets,
        &plugin,
        "mailbox",
        account("b@example.com", "two"),
        None,
    )
    .unwrap();

    assert!(clear(&secrets, &plugin, "mailbox", Some(&first), None).unwrap());
    let listed = list(&secrets, &plugin, None).unwrap();
    assert_eq!(instances_of(&listed).len(), 1);
    assert_eq!(instances_of(&listed)[0]["label"], json!("b@example.com"));

    // Clearing the slot itself removes the rest.
    assert!(clear(&secrets, &plugin, "mailbox", None, None).unwrap());
    assert_eq!(
        instances_of(&list(&secrets, &plugin, None).unwrap()).len(),
        0
    );
}

#[test]
fn status_reports_the_select_control_and_the_label_field() {
    let dir = tempdir().unwrap();
    let (_plugins, plugin, _root) = install(
        dir.path(),
        "demo.multi-select",
        json!({ "credentials": [{
            "id": "mailbox",
            "title": "Mailbox",
            "kind": "imap",
            "fields": [
                field("username", "Address", false),
                { "key": "security", "label": { "en": "Security", "zh-CN": "安全" },
                  "type": "select",
                  "options": [
                    { "value": "tls", "label": { "en": "TLS", "zh-CN": "TLS" } },
                    { "value": "starttls", "label": "STARTTLS" }
                  ] },
            ],
            "scope": { "domains": ["imap.example.com"] },
            "multiple": { "max": 3 },
            "labelField": "username",
        }] }),
    );
    let secrets = SecretStore::open(dir.path()).unwrap();
    let status = status(&secrets, &plugin, "zh-CN", None).unwrap();
    let slot = &status["slots"][0];
    assert_eq!(slot["max"], json!(3));
    assert_eq!(slot["labelField"], json!("username"));
    assert_eq!(slot["fields"][1]["type"], json!("select"));
    assert_eq!(slot["fields"][1]["options"][0]["label"], json!("TLS"));
    assert_eq!(slot["fields"][1]["options"][1]["label"], json!("STARTTLS"));
}

#[test]
fn a_manifest_with_an_unusable_instance_declaration_is_refused() {
    let dir = tempdir().unwrap();
    let cases = [
        json!({ "id": "mailbox", "title": "M", "kind": "imap",
                "fields": [field("username", "U", false)],
                "multiple": { "max": 6 } }),
        json!({ "id": "mailbox", "title": "M", "kind": "imap",
                "fields": [field("username", "U", false)],
                "multiple": { "max": 0 } }),
        json!({ "id": "mailbox", "title": "M", "kind": "imap",
                "fields": [field("password", "P", true)],
                "multiple": { "max": 2 }, "labelField": "password" }),
        json!({ "id": "mailbox", "title": "M", "kind": "imap",
                "fields": [field("username", "U", false)],
                "multiple": { "max": 2 }, "labelField": "missing" }),
        json!({ "id": "mailbox", "title": "M", "kind": "imap",
                "fields": [{ "key": "secret", "label": "S", "secret": true, "type": "select",
                             "options": [{ "value": "a", "label": "A" }] }] }),
        json!({ "id": "mailbox", "title": "M", "kind": "imap",
                "fields": [{ "key": "pick", "label": "P", "type": "select" }] }),
    ];
    for (position, slot) in cases.into_iter().enumerate() {
        let (_plugins, plugin, _root) = install(
            dir.path(),
            &format!("demo.bad-{position}"),
            json!({ "credentials": [slot] }),
        );
        let secrets = SecretStore::open(dir.path()).unwrap();
        let error = status(&secrets, &plugin, "en", None).unwrap_err();
        assert!(
            error.to_string().starts_with("PLUGIN_INVALID"),
            "case {position}: {error}"
        );
    }
}

/// `credential_instances::add` is the one caller that does not go through
/// `credentials::set`, so it has to settle the stored shape itself. This pins the
/// order inside it: with a pre-`multiple` value still at the released reference,
/// the migrated account and the new one both have to survive the write.
#[test]
fn adding_to_a_slot_with_a_legacy_value_migrates_it_and_keeps_both() {
    let dir = tempdir().unwrap();
    let (_plugins, plugin, root) = install(
        dir.path(),
        "demo.add-migrates",
        json!({ "credentials": [mailbox_slot()] }),
    );
    let secrets = SecretStore::open(dir.path()).unwrap();
    set(&secrets, &plugin, "mailbox", filled(), None).unwrap();

    // The manifest now declares instances, but nothing has read the slot since:
    // the released single value is still the only thing stored.
    write_manifest(
        &root,
        manifest(
            "demo.add-migrates",
            json!({ "credentials": [multi_mailbox_slot()] }),
        ),
    );
    let slot = declared_slot(&plugin, "mailbox").unwrap();
    assert!(secrets.has(&slot_ref(&plugin.id, "mailbox")));

    let mut values = BTreeMap::new();
    values.insert("username".to_string(), "b@example.com".to_string());
    values.insert("password".to_string(), "two".to_string());
    let added = credential_instances::add(&secrets, &plugin.id, &slot, &values, None).unwrap();

    let listed = list(&secrets, &plugin, None).unwrap();
    let instances = instances_of(&listed);
    assert_eq!(
        instances.len(),
        2,
        "the migrated account and the new one both stay: {instances:?}"
    );
    assert_eq!(instances[0]["label"], json!("alice"));
    assert_eq!(instances[0]["publicFields"], json!({ "username": "alice" }));
    assert_eq!(instances[1]["instanceId"], json!(added));
    assert_eq!(instances[1]["label"], json!("b@example.com"));
    // The released reference is gone: the value lives on as the first instance.
    assert!(!secrets.has(&slot_ref(&plugin.id, "mailbox")));
    let migrated = instances[0]["instanceId"].as_str().unwrap();
    let fields = resolve(&secrets, &plugin, &format!("mailbox#{migrated}"), None).unwrap();
    assert_eq!(fields["password"], "hunter2");
}
