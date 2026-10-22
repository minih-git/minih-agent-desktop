use super::*;

fn capture_application(st: &AppState) -> Result<PortableEntity> {
    let mut settings = st.db.get_setting("app")?.unwrap_or_else(|| json!({}));
    if let Some(object) = settings.as_object_mut() {
        object.retain(|key, _| PORTABLE_APPLICATION_FIELDS.contains(&key.as_str()));
    }
    Ok(entity(
        DOMAIN_APPLICATION,
        "application",
        "Application preferences",
        settings,
        false,
        false,
        false,
        Vec::new(),
    ))
}

fn capture_providers(st: &AppState) -> Result<Vec<PortableEntity>> {
    let providers = crate::providers::list_providers(&st.db, &st.secrets, true)?;
    let mut result = Vec::new();
    for provider in providers {
        if provider.owner_plugin_id.is_some() {
            continue;
        }
        // The connected Minih Router account row is the backup transport's own
        // identity, not portable configuration. Each device links its own
        // account row; syncing it would duplicate the row and tombstone the
        // receiving device's working account. It stays device-local, like the
        // device-local project lists.
        if provider
            .vendor_key
            .eq_ignore_ascii_case(crate::providers::MINIH_ROUTER_VENDOR_KEY)
        {
            continue;
        }
        let mut payload = serde_json::to_value(&provider)?;
        strip_keys(
            &mut payload,
            &[
                "hasSecret",
                "hasOauth",
                "enabled",
                "supportsVision",
                "createdAt",
                "updatedAt",
                "ownerPluginId",
            ],
        );
        let has_secret = provider.has_secret;
        result.push(entity(
            DOMAIN_PROVIDERS,
            format!("provider:{}", provider.id),
            provider.name,
            payload,
            has_secret,
            has_secret,
            false,
            Vec::new(),
        ));
    }
    Ok(result)
}

/// Global MCP servers only. A server a device keeps for one project belongs to
/// that folder: it stays on this machine and travels through a project archive,
/// never through the cloud copy.
fn capture_mcp(
    st: &mut AppState,
    selection: &CategorySelection,
    include_secrets: bool,
) -> Result<Vec<PortableEntity>> {
    let mut result = Vec::new();
    for record in st.mcp_servers.list(CapabilityLevel::Global, None)? {
        let mut payload = serde_json::to_value(&record)?;
        strip_keys(
            &mut payload,
            &["path", "projectPath", "createdAt", "updatedAt"],
        );
        let secret_bearing = !record.env.is_empty() || !record.headers.is_empty();
        if !selection.include_secrets(include_secrets) {
            if let Some(object) = payload.as_object_mut() {
                object.remove("env");
                object.remove("headers");
                if !record.env.is_empty() {
                    object.insert(
                        "envKeys".to_string(),
                        Value::Array(record.env.keys().cloned().map(Value::String).collect()),
                    );
                }
                if !record.headers.is_empty() {
                    object.insert(
                        "headerKeys".to_string(),
                        Value::Array(record.headers.keys().cloned().map(Value::String).collect()),
                    );
                }
            }
        }
        // The entity id keeps the global namespace it always had, so a device
        // that upgrades keeps acknowledging the same MCP definitions instead of
        // re-approving every one of them.
        let id = format!(
            "mcp:global:{}",
            stable_id("id", &format!("global:{}", record.id))
        );
        result.push(entity(
            DOMAIN_MCP,
            id,
            record.label,
            payload,
            true,
            secret_bearing,
            false,
            Vec::new(),
        ));
    }
    Ok(result)
}

