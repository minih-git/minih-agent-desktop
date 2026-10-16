use super::*;
use reqwest::header::{AUTHORIZATION, IF_MATCH, IF_NONE_MATCH};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

const FIXTURE_KEY: &str = "fixture-access-key";

#[derive(Default)]
struct FixtureState {
    // Object name (path after /api/client-backup/objects/) -> (body, strong etag).
    objects: HashMap<String, (Vec<u8>, String)>,
    weak_etag: bool,
    ignore_preconditions: bool,
    read_status: Option<u16>,
    fail_next_read: bool,
    reject_auth: bool,
}

pub(crate) struct Fixture {
    pub(crate) endpoint: String,
    pub(crate) task: tokio::task::JoinHandle<()>,
    state: Arc<Mutex<FixtureState>>,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn read_request(stream: &mut TcpStream) -> Option<(Method, String, HeaderMap, Vec<u8>)> {
    let mut buffer = Vec::new();
    let header_end;
    loop {
        let mut chunk = [0u8; 4096];
        let read = stream.read(&mut chunk).await.ok()?;
        if read == 0 {
            return None;
        }
        buffer.extend_from_slice(&chunk[..read]);
        if let Some(index) = buffer.windows(4).position(|v| v == b"\r\n\r\n") {
            header_end = index + 4;
            break;
        }
        if buffer.len() > 1024 * 1024 {
            return None;
        }
    }
    let text = String::from_utf8_lossy(&buffer[..header_end]).into_owned();
    let mut lines = text.split("\r\n");
    let mut request = lines.next()?.split_whitespace();
    let method = Method::from_bytes(request.next()?.as_bytes()).ok()?;
    let path = request.next()?.to_string();
    let mut headers = HeaderMap::new();
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            headers.insert(
                reqwest::header::HeaderName::from_bytes(name.as_bytes()).ok()?,
                HeaderValue::from_str(value.trim()).ok()?,
            );
        }
    }
    let length = headers
        .get("content-length")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(0);
    if length > MAX_REMOTE_OBJECT_BYTES {
        return None;
    }
    while buffer.len() < header_end + length {
        let mut chunk = [0u8; 4096];
        let read = stream.read(&mut chunk).await.ok()?;
        if read == 0 {
            return None;
        }
        buffer.extend_from_slice(&chunk[..read]);
    }
    Some((
        method,
        path,
        headers,
        buffer[header_end..header_end + length].to_vec(),
    ))
}

// A strong, opaque etag that changes with every write, like the router.
fn etag_for(name: &str, version: u64, body: &[u8]) -> String {
    let digest = Sha256::digest(format!("{name}:{version}").as_bytes());
    let _ = body;
    format!("\"{}-{version}\"", hex::encode(&digest[..8]))
}

