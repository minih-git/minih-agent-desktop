use super::{object_id, VaultKey};
use crate::agent_capabilities::CapabilityLevel;
use crate::state::AppState;
use anyhow::Result;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use uuid::Uuid;

#[path = "domains_capture.rs"]
mod capture_impl;
pub(crate) use capture_impl::{
    capture, global_instruction_path_for_sync, remove_instruction_file, write_instruction_file,
};
pub const DOMAIN_APPLICATION: &str = "application";
pub const DOMAIN_PROVIDERS: &str = "providers";
pub const DOMAIN_MCP: &str = "mcp";
pub const DOMAIN_SKILLS: &str = "skills";
pub const DOMAIN_SUBAGENTS: &str = "subagents";
pub const DOMAIN_INSTRUCTIONS: &str = "instructions";
pub const DOMAIN_PLUGINS: &str = "plugins";
pub const DOMAIN_AUTOMATION: &str = "automation";
pub const DOMAIN_MEMORY: &str = "memory";
/// Learned memory travels in its own domain (ADR agent-long-term-memory §7).
///
/// It cannot ride the `memory` domain: a released build treats every entity
/// there as pinned project memory, so it would erase a project's pinned notes on
/// a deletion, create groups, and fail the whole revision on a user-scope entity
/// with no mapping. A domain an older build does not know is skipped instead.
pub const DOMAIN_LEARNED_MEMORY: &str = "learnedMemory";

pub(crate) const PORTABLE_APPLICATION_FIELDS: &[&str] = &[
    "theme",
    "language",
    "fontFamily",
    "fontScale",
    "showThinking",
    "thinkingDisplayMode",
    "transcriptDensity",
    "enterToSend",
    "largePasteThreshold",
    "defaultProviderId",
    "defaultModelId",
    "defaultMode",
    "infiniteProviderRetry",
    "keybindings",
    "linkOpenTarget",
    "contextUsageDisplay",
    "chatContentMaxWidth",
    "promptEnhancementCustomTemplate",
    "promptEnhancementUserTemplate",
    "promptEnhancementProviderId",
    "promptEnhancementModelId",
    "promptEnhancementThinkingLevel",
    "imageGeneration",
    "imageGenerationModels",
    "speech",
    "learnedMemoryRead",
];

/// Payload keys that mark an entity as belonging to one machine's project or
/// project group. They are read from the entity itself, not from this device's
/// capture, so a revision another device produced still classifies correctly.
const PROJECT_SCOPE_PAYLOAD_KEYS: &[&str] = &[
    "projectLogicalId",
    "projectGroupLogicalId",
    "workspaceProjectLogicalId",
    "logicalId",
];

pub const ALL_DOMAINS: [&str; 10] = [
    DOMAIN_APPLICATION,
    DOMAIN_PROVIDERS,
    DOMAIN_MCP,
    DOMAIN_SKILLS,
    DOMAIN_SUBAGENTS,
    DOMAIN_INSTRUCTIONS,
    DOMAIN_PLUGINS,
    DOMAIN_AUTOMATION,
    DOMAIN_MEMORY,
    DOMAIN_LEARNED_MEMORY,
];

/// Contract metadata for each portable domain. Capture/apply code below is
/// deliberately explicit per domain; this registry keeps the portability,
/// identity, merge, activation, and recovery policy reviewable in one place.
#[derive(Debug, Clone, Copy)]
#[allow(dead_code)]
pub struct DomainAdapterSpec {
    pub domain: &'static str,
    pub schema_version: u32,
    pub exportable_fields: &'static [&'static str],
    pub secret_fields: &'static [&'static str],
    pub local_overlays: &'static [&'static str],
    pub identity: &'static str,
    pub references: &'static [&'static str],
    pub merge_granularity: &'static str,
    pub activation_policy: &'static str,
    pub recovery_policy: &'static str,
}

