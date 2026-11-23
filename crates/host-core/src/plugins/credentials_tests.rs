//! Credential-slot storage tests: what is written, what is refused, and what a
//! disable or an uninstall leaves behind.

use super::*;
use crate::plugins::{MarketChannel, PluginManager, PluginSummary};
use crate::secrets::SecretStore;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use tempfile::tempdir;

fn field(key: &str, label: &str, secret: bool) -> Value {
    json!({
        "key": key,
        "label": { "en": label, "zh-CN": label },
        "secret": secret,
    })
}

fn mailbox_slot() -> Value {
    json!({
        "id": "mailbox",
        "title": { "en": "Mailbox", "zh-CN": "邮箱" },
        "kind": "basic",
        "fields": [field("username", "User", false), field("password", "Password", true)],
        "scope": { "domains": ["imap.example.com"] },
    })
}

fn smtp_slot() -> Value {
    json!({
        "id": "smtp",
        "title": "SMTP",
        "kind": "basic",
        "fields": [field("host", "Host", false)],
        "scope": { "domains": ["smtp.example.com"] },
    })
}

fn manifest(plugin_id: &str, contributes: Value) -> Value {
    json!({
        "schemaVersion": 1,
        "id": plugin_id,
        "name": "Mail",
        "version": "0.1.0",
        "main": "main.js",
        "permissions": ["credentials.use"],
        "contributes": contributes,
    })
}

fn write_manifest(root: &Path, document: Value) {
    fs::create_dir_all(root).unwrap();
    fs::write(root.join("main.js"), "export function onLoad() {}").unwrap();
    fs::write(
        root.join("manifest.json"),
        serde_json::to_string_pretty(&document).unwrap(),
    )
    .unwrap();
}

/// A manager over `data_dir` without going through `PluginManager::new`, which
/// would reach for the marketplace catalog these tests never use.
fn manager(data_dir: &Path) -> PluginManager {
    PluginManager {
        data_dir: data_dir.to_path_buf(),
        runtime: Vec::new(),
        bundled_ids: Default::default(),
        market_channel: MarketChannel::Official,
        install_cancel: None,
        locale: "en".into(),
    }
}

fn install(
    data_dir: &Path,
    plugin_id: &str,
    contributes: Value,
) -> (PluginManager, PluginSummary, PathBuf) {
    let root = data_dir
        .join("plugins/installed")
        .join(plugin_id.replace('.', "-"));
    write_manifest(&root, manifest(plugin_id, contributes));
    let mut plugins = manager(data_dir);
    let summary = plugins
        .load_dev(root.to_str().unwrap())
        .expect("register the development plugin");
    (plugins, summary, root)
}

fn filled() -> Map<String, Value> {
    let mut fields = Map::new();
    fields.insert("username".into(), json!("alice"));
    fields.insert("password".into(), json!("hunter2"));
    fields
}

fn smtp_fields() -> Map<String, Value> {
    let mut fields = Map::new();
    fields.insert("host".into(), json!("smtp.example.com"));
    fields
}

#[test]
fn status_carries_the_declaration_and_never_a_value() {
    let dir = tempdir().unwrap();
    let (_plugins, plugin, _root) = install(
        dir.path(),
        "demo.status",
        json!({ "credentials": [mailbox_slot()] }),
    );
    let secrets = SecretStore::open(dir.path()).unwrap();
    set(&secrets, &plugin, "mailbox", filled(), None).unwrap();

    let english = status(&secrets, &plugin, "en", None).unwrap();
    let slot = &english["slots"][0];
    assert_eq!(slot["id"], "mailbox");
    assert_eq!(slot["title"], "Mailbox");
    assert_eq!(slot["kind"], "basic");
    assert_eq!(slot["fields"][0]["key"], "username");
    assert_eq!(slot["fields"][0]["label"], "User");
    assert_eq!(slot["fields"][0]["secret"], false);
    assert_eq!(slot["fields"][1]["key"], "password");
    assert_eq!(slot["fields"][1]["secret"], true);
    assert_eq!(slot["scope"]["domains"][0], "imap.example.com");
    assert_eq!(slot["configured"], true);
    assert!(slot["lastUsedAt"].is_null());

    // The declaration is localized like every other plugin display string, and
    // no response shape may grow a value.
    let localized = status(&secrets, &plugin, "zh-CN", None).unwrap();
    assert_eq!(localized["slots"][0]["title"], "邮箱");
    for response in [&english, &localized] {
        let text = serde_json::to_string(response).unwrap();
        assert!(!text.contains("hunter2"), "{text}");
        assert!(!text.contains("alice"), "{text}");
    }
}

