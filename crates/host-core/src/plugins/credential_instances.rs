//! Instances of a multi-instance credential slot (`multiple` / `labelField`).
//!
//! A slot that declares `multiple` holds up to `max` separate values — several
//! mailboxes, accounts, or tenants — while a slot without it keeps exactly the
//! released behaviour: one blob under `plugin:<id>:cred:<slot>`.
//!
//! Storage stays inside the encrypted secret store, so no schema changes:
//!
//! * one blob per instance under `plugin:<id>:cred:<slot>#<instanceId>`;
//! * the instance list — id, label, non-secret field values, creation time — in
//!   the per-plugin credential index (`plugin:<id>:cred-index`), next to the slot
//!   ids that index already carried.
//!
//! The `#` separator is unambiguous because a slot id is a contribution id and
//! can never contain one.
//!
//! # Upgrades and downgrades
//!
//! A manifest that turns an existing single slot into a multi-instance one must
//! not cost the user the value they already entered, so the first read of that
//! slot copies the stored blob to the first instance and only then removes the
//! original: at every point at least one copy exists. The migrated id is derived
//! from the slot reference, so a retry after a partial failure writes the same
//! instance instead of accumulating orphans.
//!
//! The reverse (a slot that drops `multiple`) keeps the first instance's value as
//! the slot's single value, drops the rest, and writes one audit row naming the
//! ids it removed. Both directions are audited by id only: no field value, not
//! even a label, reaches the audit log.

use super::credentials::{
    self, slot_ref, CredentialError, DeclaredSlot, PluginIndex, StoredSlot, CREDENTIAL_INVALID,
    CREDENTIAL_LIMIT, CREDENTIAL_NOT_CONFIGURED, MAX_FIELD_BYTES,
};
use super::{is_contrib_id, user_endpoint, user_proxy, user_send, Utc};
use crate::db::Database;
use crate::secrets::SecretStore;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

/// A multi-instance slot was named without an instance (`slot` instead of
/// `slot#instance`).
pub(crate) const CREDENTIAL_INSTANCE_REQUIRED: &str = "CREDENTIAL_INSTANCE_REQUIRED";

/// Audit kind for every instance-list change. Payloads carry ids, never values.
pub(crate) const AUDIT_KIND: &str = "plugin_credential_instances";

/// Shape of a generated instance id: opaque, host-issued, and stable.
const INSTANCE_ID_PREFIX: &str = "acc_";

/// One instance as the index remembers it. Values live in their own blob.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct InstanceMeta {
    pub instance_id: String,
    /// The `labelField` value at write time; empty when the slot declares none.
    pub label: String,
    /// Non-secret declared field values only, so `list` can identify an account.
    pub public_fields: BTreeMap<String, String>,
    pub created_at: i64,
}

/// One instance as a reader (Settings, `credentials.list`) sees it.
#[derive(Debug, Clone)]
pub(crate) struct InstanceSnapshot {
    pub instance_id: String,
    pub label: String,
    pub public_fields: BTreeMap<String, String>,
    pub configured: bool,
}

/// The secret-store reference of one instance's blob.
pub(crate) fn instance_ref(plugin_id: &str, slot_id: &str, instance_id: &str) -> String {
    format!("{}#{instance_id}", slot_ref(plugin_id, slot_id))
}

/// Split a `credentialRef` into its slot and optional instance.
///
/// A slot id cannot contain `#`, so the first one separates the two halves.
pub(crate) fn split_ref(raw: &str) -> (&str, Option<&str>) {
    match raw.split_once('#') {
        Some((slot, instance)) => (slot.trim(), Some(instance.trim())),
        None => (raw.trim(), None),
    }
}

fn valid_instance_id(value: &str) -> bool {
    value.len() == INSTANCE_ID_PREFIX.len() + 8
        && value.starts_with(INSTANCE_ID_PREFIX)
        && value[INSTANCE_ID_PREFIX.len()..]
            .chars()
            .all(|character| character.is_ascii_hexdigit())
}

/// 64 bits, lowercase hex. Opaque on purpose: a plugin names an instance but
/// never learns or chooses what an id means.
fn random_instance_id() -> String {
    let hex = uuid::Uuid::new_v4().simple().to_string();
    format!("{INSTANCE_ID_PREFIX}{}", &hex[..8])
}