/// Global skills only, with their bounded package resources. A skill installed
/// for one project stays with that folder and is carried by a project archive.
fn capture_skills(st: &mut AppState, key: &VaultKey) -> Result<(Vec<PortableEntity>, ResourceMap)> {
    let mut result = Vec::new();
    let mut resources = BTreeMap::new();
    for record in st.user_skills.list(CapabilityLevel::Global, None)? {
        let bytes = st
            .user_skills
            .read(&record.id, Some(CapabilityLevel::Global), None)?
            .map(|(_, body)| body.into_bytes())
            .ok_or_else(|| anyhow::anyhow!("skill disappeared while capturing"))?;
        let resource_id = object_id(key, &bytes);
        resources.entry(resource_id.clone()).or_insert(bytes);
        let package_files =
            st.user_skills
                .package_files(&record.id, CapabilityLevel::Global, None)?;
        let mut resource_ids = vec![resource_id.clone()];
        let mut package_descriptors = Vec::with_capacity(package_files.len());
        for (path, bytes) in package_files {
            let package_resource_id = object_id(key, &bytes);
            resources
                .entry(package_resource_id.clone())
                .or_insert(bytes);
            resource_ids.push(package_resource_id.clone());
            package_descriptors.push(json!({
                "path": path,
                "resourceId": package_resource_id,
            }));
        }
        let mut payload = serde_json::to_value(&record)?;
        strip_keys(
            &mut payload,
            &[
                "path",
                "projectPath",
                "workspacePath",
                "sizeBytes",
                "createdAt",
                "updatedAt",
            ],
        );
        if let Some(object) = payload.as_object_mut() {
            object.insert(
                "bodyResourceId".to_string(),
                Value::String(resource_id.clone()),
            );
            if !package_descriptors.is_empty() {
                object.insert(
                    "packageFiles".to_string(),
                    Value::Array(package_descriptors),
                );
            }
        }
        let id = format!(
            "skill:{}",
            stable_id("skill", &format!("global:{}", record.id))
        );
        result.push(entity(
            DOMAIN_SKILLS,
            id,
            record.name,
            payload,
            true,
            false,
            false,
            resource_ids,
        ));
    }
    Ok((result, resources))
}

fn capture_subagents(
    st: &mut AppState,
    key: &VaultKey,
) -> Result<(Vec<PortableEntity>, ResourceMap)> {
    let mut result = Vec::new();
    let mut resources = BTreeMap::new();
    for record in st.user_subagents.list()? {
        let bytes = st
            .user_subagents
            .read(&record.id)?
            .map(|(_, body)| body.into_bytes())
            .ok_or_else(|| anyhow::anyhow!("subagent disappeared while capturing"))?;
        let resource_id = object_id(key, &bytes);
        resources.entry(resource_id.clone()).or_insert(bytes);
        let mut payload = serde_json::to_value(&record)?;
        strip_keys(
            &mut payload,
            &["path", "sizeBytes", "createdAt", "updatedAt"],
        );
        if let Some(object) = payload.as_object_mut() {
            object.insert(
                "bodyResourceId".to_string(),
                Value::String(resource_id.clone()),
            );
        }
        result.push(entity(
            DOMAIN_SUBAGENTS,
            format!("subagent:{}", record.id),
            record.name,
            payload,
            true,
            false,
            false,
            vec![resource_id],
        ));
    }
    Ok((result, resources))
}

/// The one instruction file that belongs to the user rather than to a folder.
/// Project `AGENTS.md` files, group instructions and pinned project memory are
/// device-local: they describe folders this machine owns.
fn capture_instructions() -> Result<Vec<PortableEntity>> {
    let mut result = Vec::new();
    if let Some(path) = global_instruction_path() {
        if let Some(content) = read_instruction_file(&path)? {
            result.push(entity(
                DOMAIN_INSTRUCTIONS,
                "instructions:global",
                "Global instructions",
                json!({
                    "scope": "global",
                    "content": content,
                }),
                true,
                true,
                false,
                Vec::new(),
            ));
        }
    }
    Ok(result)
}

fn global_instruction_path() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(".pi").join("agent").join("AGENTS.md"))
}

fn read_instruction_file(path: &Path) -> Result<Option<String>> {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return Ok(None);
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Ok(None);
    }
    let bytes = fs::read(path)?;
    let content = String::from_utf8(bytes)
        .map_err(|_| anyhow::anyhow!("CONFIG_SYNC_INVALID: instruction file is not UTF-8"))?;
    if content.trim().is_empty() {
        return Ok(None);
    }
    Ok(Some(content))
}

