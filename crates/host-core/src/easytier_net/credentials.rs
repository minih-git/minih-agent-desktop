//! The credential the gateway bootstrap request identifies with.
//!
//! Kept in its own module so the database and secret store stay behind one
//! narrow interface: `easytier_net` asks for a Router base URL and AccessKey,
//! and never learns how either is stored. The key is read on demand and dropped
//! as soon as the request completes — it is never logged, cached, or copied into
//! the bootstrap cache, which is keyed by a digest instead.

use crate::easytier_net::BootstrapCredentialProvider;
use crate::providers;
use crate::state::AppState;
use std::sync::Arc;
use tokio::sync::Mutex;

/// Reads the Minih Router credential the tunnel identifies with.
pub struct AppStateCredentialProvider {
    state: Arc<Mutex<AppState>>,
}

impl AppStateCredentialProvider {
    pub fn new(state: Arc<Mutex<AppState>>) -> Self {
        Self { state }
    }
}

#[async_trait::async_trait]
impl BootstrapCredentialProvider for AppStateCredentialProvider {
    async fn minih_router_credential(&self) -> Option<(String, String)> {
        let st = self.state.lock().await;
        // Disabled rows count: the user may have switched a Router off and still
        // expect the LAN channel to describe the network it last joined.
        let rows = providers::list_providers(&st.db, &st.secrets, true).ok()?;
        select_credential(rows, |id| {
            providers::get_secret_for_provider(&st.db, &st.secrets, id)
                .ok()
                .flatten()
        })
    }
}

/// The Router row the tunnel identifies with, in creation order.
///
/// The row must carry both a base URL and a key. Skipping keyless rows is the
/// point: taking the first `minih-router` row regardless left the desktop asking
/// nobody for an identity while a credentialed row sat right behind it.
fn select_credential(
    rows: Vec<providers::ProviderPublic>,
    read_secret: impl Fn(&str) -> Option<String>,
) -> Option<(String, String)> {
    rows.into_iter()
        .filter(|row| is_minih_router_vendor_key(Some(row.vendor_key.as_str())))
        .find_map(|row| {
            let base_url = row.base_url.filter(|value| !value.trim().is_empty())?;
            let access_key = read_secret(&row.id).filter(|value| !value.trim().is_empty())?;
            Some((base_url, access_key))
        })
}

/// Local copy of the shared predicate, so this module does not depend on the
/// renderer-facing package for one string comparison.
fn is_minih_router_vendor_key(vendor_key: Option<&str>) -> bool {
    vendor_key
        .map(str::trim)
        .is_some_and(|key| key.eq_ignore_ascii_case("minih-router"))
}

/// What one provider row contributes to the network center identity: the
/// endpoint the bootstrap is asked at and a digest of the key it is asked with.
///
/// `None` for a row that is not a Router row, so turning a row into (or out
/// of) a Router changes it as well. Edits that touch neither the endpoint nor
/// the key — models, name, default model, headers — compare equal, so they do
/// not restart a working tunnel. The key itself is never held here.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RouterRowIdentity {
    base_url: Option<String>,
    access_key_digest: Option<String>,
}

