# pi.terminal — optional embedded terminal

A first-party plugin that gives Minih-Agent-Desktop an embedded terminal: local
interactive shells in tabs, opened from an entry near the top of the left
sidebar, rendered in the main content area.

It is **not** bundled with the app. With the plugin absent or disabled there is
no terminal entry, and the Desktop package carries no terminal-specific native
payload (ADR `optional-terminal-plugin`, which supersedes in part ADR 0108).

The terminal is a manual surface. It does not register Agent tools, an agent
extension, an MCP server, or prompt injection, and nothing it shows is attached
to a chat, logged, or uploaded.

## What it does

- Starts a real local shell from the profiles installed on this machine:
  PowerShell, `pwsh`, `cmd`, or Git Bash on Windows; the user's login shell, zsh,
  bash, or sh on macOS and Linux. The start form always shows the executable and
  the working directory before anything is spawned.
- Opens in the active local project directory, and offers the host's own folder
  picker or the home directory when that is not what you want. A path that does
  not exist on this machine (a remote project) is refused by name instead of
  being replaced with something else.
- Keeps terminals alive across chat switches, hiding the page, and minimizing the
  window. Closing a tab ends that terminal **and the jobs it started**: the close
  signals the shell's whole process group and escalates, so it does not depend on
  the shell's own exit behaviour. A close that cannot confirm the process is gone
  is reported as a failure instead of claiming a cleanup that did not happen.
- Ends every terminal when the plugin is disabled, uninstalled, reloaded, or
  upgraded — and asks first. The host's own confirmation names this plugin and
  says how many shells are still running; cancelling leaves every shell, the
  plugin, and the page exactly as they were. The same disclosure rides on the
  existing quit prompt, so quitting says which shells it will end. Nothing is
  restored after a reload or an app restart: there is no transcript persistence
  and no command replay.
- Handles search, copy/paste, resize, Chinese IME and wide characters, and the
  app's light/dark theme.

## Build and package

```bash
pnpm --filter @minih-agent/plugin-terminal build        # stage dist/ (dev subset)
pnpm --filter @minih-agent/plugin-terminal test         # build, then node --test
pnpm --filter @minih-agent/plugin-terminal check        # pi-plugin check dist
pnpm --filter @minih-agent/plugin-terminal pack         # .piplug for the platforms present
pnpm --filter @minih-agent/plugin-terminal pack:release # refuses unless all six are present
```

`build` prints the PTY platforms it carries and, when one is missing, says the
result is **a development package for a platform subset, not a three-platform
delivery**. `pack:release` runs the same build with `--require-platforms` for
darwin-arm64, darwin-x64, win32-x64, win32-arm64, linux-x64 and linux-arm64: a
missing asset fails the build and removes the staged directory rather than
producing a package that cannot run where it claims to.

`build` copies the plugin's own sources, xterm.js and its two addons, and the
pinned `node-pty` runtime plus the per-platform prebuilt binaries into `dist/`.
Debug symbols (`.pdb`) and the legacy winpty shim are dropped, and the macOS
`spawn-helper` keeps its executable bit — without that bit a spawn fails with a
bare `posix_spawnp failed`.

`dist/` is a normal plugin directory: it can be loaded from **Plugins → Load
development plugin** or packed into a `.piplug` and installed.

## Verify the native payload

The plugin backend is an Electron `utilityProcess`, not a plain `node` process,
so loading `node-pty` under `node` proves nothing about the packaged plugin. Point
the check at the Electron binary the release is built against:

```bash
node scripts/verify-electron.mjs --electron ../../node_modules/.bin/electron
```

It exits 0 only when the utility process loads the vendored `node-pty`, spawns a
real shell through it, receives that shell's output, and closes the terminal.
`node-pty@1.1.0` prebuilds are N-API, so the same binary loads in Electron and in
`node` (verified with Electron 43.6.0 / Node 24.20.0 on darwin-arm64).

## Platform delivery status

A package is only as complete as the native assets it carries. `node-pty@1.1.0`
publishes prebuilds for darwin (x64, arm64) and win32 (x64, arm64), and none for
Linux, so a package built on macOS or Windows carries four of the six target
platforms.

| Platform | Assets | Verification |
|---|---|---|
| darwin-arm64 | prebuild | **run** on this machine: unit tests, real PTY, Electron utility process, owner-death, real host process |
| darwin-x64 | prebuild | **NOT RUN** — same binary family, no x64 machine here |
| win32-x64, win32-arm64 | prebuild (conpty) | **NOT RUN** — no Windows machine here |
| linux-x64, linux-arm64 | none in a darwin/Windows build | **NOT RUN and NOT DELIVERABLE** from this machine |

A Linux build has to happen on Linux, because `node-pty` compiles there:

```bash
# on Linux, in plugins/pi.terminal
npm_config_build_from_source=1 pnpm rebuild node-pty   # writes node-pty/build/Release
node scripts/build.mjs                                # packages build/Release as <platform>-<arch>
```

`build` reads `node-pty/build/Release` for the host's own platform, so that source
build is what a Linux package is made of; it can only ever fill the platform the
build ran on. Until packages from all three platforms are assembled,
`pack:release` fails, and this plugin has no three-platform deliverable.

One Windows behaviour that used to be a guess is now measured: node-pty starts
`conpty_console_list_agent` with `child_process.fork`, and inside an Electron
utility process that fork runs the child with `ELECTRON_RUN_AS_NODE=1` (checked on
darwin-arm64 with Electron 43.6.0). The Windows console-list path itself still
needs a Windows run.

## Known limits

- `pi-plugin check` warns that `clipboard.write` looks unused. It is used from the
  page (`pluginBridge.invoke("clipboard.writeText")`), and the checker only scans
  `main.js`.
- A crash ends the shell because the PTY master closes with the process, which
  hangs up the session — `test/owner-death.test.mjs` measures the shell's pid
  dying. Whether the shell's background jobs follow is the shell's own policy:
  bash and zsh resend SIGHUP to their jobs on exit, while a dash-like `sh` does
  not hang up its jobs, so on a crash such a shell can leave a background job
  behind. That is why the terminal starts the user's interactive shell rather
  than a bare `sh`, and why the guaranteed path is the explicit one: closing a
  tab or disabling the plugin signals the process group. No host-managed
  supervisor exists behind this; a guarantee that covers every shell on a crash
  needs a host-owned PTY, which the ADR deliberately excluded.
- The interruption prompt is answered from memory at the moment it is asked. A
  terminal that exits between the prompt and the teardown is simply reported as
  finished, and a plugin that cannot answer within two seconds is treated as
  having nothing running.
- Scrollback is bounded (5000 lines per terminal) and there is no session
  persistence: a reloaded plugin starts with no terminals.

## Layout

```text
src/manifest.json      sidebar-placed view, permissions, localized safety notes
src/main.js            panel-bridge channels; the plugin's whole public surface
src/lib/shells.js      installed-shell catalog (no startup files are sourced)
src/lib/terminal-engine.js  PTY registry, bounded buffers, flow control, cleanup
src/view/              the sandboxed page: xterm.js, tabs, search, copy/paste
scripts/build.mjs      stages dist/ and verifies the payload it carries
scripts/verify-electron.mjs  forks the packaged PTY in a real utility process
test/                  real-PTY, flow-control, manifest, and owner-death tests
```
