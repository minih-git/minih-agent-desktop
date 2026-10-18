use super::*;
use serde_json::json;

const VALID_PEM: &str = "-----BEGIN CERTIFICATE-----\n\
MIIBkTCB+wIJAJ8Y0V0n8m2fMA0GCSqGSIb3DQEBCwUAMB4xHDAaBgNVBAMME2dh\ndGV3YXkuZXhhbXBsZS5jb20=\n\
-----END CERTIFICATE-----\n";

fn payload(extra: Value) -> Map<String, Value> {
    match extra {
        Value::Object(map) => map,
        _ => unreachable!(),
    }
}

fn valid_object() -> Value {
    json!({
        "hostlink_url": "wss://gateway.example.com:8443/hostlink",
        "public_origin": "https://gateway.example.com",
        "ca_pem": VALID_PEM,
    })
}

#[test]
fn absent_or_null_means_account_mode_is_off() {
    assert_eq!(
        parse_remote_gateway(&payload(json!({}))),
        RemoteGatewayOutcome::Absent
    );
    assert_eq!(
        parse_remote_gateway(&payload(json!({ "remote_gateway": null }))),
        RemoteGatewayOutcome::Absent
    );
}

#[test]
fn both_spellings_are_accepted() {
    let snake = parse_remote_gateway(&payload(json!({ "remote_gateway": valid_object() })));
    let camel = parse_remote_gateway(&payload(json!({
        "remoteGateway": {
            "hostlinkUrl": "wss://gateway.example.com:8443/hostlink",
            "publicOrigin": "https://gateway.example.com",
            "caPem": VALID_PEM,
        }
    })));
    assert_eq!(snake, camel);
    let announced = snake
        .announcement()
        .expect("the object should be announced");
    assert_eq!(
        announced.hostlink_url,
        "wss://gateway.example.com:8443/hostlink"
    );
    assert_eq!(announced.public_origin, "https://gateway.example.com");
}

#[test]
fn malformed_objects_are_reported_not_fatal() {
    let cases: Vec<Value> = vec![
        json!("wss://gateway.example.com"),
        json!({ "hostlink_url": "wss://gateway.example.com" }),
        json!({
            "hostlink_url": "https://gateway.example.com:8443",
            "public_origin": "https://gateway.example.com",
            "ca_pem": VALID_PEM,
        }),
        json!({
            "hostlink_url": "wss://gateway.example.com:8443",
            "public_origin": "http://gateway.example.com",
            "ca_pem": VALID_PEM,
        }),
        json!({
            "hostlink_url": "wss://gateway.example.com:8443",
            "public_origin": "https://gateway.example.com/h5",
            "ca_pem": VALID_PEM,
        }),
        json!({
            "hostlink_url": "wss://gateway.example.com:8443",
            "public_origin": "https://gateway.example.com",
            "ca_pem": "not a certificate",
        }),
        json!({
            "hostlink_url": "wss://gateway.example.com:8443",
            "public_origin": "https://gateway.example.com",
            "ca_pem": "-----BEGIN EC PRIVATE KEY-----\nMIIB\n-----END EC PRIVATE KEY-----\n",
        }),
        json!({
            "hostlink_url": "wss://gateway.example.com:8443",
            "public_origin": "https://gateway.example.com",
            "ca_pem": "-----BEGIN CERTIFICATE-----\nbm90IGRlcg==\n-----END CERTIFICATE-----\n",
        }),
        json!({
            "hostlink_url": format!("wss://gateway.example.com/{}", "a".repeat(MAX_HOSTLINK_URL_LEN)),
            "public_origin": "https://gateway.example.com",
            "ca_pem": VALID_PEM,
        }),
        json!({
            "hostlink_url": "wss://gateway.example.com:8443",
            "public_origin": "https://gateway.example.com",
            "ca_pem": "a".repeat(MAX_CA_PEM_LEN + 1),
        }),
    ];
    for case in cases {
        match parse_remote_gateway(&payload(json!({ "remote_gateway": case }))) {
            RemoteGatewayOutcome::Malformed(reason) => assert!(!reason.is_empty()),
            other => panic!("expected a diagnosable reason, got {other:?}"),
        }
    }
}