#[test]
fn resolve_returns_the_declared_fields_and_records_last_use() {
    let dir = tempdir().unwrap();
    let (_plugins, plugin, _root) = install(
        dir.path(),
        "demo.resolve",
        json!({ "credentials": [mailbox_slot()] }),
    );
    let secrets = SecretStore::open(dir.path()).unwrap();
    set(&secrets, &plugin, "mailbox", filled(), None).unwrap();

    let fields = resolve(&secrets, &plugin, "mailbox", None).unwrap();
    assert_eq!(fields.len(), 2);
    assert_eq!(fields.get("username").map(String::as_str), Some("alice"));
    assert_eq!(fields.get("password").map(String::as_str), Some("hunter2"));

    let status = status(&secrets, &plugin, "en", None).unwrap();
    assert!(status["slots"][0]["lastUsedAt"].is_number());

    // A store that cannot authenticate is not a slot with values.
    clear(&secrets, &plugin, "mailbox", None, None).unwrap();
    assert!(matches!(
        resolve(&secrets, &plugin, "mailbox", None),
        Err(CredentialError::NotConfigured(_))
    ));
}

#[test]
fn a_stored_slot_is_encrypted_at_rest() {
    let dir = tempdir().unwrap();
    let (_plugins, plugin, _root) = install(
        dir.path(),
        "demo.at-rest",
        json!({ "credentials": [mailbox_slot()] }),
    );
    let secrets = SecretStore::open(dir.path()).unwrap();
    set(&secrets, &plugin, "mailbox", filled(), None).unwrap();

    let mut inspected = 0;
    for entry in fs::read_dir(dir.path().join("secrets")).unwrap() {
        let path = entry.unwrap().path();
        // `.machine-key` is raw key bytes, not text: only the blobs are
        // encrypted payloads and only they are inspected this way.
        if path.extension().and_then(|ext| ext.to_str()) != Some("bin") {
            continue;
        }
        let raw = String::from_utf8_lossy(&fs::read(&path).unwrap()).to_string();
        inspected += 1;
        assert!(!raw.contains("hunter2"), "slot blob holds plaintext");
        assert!(!raw.contains("alice"), "slot blob holds plaintext");
    }
    assert!(inspected > 0, "no secret blob was written");
}

#[test]
fn resolve_before_the_slot_is_filled_is_not_configured() {
    let dir = tempdir().unwrap();
    let (_plugins, plugin, _root) = install(
        dir.path(),
        "demo.unconfigured",
        json!({ "credentials": [mailbox_slot()] }),
    );
    let secrets = SecretStore::open(dir.path()).unwrap();

    let status = status(&secrets, &plugin, "en", None).unwrap();
    assert_eq!(status["slots"][0]["configured"], false);
    assert!(status["slots"][0]["lastUsedAt"].is_null());

    let error = resolve(&secrets, &plugin, "mailbox", None).unwrap_err();
    assert!(
        error.to_string().starts_with(CREDENTIAL_NOT_CONFIGURED),
        "{error}"
    );
}

#[test]
fn a_partial_widened_empty_or_non_string_field_set_is_refused() {
    let dir = tempdir().unwrap();
    let (_plugins, plugin, _root) = install(
        dir.path(),
        "demo.partial",
        json!({ "credentials": [mailbox_slot()] }),
    );
    let secrets = SecretStore::open(dir.path()).unwrap();

    let mut partial = Map::new();
    partial.insert("username".into(), json!("alice"));
    let mut widened = filled();
    widened.insert("tenant".into(), json!("acme"));
    let mut empty = filled();
    empty.insert("password".into(), json!("   "));
    let mut non_string = filled();
    non_string.insert("password".into(), json!(42));

    for fields in [partial, widened, empty, non_string] {
        let error = set(&secrets, &plugin, "mailbox", fields, None).unwrap_err();
        assert!(error.to_string().starts_with(CREDENTIAL_INVALID), "{error}");
    }
    // A refused slot never reaches the store.
    assert!(!secrets.has(&slot_ref(&plugin.id, "mailbox")));
}

