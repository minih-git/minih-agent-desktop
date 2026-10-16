use super::*;
use crate::providers;

fn provider_snapshot(include_credentials: bool, requested: bool) -> Result<LocalSnapshot> {
    let directory = tempfile::tempdir()?;
    let mut state = AppState::open(directory.path())?;
    let provider = providers::create_provider(
        &state.db,
        &state.secrets,
        serde_json::from_value(json!({
            "name": "Personal router",
            "vendorKey": "minih-router",
            "type": "openai_compatible",
            "protocol": "openai_compatible",
            "baseUrl": "https://router.example.test/v1",
            "authKind": "api_key_and_base_url",
            "oauthAccountLabel": "Portable account label",
            "secretValue": "fixture-portable-api-key",
            "supportsReasoning": true,
            "supportedThinkingLevels": ["low", "high"],
            "models": [{
                "id": "fixture-model",
                "alias": "My model",
                "contextWindow": 200000,
                "contextWindowSource": "user",
                "maxTokens": 8192,
                "maxTokensSource": "user",
                "thinkingLevels": ["low", "high"],
                "defaultThinkingLevel": "high",
                "thinkingProtocol": "adaptive",
                "supportsImages": true,
                "supportsDocuments": false,
                "availableForSubagents": true,
                "nativeWebSearch": true,
                "apiStyle": "responses"
            }]
        }))?,
    )?;
    // OAuth credentials can coexist with an API key, but must never become
    // portable merely because the credential category was selected.
    state.secrets.set(
        &crate::secrets::secret_ref_for_provider_oauth(&provider.id),
        "fixture-private-oauth-session",
    )?;
    let mut selection = CategorySelection(
        ALL_DOMAINS
            .iter()
            .map(|domain| ((*domain).into(), false))
            .collect(),
    );
    selection.0.insert(DOMAIN_PROVIDERS.into(), true);
    selection
        .0
        .insert("credentials".into(), include_credentials);
    capture(
        &mut state,
        &VaultKey([7; 32]),
        &selection,
        requested,
        &BTreeMap::new(),
        &ProjectIdentityOverrides::default(),
    )
}

#[test]
fn provider_capture_preserves_account_identity_and_explicit_reasoning_configuration() -> Result<()>
{
    let snapshot = provider_snapshot(true, true)?;
    let provider = &snapshot.manifest.entities[0];
    assert_eq!(
        provider.payload["oauthAccountLabel"],
        "Portable account label"
    );
    assert_eq!(provider.payload["supportsReasoning"], true);
    assert_eq!(
        provider.payload["supportedThinkingLevels"],
        json!(["low", "high"])
    );
    assert_eq!(
        provider.payload["portableApiKey"],
        "fixture-portable-api-key"
    );
    let model = &provider.payload["models"][0];
    assert_eq!(model["id"], "fixture-model");
    assert_eq!(model["alias"], "My model");
    assert_eq!(model["contextWindow"], 200000);
    assert_eq!(model["contextWindowSource"], "user");
    assert_eq!(model["maxTokens"], 8192);
    assert_eq!(model["maxTokensSource"], "user");
    assert_eq!(model["thinkingLevels"], json!(["low", "high"]));
    assert_eq!(model["defaultThinkingLevel"], "high");
    assert_eq!(model["thinkingProtocol"], "adaptive");
    assert_eq!(model["supportsImages"], true);
    assert_eq!(model["supportsDocuments"], false);
    assert_eq!(model["availableForSubagents"], true);
    assert_eq!(model["nativeWebSearch"], true);
    assert_eq!(model["apiStyle"], "responses");
    for field in [
        "enabled",
        "hasSecret",
        "hasOauth",
        "createdAt",
        "updatedAt",
        "ownerPluginId",
    ] {
        assert!(
            provider.payload.get(field).is_none(),
            "device-local field: {field}"
        );
    }
    assert!(!serde_json::to_string(&snapshot)?.contains("fixture-private-oauth-session"));
    Ok(())
}

#[test]
fn provider_capture_requires_both_credential_selection_and_permission() -> Result<()> {
    for (selection, requested) in [(false, false), (false, true), (true, false)] {
        let snapshot = provider_snapshot(selection, requested)?;
        let provider = &snapshot.manifest.entities[0];
        assert!(provider.payload.get("portableApiKey").is_none());
        let serialized = serde_json::to_string(&snapshot)?;
        assert!(!serialized.contains("fixture-portable-api-key"));
        assert!(!serialized.contains("fixture-private-oauth-session"));
        assert!(provider.secret_bearing);
    }
    Ok(())
}
