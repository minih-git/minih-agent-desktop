//! The loopback ports the Router and Host-link forwards are bound to.
//!
//! Both forwards live on `127.0.0.1` inside this process and cannot share a
//! bind address, so an allocation has to be asked for deliberately: the OS
//! picks the port, a collision is retried instead of failing the start, and a
//! restart asks whether the port the node it replaces held can be kept, since
//! the listener is released before the replacing node binds it.
//!
//! Pure socket bookkeeping: nothing here knows about EasyTier, settings, or the
//! manager state that decides which forward is needed.

use std::net::TcpListener;

pub(super) fn allocate_loopback_port() -> Result<u16, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|e| format!("failed to allocate local port forward socket: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("failed to inspect local port forward socket: {e}"))?
        .port();
    Ok(port)
}

/// Reserve a loopback port that is not already used by another forward.
///
/// The Router forward holds its port for the lifetime of the node, and two
/// forwards cannot share one bind address. The probe listener is released
/// before the node binds it, so a collision is retried instead of failing.
pub(super) fn allocate_loopback_port_excluding(excluded: &[u16]) -> Result<u16, String> {
    const ATTEMPTS: usize = 8;
    for _ in 0..ATTEMPTS {
        let port = allocate_loopback_port()?;
        if !excluded.contains(&port) {
            return Ok(port);
        }
    }
    Err("failed to allocate a distinct loopback port for the Host-link forward".to_string())
}

/// Whether a loopback port can be taken right now.
///
/// A restart wants the ports the replaced node held; the listener is released
/// immediately and the node binds it a moment later.
pub(super) fn loopback_port_is_free(port: u16) -> bool {
    TcpListener::bind(("127.0.0.1", port)).is_ok()
}