#[test]
fn slots_the_manifest_does_not_declare_are_refused() {
    let dir = tempdir().unwrap();
    let (_plugins, plugin, _root) = install(
        dir.path(),
        "demo.undeclared",
        json!({ "credentials": [mailbox_slot()] }),
    );
    let secrets = SecretStore::open(dir.path()).unwrap();

    let error = set(&secrets, &plugin, "smtp", smtp_fields(), None).unwrap_err();
    assert!(
        error.to_string().starts_with(CREDENTIAL_SLOT_NOT_DECLARED),
        "{error}"
    );
    let error = resolve(&secrets, &plugin, "smtp", None).unwrap_err();
    assert!(
        error.to_string().starts_with(CREDENTIAL_SLOT_NOT_DECLARED),
        "{error}"
    );
}

#[test]
fn a_plugin_without_credential_slots_reports_none() {
    let dir = tempdir().unwrap();
    let (_plugins, plugin, _root) = install(dir.path(), "demo.slotless", json!({}));
    let secrets = SecretStore::open(dir.path()).unwrap();

    assert_eq!(
        status(&secrets, &plugin, "en", None).unwrap()["slots"],
        json!([])
    );
    assert_eq!(list(&secrets, &plugin, None).unwrap()["slots"], json!([]));
}

#[test]
fn a_manifest_that_added_a_field_makes_the_stored_slot_unconfigured() {
    let dir = tempdir().unwrap();
    let (_plugins, plugin, root) = install(
        dir.path(),
        "demo.grown",
        json!({ "credentials": [mailbox_slot()] }),
    );
    let secrets = SecretStore::open(dir.path()).unwrap();
    set(&secrets, &plugin, "mailbox", filled(), None).unwrap();
    assert_eq!(
        status(&secrets, &plugin, "en", None).unwrap()["slots"][0]["configured"],
        true
    );

    let mut grown = mailbox_slot();
    grown["fields"] = json!([
        field("username", "User", false),
        field("password", "Password", true),
        field("domain", "Domain", false),
    ]);
    write_manifest(
        &root,
        manifest("demo.grown", json!({ "credentials": [grown] })),
    );

    // Half a credential must never be injected after a manifest change.
    assert_eq!(
        status(&secrets, &plugin, "en", None).unwrap()["slots"][0]["configured"],
        false
    );
    let error = resolve(&secrets, &plugin, "mailbox", None).unwrap_err();
    assert!(
        error.to_string().starts_with(CREDENTIAL_NOT_CONFIGURED),
        "{error}"
    );
}

#[test]
fn clear_works_after_the_manifest_dropped_the_slot() {
    let dir = tempdir().unwrap();
    let (_plugins, plugin, root) = install(
        dir.path(),
        "demo.dropped",
        json!({ "credentials": [mailbox_slot(), smtp_slot()] }),
    );
    let secrets = SecretStore::open(dir.path()).unwrap();
    set(&secrets, &plugin, "smtp", smtp_fields(), None).unwrap();
    set(&secrets, &plugin, "mailbox", filled(), None).unwrap();
    write_manifest(
        &root,
        manifest("demo.dropped", json!({ "credentials": [mailbox_slot()] })),
    );

    assert!(clear(&secrets, &plugin, "smtp", None, None).unwrap());
    assert!(!secrets.has(&slot_ref(&plugin.id, "smtp")));
    // Clearing again is idempotent and reports that nothing was there.
    assert!(!clear(&secrets, &plugin, "smtp", None, None).unwrap());
    // The slot still declared keeps its value.
    assert!(secrets.has(&slot_ref(&plugin.id, "mailbox")));
}

#[test]
fn disabling_a_plugin_keeps_its_slots() {
    let dir = tempdir().unwrap();
    let (mut plugins, plugin, _root) = install(
        dir.path(),
        "demo.disable",
        json!({ "credentials": [mailbox_slot()] }),
    );
    let secrets = SecretStore::open(dir.path()).unwrap();
    set(&secrets, &plugin, "mailbox", filled(), None).unwrap();

    plugins.set_enabled(&plugin.id, false).unwrap();
    let disabled = plugins.get(&plugin.id).expect("row stays registered");
    assert!(!disabled.enabled);

    // A re-enable must not ask the user to paste the token again.
    assert_eq!(
        resolve(&secrets, &disabled, "mailbox", None)
            .unwrap()
            .get("password")
            .map(String::as_str),
        Some("hunter2")
    );
    assert_eq!(
        status(&secrets, &disabled, "en", None).unwrap()["slots"][0]["configured"],
        true
    );
}

