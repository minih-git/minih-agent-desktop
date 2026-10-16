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

/// Reads the first Minih Router row's address and AccessKey.
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
        let row = rows
            .into_iter()
            .find(|provider| is_minih_router_vendor_key(Some(provider.vendor_key.as_str())))?;
        let base_url = row.base_url.filter(|value| !value.trim().is_empty())?;
        // A row without a key cannot authenticate, so there is nothing to ask.
        let access_key = providers::get_secret_for_provider(&st.db, &st.secrets, &row.id)
            .ok()
            .flatten()
            .filter(|value| !value.trim().is_empty())?;
        Some((base_url, access_key))
    }
}

/// Local copy of the shared predicate, so this module does not depend on the
/// renderer-facing package for one string comparison.
fn is_minih_router_vendor_key(vendor_key: Option<&str>) -> bool {
    vendor_key
        .map(str::trim)
        .is_some_and(|key| key.eq_ignore_ascii_case("minih-router"))
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
}