pub const DOMAIN_ADAPTERS: &[DomainAdapterSpec] = &[
    DomainAdapterSpec {
        domain: DOMAIN_APPLICATION,
        schema_version: 1,
        exportable_fields: &[
            "theme",
            "language",
            "fontFamily",
            "fontScale",
            "showThinking",
            "thinkingDisplayMode",
            "transcriptDensity",
            "enterToSend",
            "keybindings",
            "display bindings",
            "provider/model bindings",
            "learned memory reading",
        ],
        secret_fields: &[],
        local_overlays: &[
            "window geometry",
            "default command shell",
            "network proxy",
            "developer mode",
            "onboarding state",
            "permission mode",
        ],
        identity: "application",
        references: &["provider ids", "model ids"],
        merge_granularity: "field",
        activation_policy: "immediate-safe-settings-only",
        recovery_policy: "import journal",
    },
    DomainAdapterSpec {
        domain: DOMAIN_PROVIDERS,
        schema_version: 1,
        exportable_fields: &[
            "provider identity",
            "account display label",
            "explicit reasoning configuration",
            "models",
            "aliases",
            "parameters",
            "ordering",
            "defaults",
        ],
        secret_fields: &["portableApiKey"],
        local_overlays: &["OAuth sessions", "readiness flags", "catalog caches"],
        identity: "user-owned provider id",
        references: &["model bindings"],
        merge_granularity: "provider aggregate",
        activation_policy: "review when credential-bearing or destination changes",
        recovery_policy: "database plus secret-store journal",
    },
    DomainAdapterSpec {
        domain: DOMAIN_MCP,
        schema_version: 1,
        exportable_fields: &[
            "scope",
            "transport",
            "command",
            "args",
            "endpoint",
            "desired enabled state",
        ],
        secret_fields: &["env", "headers"],
        local_overlays: &["device approval", "local path bindings"],
        identity: "scope plus user-owned MCP id",
        references: &["project mapping"],
        merge_granularity: "one definition",
        activation_policy: "approval required before discovery",
        recovery_policy: "capability write journal",
    },
    DomainAdapterSpec {
        domain: DOMAIN_SKILLS,
        schema_version: 1,
        exportable_fields: &["metadata", "instructions", "bounded package resources"],
        secret_fields: &[],
        local_overlays: &[
            "external symlink targets",
            "execution approval",
            "dependencies",
        ],
        identity: "scope plus skill id",
        references: &["project mapping", "package resources"],
        merge_granularity: "one package",
        activation_policy: "approval required before discovery",
        recovery_policy: "bounded package write journal",
    },
    DomainAdapterSpec {
        domain: DOMAIN_SUBAGENTS,
        schema_version: 1,
        exportable_fields: &[
            "definition",
            "prompt",
            "model references",
            "tool preferences",
        ],
        secret_fields: &[],
        local_overlays: &["global-only ownership", "privileges", "execution approval"],
        identity: "global subagent id",
        references: &["provider/model ids"],
        merge_granularity: "one definition",
        activation_policy: "approval required before discovery",
        recovery_policy: "capability write journal",
    },
    DomainAdapterSpec {
        domain: DOMAIN_INSTRUCTIONS,
        schema_version: 1,
        exportable_fields: &[
            "fixed global file",
            "registered project-root file",
            "group text",
        ],
        secret_fields: &["instruction content"],
        local_overlays: &["unregistered repository files", "symlink targets"],
        identity: "scope plus project/group identity",
        references: &["project mapping"],
        merge_granularity: "one file or group text",
        activation_policy: "approval required before write",
        recovery_policy: "atomic file replacement journal",
    },
    DomainAdapterSpec {
        domain: DOMAIN_PLUGINS,
        schema_version: 1,
        exportable_fields: &["installation intent", "id/version/source metadata"],
        secret_fields: &[],
        local_overlays: &[
            "binaries",
            "plugin database",
            "permission grants",
            "activation",
        ],
        identity: "plugin id",
        references: &["future validated SDK settings only"],
        merge_granularity: "one installation intent",
        activation_policy: "explicit installation and activation",
        recovery_policy: "overlay journal",
    },
    DomainAdapterSpec {
        domain: DOMAIN_AUTOMATION,
        schema_version: 1,
        exportable_fields: &["task definition", "prompt", "schedule", "references"],
        secret_fields: &["credential references"],
        local_overlays: &["execution ownership", "enabled state on new device"],
        identity: "automation id",
        references: &["project mapping", "provider/model ids"],
        merge_granularity: "one task",
        activation_policy: "approval plus local execution ownership",
        recovery_policy: "database import journal",
    },
    DomainAdapterSpec {
        domain: DOMAIN_LEARNED_MEMORY,
        schema_version: 1,
        exportable_fields: &[
            "learned entries with status active or archived",
            "deletion tombstones",
        ],
        secret_fields: &["note content"],
        local_overlays: &[
            "suggestions",
            "extraction cursor and session state",
            "daily token ledger",
            "usage counters",
        ],
        identity: "one entity per scope (user, or project/group identity), with notes keyed by fingerprint inside it",
        references: &["project mapping"],
        merge_granularity: "one note, keyed by fingerprint within its scope; a scope payload is unioned, never split into conflict candidates",
        activation_policy: "project scope needs a folder mapping and confirmation; user scope applies directly",
        recovery_policy: "database import journal",
    },
    DomainAdapterSpec {
        domain: DOMAIN_MEMORY,
        schema_version: 1,
        exportable_fields: &["opt-in app-managed project/group memory"],
        secret_fields: &["memory content"],
        local_overlays: &["category subscription"],
        identity: "project/group identity",
        references: &["project mapping"],
        merge_granularity: "one memory unit",
        activation_policy: "mapping and approval required",
        recovery_policy: "database import journal",
    },
];

