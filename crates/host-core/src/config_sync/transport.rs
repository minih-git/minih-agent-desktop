use anyhow::{anyhow, bail, Result};
use reqwest::header::{HeaderMap, HeaderValue, ETAG, IF_MATCH, IF_NONE_MATCH};
use reqwest::{Client, Method, StatusCode, Url};
use std::net::IpAddr;
use std::time::Duration;

#[cfg(test)]
#[path = "transport_tests.rs"]
pub(crate) mod tests;

const MAX_REMOTE_OBJECT_BYTES: usize = 64 * 1024 * 1024;

// Deliberately not Debug: the bearer credential must never enter logs.
pub struct RouterConfig {
    /// Minih Router control-plane root, e.g. `https://router.hmini.org`.
    /// A `/v1` data-plane suffix is not allowed here; `connection::control_root`
    /// strips it before a transport is built.
    pub root: String,
    pub access_key: String,
    pub allow_insecure_http: bool,
}

#[derive(Debug, Clone)]
pub struct ProbeResult {
    pub conditional_writes: bool,
}

pub struct RouterTransport {
    client: Client,
    base: Url,
    authorization: HeaderValue,
}

fn safe_path(value: &str) -> Result<()> {
    if value.is_empty() || value.len() > 1024 {
        bail!("CONFIG_SYNC_INVALID: invalid backup object path length");
    }
    for segment in value.split('/') {
        if segment.is_empty()
            || matches!(segment, "." | "..")
            || !segment
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"-_.~ ".contains(&c))
        {
            bail!("CONFIG_SYNC_INVALID: unsafe backup object path");
        }
    }
    Ok(())
}

fn is_lan_http_host(host: &str) -> bool {
    let host = host
        .trim_matches(['[', ']'])
        .trim_end_matches('.')
        .to_ascii_lowercase();
    if matches!(host.as_str(), "localhost" | "localhost.localdomain") || host.ends_with(".local") {
        return true;
    }
    match host.parse::<IpAddr>() {
        Ok(IpAddr::V4(ip)) => ip.is_loopback() || ip.is_private() || ip.is_link_local(),
        Ok(IpAddr::V6(ip)) => {
            ip.is_loopback() || ip.is_unique_local() || ip.is_unicast_link_local()
        }
        Err(_) => false,
    }
}

fn validate_root(raw: &str, allow_insecure_http: bool) -> Result<Url> {
    let url =
        Url::parse(raw.trim()).map_err(|_| anyhow!("CONFIG_SYNC_INVALID: invalid router root"))?;
    if !matches!(url.scheme(), "https" | "http")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        bail!(
            "CONFIG_SYNC_INVALID: router root must be an HTTP(S) URL without userinfo, query or fragment"
        );
    }
    if url.scheme() == "http"
        && (!allow_insecure_http || !is_lan_http_host(url.host_str().unwrap_or_default()))
    {
        bail!(
            "CONFIG_SYNC_INVALID: HTTP requires relaxed network policy and a private LAN endpoint"
        );
    }
    Ok(url)
}

