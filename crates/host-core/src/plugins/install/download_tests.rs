use super::*;
use std::net::TcpListener;
use std::sync::mpsc;
use std::thread;
use std::time::Instant;
use tempfile::tempdir;

/// Real curl transfers against loopback; no network service or user profile.
fn server(
    body: Vec<u8>,
    chunks: usize,
    interval: Duration,
    stall: bool,
) -> (String, mpsc::Sender<()>, thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/package.piplug", listener.local_addr().unwrap());
    let (stop, stopped) = mpsc::channel();
    let worker = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        stream
            .set_write_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut request = [0u8; 4096];
        stream.read(&mut request).unwrap();
        write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        )
        .unwrap();
        for chunk in body.chunks(body.len().div_ceil(chunks)) {
            if stream.write_all(chunk).is_err() || stream.flush().is_err() {
                break;
            }
            if stall {
                let _ = stopped.recv_timeout(Duration::from_secs(45));
                break;
            }
            if stopped.recv_timeout(interval).is_ok() {
                break;
            }
        }
    });
    (url, stop, worker)
}

#[derive(Default)]
struct TransferLog {
    received: u64,
    cancel: bool,
}

impl InstallObserver for TransferLog {
    fn progress(&mut self, event: InstallProgress) {
        self.received = event.received_bytes;
    }

    fn cancelled(&self) -> bool {
        self.cancel && self.received > 0
    }
}

#[test]
fn package_transfer_continues_past_thirty_seconds() {
    let expected = vec![b'x'; 33 * 2048];
    let (url, stop, worker) = server(expected.clone(), 33, Duration::from_secs(1), false);
    let mut log = TransferLog::default();
    let begin = Instant::now();
    let result = download_url_observed(
        &url,
        Some(&url),
        expected.len() as u64,
        &mut DownloadReport::new(&mut log, "demo.slow", "1.0.0"),
    );
    let _ = stop.send(());
    worker.join().unwrap();
    assert!(begin.elapsed() >= Duration::from_secs(30));
    assert_eq!(result.unwrap(), expected);
    assert_eq!(log.received, expected.len() as u64);
}

#[test]
fn stalled_package_transfer_remains_bounded() {
    let (url, stop, worker) = server(vec![b'x'; 1024 * 1024], 1024, Duration::ZERO, true);
    let begin = Instant::now();
    let result = download_url_guarded(&url, Some(&url));
    let _ = stop.send(());
    worker.join().unwrap();
    let error = result.unwrap_err().to_string();
    assert!(error.contains("PLUGIN_NETWORK"), "{error}");
    assert!(
        error.contains("slow") || error.contains("timed out"),
        "{error}"
    );
    assert!(begin.elapsed() < Duration::from_secs(40));
}

#[test]
fn an_active_package_transfer_can_be_cancelled() {
    let (url, stop, worker) = server(
        vec![b'x'; 1024 * 1024],
        64,
        Duration::from_millis(200),
        false,
    );
    let mut log = TransferLog {
        cancel: true,
        ..Default::default()
    };
    let begin = Instant::now();
    let result = download_url_observed(
        &url,
        Some(&url),
        1024 * 1024,
        &mut DownloadReport::new(&mut log, "demo.cancel", "1.0.0"),
    );
    let _ = stop.send(());
    worker.join().unwrap();
    let error = result.unwrap_err().to_string();
    assert!(error.contains("PLUGIN_CANCELLED"), "{error}");
    assert!(begin.elapsed() < Duration::from_secs(5));
}

#[test]
fn size_and_hash_still_gate_the_download_cache() {
    let dir = tempdir().unwrap();
    let manager = PluginManager {
        data_dir: dir.path().to_path_buf(),
        runtime: Vec::new(),
        bundled_ids: Default::default(),
        market_channel: MarketChannel::Official,
        install_cancel: None,
        locale: "en".into(),
    };
    let package = dir.path().join("package.piplug");
    fs::write(&package, b"actual package bytes").unwrap();
    let info = MarketDownloadInfo {
        plugin_id: "demo.integrity".into(),
        version: "1.0.0".into(),
        url: format!("file://{}", package.display()),
        size_bytes: b"actual package bytes".len() as u64,
        shasum: "0".repeat(64),
        signature: None,
        signature_alg: None,
        published_at: String::new(),
        permissions: Vec::new(),
        changelog: None,
        provenance: None,
        trust: None,
        publisher_id: None,
    };
    for size in [1, info.size_bytes] {
        let mut observer = NoProgress;
        let error = manager
            .download_market_package(
                &info,
                &info.url,
                &info.shasum,
                size,
                &mut DownloadReport::new(&mut observer, &info.plugin_id, &info.version),
            )
            .unwrap_err()
            .to_string();
        assert!(error.contains("PLUGIN_INTEGRITY"), "{error}");
        if size == info.size_bytes {
            assert!(error.contains("checksum mismatch"), "{error}");
        }
        assert!(
            !dir.path()
                .join("plugins/cache/download/demo.integrity-1.0.0.piplug")
                .exists()
        );
    }
}