async fn handle(mut stream: TcpStream, state: Arc<Mutex<FixtureState>>) {
    let Some((method, path, headers, body)) = read_request(&mut stream).await else {
        return;
    };
    let authorized = !state.lock().unwrap().reject_auth
        && headers.get(AUTHORIZATION).and_then(|v| v.to_str().ok())
            == Some(&format!("Bearer {FIXTURE_KEY}"));
    let (status, response, etag) = {
        let mut state = state.lock().unwrap();
        if !authorized {
            (401, b"fixture auth text must not escape".to_vec(), None)
        } else if path == "/api/client-backup/probe" {
            let conditional_writes = !state.ignore_preconditions;
            (
                200,
                serde_json::to_vec(&serde_json::json!({
                    "code": 0,
                    "data": {"conditionalWrites": conditional_writes}
                }))
                .unwrap(),
                None,
            )
        } else if let Some(name) = path.strip_prefix("/api/client-backup/objects/") {
            if method == Method::GET && state.fail_next_read {
                state.fail_next_read = false;
                (503, Vec::new(), None)
            } else {
                match method {
                    Method::GET => {
                        if let Some(status) = state.read_status {
                            (status, Vec::new(), None)
                        } else if let Some((body, etag)) = state.objects.get(name) {
                            let tag = if state.weak_etag {
                                format!("W/{etag}")
                            } else {
                                etag.clone()
                            };
                            (200, body.clone(), Some(tag))
                        } else {
                            (404, Vec::new(), None)
                        }
                    }
                    Method::PUT => {
                        let existing = state.objects.get(name);
                        let conflict = (headers.contains_key(IF_NONE_MATCH) && existing.is_some())
                            || headers.get(IF_MATCH).is_some_and(|value| {
                                existing.is_none_or(|(_, tag)| value != tag.as_str())
                            });
                        if conflict && !state.ignore_preconditions {
                            (412, Vec::new(), None)
                        } else {
                            let version = existing.map_or(1, |(_, tag)| {
                                tag.trim_matches('"')
                                    .rsplit('-')
                                    .next()
                                    .and_then(|v| v.parse::<u64>().ok())
                                    .unwrap_or(1)
                                    + 1
                            });
                            let etag = etag_for(name, version, &body);
                            state.objects.insert(name.to_string(), (body, etag.clone()));
                            (201, Vec::new(), Some(etag))
                        }
                    }
                    _ => (405, Vec::new(), None),
                }
            }
        } else {
            (404, Vec::new(), None)
        }
    };
    let mut response_headers = format!(
        "HTTP/1.1 {status} Fixture\r\nContent-Length: {}\r\nConnection: close\r\n",
        response.len()
    );
    if let Some(etag) = etag {
        response_headers.push_str(&format!("ETag: {etag}\r\n"));
    }
    if status == 307 {
        response_headers.push_str("Location: http://127.0.0.1:1/must-not-follow\r\n");
    }
    response_headers.push_str("\r\n");
    stream.write_all(response_headers.as_bytes()).await.unwrap();
    stream.write_all(&response).await.unwrap();
}

pub(crate) async fn fixture(weak_etag: bool) -> Fixture {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let state = Arc::new(Mutex::new(FixtureState {
        weak_etag,
        ..Default::default()
    }));
    let serving_state = state.clone();
    let task = tokio::spawn(async move {
        let mut requests = tokio::task::JoinSet::new();
        loop {
            tokio::select! {
                result = listener.accept() => {
                    let (stream, _) = result.unwrap();
                    requests.spawn(handle(stream, serving_state.clone()));
                }
                result = requests.join_next(), if !requests.is_empty() => { result.unwrap().unwrap(); }
            }
        }
    });
    Fixture {
        endpoint,
        task,
        state,
    }
}

pub(crate) async fn fixture_ignoring_preconditions() -> Fixture {
    let fixture = fixture(false).await;
    fixture.state.lock().unwrap().ignore_preconditions = true;
    fixture
}

fn config(endpoint: &str) -> RouterConfig {
    RouterConfig {
        root: endpoint.into(),
        access_key: FIXTURE_KEY.into(),
        allow_insecure_http: true,
    }
}

#[tokio::test]
async fn probe_reports_router_self_test_result() -> Result<()> {
    let fixture = fixture(false).await;
    let transport = RouterTransport::new(&config(&fixture.endpoint))?;
    assert!(transport.probe().await?.conditional_writes);
    let broken = fixture_ignoring_preconditions().await;
    let transport = RouterTransport::new(&config(&broken.endpoint))?;
    assert!(!transport.probe().await?.conditional_writes);
    Ok(())
}

