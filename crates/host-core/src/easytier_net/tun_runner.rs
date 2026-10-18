use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use easytier::instance::factory::{create_native_instance, NativeCoreInstance};
use serde::{Deserialize, Serialize};

use super::config::{build_toml_config, EasyTierConnectionState, EasyTierSettings};
use super::EasyTierPeerSummary;

pub const INTERNAL_EASYTIER_TUN_RUNNER_FLAG: &str = "--easytier-tun-runner";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TunRunnerSpec {
    pub settings: EasyTierSettings,
    pub local_forward_port: u16,
    pub status_path: PathBuf,
    pub control_path: PathBuf,
    pub parent_pid: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TunRunnerStatusSnapshot {
    pub pid: u32,
    pub state: EasyTierConnectionState,
    pub virtual_ipv4: Option<String>,
    pub hostname: Option<String>,
    pub local_forward_port: u16,
    pub peers: Vec<EasyTierPeerSummary>,
    pub last_error: Option<String>,
    pub updated_at_ms: u64,
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn is_current_process_elevated() -> bool {
    #[cfg(unix)]
    {
        // SAFETY: geteuid is a thread-safe POSIX syscall with no preconditions.
        unsafe { libc::geteuid() == 0 }
    }
    #[cfg(windows)]
    {
        std::process::Command::new("net")
            .arg("session")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    }
}

fn is_process_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    #[cfg(unix)]
    {
        // SAFETY: kill with signal 0 only checks process existence/permission.
        let rc = unsafe { libc::kill(pid as i32, 0) };
        if rc == 0 {
            return true;
        }
        std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }
    #[cfg(windows)]
    {
        let _ = pid;
        true
    }
}

pub async fn collect_instance_snapshot(
    instance: &NativeCoreInstance,
) -> (
    Option<String>,
    Option<String>,
    Vec<EasyTierPeerSummary>,
    Option<String>,
) {
    let node = instance.node_snapshot().await;
    let virtual_ipv4 = node.ipv4_addr.map(|ip| ip.to_string());
    let hostname = (!node.hostname.trim().is_empty()).then_some(node.hostname);
    let routes = instance.route_snapshots().await;
    let peers = instance.peer_snapshots().await;

    let mut summaries = Vec::with_capacity(peers.len());
    for peer in peers {
        let route = routes.iter().find(|r| r.peer_id == peer.peer_id);
        let ipv4 = route.and_then(|r| r.ipv4_addr).map(|addr| addr.to_string());
        let peer_hostname = route
            .map(|r| r.hostname.clone())
            .filter(|h| !h.trim().is_empty())
            .unwrap_or_else(|| format!("peer-{}", peer.peer_id));
        let cost = match route.map(|r| r.cost) {
            Some(1) => "p2p".to_string(),
            Some(c) if c > 1 => format!("relay({c})"),
            _ => "direct".to_string(),
        };
        let conn = peer.conns.first();
        let tunnel_proto = conn
            .and_then(|c| c.tunnel.as_ref())
            .map(|t| t.tunnel_type.clone())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "udp".to_string());
        let loss_rate = conn.map(|c| c.loss_rate);
        let rx_bytes = conn
            .and_then(|c| c.stats.as_ref())
            .map(|s| s.rx_bytes)
            .unwrap_or(0);
        let tx_bytes = conn
            .and_then(|c| c.stats.as_ref())
            .map(|s| s.tx_bytes)
            .unwrap_or(0);
        summaries.push(EasyTierPeerSummary {
            peer_id: peer.peer_id,
            ipv4,
            hostname: peer_hostname,
            cost,
            tunnel_proto,
            loss_rate,
            rx_bytes,
            tx_bytes,
        });
    }

    (virtual_ipv4, hostname, summaries, instance.latest_error())
}

fn write_status_snapshot(path: &Path, snapshot: &TunRunnerStatusSnapshot) {
    if let Ok(serialized) = serde_json::to_vec(snapshot) {
        let tmp_path = path.with_extension("json.tmp");
        if std::fs::write(&tmp_path, serialized).is_ok() {
            let _ = std::fs::rename(&tmp_path, path);
        }
    }
}

