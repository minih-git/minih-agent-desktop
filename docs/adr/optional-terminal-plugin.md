# ADR: Optional embedded terminal plugin

- Status: Accepted for implementation; optional-plugin scope confirmed by the user, with the engineering defaults below
- Date: 2026-10-23
- Decision owners: Minih-Agent-Desktop maintainers
- Source baseline: `c7278638df08f227361828c63242c43b531185f0`
- Related: [ADR 0108](0108-remove-built-in-interactive-terminal.md),
  [plugin API](../spec/07-plugins/03-plugin-api.md),
  [plugin security](../spec/07-plugins/04-plugin-security.md),
  [plugin lifecycle](../spec/07-plugins/05-plugin-lifecycle.md),
  [plugin packaging](../spec/07-plugins/06-plugin-packaging.md),
  [process model](../spec/03-runtime/07-process-model.md)
- Supersedes in part: ADR 0108's exclusion of an optional plugin-owned
  interactive terminal. Its removal of a mandatory built-in terminal and its
  preservation of Agent Bash remain in force.

## Context

The user wants an embedded terminal reachable near the top of the left sidebar,
with a consistent interaction model on Windows, macOS, and Linux. After
reviewing the maintenance cost, the user explicitly chose an optional embedded
terminal plugin rather than only an external-terminal launcher. They requested
this ADR followed by implementation in a separate session.

Desktop is an Agent workspace, not a general-purpose terminal application. The
feature is useful for manual intervention, interactive CLI programs, and local
verification in a project or worktree. It must not duplicate the Agent Bash
tool, task output, or permission workflow.

Current code offers a useful reference, not a ready-made desktop subsystem:

- `apps/agent-host-cli/src/terminal.ts` uses optional `node-pty`, associates
  terminals with chat sessions, and retains a bounded tail of output. Its
  default-shell handling, close semantics, and tail replay do not establish
  desktop-wide lifecycle or full screen restoration guarantees.
- The Rust shell catalog serves non-interactive Agent commands. Interactive
  shell profiles must not reuse `-NonInteractive` or change Agent defaults.
- Plugins have isolated views and resident background services. They do not
  currently have a sidebar/main-content destination contribution or a public
  PTY API. Plugin entry code can use Node APIs; it is not an OS sandbox.

A host-owned Rust PTY service would centralize lifetime and native distribution,
but would also add an always-shipped native dependency and a privileged plugin
contract for one optional feature. No requirement currently demands terminal
survival across plugin reloads or application restarts. That investment is not
a prerequisite for this scope.

## Decision

### 1. Optional product surface

Deliver a first-party, separately installable terminal plugin. Do not bundle or
auto-enable it in the default Desktop installation. With the plugin absent or
disabled, there is no terminal entry and no terminal-specific native payload
in the Desktop package.

When installed and enabled, the plugin contributes a host-rendered entry near
the top of the left sidebar. Opening it displays an isolated plugin view in the
main content area, not a new chat and not merely a right work-panel tab. Reuse
the existing contributed-view infrastructure, adding only the necessary
opt-in placement and navigation support. Existing view placement and other
plugins retain their defaults. No DOM injection, terminal-id special case,
arbitrary renderer script grant, or general-purpose navigation framework is
needed for this entry.

The terminal view is independent of the selected chat. A terminal has its own
identifier and launch directory. Use the active local project/worktree directory
when available; otherwise offer an explicit local directory choice or home
directory. Show the actual target and shell. Do not treat a remote project path
as a local path or silently open a local shell for a remote Host.

### 2. Plugin-owned terminal engine

Use xterm.js for terminal presentation and `node-pty` for native PTY access in
the plugin-owned backend. Pin tested versions during implementation. This
choice follows the optional-distribution boundary, not a claimed performance
advantage over Rust.

Keep terminal registry, interactive profiles, I/O flow control, and process
cleanup inside the plugin. Electron Main continues to coordinate ordinary
plugin views, messages, permissions, and lifecycle; it does not own a terminal
manager. Do not add `portable-pty` to Rust host-core, a host `terminal.*` RPC
surface, a public plugin PTY/process-execution API, or another persistent daemon.

Keep the existing headless Host CLI terminal implementation and remote RACP
contracts unchanged. Inspect them for reusable behavior, but do not import an
application-private module across package boundaries or create a shared backend
framework merely to avoid a small amount of plugin-local logic.

Use the existing sender-bound panel/plugin bridge wherever it supports the
necessary traffic. If a view/backend messaging gap exists, limit any addition
to same-plugin messaging with validation, bounded payloads, and clear lifecycle.
Do not carry terminal output on the cross-plugin public bus, expose raw Electron
IPC to the page, or start a loopback HTTP/WebSocket terminal server.

### 3. Deliberately limited lifecycle

- Create a shell only following an explicit user action. Enabling or restarting
  the plugin does not execute a stored command or start a previous terminal.
- Switching chats, hiding the terminal page, or minimizing Desktop does not
  end the terminal. Retain its live view/state while the plugin is enabled;
  do not claim a truncated output tail is a complete emulator snapshot.
- Closing a terminal tab terminates its owned processes and reports cleanup
  failure instead of silently reporting success.
- Disabling, uninstalling, reloading/upgrading the plugin, or quitting Desktop
  ends its terminals. Make interruption visible and obtain confirmation for a
  user-initiated destructive action while terminals remain active. Do not
  promise that plugin updates preserve running shell jobs.
- Plugin crashes must not leave unmanaged shell jobs indefinitely. Establish
  and test owner-death cleanup; do not assume killing the plugin process kills
  its descendants. If existing lifecycle primitives cannot support this
  without a new native host service, report the specific constraint before
  expanding scope.
