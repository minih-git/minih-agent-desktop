use super::*;
use sha2::{Digest, Sha256};

/// The vendor key of the Minih Router account row in the providers store.
pub(crate) use crate::providers::MINIH_ROUTER_VENDOR_KEY;
const DEFAULT_ROUTER_BASE_URL: &str = "https://router.hmini.org/v1";

/// Identifies the server-side backup namespace this configuration belongs to.
///
/// The router stores backup objects per AccessKey, so the fingerprint of the
/// connected account's key is the destination identity. Changing the account
/// (or rotating the key) therefore requires setting the backup up again — the
/// same binding a direct cloud-credential transport would have.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RouterConnection {
    pub account: String,
}

/// The connected Minih Router account, resolved live from the providers store.
/// `access_key` must never be logged or serialized.
pub(crate) struct ResolvedAccount {
    pub base_url: String,
    pub access_key: String,
    pub fingerprint: String,
}

pub(super) fn account_fingerprint(access_key: &str) -> String {
    let digest = Sha256::digest(access_key.trim().as_bytes());
    digest[..16]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// The first enabled Minih Router provider row that holds a token — the same
/// row the Accounts page presents as the connected account.
pub(super) fn resolve_account(st: &AppState) -> Result<ResolvedAccount> {
    let rows = providers::list_providers(&st.db, &st.secrets, false)?;
    let provider = rows
        .iter()
        .find(|row| row.vendor_key.eq_ignore_ascii_case(MINIH_ROUTER_VENDOR_KEY) && row.has_secret)
        .ok_or_else(|| {
            anyhow!("CONFIG_SYNC_AUTH: connect a Minih Router account before using backup")
        })?;
    let access_key = providers::get_secret_for_provider(&st.db, &st.secrets, &provider.id)?
        .ok_or_else(|| {
            anyhow!("CONFIG_SYNC_AUTH: the Minih Router account token is not available")
        })?;
    let access_key = access_key.trim().to_string();
    if access_key.is_empty() {
        bail!("CONFIG_SYNC_AUTH: the Minih Router account token is empty");
    }
    let base_url = provider
        .base_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(DEFAULT_ROUTER_BASE_URL)
        .to_string();
    Ok(ResolvedAccount {
        base_url,
        fingerprint: account_fingerprint(&access_key),
        access_key,
    })
}

/// Renderer-facing account presence, without reading the token.
pub(super) fn account_status(st: &AppState) -> (bool, Option<String>) {
    let Ok(rows) = providers::list_providers(&st.db, &st.secrets, false) else {
        return (false, None);
    };
    match rows
        .iter()
        .find(|row| row.vendor_key.eq_ignore_ascii_case(MINIH_ROUTER_VENDOR_KEY) && row.has_secret)
    {
        Some(row) => (
            true,
            Some(
                row.base_url
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .unwrap_or(DEFAULT_ROUTER_BASE_URL)
                    .to_string(),
            ),
        ),
        None => (false, None),
    }
}

/// Strip the OpenAI-compatible `/v1` suffix so the control-plane root remains.
pub(super) fn control_root(base_url: &str) -> String {
    let mut value = base_url.trim().trim_end_matches('/').to_string();
    if let Some(stripped) = value.strip_suffix("/v1") {
        value = stripped.trim_end_matches('/').to_string();
    }
    value
}

/// Prefer the EasyTier LAN endpoint when it is reachable, like the chat path.
pub(super) async fn account_transport(account: &ResolvedAccount) -> Result<RouterTransport> {
    let resolved =
        crate::easytier_net::resolve_minih_router_endpoint(Some(&account.base_url)).await;
    RouterTransport::new(&RouterConfig {
        root: control_root(&resolved.active_base_url),
        access_key: account.access_key.clone(),
        allow_insecure_http: crate::network_policy::relaxed(),
    })
}

/// Validate the stored configuration against the live account. The account is
/// returned owned so no `&AppState` borrow crosses an await (AppState is not
/// `Sync`); pair it with `account_transport`.
pub(super) fn configured_account(st: &AppState, config: &StoredConfig) -> Result<ResolvedAccount> {
    let account = resolve_account(st)?;
    if account.fingerprint != config.connection.account {
        bail!(
            "CONFIG_SYNC_AUTH: the connected Minih Router account changed; set the backup up again"
        );
    }
    Ok(account)
}

fn input_text(input: &Value, name: &str, fallback: &str) -> Result<String> {
    match input.get(name) {
        Some(Value::String(value)) => Ok(value.trim().to_string()),
        Some(_) => bail!("CONFIG_SYNC_INVALID: {name} must be text"),
        None => Ok(fallback.to_string()),
    }
}

fn input_bool(input: &Value, name: &str, fallback: bool) -> Result<bool> {
    match input.get(name) {
        Some(Value::Bool(value)) => Ok(*value),
        Some(_) => bail!("CONFIG_SYNC_INVALID: {name} must be a boolean"),
        None => Ok(fallback),
    }
}

pub(super) fn config_from_input(
    existing: Option<&StoredConfig>,
    input: &Value,
    header: VaultHeader,
    account: &str,
) -> Result<StoredConfig> {
    if !input.is_object() {
        bail!("CONFIG_SYNC_INVALID: configuration must be an object");
    }
    for removed in [
        "username",
        "appPassword",
        "directory",
        "remoteMode",
        "endpoint",
        "region",
        "bucket",
        "prefix",
        "accessKeyId",
        "secretAccessKey",
        "sessionToken",
        "pathStyle",
    ] {
        if input.get(removed).is_some() {
            bail!("CONFIG_SYNC_INVALID: standalone S3 connection fields are no longer supported");
        }
    }
    let connection = RouterConnection {
        account: account.to_string(),
    };
    let device_label = input_text(
        input,
        "deviceLabel",
        existing.map_or("This device", |v| &v.device_label),
    )?;
    if device_label.is_empty() || device_label.len() > 128 {
        bail!("CONFIG_SYNC_INVALID: device label must contain 1 to 128 bytes");
    }
    let mode = match input.get("mode") {
        None => existing.map(|value| value.mode).unwrap_or_default(),
        Some(Value::String(value)) if value == "sync" => SyncMode::Sync,
        Some(Value::String(value)) if value == "backup" => SyncMode::Backup,
        _ => bail!("CONFIG_SYNC_INVALID: unsupported configuration mode"),
    };
    let same_state = existing.filter(|saved| saved.connection == connection && saved.mode == mode);
    let include_memory = input_bool(
        input,
        "includeMemory",
        existing.is_some_and(|v| v.include_memory),
    )?;
    let include_secrets = input_bool(
        input,
        "includeSecrets",
        existing.is_some_and(|v| v.include_secrets),
    )?;
    let mut categories = existing
        .map(|value| value.categories.clone())
        .unwrap_or_else(default_categories);
    if let Some(value) = input.get("categories") {
        let object = value
            .as_object()
            .ok_or_else(|| anyhow!("CONFIG_SYNC_INVALID: categories must be an object"))?;
        for (name, selected) in object {
            if !domains::ALL_DOMAINS.contains(&name.as_str()) && name != "credentials" {
                bail!("CONFIG_SYNC_INVALID: unsupported configuration category");
            }
            categories.insert(
                name.clone(),
                selected.as_bool().ok_or_else(|| {
                    anyhow!("CONFIG_SYNC_INVALID: category selection must be a boolean")
                })?,
            );
        }
    }
    categories.insert("credentials".into(), include_secrets);
    categories.insert(domains::DOMAIN_MEMORY.into(), include_memory);
    Ok(StoredConfig {
        format: FORMAT.into(),
        version: 1,
        connection,
        mode,
        state_id: same_state
            .map(|value| value.state_id.clone())
            .unwrap_or_else(new_device_id),
        device_label,
        device_id: existing
            .map(|value| value.device_id.clone())
            .unwrap_or_else(new_device_id),
        categories,
        include_secrets,
        include_memory,
        automatic_sync: input_bool(
            input,
            "automaticSync",
            existing.is_none_or(|v| v.automatic_sync),
        )?,
        enabled: true,
        paused: existing.is_some_and(|value| value.paused),
        vault_id: header.vault_id.clone(),
        vault_header: header,
        last_run_at: same_state.and_then(|v| v.last_run_at.clone()),
        last_success_at: same_state.and_then(|v| v.last_success_at.clone()),
        last_revision_id: same_state.and_then(|v| v.last_revision_id.clone()),
        last_error: None,
        last_error_code: None,
        last_local_digest: same_state.and_then(|v| v.last_local_digest.clone()),
        local_change_seen_at: None,
        retry_count: 0,
        next_retry_at: None,
        project_mappings: same_state
            .map(|v| v.project_mappings.clone())
            .unwrap_or_default(),
        project_group_mappings: same_state
            .map(|v| v.project_group_mappings.clone())
            .unwrap_or_default(),
        dismissed: same_state.map(|v| v.dismissed.clone()).unwrap_or_default(),
        resolved_conflicts: same_state
            .map(|v| v.resolved_conflicts.clone())
            .unwrap_or_default(),
        plugin_intents: same_state
            .map(|v| v.plugin_intents.clone())
            .unwrap_or_default(),
        recovery_points: same_state
            .map(|v| v.recovery_points.clone())
            .unwrap_or_default(),
    })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    #[test]
    fn control_root_strips_the_data_plane_suffix() {
        assert_eq!(
            control_root("https://router.hmini.org/v1/"),
            "https://router.hmini.org"
        );
        assert_eq!(
            control_root("http://11.12.0.1:3001/v1"),
            "http://11.12.0.1:3001"
        );
        assert_eq!(
            control_root("https://proxy.example.test/router/v1"),
            "https://proxy.example.test/router"
        );
        assert_eq!(
            control_root("https://router.hmini.org"),
            "https://router.hmini.org"
        );
    }

    #[test]
    fn fingerprint_binds_the_account_identity() -> Result<()> {
        let directory = tempfile::tempdir()?;
        let state = AppState::open(directory.path())?;
        assert!(resolve_account(&state).is_err());
        create_router_provider(&state, "https://router.example.test/v1", "fixture-key")?;
        let account = resolve_account(&state)?;
        assert_eq!(account.fingerprint, account_fingerprint("fixture-key"));
        assert_eq!(account.base_url, "https://router.example.test/v1");
        // Rotating to a different key changes the destination identity.
        assert_ne!(account_fingerprint("rotated-key"), account.fingerprint);
        Ok(())
    }

    #[test]
    fn account_changes_get_a_fresh_local_baseline() -> Result<()> {
        let (header, _) = create_vault("backup-password", "test-vault")?;
        let input = json!({"deviceLabel":"Test"});
        let config = config_from_input(None, &input, header.clone(), "account-one")?;
        let same = config_from_input(Some(&config), &input, header.clone(), "account-one")?;
        assert_eq!(same.state_id, config.state_id);
        let changed = config_from_input(Some(&config), &input, header, "account-two")?;
        assert_ne!(changed.state_id, config.state_id);
        assert!(changed.last_revision_id.is_none());
        for removed in ["endpoint", "bucket", "secretAccessKey"] {
            let error = config_from_input(
                Some(&config),
                &json!({(removed):"value"}),
                create_vault("backup-password", "test-vault")?.0,
                "account-one",
            );
            assert!(error.is_err());
        }
        Ok(())
    }

    pub(crate) fn create_router_provider(
        st: &AppState,
        base_url: &str,
        access_key: &str,
    ) -> Result<()> {
        providers::create_provider(
            &st.db,
            &st.secrets,
            ProviderCreateInput {
                name: "Minih Router".into(),
                vendor_key: Some(MINIH_ROUTER_VENDOR_KEY.into()),
                provider_type: Some("custom".into()),
                protocol: Some("openai_compatible".into()),
                base_url: Some(base_url.into()),
                auth_kind: Some("api_key_and_base_url".into()),
                secret_value: Some(access_key.into()),
                models: None,
                default_model_id: None,
                api_style: None,
                oauth_account_label: None,
                headers: None,
                supports_reasoning: None,
                supported_thinking_levels: None,
                context_window: None,
                max_output_tokens: None,
                temperature: None,
            },
        )?;
        Ok(())
    }
}