pub async fn run_internal_tun_runner() -> Result<i32> {
    let args: Vec<String> = std::env::args().collect();
    let flag_pos = args
        .iter()
        .position(|arg| arg == INTERNAL_EASYTIER_TUN_RUNNER_FLAG)
        .context("missing --easytier-tun-runner flag")?;
    let spec_path = args
        .get(flag_pos + 1)
        .map(PathBuf::from)
        .context("missing TunRunnerSpec path")?;

    let spec_raw = std::fs::read_to_string(&spec_path)
        .with_context(|| format!("failed to read {}", spec_path.display()))?;
    let spec: TunRunnerSpec =
        serde_json::from_str(&spec_raw).context("invalid TunRunnerSpec JSON")?;

    let toml_config = build_toml_config(&spec.settings, false, Some(spec.local_forward_port), None)
        .map_err(anyhow::Error::msg)?;
    let instance = match create_native_instance(toml_config) {
        Ok(inst) => inst,
        Err(error) => {
            write_status_snapshot(
                &spec.status_path,
                &TunRunnerStatusSnapshot {
                    pid: std::process::id(),
                    state: EasyTierConnectionState::Error,
                    virtual_ipv4: None,
                    hostname: None,
                    local_forward_port: spec.local_forward_port,
                    peers: Vec::new(),
                    last_error: Some(format!("failed to create TUN instance: {error}")),
                    updated_at_ms: now_ms(),
                },
            );
            return Ok(1);
        }
    };

    if let Err(error) = instance.start().await {
        write_status_snapshot(
            &spec.status_path,
            &TunRunnerStatusSnapshot {
                pid: std::process::id(),
                state: EasyTierConnectionState::Error,
                virtual_ipv4: None,
                hostname: None,
                local_forward_port: spec.local_forward_port,
                peers: Vec::new(),
                last_error: Some(format!("failed to start TUN instance: {error}")),
                updated_at_ms: now_ms(),
            },
        );
        return Ok(1);
    }

    while spec.control_path.exists() && is_process_alive(spec.parent_pid) {
        let (virtual_ipv4, hostname, peers, last_error) =
            collect_instance_snapshot(&instance).await;
        let state = if last_error.is_some() && !instance.is_ready() {
            EasyTierConnectionState::Error
        } else if !peers.is_empty() || virtual_ipv4.is_some() {
            EasyTierConnectionState::Connected
        } else {
            EasyTierConnectionState::Connecting
        };
        write_status_snapshot(
            &spec.status_path,
            &TunRunnerStatusSnapshot {
                pid: std::process::id(),
                state,
                virtual_ipv4,
                hostname,
                local_forward_port: spec.local_forward_port,
                peers,
                last_error,
                updated_at_ms: now_ms(),
            },
        );
        tokio::time::sleep(Duration::from_millis(800)).await;
    }

    instance.stop().await;
    let _ = std::fs::remove_file(&spec.status_path);
    Ok(0)
}

#[cfg(target_os = "macos")]
fn apple_script_quote(input: &str) -> String {
    input.replace('\\', "\\\\").replace('"', "\\\"")
}

#[cfg(unix)]
fn shell_single_quote(input: &str) -> String {
    format!("'{}'", input.replace('\'', "'\\''"))
}

pub async fn spawn_elevated_tun_runner(
    spec_path: &Path,
    status_path: &Path,
) -> Result<TunRunnerStatusSnapshot, String> {
    let exe = std::env::current_exe()
        .map_err(|e| format!("failed to locate host-core executable: {e}"))?;
    let exe_str = exe.to_string_lossy().to_string();
    let spec_str = spec_path.to_string_lossy().to_string();
    let _ = std::fs::remove_file(status_path);

    let spawn_result = tokio::task::spawn_blocking(move || -> Result<(), String> {
        #[cfg(target_os = "macos")]
        {
            let shell_cmd = format!(
                "{} {} {} >/dev/null 2>&1 &",
                shell_single_quote(&exe_str),
                INTERNAL_EASYTIER_TUN_RUNNER_FLAG,
                shell_single_quote(&spec_str)
            );
            let script = format!(
                "do shell script \"{}\" with administrator privileges",
                apple_script_quote(&shell_cmd)
            );
            let output = std::process::Command::new("osascript")
                .arg("-e")
                .arg(&script)
                .output()
                .map_err(|e| format!("failed to invoke macOS privilege elevation: {e}"))?;
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
                return Err(if stderr.is_empty() {
                    "administrator privilege request was cancelled or denied".into()
                } else {
                    stderr
                });
            }
            Ok(())
        }
        #[cfg(target_os = "linux")]
        {
            let shell_cmd = format!(
                "{} {} {} >/dev/null 2>&1 &",
                shell_single_quote(&exe_str),
                INTERNAL_EASYTIER_TUN_RUNNER_FLAG,
                shell_single_quote(&spec_str)
            );
            let output = std::process::Command::new("pkexec")
                .arg("sh")
                .arg("-c")
                .arg(&shell_cmd)
                .output()
                .map_err(|e| format!("failed to invoke pkexec elevation: {e}"))?;
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
                return Err(if stderr.is_empty() {
                    "administrator privilege request was cancelled or denied".into()
                } else {
                    stderr
                });
            }
            Ok(())
        }
        #[cfg(target_os = "windows")]
        {
            let ps_exe = exe_str.replace('\'', "''");
            let ps_spec = spec_str.replace('\'', "''");
            let command = format!(
                "Start-Process -FilePath '{ps_exe}' -ArgumentList @('{INTERNAL_EASYTIER_TUN_RUNNER_FLAG}', '{ps_spec}') -Verb RunAs -WindowStyle Hidden"
            );
            let output = std::process::Command::new("powershell.exe")
                .args(["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", &command])
                .output()
                .map_err(|e| format!("failed to invoke Windows UAC elevation: {e}"))?;
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
                return Err(if stderr.is_empty() {
                    "administrator privilege request was cancelled or denied".into()
                } else {
                    stderr
                });
            }
            Ok(())
        }
    })
    .await
    .map_err(|e| format!("elevation task join failed: {e}"))?;

    spawn_result?;

    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while std::time::Instant::now() < deadline {
        if let Ok(raw) = std::fs::read_to_string(status_path) {
            if let Ok(snapshot) = serde_json::from_str::<TunRunnerStatusSnapshot>(&raw) {
                if snapshot.state == EasyTierConnectionState::Error {
                    return Err(snapshot
                        .last_error
                        .unwrap_or_else(|| "elevated TUN runner failed to start".into()));
                }
                return Ok(snapshot);
            }
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }

    Err("timed out waiting for elevated EasyTier TUN runner to report status".into())
}
