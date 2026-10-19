//! Whether a start may proceed, and with which identity.
//!
//! Two modes, one decision point:
//!
//! - **gateway** (default) — the Router's bootstrap answer *is* the identity.
//!   Without an answer the tunnel stays down and the caller reports why; the
//!   public endpoint keeps serving requests in the meantime. There is no
//!   built-in network to fall back on, because a shared key in a public source
//!   tree is a published key.
//! - **manual** — a developer typed the network parameters for a gateway that
//!   does not serve the bootstrap endpoint. The typed secret is required; the
//!   brand defaults never stand in for it.
//!
//! Kept as a pure function of (saved settings, last bootstrap attempt) so the
//! decision is testable without an HTTP server, a database, or a real node.

use super::bootstrap::{apply_bootstrap, BootstrapResponse};
use super::config::{EasyTierIdentity, EasyTierSettings};

/// Fallback wording when the gateway gave no more specific reason.
const NO_GATEWAY_ANSWER: &str = "no network identity was issued by the gateway";
/// Manual mode without a secret: nothing can be typed in its place.
const MANUAL_SECRET_MISSING: &str = "manual network identity needs a network secret";

/// What a start should do next.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    /// Start the tunnel with these effective settings.
    Start(EasyTierSettings),
    /// Keep the tunnel down; the reason is what the panel shows.
    Hold(String),
}

/// Decide whether to start, and with which settings.
///
/// `answer` is the last successful bootstrap, `reason` the explanation of the
/// last failed one; both are `None` before the first attempt.
pub fn decide(
    settings: &EasyTierSettings,
    answer: Option<&BootstrapResponse>,
    reason: Option<&str>,
) -> Decision {
    match settings.identity {
        EasyTierIdentity::Manual => decide_manual(settings),
        EasyTierIdentity::Gateway => match answer {
            Some(response) => {
                let mut effective = settings.clone();
                apply_bootstrap(&mut effective, response);
                Decision::Start(effective)
            }
            None => Decision::Hold(
                reason
                    .map(str::trim)
                    .filter(|text| !text.is_empty())
                    .unwrap_or(NO_GATEWAY_ANSWER)
                    .to_string(),
            ),
        },
    }
}

/// Manual mode trusts exactly what the user typed.
///
/// Nothing is filled in here: a name, a peer list or a Router address the user
/// left blank is the user's choice, and the only hard requirement is a secret,
/// because an empty one cannot join any mesh.
fn decide_manual(settings: &EasyTierSettings) -> Decision {
    if settings.network_secret.trim().is_empty() {
        return Decision::Hold(MANUAL_SECRET_MISSING.to_string());
    }
    Decision::Start(settings.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::easytier_net::config::{EasyTierIdentity, EasyTierMode};

    fn settings(identity: EasyTierIdentity) -> EasyTierSettings {
        EasyTierSettings {
            enabled: true,
            mode: EasyTierMode::NoTun,
            identity,
            network_name: "local-net".into(),
            network_secret: String::new(),
            peers: vec!["udp://local:11012".into()],
            router_lan_url: "http://10.144.144.99:3001/v1".into(),
            dhcp: true,
            ipv4: None,
        }
    }

    fn answer() -> BootstrapResponse {
        BootstrapResponse {
            network_name: "gateway-issued".into(),
            network_secret: "gateway-secret".into(),
            gateway_virtual_ipv4: Some("11.11.11.10".into()),
            router_lan_url: Some("http://11.11.11.10:3001/v1".into()),
            peers: Some(vec!["udp://router.hmini.org:11012".into()]),
            ttl_seconds: None,
            remote_gateway: crate::easytier_net::remote_gateway::RemoteGatewayOutcome::Absent,
        }
    }

    #[test]
    fn gateway_mode_starts_with_the_issued_identity() {
        let effective = match decide(&settings(EasyTierIdentity::Gateway), Some(&answer()), None) {
            Decision::Start(effective) => effective,
            Decision::Hold(reason) => panic!("a gateway answer must start the tunnel: {reason}"),
        };
        assert_eq!(effective.network_name, "gateway-issued");
        assert_eq!(effective.network_secret, "gateway-secret");
        assert_eq!(effective.router_lan_url, "http://11.11.11.10:3001/v1");
        assert_eq!(effective.peers, vec!["udp://router.hmini.org:11012"]);
    }

    #[test]
    fn gateway_mode_holds_without_an_answer() {
        let decision = decide(
            &settings(EasyTierIdentity::Gateway),
            None,
            Some("bootstrap request failed: connection refused"),
        );
        assert_eq!(
            decision,
            Decision::Hold("bootstrap request failed: connection refused".to_string())
        );
        // Even a local secret the user once typed cannot stand in for an answer.
        let mut local = settings(EasyTierIdentity::Gateway);
        local.network_secret = "typed-earlier".into();
        assert!(matches!(decide(&local, None, None), Decision::Hold(_)));
        assert_eq!(
            decide(&local, None, None),
            Decision::Hold(NO_GATEWAY_ANSWER.to_string())
        );
    }

    #[test]
    fn manual_mode_needs_a_secret() {
        assert_eq!(
            decide(&settings(EasyTierIdentity::Manual), None, None),
            Decision::Hold(MANUAL_SECRET_MISSING.to_string())
        );
        // Blank is as unusable as absent.
        let mut blank = settings(EasyTierIdentity::Manual);
        blank.network_secret = "   ".into();
        assert!(matches!(decide(&blank, None, None), Decision::Hold(_)));
    }

    #[test]
    fn manual_mode_starts_without_a_gateway() {
        let mut manual = settings(EasyTierIdentity::Manual);
        manual.network_secret = "typed-by-user".into();
        // No answer and no credential source: manual is the one supported way to
        // start a tunnel a gateway never described.
        let effective = match decide(&manual, None, Some("no Router credential")) {
            Decision::Start(effective) => effective,
            Decision::Hold(reason) => panic!("manual mode must start: {reason}"),
        };
        assert_eq!(effective, manual);
        assert_eq!(effective.identity, EasyTierIdentity::Manual);
    }

    #[test]
    fn manual_mode_ignores_a_stray_gateway_answer() {
        // A gateway answer must not rewrite what a developer typed: switching the
        // row's endpoint would otherwise silently change the joined network.
        let mut manual = settings(EasyTierIdentity::Manual);
        manual.network_secret = "typed-by-user".into();
        let effective = match decide(&manual, Some(&answer()), None) {
            Decision::Start(effective) => effective,
            Decision::Hold(reason) => panic!("manual mode must start: {reason}"),
        };
        assert_eq!(effective.network_name, "local-net");
        assert_eq!(effective.network_secret, "typed-by-user");
    }
}