/// The id the first instance of a migrated slot always gets: same slot, same id,
/// so a retry after a failed write cannot leave a second orphan behind.
fn migrated_instance_id(plugin_id: &str, slot_id: &str) -> String {
    let digest = Sha256::digest(format!("plugin:{plugin_id}:cred:{slot_id}").as_bytes());
    let hex = hex::encode(digest);
    format!("{INSTANCE_ID_PREFIX}{}", &hex[..8])
}

fn not_configured(plugin_id: &str, slot_id: &str, instance_id: &str) -> CredentialError {
    CredentialError::NotConfigured(format!(
        "{CREDENTIAL_NOT_CONFIGURED}: credential instance {instance_id} of slot {slot_id} in plugin {plugin_id} has no stored value"
    ))
}

fn instance_limit(plugin_id: &str, slot_id: &str, max: u32) -> CredentialError {
    CredentialError::Limit(format!(
        "{CREDENTIAL_LIMIT}: credential slot {slot_id} of plugin {plugin_id} already holds {max} instances"
    ))
}

fn label_of(slot: &DeclaredSlot, values: &BTreeMap<String, String>) -> String {
    slot.label_field
        .as_ref()
        .and_then(|key| values.get(key))
        .map(|value| value.trim().to_string())
        .unwrap_or_default()
}

fn public_fields(
    slot: &DeclaredSlot,
    values: &BTreeMap<String, String>,
) -> BTreeMap<String, String> {
    let mut fields: BTreeMap<String, String> = slot
        .fields
        .iter()
        .filter(|field| !field.secret)
        .filter_map(|field| {
            values
                .get(&field.key)
                .map(|value| (field.key.clone(), value.clone()))
        })
        .collect();
    // A user-typed mail server is part of how the account is identified, so a
    // plugin may read back where it points. The password stays unreadable.
    if !slot.user_endpoint_protocols.is_empty() {
        for key in super::user_endpoint::RESERVED_KEYS {
            if let Some(value) = values.get(key) {
                fields.insert(key.to_string(), value.clone());
            }
        }
    }
    // The same for a proxy: where it points names the account's route, while
    // the proxy login stays host-only.
    if !slot.user_proxy_types.is_empty() {
        for key in user_proxy::PUBLIC_KEYS {
            if let Some(value) = values.get(key) {
                fields.insert(key.to_string(), value.clone());
            }
        }
    }
    // And the outgoing server: an account card that already says where mail is
    // read from can say where it is sent from too.
    if !slot.user_send_securities.is_empty() {
        for key in user_send::PUBLIC_KEYS {
            if let Some(value) = values.get(key) {
                fields.insert(key.to_string(), value.clone());
            }
        }
    }
    fields
}

/// Append one audit row about an instance-list change. Ids only.
fn audit(db: Option<&Database>, payload: Value) {
    if let Some(db) = db {
        // The change is already committed; losing the audit row must not fail
        // the operation the user asked for.
        let _ = crate::audit::append(db, AUDIT_KIND, None, payload);
    }
}

/// The instance list of one slot, after reconciling the stored shape.
///
/// Missing values are dropped from the list: an instance the host cannot read is
/// not an account the user can use, and reporting it as configured would be a
/// lie the next injection would contradict.
fn read_instances(
    secrets: &SecretStore,
    plugin_id: &str,
    slot: &DeclaredSlot,
    index: &mut PluginIndex,
    db: Option<&Database>,
) -> Result<Vec<InstanceMeta>, CredentialError> {
    let mut stored = index.instances.get(&slot.id).cloned().unwrap_or_default();
    let before = stored.len();
    stored.retain(|meta| {
        match credentials::read_slot(
            secrets,
            plugin_id,
            &format!("{}#{}", slot.id, meta.instance_id),
        ) {
            Ok(Some(blob)) => covers(&blob, slot),
            Ok(None) => false,
            // A store failure is not evidence that the instance is gone.
            Err(_) => true,
        }
    });
    if stored.len() != before {
        index.instances.insert(slot.id.clone(), stored.clone());
        credentials::write_index(secrets, plugin_id, index)?;
        audit(
            db,
            json!({
                "pluginId": plugin_id,
                "slotId": slot.id,
                "event": "prune",
                "removed": before - stored.len(),
            }),
        );
    }
    Ok(stored)
}