#[tokio::test]
async fn objects_round_trip_with_strong_etags() -> Result<()> {
    let fixture = fixture(false).await;
    let transport = RouterTransport::new(&config(&fixture.endpoint))?;
    assert!(transport.get("vault/v1/head").await?.is_none());
    assert!(
        transport
            .put_if_none("vault/v1/head", b"one".to_vec())
            .await?
    );
    let (body, etag) = transport.get("vault/v1/head").await?.expect("object");
    assert_eq!(body, b"one");
    let etag = etag.expect("strong etag");
    assert!(
        transport
            .put_if_match("vault/v1/head", &etag, b"two".to_vec())
            .await?
    );
    // Stale etag must not replace the object.
    assert!(
        !transport
            .put_if_match("vault/v1/head", &etag, b"stale".to_vec())
            .await?
    );
    // Create-only writes never replace an existing object.
    assert!(
        !transport
            .put_if_none("vault/v1/head", b"must-not-replace".to_vec())
            .await?
    );
    let (body, new_etag) = transport.get("vault/v1/head").await?.expect("object");
    assert_eq!(body, b"two");
    assert_ne!(etag, new_etag.expect("strong etag"));
    Ok(())
}

#[tokio::test]
async fn weak_etags_are_ignored() -> Result<()> {
    let fixture = fixture(true).await;
    let transport = RouterTransport::new(&config(&fixture.endpoint))?;
    assert!(
        transport
            .put_if_none("vault/v1/head", b"one".to_vec())
            .await?
    );
    let (_, etag) = transport.get("vault/v1/head").await?.expect("object");
    assert!(
        etag.is_none(),
        "weak etags must not be used as preconditions"
    );
    Ok(())
}

#[tokio::test]
async fn unsafe_object_paths_are_rejected_locally() -> Result<()> {
    let fixture = fixture(false).await;
    let transport = RouterTransport::new(&config(&fixture.endpoint))?;
    for name in [
        "",
        "../escape",
        "vault//head",
        "vault/./head",
        "vault/../head",
    ] {
        assert!(
            transport.get(name).await.is_err(),
            "{name} must be rejected"
        );
        assert!(transport.put_if_none(name, Vec::new()).await.is_err());
    }
    Ok(())
}

#[tokio::test]
async fn http_root_requires_relaxed_policy_and_lan_host() -> Result<()> {
    let public_http = RouterConfig {
        root: "http://router.example.test".into(),
        access_key: FIXTURE_KEY.into(),
        allow_insecure_http: true,
    };
    assert!(RouterTransport::new(&public_http).is_err());
    let https = RouterConfig {
        root: "https://router.example.test".into(),
        access_key: FIXTURE_KEY.into(),
        allow_insecure_http: false,
    };
    assert!(RouterTransport::new(&https).is_ok());
    Ok(())
}

#[tokio::test]
async fn redirects_are_not_followed() -> Result<()> {
    let fixture = fixture(false).await;
    fixture.state.lock().unwrap().read_status = Some(307);
    let transport = RouterTransport::new(&config(&fixture.endpoint))?;
    let error = transport.get("vault/v1/head").await.unwrap_err();
    assert!(error.to_string().starts_with("CONFIG_SYNC_REDIRECT:"));
    Ok(())
}

#[tokio::test]
async fn auth_errors_map_to_fixed_messages_without_body_text() -> Result<()> {
    let fixture = fixture(false).await;
    fixture.state.lock().unwrap().reject_auth = true;
    let transport = RouterTransport::new(&config(&fixture.endpoint))?;
    let error = transport.get("vault/v1/head").await.unwrap_err();
    let text = error.to_string();
    assert!(text.starts_with("CONFIG_SYNC_AUTH:"), "{text}");
    assert!(!text.contains("fixture auth text"), "{text}");
    Ok(())
}

#[tokio::test]
async fn network_failures_map_to_offline_errors() -> Result<()> {
    let transport = RouterTransport::new(&RouterConfig {
        root: "http://127.0.0.1:9".into(),
        access_key: FIXTURE_KEY.into(),
        allow_insecure_http: true,
    })?;
    let error = transport.get("vault/v1/head").await.unwrap_err();
    assert!(error.to_string().starts_with("CONFIG_SYNC_NETWORK:"));
    assert!(remote_error_is_offline(&error));
    Ok(())
}