#[test]
fn uninstall_clears_every_slot_including_removed_declarations() {
    let dir = tempdir().unwrap();
    let (mut plugins, plugin, root) = install(
        dir.path(),
        "demo.uninstall",
        json!({ "credentials": [mailbox_slot(), smtp_slot()] }),
    );
    let secrets = SecretStore::open(dir.path()).unwrap();
    set(&secrets, &plugin, "mailbox", filled(), None).unwrap();
    set(&secrets, &plugin, "smtp", smtp_fields(), None).unwrap();

    // The manifest stops declaring `smtp` before the uninstall; its value must
    // still go, which is what the per-plugin index is for.
    write_manifest(
        &root,
        manifest("demo.uninstall", json!({ "credentials": [mailbox_slot()] })),
    );

    assert!(plugins.uninstall(&plugin.id).unwrap());
    assert!(!secrets.has(&slot_ref(&plugin.id, "mailbox")));
    assert!(!secrets.has(&slot_ref(&plugin.id, "smtp")));
    assert!(!secrets.has(&index_ref(&plugin.id)));

    // Nothing but the machine key may survive in the secret store.
    let leftover: Vec<String> = fs::read_dir(dir.path().join("secrets"))
        .unwrap()
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.file_name().to_string_lossy().to_string())
        .filter(|name| name != ".machine-key")
        .collect();
    assert!(leftover.is_empty(), "{leftover:?}");
}

/// The on-disk blob a secret ref hashes to. The store's own path helper is
/// private, and this test needs to damage one file on purpose.
fn blob_path(data_dir: &Path, secret_ref: &str) -> PathBuf {
    let mut hasher = Sha256::new();
    hasher.update(secret_ref.as_bytes());
    data_dir
        .join("secrets")
        .join(format!("{}.bin", hex::encode(hasher.finalize())))
}

/// A purge that cannot finish must refuse the uninstall instead of removing the
/// row and stranding encrypted values with nothing left pointing at them.
#[test]
fn a_failed_credential_purge_refuses_the_uninstall_and_keeps_the_value() {
    let dir = tempdir().unwrap();
    let (mut plugins, plugin, _root) = install(
        dir.path(),
        "demo.purge-fails",
        json!({ "credentials": [mailbox_slot()] }),
    );
    let secrets = SecretStore::open(dir.path()).unwrap();
    set(&secrets, &plugin, "mailbox", filled(), None).unwrap();

    // Damage the plugin's slot index: the purge can no longer prove which slots
    // belong to this plugin, which is exactly the state it must not paper over.
    let index_file = blob_path(dir.path(), &index_ref(&plugin.id));
    let original = fs::read(&index_file).unwrap();
    fs::write(&index_file, "AAAA").unwrap();

    let error = plugins
        .uninstall(&plugin.id)
        .expect_err("a purge that failed must not report a successful uninstall")
        .to_string();
    assert!(
        error.starts_with("PLUGIN_CREDENTIAL_PURGE_FAILED"),
        "{error}"
    );
    assert!(error.contains("demo.purge-fails"), "{error}");
    // The failure text names the plugin and the cause, never a field value.
    assert!(!error.contains("hunter2"), "{error}");
    assert!(!error.contains("alice"), "{error}");

    // The uninstall did not happen: the plugin is still registered and its
    // stored value is untouched.
    assert!(plugins.get(&plugin.id).is_some());
    assert!(secrets.has(&slot_ref(&plugin.id, "mailbox")));
    assert_eq!(
        resolve(&secrets, &plugin, "mailbox", None)
            .unwrap()
            .get("password")
            .map(String::as_str),
        Some("hunter2")
    );

    // With the index readable again the same uninstall goes through and leaves
    // no secret behind, so the refusal above came from the damage, not from a
    // store that can never be cleared.
    fs::write(&index_file, original).unwrap();
    assert!(plugins.uninstall(&plugin.id).unwrap());
    assert!(!secrets.has(&slot_ref(&plugin.id, "mailbox")));
    assert!(!secrets.has(&index_ref(&plugin.id)));
}

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