/// Turn a slot's stored single value into its first instance.
///
/// Idempotent: the instance id is derived from the slot, and the original blob is
/// removed only after the copy and its index entry are both written, so a
/// failure halfway leaves the value readable and the retry finishes the job.
fn migrate_legacy(
    secrets: &SecretStore,
    plugin_id: &str,
    slot: &DeclaredSlot,
    index: &mut PluginIndex,
    db: Option<&Database>,
) -> Result<Vec<InstanceMeta>, CredentialError> {
    let Some(legacy) = credentials::read_slot(secrets, plugin_id, &slot.id)? else {
        return Ok(Vec::new());
    };
    let instance_id = migrated_instance_id(plugin_id, &slot.id);
    let payload = serde_json::to_string(&legacy)
        .map_err(|error| CredentialError::Storage(format!("credential store failure: {error}")))?;
    // 1. the copy, under the instance reference
    secrets
        .set(&instance_ref(plugin_id, &slot.id, &instance_id), &payload)
        .map_err(|error| CredentialError::Storage(format!("credential store failure: {error}")))?;
    let meta = InstanceMeta {
        instance_id: instance_id.clone(),
        label: label_of(slot, &legacy.fields),
        public_fields: public_fields(slot, &legacy.fields),
        created_at: Utc::now().timestamp_millis(),
    };
    // 2. the index entry, so the instance is reachable by name
    index.insert(&slot.id);
    index.instances.insert(slot.id.clone(), vec![meta.clone()]);
    credentials::write_index(secrets, plugin_id, index)?;
    // 3. only now the original. A leftover here costs one stale delete later
    //    and nothing else, while deleting earlier could lose the only copy.
    let _ = secrets.delete(&slot_ref(plugin_id, &slot.id));
    audit(
        db,
        json!({
            "pluginId": plugin_id,
            "slotId": slot.id,
            "event": "migrate",
            "instanceId": instance_id,
        }),
    );
    Ok(vec![meta])
}

/// Fold a slot's instances back into the single released value.
///
/// Runs when a manifest drops `multiple`: the first instance's values become the
/// slot's value, the rest are removed. Returns the values so the caller can finish
/// the read it was doing.
fn fold_back(
    secrets: &SecretStore,
    plugin_id: &str,
    slot: &DeclaredSlot,
    index: &mut PluginIndex,
    db: Option<&Database>,
) -> Result<Option<BTreeMap<String, String>>, CredentialError> {
    let metas = index.instances.get(&slot.id).cloned().unwrap_or_default();
    if metas.is_empty() {
        return Ok(None);
    }
    let mut kept: Option<BTreeMap<String, String>> = None;
    let mut removed: Vec<String> = Vec::new();
    for (position, meta) in metas.iter().enumerate() {
        let reference = instance_ref(plugin_id, &slot.id, &meta.instance_id);
        let blob = credentials::read_slot(
            secrets,
            plugin_id,
            &format!("{}#{}", slot.id, meta.instance_id),
        )?;
        if position == 0 {
            if let Some(blob) = &blob {
                if covers(blob, slot) {
                    let payload = serde_json::to_string(blob).map_err(|error| {
                        CredentialError::Storage(format!("credential store failure: {error}"))
                    })?;
                    // Write the single value before dropping any instance, so a
                    // failure here still leaves every value readable.
                    secrets
                        .set(&slot_ref(plugin_id, &slot.id), &payload)
                        .map_err(|error| {
                            CredentialError::Storage(format!("credential store failure: {error}"))
                        })?;
                    kept = Some(blob.fields.clone());
                }
            }
        } else {
            removed.push(meta.instance_id.clone());
        }
        secrets.delete(&reference).map_err(|error| {
            CredentialError::Storage(format!("credential store failure: {error}"))
        })?;
    }
    index.instances.remove(&slot.id);
    credentials::write_index(secrets, plugin_id, index)?;
    audit(
        db,
        json!({
            "pluginId": plugin_id,
            "slotId": slot.id,
            "event": "foldBack",
            "instanceId": metas.first().map(|meta| meta.instance_id.clone()),
            "removedInstances": removed,
        }),
    );
    Ok(kept)
}

