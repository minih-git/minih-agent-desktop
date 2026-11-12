//! The host binary's own command line.
//!
//! Minih-Agent-Desktop starts the host as a child process with an empty argument
//! list and `MINIH_AGENT_DATA_DIR` in its environment, so nothing here is needed
//! to boot. It exists to keep a *manual* invocation from reaching the boot path:
//! a `--version` probe used to fall through to the normal start, open whatever
//! data directory the environment named (the user's own, by default) and run the
//! boot maintenance that settles every `running` turn of the host that was
//! already using it. `--version` and `--help` therefore answer and exit, any
//! other argument is refused, and both happen before a directory or database is
//! touched.
//!
//! Two internal flags still enter the binary, and only from the running host
//! itself: `--internal-tool-runner` (stdio Bash runner) and
//! `--easytier-tun-runner <spec>` (privileged TUN helper). They are matched
//! first and never take the data-directory lock.

use crate::easytier_net::INTERNAL_EASYTIER_TUN_RUNNER_FLAG;
use crate::tools::INTERNAL_TOOL_RUNNER_FLAG;

/// Exit code for an argument this binary does not accept, distinct from a
/// runtime failure (1) and from a data directory another host owns
/// ([`crate::host_lock::EXIT_DATA_DIR_BUSY`]).
pub const EXIT_USAGE: i32 = 2;

/// Printed by `--help`. The host is a child process, so the text names the
/// environment variable that tells it where to work instead of an option.
pub const USAGE: &str = "\
Usage: minih-agent-desktop-host-core [--version | --help]

Minih-Agent-Desktop starts this process itself and passes no arguments: it
speaks NDJSON JSON-RPC over stdin/stdout, and reads its data directory from
MINIH_AGENT_DATA_DIR (default: ~/.minih-agent-desktop). One data directory
admits one host process at a time.

Options:
  -V, --version  Print the host version and exit
  -h, --help     Print this help and exit
";

/// What the process should do with the arguments it was started with.
#[derive(Debug, PartialEq, Eq)]
pub enum HostInvocation {
    /// Start the host: the only path that opens the data directory.
    Boot,
    Version,
    Help,
    /// Spawned by the host to run one Bash tool invocation.
    ToolRunner,
    /// Spawned by the host (privilege-elevated) to run the EasyTier TUN helper.
    TunRunner,
    /// An argument this binary does not accept; carries it for the message.
    Unrecognized(String),
}

/// Classify the arguments that follow the executable path.
pub fn parse(args: &[String]) -> HostInvocation {
    // The internal runners are matched by flag position rather than being
    // required to be first: the TUN helper is also launched through a shell
    // command and a PowerShell `-ArgumentList`.
    if args.iter().any(|arg| arg == INTERNAL_TOOL_RUNNER_FLAG) {
        return HostInvocation::ToolRunner;
    }
    if args
        .iter()
        .any(|arg| arg == INTERNAL_EASYTIER_TUN_RUNNER_FLAG)
    {
        return HostInvocation::TunRunner;
    }
    match args {
        [] => HostInvocation::Boot,
        [arg] if arg == "--version" || arg == "-V" => HostInvocation::Version,
        [arg] if arg == "--help" || arg == "-h" => HostInvocation::Help,
        _ => HostInvocation::Unrecognized(args.join(" ")),
    }
}

/// `name version`, the shape `--version` prints.
pub fn version_line() -> String {
    format!("{} {}", env!("CARGO_BIN_NAME"), env!("CARGO_PKG_VERSION"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|arg| arg.to_string()).collect()
    }

    #[test]
    fn version_flags_print_the_version() {
        assert_eq!(parse(&args(&["--version"])), HostInvocation::Version);
        assert_eq!(parse(&args(&["-V"])), HostInvocation::Version);
    }

    #[test]
    fn help_flags_print_the_usage() {
        assert_eq!(parse(&args(&["--help"])), HostInvocation::Help);
        assert_eq!(parse(&args(&["-h"])), HostInvocation::Help);
    }

    #[test]
    fn internal_runners_keep_their_flags() {
        assert_eq!(
            parse(&args(&[INTERNAL_TOOL_RUNNER_FLAG])),
            HostInvocation::ToolRunner
        );
        assert_eq!(
            parse(&args(&[
                INTERNAL_EASYTIER_TUN_RUNNER_FLAG,
                "/tmp/spec.json"
            ])),
            HostInvocation::TunRunner
        );
    }

    #[test]
    fn no_arguments_boots_the_host() {
        assert_eq!(parse(&[]), HostInvocation::Boot);
    }

    #[test]
    fn unknown_arguments_are_refused() {
        assert_eq!(
            parse(&args(&["--relocate-data"])),
            HostInvocation::Unrecognized("--relocate-data".into())
        );
        // A known flag followed by more arguments is not the flag: both are
        // reported so the caller sees what it actually sent.
        assert_eq!(
            parse(&args(&["--version", "extra"])),
            HostInvocation::Unrecognized("--version extra".into())
        );
    }

    #[test]
    fn version_line_names_the_binary_and_its_version() {
        let line = version_line();
        assert_eq!(
            line,
            format!(
                "minih-agent-desktop-host-core {}",
                env!("CARGO_PKG_VERSION")
            )
        );
    }
}
