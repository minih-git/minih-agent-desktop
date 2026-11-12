mod activation;
mod agent_capabilities;
mod artifacts;
mod audit;
mod background_tasks;
mod cli;
mod config_sync;
mod conversation_archive;
mod data_relocation;
mod db;
mod delegations;
mod easytier_net;
mod host_lock;
mod keyboard;
mod mcp_servers;
mod memory;
mod network_policy;
mod network_proxy;
mod notifications;
mod permissions;
mod plans;
mod plugin_sessions;
mod plugin_usage;
mod plugins;
mod project_archive;
mod providers;
mod review;
mod rpc;
mod scheduled;
mod scratch;
mod secrets;
mod session_collaboration;
mod session_search;
mod session_worktrees;
mod sessions;
mod state;
mod tasks;
mod todos;
mod tool_budget;
mod tool_cancellation;
mod tools;
mod transcripts;
mod turn_queue;
mod user_skills;
mod user_subagents;
mod workspace;

use std::sync::Arc;
use tokio::sync::Mutex;
use tracing_subscriber::EnvFilter;

use crate::state::AppState;

#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    if data_relocation::run_cli()? {
        return Ok(());
    }
    // Classify the arguments before anything is created or opened: a manual
    // `--version` probe must not reach the boot maintenance that settles the
    // turns of the host already using the data directory.
    match cli::parse(&std::env::args().skip(1).collect::<Vec<String>>()) {
        cli::HostInvocation::Version => {
            println!("{}", cli::version_line());
            return Ok(());
        }
        cli::HostInvocation::Help => {
            print!("{}", cli::USAGE);
            return Ok(());
        }
        cli::HostInvocation::Unrecognized(argument) => {
            eprintln!(
                "{}: unrecognized argument '{argument}'; run --help for usage",
                env!("CARGO_BIN_NAME")
            );
            std::process::exit(cli::EXIT_USAGE);
        }
        cli::HostInvocation::ToolRunner => {
            let exit_code = match tools::run_internal_tool_runner().await {
                Ok(exit_code) => exit_code,
                Err(error) => {
                    eprintln!("internal tool runner failed: {error:#}");
                    1
                }
            };
            std::process::exit(exit_code);
        }
        cli::HostInvocation::TunRunner => {
            let exit_code = match easytier_net::run_internal_tun_runner().await {
                Ok(exit_code) => exit_code,
                Err(error) => {
                    eprintln!("internal easytier tun runner failed: {error:#}");
                    1
                }
            };
            std::process::exit(exit_code);
        }
        cli::HostInvocation::Boot => {}
    }

    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .with_writer(std::io::stderr)
        .init();

    let data_dir = std::env::var("MINIH_AGENT_DATA_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| {
            dirs::home_dir()
                .unwrap_or_else(|| std::path::PathBuf::from("."))
                .join(".minih-agent-desktop")
        });

    std::fs::create_dir_all(&data_dir)?;

    // The data directory admits one host process. Everything below — the boot
    // maintenance that settles `running` turns, the single SQLite writer, the
    // scratch sweep — is only safe when nothing else is using it, and a second
    // host that opened it anyway would abort the turns a live host is running.
    // The lock is held until the process exits; the OS releases it then.
    let data_dir_lock = match host_lock::acquire(&data_dir) {
        Ok(lock) => lock,
        Err(error @ host_lock::AcquireError::Busy { .. }) => {
            eprintln!("{}: {error}", env!("CARGO_BIN_NAME"));
            std::process::exit(host_lock::EXIT_DATA_DIR_BUSY);
        }
        Err(error) => return Err(anyhow::Error::new(error)),
    };
    std::fs::create_dir_all(data_dir.join("logs"))?;
    std::fs::create_dir_all(data_dir.join("plugins/installed"))?;
    std::fs::create_dir_all(data_dir.join("plugins/data"))?;
    std::fs::create_dir_all(data_dir.join("plugins/market"))?;
    std::fs::create_dir_all(data_dir.join("plugins/cache/download"))?;
    std::fs::create_dir_all(data_dir.join("cache"))?;
    std::fs::create_dir_all(data_dir.join("scratch"))?;

    let state = Arc::new(Mutex::new(AppState::open(&data_dir)?));
    tracing::info!(
        path = %data_dir.display(),
        lock = %data_dir_lock.path().display(),
        "host-core starting"
    );
    {
        // Sweep orphaned/stale session scratch dirs left behind by crashes or
        // deletions that bypassed session.delete (D114).
        let st = state.lock().await;
        // Only sweep with a real session list: an empty fallback on a db
        // error would wipe scratch dirs of sessions that still exist.
        if let Ok(list) = sessions::list_sessions(&st.db) {
            let live: std::collections::HashSet<String> = list.into_iter().map(|s| s.id).collect();
            scratch::sweep(&data_dir, &live);
            review::sweep(&data_dir, &live);
        }
        let app_settings = st.db.get_setting("app").unwrap_or_default();
        // Drop the guard before the provider reads the same state: the bootstrap
        // request asks it for the Router row while this task runs.
        drop(st);
        easytier_net::spawn_at_boot(
            &data_dir,
            app_settings.as_ref(),
            Arc::new(easytier_net::AppStateCredentialProvider::new(state.clone())),
        );
    }
    // Drop half-created worktrees, mark vanished ones, repair links after a
    // moved data directory, and remove orphans (ADR 0329).
    tokio::spawn(session_worktrees::lifecycle::reconcile(
        state.clone(),
        session_worktrees::git::GitRunner::default(),
    ));
    rpc::serve(state).await
}