pub fn router_row_identity(
    db: &crate::db::Database,
    secrets: &crate::secrets::SecretStore,
    id: &str,
) -> Option<RouterRowIdentity> {
    let row = providers::get_provider(db, secrets, id).ok().flatten()?;
    if !is_minih_router_vendor_key(Some(row.vendor_key.as_str())) {
        return None;
    }
    let access_key_digest = providers::get_secret_for_provider(db, secrets, id)
        .ok()
        .flatten()
        .filter(|value| !value.trim().is_empty())
        .map(|value| crate::easytier_net::bootstrap::access_key_digest(&value));
    Some(RouterRowIdentity {
        base_url: row.base_url.filter(|value| !value.trim().is_empty()),
        access_key_digest,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_minih_router_row_qualifies() {
        assert!(is_minih_router_vendor_key(Some("minih-router")));
        assert!(is_minih_router_vendor_key(Some("Minih-Router")));
        assert!(!is_minih_router_vendor_key(Some("openai")));
        assert!(!is_minih_router_vendor_key(Some("custom")));
        assert!(!is_minih_router_vendor_key(None));
    }
    fn create_router(
        db: &crate::db::Database,
        secrets: &crate::secrets::SecretStore,
        name: &str,
        base_url: &str,
        secret_value: Option<&str>,
    ) {
        use crate::providers::ProviderCreateInput;
        crate::providers::create_provider(
            db,
            secrets,
            ProviderCreateInput {
                name: name.into(),
                vendor_key: Some("minih-router".into()),
                provider_type: Some("openai_compatible".into()),
                protocol: Some("openai_compatible".into()),
                base_url: Some(base_url.into()),
                auth_kind: Some("api_key_and_base_url".into()),
                models: None,
                default_model_id: None,
                secret_value: secret_value.map(ToString::to_string),
                api_style: Some("chat_completions".into()),
                oauth_account_label: None,
                headers: None,
                context_window: None,
                max_output_tokens: None,
                temperature: None,
                supports_reasoning: None,
                supported_thinking_levels: None,
            },
        )
        .expect("fixture provider");
    }

    #[test]
    fn a_row_without_a_key_is_skipped_for_the_next_router_row() {
        // R4: the tunnel used to take the first Router row even when it had no
        // key, so the desktop asked nobody while a credentialed row sat behind it.
        let dir = tempfile::tempdir().unwrap();
        let db = crate::db::Database::open(&dir.path().join("pi.sqlite")).unwrap();
        let secrets = crate::secrets::SecretStore::open(dir.path()).unwrap();
        create_router(
            &db,
            &secrets,
            "no key",
            "https://stale.example.com/v1",
            None,
        );
        create_router(
            &db,
            &secrets,
            "with key",
            "https://router.hmini.org/v1",
            Some("sk-fixture"),
        );

        let rows = crate::providers::list_providers(&db, &secrets, true).unwrap();
        assert_eq!(rows.len(), 2, "both fixture rows exist");
        let picked = select_credential(rows, |id| {
            crate::providers::get_secret_for_provider(&db, &secrets, id).unwrap()
        })
        .expect("the credentialed row must be picked");
        assert_eq!(picked.0, "https://router.hmini.org/v1");
        assert_eq!(picked.1, "sk-fixture");
    }

    #[test]
    fn a_keyless_router_row_is_never_used() {
        let dir = tempfile::tempdir().unwrap();
        let db = crate::db::Database::open(&dir.path().join("pi.sqlite")).unwrap();
        let secrets = crate::secrets::SecretStore::open(dir.path()).unwrap();
        create_router(&db, &secrets, "router", "https://router.hmini.org/v1", None);
        let rows = crate::providers::list_providers(&db, &secrets, true).unwrap();
        assert!(select_credential(rows, |_| None).is_none());
    }

    fn update(
        db: &crate::db::Database,
        secrets: &crate::secrets::SecretStore,
        patch: serde_json::Value,
    ) {
        let input: crate::providers::ProviderUpdateInput =
            serde_json::from_value(patch).expect("update input");
        crate::providers::update_provider(db, secrets, input).expect("update");
    }

    #[test]
    fn only_endpoint_key_or_vendor_edits_change_the_router_identity() {
        let dir = tempfile::tempdir().unwrap();
        let db = crate::db::Database::open(&dir.path().join("pi.sqlite")).unwrap();
        let secrets = crate::secrets::SecretStore::open(dir.path()).unwrap();
        create_router(
            &db,
            &secrets,
            "router",
            "https://router.hmini.org/v1",
            Some("sk-one"),
        );
        let id = crate::providers::list_providers(&db, &secrets, true).unwrap()[0]
            .id
            .clone();
        let initial = router_row_identity(&db, &secrets, &id).expect("router row");

        // Renaming the row or editing its models must not restart the tunnel.
        update(
            &db,
            &secrets,
            serde_json::json!({ "id": id, "name": "renamed" }),
        );
        update(
            &db,
            &secrets,
            serde_json::json!({ "id": id, "models": [{ "id": "gpt-x" }] }),
        );
        assert_eq!(
            router_row_identity(&db, &secrets, &id).as_ref(),
            Some(&initial)
        );

        update(
            &db,
            &secrets,
            serde_json::json!({ "id": id, "baseUrl": "https://aiapi.hungraim.com/v1" }),
        );
        let moved = router_row_identity(&db, &secrets, &id).expect("router row");
        assert_ne!(moved, initial, "a new endpoint is a new identity");

        crate::providers::set_provider_secret(&db, &secrets, &id, Some("sk-two")).unwrap();
        let rekeyed = router_row_identity(&db, &secrets, &id).expect("router row");
        assert_ne!(rekeyed, moved, "a new key is a new identity");

        update(
            &db,
            &secrets,
            serde_json::json!({ "id": id, "vendorKey": "custom" }),
        );
        assert_eq!(router_row_identity(&db, &secrets, &id), None);
    }
}