- Application restart and plugin crash recovery start with no live terminal
  sessions. No command replay, session resurrection, or transcript persistence.

### 4. Cross-platform behavior, not identical shells

The UI, terminal actions, themes, search, tabs, and error states are shared
across Windows, macOS, and Linux. Keyboard mappings respect platform conventions
and preserve terminal control keys such as interrupt.

Choose from installed interactive shells: PowerShell on Windows, and the
user's supported login shell on macOS/Linux, including zsh/bash. Additional
installed profiles such as Git Bash can be offered only when detected and
tested. Respect the selected shell's interactive startup/profile behavior,
without sourcing startup files merely to scan for executable paths. A missing
profile produces an actionable error, not a silent shell substitution. Keep
terminal preferences independent of the Agent command-shell preference.

Use proper incremental Unicode handling, size negotiation, bounded scrollback,
and end-to-end output backpressure. A replay/history cap alone is not flow
control. Exercise Chinese IME, wide characters, interactive TUI resize, paste,
and interrupt while output is busy. Do not market equal command syntax, paths,
installed tools, or operating-system behavior across platforms.

### 5. Explicit trust and constrained distribution

The plugin executes local commands with the current user's privileges and can
observe terminal input/output. A working directory is not a filesystem sandbox.
Installation/enablement must make this native-execution trust visible through
the normal host-controlled review path. A medium-risk background-service label
alone must not imply limited local access. If existing review metadata cannot
express this truth, add only the minimal declarative risk/acknowledgement
contract; do not introduce a generic command-execution API to justify a label.
This is informed consent, not a claim that raw Node access is OS-sandboxed.

Do not register Agent tools, Agent extensions, MCP servers, or prompt injection
for this manual feature. Do not attach terminal contents to a chat or log input,
output, passwords, environment values, or shell history. Diagnostic records may
contain bounded operational status, without sensitive payloads. Terminal output,
titles, and links remain untrusted data. No automatic clipboard-read escape
sequence, external navigation, or auto-execution of pasted text.

Ship native runtime assets in the plugin package, tested for the Desktop
release targets and their actual runtime. Do not install build tools, run npm,
or download executable code on the user's machine at plugin enablement. Prefer
one package with validated per-platform assets if it fits existing archive
limits; if it does not, report the measured size/architecture constraint before
designing platform-specific marketplace delivery. Respect existing signature,
permission, extraction, and package-size checks.

The initial deliverable is source, a reproducible build/package path, and local
validation. Public marketplace publication, committing, pushing, merging,
installing into the user's running application, and restarting that application
are separate authorized actions, not implied by implementation handoff.

## Consequences

- The manual terminal is optional and can iterate independently of the core UI.
  Users without the plugin pay neither a navigation nor a PTY payload cost.
- Desktop still needs a small, backward-compatible plugin view placement
  extension and possibly a narrowly scoped message/review adjustment. This is
  not a zero-host-change plugin.
- Native packaging, shell compatibility, and descendant cleanup remain real
  plugin maintenance responsibilities. Plugin ownership does not eliminate
  them or prove security/performance advantages.
- Reloading/upgrading the plugin interrupts its terminals. Host-owned PTY can
  be reconsidered only for a demonstrated lifecycle or reuse requirement, not
  as speculative infrastructure for this first release.
- No built-in Agent Bash behavior, remote terminal contract, storage schema,
  or remote-control scope changes.

## Alternatives considered

1. **External-terminal launcher only:** less maintenance, but not the embedded
   plugin scope explicitly selected by the user. It is not a silent fallback.
2. **Optional UI plus host-owned Rust PTY:** a reasonable future ownership
   model, but adds host payload and a privileged API before a host-lifetime
   requirement exists. Deferred, not rejected as technically inferior.
3. **Mandatory built-in terminal:** imposes UI, release, and lifecycle cost on
   every user. Rejected for this optional feature.
4. **Standalone terminal platform:** split layouts, SSH/SFTP management, WSL
   distribution management, remote/mobile terminals, persistence across restart,
   and Agent takeover are outside this decision.

## Implementation handoff

This ADR records the choice and rationale, not a replacement for executable
contracts. The implementation session updates the relevant plugin manifest/API,
security/lifecycle, UI, and acceptance specs before changing their behavior,
then implements the smallest compatible change. Amend E2E-058 so the default
installation still has no terminal while explicitly installed plugins may
provide one. Do not weaken unrelated absence or security checks.

Development validation should focus on the changed surface:

- SDK/manifest and navigation tests: opt-in placement, old manifests unchanged,
  install/enable/open/hide/reopen/disable path, and no entry without the plugin.
- Plugin tests with real local processes: interactive input/resize/exit, bounded
  flow control, independent tabs/directories, explicit close and owner shutdown.
- Same-plugin bridge rejection tests and native-execution acknowledgement.
- Build affected packages before downstream checks; run affected tests and
  changed-file lint. Use an isolated UI fixture for the representative user
  path, not the user's running Desktop or paid providers.
- Report Windows/macOS/Linux package/runtime checks separately. An unavailable
  OS is NOT RUN, not a passing three-platform result. Follow repository gates
  when later preparing integration; do not use broad checks as a substitute
  for these feature-specific checks.

Stop and report a concrete blocker if native package limits, view transport,
owner-death cleanup, or trust presentation requires a larger architectural
change. Do not silently replace the feature with an external launcher, move
PTY into Rust, expose a shell server, or broaden plugin privileges.
