mod crypto;
pub(crate) mod domains;
pub(crate) mod engine;
pub(crate) mod learned_memory;
pub(crate) mod merge;
mod transport;

pub(crate) use crypto::{
    create_vault, decrypt_object, encrypt_object, object_id, rewrap_vault, unlock_vault,
    vault_key_b64, vault_key_from_b64, VaultHeader, VaultKey,
};
pub(crate) use engine::{forget_plugin_intent, sync_locked_state};
pub(crate) use transport::{remote_error_is_offline, RouterConfig, RouterTransport};