/// The instances of a multi-instance slot, in creation order.
pub(crate) fn instances(
    secrets: &SecretStore,
    plugin_id: &str,
    slot: &DeclaredSlot,
    db: Option<&Database>,
) -> Result<Vec<InstanceSnapshot>, CredentialError> {
    let mut index = credentials::read_index(secrets, plugin_id)?;
    let has_instances = index
        .instances
        .get(&slot.id)
        .is_some_and(|metas| !metas.is_empty());
    let metas = if has_instances {
        read_instances(secrets, plugin_id, slot, &mut index, db)?
    } else {
        migrate_legacy(secrets, plugin_id, slot, &mut index, db)?
    };
    Ok(metas
        .into_iter()
        .map(|meta| InstanceSnapshot {
            instance_id: meta.instance_id,
            label: meta.label,
            public_fields: meta.public_fields,
            configured: true,
        })
        .collect())
}

/// Store a new instance. `values` is the already-validated field map.
pub(crate) fn add(
    secrets: &SecretStore,
    plugin_id: &str,
    slot: &DeclaredSlot,
    values: &BTreeMap<String, String>,
    db: Option<&Database>,
) -> Result<String, CredentialError> {
    let Some(max) = slot.multiple_max else {
        return Err(CredentialError::Invalid(format!(
            "{CREDENTIAL_INVALID}: credential slot {} holds a single value",
            slot.id
        )));
    };
    // `instances` first, and the index read after it: that call is what migrates a
    // pre-`multiple` value or prunes a vanished one, both of which rewrite the
    // index. Reading the index first would write that stale copy back and drop
    // the migrated instance from the list.
    let existing = instances(secrets, plugin_id, slot, db)?;
    if existing.len() >= max as usize {
        return Err(instance_limit(plugin_id, &slot.id, max));
    }
    let label = label_of(slot, values);
    if !label.is_empty() && existing.iter().any(|instance| instance.label == label) {
        return Err(CredentialError::Invalid(format!(
            "{CREDENTIAL_INVALID}: credential slot {} already holds an instance labelled {label}",
            slot.id
        )));
    }
    let mut instance_id = random_instance_id();
    while existing
        .iter()
        .any(|instance| instance.instance_id == instance_id)
    {
        instance_id = random_instance_id();
    }
    let payload = serde_json::to_string(&credentials::StoredSlot {
        fields: values.clone(),
    })
    .map_err(|error| CredentialError::Storage(format!("credential store failure: {error}")))?;
    let reference = instance_ref(plugin_id, &slot.id, &instance_id);
    secrets
        .set(&reference, &payload)
        .map_err(|error| CredentialError::Storage(format!("credential store failure: {error}")))?;
    // Only now, so the list this write replaces is the one `instances` just
    // settled on.
    let mut index = credentials::read_index(secrets, plugin_id)?;
    let metas = index.instances.get(&slot.id).cloned().unwrap_or_default();
    let metas = merge_metas(
        metas,
        InstanceMeta {
            instance_id: instance_id.clone(),
            label,
            public_fields: public_fields(slot, values),
            created_at: Utc::now().timestamp_millis(),
        },
    );
    index.insert(&slot.id);
    index.instances.insert(slot.id.clone(), metas);
    if let Err(error) = credentials::write_index(secrets, plugin_id, &index) {
        // The value without its index entry could never be listed or removed;
        // drop it so the failure leaves the stored state as it was.
        let _ = secrets.delete(&reference);
        return Err(error);
    }
    credentials::forget_used(plugin_id, &slot.id);
    audit(
        db,
        json!({
            "pluginId": plugin_id,
            "slotId": slot.id,
            "event": "add",
            "instanceId": instance_id,
        }),
    );
    Ok(instance_id)
}

/// Append one instance, replacing a same-id entry so a retried write is stable.
fn merge_metas(mut existing: Vec<InstanceMeta>, meta: InstanceMeta) -> Vec<InstanceMeta> {
    if let Some(position) = existing
        .iter()
        .position(|entry| entry.instance_id == meta.instance_id)
    {
        existing[position] = meta;
        return existing;
    }
    existing.push(meta);
    existing
}