impl RouterTransport {
    pub fn new(config: &RouterConfig) -> Result<Self> {
        let base = validate_root(&config.root, config.allow_insecure_http)?;
        let key = config.access_key.trim();
        if key.is_empty() || key.len() > 4096 {
            bail!("CONFIG_SYNC_INVALID: Minih Router access key is missing or too long");
        }
        let authorization = HeaderValue::from_str(&format!("Bearer {key}")).map_err(|_| {
            anyhow!("CONFIG_SYNC_INVALID: Minih Router access key is not a header value")
        })?;
        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(60))
            .build()
            .map_err(|_| anyhow!("CONFIG_SYNC_NETWORK: could not create router client"))?;
        Ok(Self {
            client,
            base,
            authorization,
        })
    }

    /// `{root}/api/client-backup/objects/{relative}` with spaces percent-encoded.
    fn object_url(&self, relative: &str) -> Result<Url> {
        safe_path(relative)?;
        let base_path = self.base.path().trim_end_matches('/');
        let mut url = self.base.clone();
        url.set_path(&format!(
            "{base_path}/api/client-backup/objects/{}",
            relative.replace(' ', "%20")
        ));
        url.set_query(None);
        Ok(url)
    }

    async fn send(
        &self,
        method: Method,
        url: Url,
        body: Vec<u8>,
        mut headers: HeaderMap,
    ) -> Result<reqwest::Response> {
        if body.len() > MAX_REMOTE_OBJECT_BYTES {
            bail!("CONFIG_SYNC_LIMIT_EXCEEDED: backup object is too large");
        }
        headers.insert(reqwest::header::AUTHORIZATION, self.authorization.clone());
        let response = self
            .client
            .request(method, url)
            .headers(headers)
            .body(body)
            .send()
            .await
            .map_err(request_error)?;
        if response.status().is_redirection() {
            bail!("CONFIG_SYNC_REDIRECT: use the direct Minih Router address; redirects are not followed");
        }
        Ok(response)
    }

    async fn limited_bytes(mut response: reqwest::Response) -> Result<Vec<u8>> {
        if response
            .content_length()
            .is_some_and(|size| size > MAX_REMOTE_OBJECT_BYTES as u64)
        {
            bail!("CONFIG_SYNC_LIMIT_EXCEEDED: remote object is too large");
        }
        let mut result = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(request_error)? {
            if result.len().saturating_add(chunk.len()) > MAX_REMOTE_OBJECT_BYTES {
                bail!("CONFIG_SYNC_LIMIT_EXCEEDED: remote object is too large");
            }
            result.extend_from_slice(&chunk);
        }
        Ok(result)
    }

    pub async fn get(&self, relative: &str) -> Result<Option<(Vec<u8>, Option<String>)>> {
        let response = self
            .send(
                Method::GET,
                self.object_url(relative)?,
                Vec::new(),
                HeaderMap::new(),
            )
            .await?;
        if response.status() == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if response.status() != StatusCode::OK {
            return Err(response_error("read", response).await);
        }
        let etag = response
            .headers()
            .get(ETAG)
            .and_then(|value| value.to_str().ok())
            .filter(|value| valid_etag(value))
            .map(str::to_string);
        Ok(Some((Self::limited_bytes(response).await?, etag)))
    }

    async fn conditional_put(
        &self,
        relative: &str,
        body: Vec<u8>,
        headers: HeaderMap,
    ) -> Result<bool> {
        let response = self
            .send(Method::PUT, self.object_url(relative)?, body, headers)
            .await?;
        match response.status() {
            StatusCode::PRECONDITION_FAILED | StatusCode::CONFLICT => Ok(false),
            status if status.is_success() => Ok(true),
            _ => Err(response_error("write", response).await),
        }
    }

    pub async fn put_if_none(&self, relative: &str, body: Vec<u8>) -> Result<bool> {
        let mut headers = HeaderMap::new();
        headers.insert(IF_NONE_MATCH, HeaderValue::from_static("*"));
        self.conditional_put(relative, body, headers).await
    }

    pub async fn put_if_match(&self, relative: &str, etag: &str, body: Vec<u8>) -> Result<bool> {
        if !valid_etag(etag) {
            bail!("CONFIG_SYNC_INVALID: a strong backup ETag is required");
        }
        let mut headers = HeaderMap::new();
        headers.insert(
            IF_MATCH,
            HeaderValue::from_str(etag)
                .map_err(|_| anyhow!("CONFIG_SYNC_INVALID: invalid backup ETag"))?,
        );
        self.conditional_put(relative, body, headers).await
    }

    /// The router backend proves its conditional-write contract itself; this
    /// request only asks it to run that self-test for this account.
    pub async fn probe(&self) -> Result<ProbeResult> {
        let base_path = self.base.path().trim_end_matches('/');
        let mut url = self.base.clone();
        url.set_path(&format!("{base_path}/api/client-backup/probe"));
        url.set_query(None);
        let response = self
            .send(Method::POST, url, Vec::new(), HeaderMap::new())
            .await?;
        if response.status() != StatusCode::OK {
            return Err(response_error("probe", response).await);
        }
        let body: serde_json::Value = serde_json::from_slice(&Self::limited_bytes(response).await?)
            .map_err(|_| anyhow!("CONFIG_SYNC_REMOTE: router probe returned a malformed body"))?;
        if body.get("code") != Some(&serde_json::json!(0)) {
            bail!("CONFIG_SYNC_REMOTE: router probe was rejected");
        }
        let conditional_writes = body
            .get("data")
            .and_then(|data| data.get("conditionalWrites"))
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false);
        Ok(ProbeResult { conditional_writes })
    }
}

fn valid_etag(value: &str) -> bool {
    value.len() >= 3
        && value.len() <= 256
        && value.starts_with('"')
        && value.ends_with('"')
        && value[1..value.len() - 1]
            .bytes()
            .all(|c| c.is_ascii_graphic() && c != b'"')
}

fn request_error(error: reqwest::Error) -> anyhow::Error {
    if error.is_timeout() {
        anyhow!("CONFIG_SYNC_TIMEOUT: Minih Router request timed out")
    } else {
        anyhow!("CONFIG_SYNC_NETWORK: Minih Router could not be reached; check the network and TLS certificate")
    }
}

// The error body is operator-controlled text and may echo request material;
// never include it. Only the mapped status code is reported.
async fn response_error(operation: &str, mut response: reqwest::Response) -> anyhow::Error {
    let _ = response.chunk().await;
    status_error(operation, response.status())
}

fn status_error(operation: &str, status: StatusCode) -> anyhow::Error {
    let code = match status.as_u16() {
        401 => "AUTH",
        403 => "PERMISSION",
        404 => "NOT_FOUND",
        409 => "CONFLICT",
        413 | 507 => "QUOTA",
        429 => "RATE_LIMIT",
        500..=599 => "SERVER",
        _ => "REMOTE",
    };
    anyhow!(
        "CONFIG_SYNC_{code}: Minih Router {operation} returned HTTP {}",
        status.as_u16()
    )
}

pub fn remote_error_is_offline(error: &anyhow::Error) -> bool {
    let text = error.to_string();
    [
        "CONFIG_SYNC_NETWORK:",
        "CONFIG_SYNC_TIMEOUT:",
        "CONFIG_SYNC_SERVER:",
        "CONFIG_SYNC_RATE_LIMIT:",
    ]
    .iter()
    .any(|prefix| text.starts_with(prefix))
}