#[test]
fn a_certificate_chain_is_accepted() {
    let chain = format!("{VALID_PEM}{VALID_PEM}");
    let parsed = parse_remote_gateway(&payload(json!({
        "remote_gateway": {
            "hostlink_url": "wss://gateway.example.com/hostlink",
            "public_origin": "https://gateway.example.com:8443",
            "ca_pem": chain,
        }
    })));
    assert!(parsed.announcement().is_some());
}

#[test]
fn an_ip_host_is_used_directly() {
    let announcement = RemoteGatewayAnnouncement {
        hostlink_url: "wss://11.123.0.1:8443/hostlink".to_string(),
        public_origin: "https://gateway.example.com".to_string(),
        ca_pem: VALID_PEM.to_string(),
    };
    let target = derive_hostlink_target(&announcement, None).expect("an IP host needs no help");
    assert_eq!(target.dst, "11.123.0.1:8443".parse().expect("addr"));
    assert_eq!(target.tls_server_name, "11.123.0.1");
    assert_eq!(target.path, "/hostlink");
}

#[test]
fn a_domain_host_uses_the_gateways_overlay_address() {
    let announcement = RemoteGatewayAnnouncement {
        hostlink_url: "wss://gateway.example.com/hostlink".to_string(),
        public_origin: "https://gateway.example.com".to_string(),
        ca_pem: VALID_PEM.to_string(),
    };
    // The overlay address comes from the answer, never from a constant.
    let target = derive_hostlink_target(&announcement, Some("11.12.0.1"))
        .expect("the gateway overlay address should be used");
    assert_eq!(target.dst, "11.12.0.1:443".parse().expect("addr"));
    // The service identity stays the name the certificate is issued for.
    assert_eq!(target.tls_server_name, "gateway.example.com");

    let missing = derive_hostlink_target(&announcement, None);
    assert!(
        missing.is_err(),
        "a domain without an overlay address is unusable"
    );
}

#[test]
fn dial_urls_keep_the_path_and_hide_the_default_port() {
    let announcement = RemoteGatewayAnnouncement {
        hostlink_url: "wss://gateway.example.com:8443/hostlink".to_string(),
        public_origin: "https://gateway.example.com".to_string(),
        ca_pem: VALID_PEM.to_string(),
    };
    let target = derive_hostlink_target(&announcement, Some("11.12.0.1")).expect("target");
    let forwarded = RemoteGatewayStatus::available_forwarded(&announcement, &target, 41234);
    assert!(forwarded.available);
    assert_eq!(forwarded.dial_url, "wss://127.0.0.1:41234/hostlink");
    assert_eq!(forwarded.local_forward_port, Some(41234));
    assert_eq!(forwarded.tls_server_name, "gateway.example.com");

    let direct = RemoteGatewayStatus::available_direct(&announcement, &target);
    assert_eq!(direct.dial_url, "wss://11.12.0.1:8443/hostlink");
    assert_eq!(direct.local_forward_port, None);
}

#[test]
fn unavailable_status_carries_no_endpoint() {
    let status =
        RemoteGatewayStatus::unavailable("remoteGateway.hostlinkUrl must use the wss scheme");
    assert!(!status.available);
    assert!(status.hostlink_url.is_empty());
    assert!(status.dial_url.is_empty());
    assert_eq!(status.local_forward_port, None);
    assert!(!status.unavailable_reason.is_empty());
}

fn announced_outcome() -> RemoteGatewayOutcome {
    RemoteGatewayOutcome::Announced(RemoteGatewayAnnouncement {
        hostlink_url: "wss://gateway.example.com:8443/hostlink".to_string(),
        public_origin: "https://gateway.example.com".to_string(),
        ca_pem: VALID_PEM.to_string(),
    })
}