/// Replace one instance's values, keeping its id and its creation time.
///
/// The id is what a plugin stores per account (message cursors, progress), so
/// editing an account in Settings must not mint a new one. The label has to stay
/// unique inside the slot, because it is how the account is addressed by name.
pub(crate) fn update(
    secrets: &SecretStore,
    plugin_id: &str,
    slot: &DeclaredSlot,
    instance_id: &str,
    values: &BTreeMap<String, String>,
    db: Option<&Database>,
) -> Result<(), CredentialError> {
    if !valid_instance_id(instance_id) {
        return Err(CredentialError::Invalid(format!(
            "{CREDENTIAL_INVALID}: invalid credential instance id"
        )));
    }
    let mut index = credentials::read_index(secrets, plugin_id)?;
    let existing = read_instances(secrets, plugin_id, slot, &mut index, db)?;
    let Some(previous) = existing
        .iter()
        .find(|meta| meta.instance_id == instance_id)
        .cloned()
    else {
        return Err(not_configured(plugin_id, &slot.id, instance_id));
    };
    let label = label_of(slot, values);
    if !label.is_empty()
        && existing
            .iter()
            .any(|meta| meta.instance_id != instance_id && meta.label == label)
    {
        return Err(CredentialError::Invalid(format!(
            "{CREDENTIAL_INVALID}: credential slot {} already holds an instance labelled {label}",
            slot.id
        )));
    }
    let payload = serde_json::to_string(&credentials::StoredSlot {
        fields: values.clone(),
    })
    .map_err(|error| CredentialError::Storage(format!("credential store failure: {error}")))?;
    // The value first: after a failed index write the account still logs in with
    // what the user just saved, and the next edit repairs the label.
    secrets
        .set(&instance_ref(plugin_id, &slot.id, instance_id), &payload)
        .map_err(|error| CredentialError::Storage(format!("credential store failure: {error}")))?;
    // The index still holds the list `read_instances` just settled on, so the
    // meta is replaced there rather than re-read.
    let metas = index.instances.get(&slot.id).cloned().unwrap_or_default();
    let metas = merge_metas(
        metas,
        InstanceMeta {
            instance_id: instance_id.to_string(),
            label,
            public_fields: public_fields(slot, values),
            created_at: previous.created_at,
        },
    );
    index.insert(&slot.id);
    index.instances.insert(slot.id.clone(), metas);
    credentials::write_index(secrets, plugin_id, &index)?;
    audit(
        db,
        json!({
            "pluginId": plugin_id,
            "slotId": slot.id,
            "event": "update",
            "instanceId": instance_id,
        }),
    );
    Ok(())
}

/// Drop one instance. Returns whether a value was there.
pub(crate) fn remove(
    secrets: &SecretStore,
    plugin_id: &str,
    slot_id: &str,
    instance_id: &str,
    db: Option<&Database>,
) -> Result<bool, CredentialError> {
    if !is_contrib_id(slot_id) {
        return Err(CredentialError::Invalid(format!(
            "{CREDENTIAL_INVALID}: invalid credential slot id"
        )));
    }
    if !valid_instance_id(instance_id) {
        return Err(CredentialError::Invalid(format!(
            "{CREDENTIAL_INVALID}: invalid credential instance id"
        )));
    }
    let mut index = credentials::read_index(secrets, plugin_id)?;
    let reference = instance_ref(plugin_id, slot_id, instance_id);
    let existed = secrets.has(&reference);
    secrets
        .delete(&reference)
        .map_err(|error| CredentialError::Storage(format!("credential store failure: {error}")))?;
    let mut changed = false;
    if let Some(metas) = index.instances.get_mut(slot_id) {
        let before = metas.len();
        metas.retain(|meta| meta.instance_id != instance_id);
        changed = metas.len() != before;
        if metas.is_empty() {
            index.instances.remove(slot_id);
        }
    }
    if changed {
        credentials::write_index(secrets, plugin_id, &index)?;
        audit(
            db,
            json!({
                "pluginId": plugin_id,
                "slotId": slot_id,
                "event": "remove",
                "instanceId": instance_id,
            }),
        );
    }
    Ok(existed)
}

/// Remove every instance of one slot, for `credentials.clear` on a multi slot and
/// for an uninstall. Returns whether anything was stored.
pub(crate) fn clear_slot(
    secrets: &SecretStore,
    plugin_id: &str,
    slot_id: &str,
    index: &mut PluginIndex,
    db: Option<&Database>,
) -> Result<bool, CredentialError> {
    let metas = index.instances.remove(slot_id).unwrap_or_default();
    let mut removed_any = false;
    for meta in &metas {
        let reference = instance_ref(plugin_id, slot_id, &meta.instance_id);
        if secrets.has(&reference) {
            removed_any = true;
        }
        secrets.delete(&reference).map_err(|error| {
            CredentialError::Storage(format!("credential store failure: {error}"))
        })?;
    }
    if !metas.is_empty() {
        audit(
            db,
            json!({
                "pluginId": plugin_id,
                "slotId": slot_id,
                "event": "clear",
                "removedInstances": metas.iter().map(|meta| meta.instance_id.clone()).collect::<Vec<_>>(),
            }),
        );
    }
    Ok(removed_any)
}