pub(crate) fn global_instruction_path_for_sync() -> Result<PathBuf> {
    global_instruction_path()
        .ok_or_else(|| anyhow::anyhow!("CONFIG_SYNC_INVALID: home directory is unavailable"))
}

pub(crate) fn write_instruction_file(path: &Path, content: &str) -> Result<()> {
    if fs::symlink_metadata(path)
        .map(|metadata| metadata.file_type().is_symlink())
        .unwrap_or(false)
    {
        return Err(anyhow::anyhow!(
            "CONFIG_SYNC_INVALID: instruction file is a symbolic link"
        ));
    }
    let parent = path
        .parent()
        .ok_or_else(|| anyhow::anyhow!("CONFIG_SYNC_INVALID: instruction path has no parent"))?;
    fs::create_dir_all(parent)?;
    let filename = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| anyhow::anyhow!("CONFIG_SYNC_INVALID: instruction path is invalid"))?;
    let temporary = parent.join(format!(".{filename}.{}.tmp", Uuid::new_v4()));
    fs::write(&temporary, content.as_bytes())?;
    fs::rename(&temporary, path).map_err(|error| {
        let _ = fs::remove_file(&temporary);
        anyhow::anyhow!("CONFIG_SYNC_IO: replace instruction file: {error}")
    })?;
    Ok(())
}

pub(crate) fn remove_instruction_file(path: &Path) -> Result<()> {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return Ok(());
    };
    if metadata.file_type().is_symlink() {
        return Err(anyhow::anyhow!(
            "CONFIG_SYNC_INVALID: instruction file is a symbolic link"
        ));
    }
    if metadata.is_file() {
        fs::remove_file(path)?;
    }
    Ok(())
}

/// Automations that are not bound to a folder. A task that runs in a project
/// belongs to that project: it stays on this machine, keeps the user's own
/// enablement, and travels through a project archive.
fn capture_automation(st: &mut AppState) -> Result<Vec<PortableEntity>> {
    let mut result = Vec::new();
    for task in crate::scheduled::list_tasks(&st.db)? {
        if task.workspace_path.is_some() {
            continue;
        }
        let mut payload = serde_json::to_value(&task)?;
        strip_keys(
            &mut payload,
            &[
                "createdAt",
                "updatedAt",
                "lastRunAt",
                "nextRunAt",
                "workspacePath",
                "enabled",
            ],
        );
        result.push(entity(
            DOMAIN_AUTOMATION,
            format!("automation:{}", task.id),
            task.title,
            payload,
            true,
            true,
            false,
            Vec::new(),
        ));
    }
    Ok(result)
}

fn portable_plugin_payload(payload: &Value, fallback_id: &str) -> Value {
    let mut portable = serde_json::Map::new();
    if let Some(source) = payload.as_object() {
        for key in [
            "id",
            "name",
            "version",
            "source",
            "description",
            "author",
            "marketplace",
            "autoUpdate",
        ] {
            if let Some(value) = source.get(key) {
                portable.insert(key.to_string(), value.clone());
            }
        }
    }
    portable
        .entry("id".to_string())
        .or_insert_with(|| Value::String(fallback_id.to_string()));
    Value::Object(portable)
}

fn capture_plugins(
    st: &AppState,
    plugin_intents: &BTreeMap<String, Value>,
) -> Result<Vec<PortableEntity>> {
    let mut result = Vec::new();
    let mut seen = BTreeMap::new();
    for plugin in st.plugins.list() {
        if plugin.bundled {
            continue;
        }
        let mut payload = serde_json::to_value(&plugin)?;
        if let Some(object) = payload.as_object_mut() {
            object.retain(|key, _| {
                matches!(
                    key.as_str(),
                    "id" | "name"
                        | "version"
                        | "source"
                        | "description"
                        | "author"
                        | "marketplace"
                        | "autoUpdate"
                )
            });
        }
        result.push(entity(
            DOMAIN_PLUGINS,
            format!("plugin:{}", plugin.id),
            plugin.name,
            payload,
            true,
            false,
            false,
            Vec::new(),
        ));
        seen.insert(plugin.id, ());
    }
    for (plugin_id, payload) in plugin_intents {
        if seen.contains_key(plugin_id) {
            continue;
        }
        let label = payload
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or(plugin_id)
            .to_string();
        result.push(entity(
            DOMAIN_PLUGINS,
            format!("plugin:{plugin_id}"),
            label,
            portable_plugin_payload(payload, plugin_id),
            true,
            false,
            false,
            Vec::new(),
        ));
    }
    Ok(result)
}