#[test]
fn status_reports_a_disabled_channel_before_anything_else() {
    let status = status_for(
        false,
        Some(&announced_outcome()),
        Some("11.12.0.1"),
        RemoteGatewayReach::Direct,
        "",
    );
    assert!(!status.available);
    assert!(status.unavailable_reason.contains("disabled"));
}

#[test]
fn status_reports_a_malformed_announcement_reason() {
    let outcome = RemoteGatewayOutcome::Malformed(
        "remoteGateway.hostlinkUrl must use the wss scheme".to_string(),
    );
    let status = status_for(
        true,
        Some(&outcome),
        None,
        RemoteGatewayReach::Unavailable,
        "",
    );
    assert!(!status.available);
    assert!(status.unavailable_reason.contains("wss scheme"));
}

#[test]
fn status_reports_the_bootstrap_error_when_nothing_arrived() {
    let status = status_for(
        true,
        None,
        None,
        RemoteGatewayReach::Unavailable,
        "gateway returned HTTP 500",
    );
    assert!(!status.available);
    assert!(status.unavailable_reason.contains("HTTP 500"));
}

#[test]
fn status_maps_forwarded_and_direct_reach() {
    let outcome = announced_outcome();
    let forwarded = status_for(
        true,
        Some(&outcome),
        Some("11.12.0.1"),
        RemoteGatewayReach::Forwarded {
            local_port: Some(41234),
        },
        "",
    );
    assert!(forwarded.available);
    assert_eq!(forwarded.dial_url, "wss://127.0.0.1:41234/hostlink");
    assert_eq!(forwarded.local_forward_port, Some(41234));
    // Certificate validation keeps the advertised name in both modes.
    assert_eq!(forwarded.tls_server_name, "gateway.example.com");

    let direct = status_for(
        true,
        Some(&outcome),
        Some("11.12.0.1"),
        RemoteGatewayReach::Direct,
        "",
    );
    assert!(direct.available);
    assert_eq!(direct.dial_url, "wss://11.12.0.1:8443/hostlink");
    assert_eq!(direct.local_forward_port, None);

    // Announced but not reachable yet: the endpoint still shows.
    let pending = status_for(
        true,
        Some(&outcome),
        Some("11.12.0.1"),
        RemoteGatewayReach::Forwarded { local_port: None },
        "",
    );
    assert!(!pending.available);
    assert!(pending.unavailable_reason.contains("forward"));
    assert_eq!(
        pending.hostlink_url,
        "wss://gateway.example.com:8443/hostlink"
    );
}

#[test]
fn status_is_unavailable_without_an_overlay_address_for_a_domain() {
    let status = status_for(
        true,
        Some(&announced_outcome()),
        None,
        RemoteGatewayReach::Forwarded {
            local_port: Some(41234),
        },
        "",
    );
    assert!(!status.available);
    assert!(status.unavailable_reason.contains("overlay address"));
}

#[test]
fn the_status_serializes_with_the_wire_spelling_the_panel_reads() {
    // The renderer and the Host-link client read these exact camelCase keys;
    // the shared TypeScript contract mirrors them.
    let outcome = announced_outcome();
    let status = status_for(
        true,
        Some(&outcome),
        Some("11.12.0.1"),
        RemoteGatewayReach::Forwarded {
            local_port: Some(41234),
        },
        "",
    );
    let json = serde_json::to_value(&status).expect("status should serialize");
    let mut keys: Vec<String> = json
        .as_object()
        .expect("status serializes as an object")
        .keys()
        .cloned()
        .collect();
    keys.sort();
    assert_eq!(
        keys,
        vec![
            "available",
            "caPem",
            "dialUrl",
            "hostlinkUrl",
            "localForwardPort",
            "publicOrigin",
            "tlsServerName",
            "unavailableReason",
        ]
    );
    assert_eq!(json["tlsServerName"], "gateway.example.com");
    assert_eq!(json["dialUrl"], "wss://127.0.0.1:41234/hostlink");
}