pub fn adapter_for(domain: &str) -> Option<&'static DomainAdapterSpec> {
    DOMAIN_ADAPTERS
        .iter()
        .find(|adapter| adapter.domain == domain)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PortableEntity {
    pub domain: String,
    pub entity_id: String,
    pub label: String,
    pub deleted: bool,
    pub requires_approval: bool,
    pub secret_bearing: bool,
    pub mapping_required: bool,
    pub digest: String,
    pub payload: Value,
    #[serde(default)]
    pub resource_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RevisionManifest {
    pub format: String,
    pub version: u32,
    pub revision_id: String,
    #[serde(default)]
    pub parents: Vec<String>,
    pub created_at: String,
    pub entities: Vec<PortableEntity>,
    pub resource_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocalSnapshot {
    pub manifest: RevisionManifest,
    pub resources: ResourceMap,
}

pub type ResourceMap = BTreeMap<String, Vec<u8>>;

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewCounts {
    pub supported: usize,
    pub excluded: usize,
    pub secret_bearing: usize,
    pub mapping_required: usize,
    pub pending_activation: usize,
    pub conflicts: usize,
    pub categories: Vec<CategoryPreview>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryPreview {
    pub category: String,
    pub supported: usize,
    pub excluded: usize,
    pub secret_bearing: usize,
    pub mapping_required: usize,
}

#[derive(Debug, Clone, Default)]
pub struct CategorySelection(pub BTreeMap<String, bool>);

impl CategorySelection {
    pub fn all_selected() -> Self {
        let mut values = BTreeMap::new();
        for domain in ALL_DOMAINS {
            values.insert(domain.to_string(), true);
        }
        values.insert("credentials".to_string(), false);
        values.insert(DOMAIN_MEMORY.to_string(), false);
        Self(values)
    }

    pub fn is_selected(&self, domain: &str) -> bool {
        ALL_DOMAINS.contains(&domain) && self.0.get(domain).copied().unwrap_or(true)
    }

    pub fn include_secrets(&self, requested: bool) -> bool {
        requested && self.0.get("credentials").copied().unwrap_or(false)
    }
}

fn stable_id(prefix: &str, value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(prefix.as_bytes());
    hasher.update([0]);
    hasher.update(value.trim().to_lowercase().as_bytes());
    format!("{prefix}:{}", hex::encode(hasher.finalize()))
}

#[allow(clippy::too_many_arguments)]
fn digest_entity(
    domain: &str,
    entity_id: &str,
    deleted: bool,
    requires_approval: bool,
    secret_bearing: bool,
    mapping_required: bool,
    payload: &Value,
    resource_ids: &[String],
) -> String {
    let material = json!({
        "domain": domain,
        "entityId": entity_id,
        "deleted": deleted,
        "requiresApproval": requires_approval,
        "secretBearing": secret_bearing,
        "mappingRequired": mapping_required,
        "payload": payload,
        "resourceIds": resource_ids,
    });
    let mut hasher = Sha256::new();
    hasher.update(serde_json::to_vec(&material).unwrap_or_default());
    hex::encode(hasher.finalize())
}

pub fn refresh_digest(entity: &mut PortableEntity) {
    entity.digest = digest_entity(
        &entity.domain,
        &entity.entity_id,
        entity.deleted,
        entity.requires_approval,
        entity.secret_bearing,
        entity.mapping_required,
        &entity.payload,
        &entity.resource_ids,
    );
}

#[allow(clippy::too_many_arguments)]
pub(super) fn entity(
    domain: &str,
    entity_id: impl Into<String>,
    label: impl Into<String>,
    payload: Value,
    requires_approval: bool,
    secret_bearing: bool,
    mapping_required: bool,
    resource_ids: Vec<String>,
) -> PortableEntity {
    let entity_id = entity_id.into();
    PortableEntity {
        domain: domain.to_string(),
        label: label.into(),
        digest: digest_entity(
            domain,
            &entity_id,
            false,
            requires_approval,
            secret_bearing,
            mapping_required,
            &payload,
            &resource_ids,
        ),
        entity_id,
        deleted: false,
        requires_approval,
        secret_bearing,
        mapping_required,
        payload,
        resource_ids,
    }
}

fn strip_keys(value: &mut Value, keys: &[&str]) {
    if let Some(object) = value.as_object_mut() {
        for key in keys {
            object.remove(*key);
        }
    }
}

pub fn snapshot_digest(snapshot: &LocalSnapshot) -> String {
    let material = json!({
        "entities": snapshot
            .manifest
            .entities
            .iter()
            .map(|entity| json!({
                "domain": entity.domain,
                "entityId": entity.entity_id,
                "digest": entity.digest,
            }))
            .collect::<Vec<_>>(),
        "resources": snapshot.resources.keys().collect::<Vec<_>>(),
    });
    let mut hasher = Sha256::new();
    hasher.update(serde_json::to_vec(&material).unwrap_or_default());
    hex::encode(hasher.finalize())
}

/// Whether an entity belongs to one machine's project or project group.
///
/// Cloud sync transports global configuration only: a project's MCP servers,
/// skills, instructions, memory, learned notes and the automations bound to it
/// stay on the device that owns the folder and travel through a project
/// archive instead. The markers are read from the entity itself, so a revision
/// produced by a build that still captured project data classifies the same way
/// as a local capture does.
pub(crate) fn is_project_scoped(entity: &PortableEntity) -> bool {
    if entity.mapping_required {
        return true;
    }
    // Pinned memory is only ever project or group scoped; its domain has no
    // global shape to fall back to.
    if entity.domain == DOMAIN_MEMORY {
        return true;
    }
    entity.payload.as_object().is_some_and(|payload| {
        PROJECT_SCOPE_PAYLOAD_KEYS
            .iter()
            .any(|key| payload.contains_key(*key))
    })
}

/// Remove everything this build must not transport from a decoded revision or
/// local recovery state: domains that were retired, and every project- or
/// group-scoped record.
///
/// Filtering happens on the entity, not on this device's own capture, so an old
/// remote revision, the acknowledged baseline and a staged approval bundle all
/// lose project data the same way. Resource references are projected with the
/// retained entities after remote readers have validated the complete
/// authenticated manifest, so a filtered skill cannot leave its resources
/// behind, and the dropped entities never become tombstones.
pub(crate) fn retain_portable_entities(manifest: &mut RevisionManifest) {
    manifest
        .entities
        .retain(|entity| adapter_for(&entity.domain).is_some() && !is_project_scoped(entity));
    manifest.resource_ids = manifest
        .entities
        .iter()
        .flat_map(|entity| entity.resource_ids.iter().cloned())
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect();
}

pub fn preview(snapshot: &LocalSnapshot, selection: &CategorySelection) -> PreviewCounts {
    let mut counts = PreviewCounts::default();
    let mut by_category: BTreeMap<String, CategoryPreview> = BTreeMap::new();
    for entity in &snapshot.manifest.entities {
        let category =
            by_category
                .entry(entity.domain.clone())
                .or_insert_with(|| CategoryPreview {
                    category: entity.domain.clone(),
                    ..CategoryPreview::default()
                });
        if selection.is_selected(&entity.domain) {
            counts.supported += 1;
            category.supported += 1;
        } else {
            counts.excluded += 1;
            category.excluded += 1;
        }
        if entity.secret_bearing {
            counts.secret_bearing += 1;
            category.secret_bearing += 1;
        }
        if entity.mapping_required {
            counts.mapping_required += 1;
            category.mapping_required += 1;
        }
        if entity.requires_approval {
            counts.pending_activation += 1;
        }
    }
    counts.categories = by_category.into_values().collect();
    counts
}

#[cfg(test)]
#[path = "provider_capture_tests.rs"]
mod provider_capture_tests;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adapter_registry_covers_every_portable_domain() {
        assert_eq!(DOMAIN_ADAPTERS.len(), ALL_DOMAINS.len());
        assert!(!PORTABLE_APPLICATION_FIELDS.contains(&"defaultPermissionMode"));
        // The explicit reasoning-display boolean and its legacy fallback are
        // both portable, and both are advertised by the application adapter.
        // The desktop gateway switch is device-local: the URL names one user's
        // own Gateway and the credentials behind it must never travel in a
        // synced bundle (rollout R5, ADR 0331).
        assert!(!PORTABLE_APPLICATION_FIELDS.contains(&"remoteGateway"));
        assert!(PORTABLE_APPLICATION_FIELDS.contains(&"showThinking"));
        // Reading learned memory is a preference about the user's own devices,
        // so the switch travels with the application domain while the entries
        // themselves sync through the memory domain.
        assert!(PORTABLE_APPLICATION_FIELDS.contains(&"learnedMemoryRead"));
        assert!(PORTABLE_APPLICATION_FIELDS.contains(&"thinkingDisplayMode"));
        let application = adapter_for(DOMAIN_APPLICATION).expect("application adapter");
        assert!(application.exportable_fields.contains(&"showThinking"));
        assert!(application
            .exportable_fields
            .contains(&"thinkingDisplayMode"));
        // Transcript density is a portable presentation preference like the
        // reasoning-display boolean above.
        assert!(PORTABLE_APPLICATION_FIELDS.contains(&"transcriptDensity"));
        assert!(application.exportable_fields.contains(&"transcriptDensity"));
        for domain in ALL_DOMAINS {
            let adapter = adapter_for(domain).expect("portable domain adapter");
            assert_eq!(adapter.schema_version, 1);
            assert!(!adapter.identity.is_empty());
            assert!(!adapter.merge_granularity.is_empty());
            assert!(!adapter.activation_policy.is_empty());
            assert!(!adapter.recovery_policy.is_empty());
        }
    }

    fn global_entity(domain: &str, entity_id: &str, payload: Value) -> PortableEntity {
        entity(
            domain,
            entity_id,
            entity_id,
            payload,
            false,
            false,
            false,
            vec![],
        )
    }

    #[test]
    fn project_scope_is_read_from_the_entity_not_from_this_device() {
        // A project MCP server, skill, instruction, pinned memory and folder-bound
        // automation are marked either by `mappingRequired` or by the logical id
        // in their payload. Both markers matter: an entity another build wrote
        // still has to classify the same way here.
        let cases = [
            (
                DOMAIN_MCP,
                json!({"id": "server"}),
                json!({"id": "server", "projectLogicalId": "project:abc"}),
            ),
            (
                DOMAIN_SKILLS,
                json!({"id": "skill"}),
                json!({"id": "skill", "projectGroupLogicalId": "project-group:abc"}),
            ),
            (
                DOMAIN_INSTRUCTIONS,
                json!({"scope": "global"}),
                json!({"scope": "project", "projectLogicalId": "project:abc"}),
            ),
            (
                DOMAIN_AUTOMATION,
                json!({"id": "task"}),
                json!({"id": "task", "workspaceProjectLogicalId": "project:abc"}),
            ),
        ];
        for (domain, global_payload, scoped_payload) in cases {
            let global = global_entity(domain, "global", global_payload);
            assert!(!is_project_scoped(&global), "{domain} global payload");
            let mut scoped = global_entity(domain, "scoped", scoped_payload);
            assert!(is_project_scoped(&scoped), "{domain} project payload");
            // A device that only set the mapping marker, without the logical id,
            // is still project scoped.
            scoped.payload = json!({"id": "scoped"});
            scoped.mapping_required = true;
            assert!(is_project_scoped(&scoped), "{domain} mapping marker");
        }

        // Pinned memory has no global shape at all.
        assert!(is_project_scoped(&global_entity(
            DOMAIN_MEMORY,
            "memory:project:abc",
            json!({"memory": {}})
        )));
        // Learned memory travels for the user and stays local for a folder.
        assert!(!is_project_scoped(&global_entity(
            DOMAIN_LEARNED_MEMORY,
            "learned-memory:user",
            json!({"scopeKind": "user"})
        )));
        assert!(is_project_scoped(&global_entity(
            DOMAIN_LEARNED_MEMORY,
            "learned-memory:project:abc",
            json!({"scopeKind": "project", "projectLogicalId": "project:abc"})
        )));
    }

    #[test]
    fn retaining_portable_entities_drops_project_records_and_their_resources() {
        let mut journal =
            global_entity(DOMAIN_SKILLS, "skill:global", json!({"id": "global-skill"}));
        journal.resource_ids = vec!["resource-global".into()];
        let mut project_skill = global_entity(
            DOMAIN_SKILLS,
            "skill:project",
            json!({"id": "project-skill", "projectLogicalId": "project:abc"}),
        );
        project_skill.resource_ids = vec!["resource-project".into()];
        let mut project_skill_package = global_entity(
            DOMAIN_SKILLS,
            "skill:project-package",
            json!({"id": "project-package"}),
        );
        project_skill_package.mapping_required = true;
        project_skill_package.resource_ids = vec!["resource-package".into()];
        let retired_project = global_entity("projects", "project:abc", json!({"name": "Remote"}));
        let mut manifest = RevisionManifest {
            format: "revision".into(),
            version: 1,
            revision_id: "revision".into(),
            parents: vec![],
            created_at: String::new(),
            entities: vec![
                journal.clone(),
                project_skill,
                project_skill_package,
                retired_project,
            ],
            resource_ids: vec![
                "resource-global".into(),
                "resource-package".into(),
                "resource-project".into(),
            ],
        };

        retain_portable_entities(&mut manifest);

        assert_eq!(manifest.entities, vec![journal]);
        // Resources follow the retained entities, so a filtered project skill
        // cannot leave an object behind for download.
        assert_eq!(manifest.resource_ids, vec!["resource-global".to_string()]);
    }

    #[test]
    fn writes_imported_instruction_files_beyond_the_former_size_cap() {
        let data_dir = tempfile::tempdir().unwrap();
        let path = data_dir.path().join("AGENTS.md");
        let content = "imported line\n".repeat(4000);
        assert!(content.len() > 32 * 1024);

        write_instruction_file(&path, &content).unwrap();

        assert_eq!(std::fs::read_to_string(&path).unwrap(), content);
    }
}