pub(crate) fn capture(
    st: &mut AppState,
    key: &VaultKey,
    selection: &CategorySelection,
    include_secrets: bool,
    plugin_intents: &BTreeMap<String, Value>,
) -> Result<LocalSnapshot> {
    let mut snapshot = LocalSnapshot {
        manifest: RevisionManifest {
            format: "minih-agent-desktop-config-revision".to_string(),
            version: 1,
            revision_id: uuid::Uuid::new_v4().to_string(),
            parents: Vec::new(),
            created_at: chrono::Utc::now().to_rfc3339(),
            entities: Vec::new(),
            resource_ids: Vec::new(),
        },
        resources: BTreeMap::new(),
    };
    if selection.is_selected(DOMAIN_APPLICATION) {
        snapshot.manifest.entities.push(capture_application(st)?);
    }
    if selection.is_selected(DOMAIN_PROVIDERS) {
        for mut provider in capture_providers(st)? {
            if selection.include_secrets(include_secrets) {
                let id = provider
                    .entity_id
                    .strip_prefix("provider:")
                    .unwrap_or_default();
                if let Some(secret) = st
                    .secrets
                    .get(&crate::providers::secret_ref_for_provider(id))?
                {
                    if let Some(object) = provider.payload.as_object_mut() {
                        object.insert("portableApiKey".into(), Value::String(secret));
                    }
                    provider.digest = digest_entity(
                        &provider.domain,
                        &provider.entity_id,
                        provider.deleted,
                        provider.requires_approval,
                        provider.secret_bearing,
                        provider.mapping_required,
                        &provider.payload,
                        &provider.resource_ids,
                    );
                }
            }
            snapshot.manifest.entities.push(provider);
        }
    }
    if selection.is_selected(DOMAIN_MCP) {
        snapshot
            .manifest
            .entities
            .extend(capture_mcp(st, selection, include_secrets)?);
    }
    if selection.is_selected(DOMAIN_SKILLS) {
        let (entities, resources) = capture_skills(st, key)?;
        snapshot.manifest.entities.extend(entities);
        snapshot.resources.extend(resources);
    }
    if selection.is_selected(DOMAIN_SUBAGENTS) {
        let (entities, resources) = capture_subagents(st, key)?;
        snapshot.manifest.entities.extend(entities);
        snapshot.resources.extend(resources);
    }
    if selection.is_selected(DOMAIN_INSTRUCTIONS) {
        snapshot.manifest.entities.extend(capture_instructions()?);
    }
    if selection.is_selected(DOMAIN_PLUGINS) {
        snapshot
            .manifest
            .entities
            .extend(capture_plugins(st, plugin_intents)?);
    }
    if selection.is_selected(DOMAIN_AUTOMATION) {
        snapshot.manifest.entities.extend(capture_automation(st)?);
    }
    // DOMAIN_MEMORY (pinned project and group memory) is deliberately not
    // captured any more: it belongs to folders this machine owns. The domain
    // stays in the registry so an older device's revision still validates and
    // is filtered instead of failing the whole sync.
    if selection.is_selected(crate::config_sync::domains::DOMAIN_LEARNED_MEMORY) {
        snapshot.manifest.entities.extend(
            crate::config_sync::learned_memory::capture_learned_memory(st)?,
        );
    }
    snapshot.manifest.entities.sort_by(|left, right| {
        left.domain
            .cmp(&right.domain)
            .then(left.entity_id.cmp(&right.entity_id))
    });
    snapshot.manifest.resource_ids = snapshot.resources.keys().cloned().collect();
    Ok(snapshot)
}
