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

pub(super) fn field(key: &str, label: &str, secret: bool) -> Value {
    json!({
        "key": key,
        "label": { "en": label, "zh-CN": label },
        "secret": secret,
    })
}

pub(super) fn mailbox_slot() -> Value {
    json!({
        "id": "mailbox",
        "title": { "en": "Mailbox", "zh-CN": "邮箱" },
        "kind": "basic",
        "fields": [field("username", "User", false), field("password", "Password", true)],
        "scope": { "domains": ["imap.example.com"] },
    })
}

pub(super) fn smtp_slot() -> Value {
    json!({
        "id": "smtp",
        "title": "SMTP",
        "kind": "basic",
        "fields": [field("host", "Host", false)],
        "scope": { "domains": ["smtp.example.com"] },
    })
}

pub(super) fn manifest(plugin_id: &str, contributes: Value) -> Value {
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

pub(super) fn write_manifest(root: &Path, document: Value) {
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
pub(super) fn manager(data_dir: &Path) -> PluginManager {
    PluginManager {
        data_dir: data_dir.to_path_buf(),
        runtime: Vec::new(),
        bundled_ids: Default::default(),
        market_channel: MarketChannel::Official,
        install_cancel: None,
        locale: "en".into(),
    }
}

pub(super) fn install(
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

pub(super) fn filled() -> Map<String, Value> {
    let mut fields = Map::new();
    fields.insert("username".into(), json!("alice"));
    fields.insert("password".into(), json!("hunter2"));
    fields
}

pub(super) fn smtp_fields() -> Map<String, Value> {
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