/// Does a stored slot still hold what the host needs to use it?
///
/// Every declared **secret** field has to be there: a half-filled credential is
/// never injected. A non-secret field that the manifest added later is optional —
/// it is identity (an address, a provider, a server), not the secret — so an
/// account saved before that field existed keeps working instead of vanishing
/// from the instance list and being refused at login.
pub(crate) fn covers(stored: &StoredSlot, slot: &DeclaredSlot) -> bool {
    slot.fields
        .iter()
        .filter(|field| field.secret)
        .all(|field| stored.fields.contains_key(&field.key))
}

/// Every value the host may inject for one stored instance: the slot's
/// declared fields, plus the four reserved endpoint keys when the instance
/// carries them.
///
/// `None` means the blob is incomplete, which is the same answer as a slot with
/// nothing stored: a half-filled instance is never injected.
pub(crate) fn injected_fields(
    slot: &DeclaredSlot,
    stored: &StoredSlot,
) -> Option<BTreeMap<String, String>> {
    let mut fields = BTreeMap::new();
    for field in &slot.fields {
        match stored.fields.get(&field.key) {
            Some(value) => {
                fields.insert(field.key.clone(), value.clone());
            }
            // A secret nobody entered is not a credential; a non-secret the
            // manifest added later is simply not known for this account yet.
            None if field.secret => return None,
            None => {}
        }
    }
    if !slot.user_endpoint_protocols.is_empty() {
        for key in user_endpoint::RESERVED_KEYS {
            if let Some(value) = stored.fields.get(key) {
                fields.insert(key.to_string(), value.clone());
            }
        }
    }
    // The proxy travels with the credential because the dialer needs it, and
    // this map never reaches the plugin: a slot that declares a proxy is
    // `imap`, which cannot be injected into an http or websocket request.
    if !slot.user_proxy_types.is_empty() {
        for key in user_proxy::RESERVED_KEYS {
            if let Some(value) = stored.fields.get(key) {
                fields.insert(key.to_string(), value.clone());
            }
        }
    }
    // The outgoing server travels the same way: the SMTP session reads it from
    // this map, and no plugin-facing API ever returns the map itself.
    if !slot.user_send_securities.is_empty() {
        for key in user_send::RESERVED_KEYS {
            if let Some(value) = stored.fields.get(key) {
                fields.insert(key.to_string(), value.clone());
            }
        }
    }
    Some(fields)
}

/// The user-typed server of one submission, normalized, or `None` when the
/// form left it empty.
///
/// A blank value counts as "not set", so an untouched form posts exactly what
/// it rendered. A partly filled one is refused: storing it would leave the
/// password pointing at a server the user never finished choosing.
pub(crate) fn validated_endpoint(
    slot: &DeclaredSlot,
    fields: &Map<String, Value>,
) -> Result<Option<user_endpoint::UserEndpoint>, CredentialError> {
    let mut submitted = BTreeMap::new();
    for key in user_endpoint::RESERVED_KEYS {
        let Some(raw) = fields.get(key) else {
            continue;
        };
        let value = raw.as_str().ok_or_else(|| {
            CredentialError::Invalid(format!(
                "{CREDENTIAL_INVALID}: credential slot {} field {key} must be a string",
                slot.id
            ))
        })?;
        if value.len() > MAX_FIELD_BYTES {
            return Err(CredentialError::Invalid(format!(
                "{CREDENTIAL_INVALID}: credential slot {} field {key} exceeds {MAX_FIELD_BYTES} bytes",
                slot.id
            )));
        }
        submitted.insert(key.to_string(), value.to_string());
    }
    user_endpoint::from_fields(&submitted, &slot.user_endpoint_protocols).map_err(|message| {
        CredentialError::Invalid(format!(
            "{CREDENTIAL_INVALID}: credential slot {} {message}",
            slot.id
        ))
    })
}

/// The proxy of one submission, normalized, or `None` when the form left it on
/// "no proxy".
///
/// Same shape as the endpoint: a blank type means the account dials the mail
/// server directly and the other four keys are dropped, while a chosen type has
/// to be complete.
pub(crate) fn validated_proxy(
    slot: &DeclaredSlot,
    fields: &Map<String, Value>,
) -> Result<Option<user_proxy::UserProxy>, CredentialError> {
    let mut submitted = BTreeMap::new();
    for key in user_proxy::RESERVED_KEYS {
        let Some(raw) = fields.get(key) else {
            continue;
        };
        let value = raw.as_str().ok_or_else(|| {
            CredentialError::Invalid(format!(
                "{CREDENTIAL_INVALID}: credential slot {} field {key} must be a string",
                slot.id
            ))
        })?;
        if value.len() > MAX_FIELD_BYTES {
            return Err(CredentialError::Invalid(format!(
                "{CREDENTIAL_INVALID}: credential slot {} field {key} exceeds {MAX_FIELD_BYTES} bytes",
                slot.id
            )));
        }
        submitted.insert(key.to_string(), value.to_string());
    }
    user_proxy::from_fields(&submitted, &slot.user_proxy_types).map_err(|message| {
        CredentialError::Invalid(format!(
            "{CREDENTIAL_INVALID}: credential slot {} {message}",
            slot.id
        ))
    })
}

/// The outgoing server of one submission, normalized, or `None` when the form
/// left it empty.
///
/// Same shape as the two above: a blank `sendServer` means the account does not
/// send through a server of its own, and the two other keys are dropped; a
/// named server has to come with a port and a transport the slot declares.
pub(crate) fn validated_send(
    slot: &DeclaredSlot,
    fields: &Map<String, Value>,
) -> Result<Option<user_send::UserSend>, CredentialError> {
    let mut submitted = BTreeMap::new();
    for key in user_send::RESERVED_KEYS {
        let Some(raw) = fields.get(key) else {
            continue;
        };
        let value = raw.as_str().ok_or_else(|| {
            CredentialError::Invalid(format!(
                "{CREDENTIAL_INVALID}: credential slot {} field {key} must be a string",
                slot.id
            ))
        })?;
        if value.len() > MAX_FIELD_BYTES {
            return Err(CredentialError::Invalid(format!(
                "{CREDENTIAL_INVALID}: credential slot {} field {key} exceeds {MAX_FIELD_BYTES} bytes",
                slot.id
            )));
        }
        submitted.insert(key.to_string(), value.to_string());
    }
    user_send::from_fields(&submitted, &slot.user_send_securities).map_err(|message| {
        CredentialError::Invalid(format!(
            "{CREDENTIAL_INVALID}: credential slot {} {message}",
            slot.id
        ))
    })
}

/// The submitted map must be exactly the slot's declared fields, each a
/// non-empty string, plus the reserved keys of a slot that declares
/// `userEndpoint`, `userProxy` or `userSend`. Anything else is refused as a
/// whole.
pub(crate) fn validated_fields(
    slot: &DeclaredSlot,
    fields: Map<String, Value>,
) -> Result<BTreeMap<String, String>, CredentialError> {
    let takes_endpoint = !slot.user_endpoint_protocols.is_empty();
    let takes_proxy = !slot.user_proxy_types.is_empty();
    let takes_send = !slot.user_send_securities.is_empty();
    if let Some(key) = fields.keys().find(|key| {
        !slot.field_keys().any(|declared| declared == *key)
            && !(takes_endpoint && user_endpoint::is_reserved(key))
            && !(takes_proxy && user_proxy::is_reserved(key))
            && !(takes_send && user_send::is_reserved(key))
    }) {
        return Err(CredentialError::Invalid(format!(
            "{CREDENTIAL_INVALID}: credential slot {} does not declare field {key}",
            slot.id
        )));
    }
    let mut values = BTreeMap::new();
    for key in slot.field_keys() {
        let value = fields.get(key).ok_or_else(|| {
            CredentialError::Invalid(format!(
                "{CREDENTIAL_INVALID}: credential slot {} is missing field {key}",
                slot.id
            ))
        })?;
        let value = value.as_str().ok_or_else(|| {
            CredentialError::Invalid(format!(
                "{CREDENTIAL_INVALID}: credential slot {} field {key} must be a string",
                slot.id
            ))
        })?;
        if value.trim().is_empty() {
            return Err(CredentialError::Invalid(format!(
                "{CREDENTIAL_INVALID}: credential slot {} field {key} is empty",
                slot.id
            )));
        }
        if value.len() > MAX_FIELD_BYTES {
            return Err(CredentialError::Invalid(format!(
                "{CREDENTIAL_INVALID}: credential slot {} field {key} exceeds {MAX_FIELD_BYTES} bytes",
                slot.id
            )));
        }
        values.insert(key.to_string(), value.to_string());
    }
    if takes_endpoint {
        if let Some(endpoint) = validated_endpoint(slot, &fields)? {
            values.extend(endpoint.to_fields());
        }
    }
    if takes_proxy {
        if let Some(proxy) = validated_proxy(slot, &fields)? {
            values.extend(proxy.to_fields());
        }
    }
    if takes_send {
        if let Some(send) = validated_send(slot, &fields)? {
            values.extend(send.to_fields());
        }
    }
    Ok(values)
}
/// The values of one instance, ready for host-owned injection.
pub(crate) fn resolve(
    secrets: &SecretStore,
    plugin_id: &str,
    slot: &DeclaredSlot,
    instance_id: &str,
) -> Result<BTreeMap<String, String>, CredentialError> {
    if !valid_instance_id(instance_id) {
        return Err(CredentialError::Invalid(format!(
            "{CREDENTIAL_INVALID}: invalid credential instance id"
        )));
    }
    let index = credentials::read_index(secrets, plugin_id)?;
    let listed = index
        .instances
        .get(&slot.id)
        .is_some_and(|metas| metas.iter().any(|meta| meta.instance_id == instance_id));
    if !listed {
        return Err(not_configured(plugin_id, &slot.id, instance_id));
    }
    let Some(stored) =
        credentials::read_slot(secrets, plugin_id, &format!("{}#{instance_id}", slot.id))?
    else {
        return Err(not_configured(plugin_id, &slot.id, instance_id));
    };
    if !covers(&stored, slot) {
        return Err(not_configured(plugin_id, &slot.id, instance_id));
    }
    let fields = injected_fields(slot, &stored)
        .ok_or_else(|| not_configured(plugin_id, &slot.id, instance_id))?;
    credentials::remember_used(plugin_id, &slot.id);
    Ok(fields)
}

/// A downgraded slot's value: the first instance folded back on demand.
///
/// Only reached when the released single reference is empty, so the per-request
/// path pays one secret read and nothing else while the shape is unchanged.
pub(crate) fn fold_back_for_read(
    secrets: &SecretStore,
    plugin_id: &str,
    slot: &DeclaredSlot,
    db: Option<&Database>,
) -> Result<Option<BTreeMap<String, String>>, CredentialError> {
    let mut index = credentials::read_index(secrets, plugin_id)?;
    if !index.instances.contains_key(&slot.id) {
        return Ok(None);
    }
    fold_back(secrets, plugin_id, slot, &mut index, db)
}

/// Delete every instance this host stored for a plugin, as part of an uninstall.
pub(crate) fn purge(
    secrets: &SecretStore,
    plugin_id: &str,
    index: &PluginIndex,
) -> Result<usize, CredentialError> {
    let mut removed = 0;
    for (slot_id, metas) in &index.instances {
        for meta in metas {
            let reference = instance_ref(plugin_id, slot_id, &meta.instance_id);
            if secrets.has(&reference) {
                removed += 1;
            }
            secrets.delete(&reference).map_err(|error| {
                CredentialError::Storage(format!("credential store failure: {error}"))
            })?;
        }
    }
    Ok(removed)
}

/// Whether a `credentialRef` names an instance of a slot that holds none.
fn takes_instances(slot: &DeclaredSlot) -> bool {
    slot.multiple_max.is_some()
}

/// The instance half a multi-instance slot requires, or a coded refusal.
pub(crate) fn required_instance<'a>(
    slot: &DeclaredSlot,
    instance: Option<&'a str>,
) -> Result<&'a str, CredentialError> {
    match instance {
        Some(instance) if !instance.is_empty() => Ok(instance),
        _ if takes_instances(slot) => Err(CredentialError::InstanceRequired(format!(
            "{CREDENTIAL_INSTANCE_REQUIRED}: credential slot {} holds several instances",
            slot.id
        ))),
        _ => Err(CredentialError::Invalid(format!(
            "{CREDENTIAL_INVALID}: credential slot {} holds a single value",
            slot.id
        ))),
    }
}

/// The public half of one instance, as `credentials.list` reports it.
pub(crate) fn public_json(meta: &InstanceSnapshot) -> Value {
    json!({
        "instanceId": meta.instance_id,
        "label": meta.label,
        "publicFields": meta.public_fields,
        "configured": meta.configured,
    })
}
