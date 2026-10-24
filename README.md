<div align="center">

# Minih-Agent-Desktop

### A persistent desktop workspace for AI agents

**Bring projects, agents, models, plugins, and workflows into one long-lived desktop environment.**

Local-first · Model-agnostic · Plugin-powered · macOS / Windows / Linux

<br />

[![CI](https://github.com/minih-git/minih-agent-desktop/actions/workflows/ci.yml/badge.svg)](https://github.com/minih-git/minih-agent-desktop/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/minih-git/minih-agent-desktop)](LICENSE)

<br />

**[Releases](https://github.com/minih-git/minih-agent-desktop/releases)** ·
[Documentation](docs/spec/README.md) ·
[Build a Plugin](docs/plugin-development.md) ·
[Screenshots](docs/guide/screenshots.md) ·
[简体中文](README.zh-CN.md)

<br />
</div>

> **Current release line: 0.27.x (Early Preview).**

---

## Why a desktop workspace?

Terminal agents are great at execution. IDE agents are great at living inside an editor.
Minih-Agent-Desktop takes a different position:

> **Give AI agents a persistent, independent, and extensible desktop workspace of their own.**

Projects, sessions, reviews, and agents live in one workspace that survives across
launches — not in disposable chat threads tied to a single vendor.

<table>
<tr>

<td width="25%" valign="top">

### Persistent Sessions

Project → Session → Agent → Work.
Pin, archive, branch, and search sessions;
recover interrupted work.

</td>

<td width="25%" valign="top">

### Model Freedom

Cloud models, local models, custom gateways,
OpenAI-compatible APIs. Switch models without
rebuilding your workflow.

</td>

<td width="25%" valign="top">

### Agent Orchestration

Delegate to subagents or coordinate full worker
sessions in parallel when one context window
is not enough.

</td>

<td width="25%" valign="top">

### Local-First & Sandboxed

Data stays on your machine. Credentials live in
the OS keychain. Every privileged operation passes
through the permission layer.

</td>

</tr>
</table>

---

## Three ways to work

<table>
<tr>

<td width="33%" valign="top">

### Agent

**Give it a task. Let it work.**

Read code, edit files, run commands, test, iterate.

Best for day-to-day development.

</td>

<td width="33%" valign="top">

### Plan

**Review the approach before execution.**

The agent studies the project first and produces an
implementation plan.

Best for refactors and high-risk changes.

</td>

<td width="33%" valign="top">

### Goal

**Define the outcome. Let the agent choose the path.**

Lock the objective and acceptance criteria, then let
the agent drive execution.

Best for complex, long-running tasks.

</td>

</tr>
</table>

Privileged operations always pass through the permission layer:

```text
Agent → Tool Request → Permission Layer → Allow / Ask / Deny → Execution
```

---

## Plugins extend both the agent and the desktop

The core stays focused; workflows are assembled through extensions. A plugin can
contribute:

| Capability          | What it enables                                                |
| ------------------- | -------------------------------------------------------------- |
| **Command**         | Add actions to the global command system                       |
| **Panel**           | Open a standalone plugin interface                             |
| **Work Panel View** | Add new views to the right-side workspace                      |
| **Floating Widget** | Voice orbs, status lights, timers, and other floating UI       |
| **Agent Tool**      | Register tools callable by the agent                           |
| **Skill**           | Add reusable agent capabilities and workflows                  |
| **Completion**      | Use the models already configured by the user                  |
| **Theme**           | Customize workspace appearance                                 |
| **MCP Server**      | Connect local or remote MCP servers                            |
| **Service**         | Run persistent background work                                 |
| **Message Bus**     | Let plugins communicate with each other                        |

Plugins ship as `.piplug` packages, or can be loaded directly as development
plugins while you build them.

<div align="center">

### [Build your first plugin →](docs/plugin-development.md)
</div>

---

## When one agent is not enough

Complex work should not be forced into one context window.

**Subagents** delegate independent work — exploration, implementation, test
analysis, research, review — to background agents with their own context.

**Session Orchestrator** goes further: delegate to full worker sessions that run
in parallel and remain individually inspectable.

```text
Main Session
│
├── Worker A — Frontend
├── Worker B — Backend
├── Worker C — Tests
└── Worker D — Review
```

Workers are complete sessions: independent context, independent execution, full
transcript, reusable.

---

## Swap the model, keep the workflow

Minih-Agent-Desktop does not tie your workflow to a single model vendor.

Use **Anthropic · OpenAI-compatible APIs · custom gateways · Ollama · LM Studio ·
local models**, and configure each model independently: provider, model ID,
context window, output limit, reasoning settings, temperature, auth.

Different sessions can use different models. The same session can switch models
at any time.

```text
Planning     → Model A
Coding       → Model B
Review       → Model C
Private task → Local model
```

Already using another coding agent? Minih-Agent-Desktop can import local
sessions from **Claude Code · Codex · OpenCode · Pi**.

---

## Local-first by default

| Data            | Default behavior                          |
| --------------- | ----------------------------------------- |
| Projects        | Local                                     |
| Sessions        | Local                                     |
| Settings        | Local                                     |
| Logs            | Local                                     |
| API credentials | OS keychain                               |
| Telemetry       | None                                      |
| Model requests  | Sent directly to your configured provider |

**No mandatory account. No mandatory relay.**

When using a remote model, the context required for the request goes directly to
that provider.

---

## See it in action

Screenshots of sessions, the composer, model selection, and the plugin
marketplace live in [docs/guide/screenshots.md](docs/guide/screenshots.md).

---

## Get started

### Download

Grab a build from the [releases page](https://github.com/minih-git/minih-agent-desktop/releases):

| Platform | Architecture  | Package                                 |
| -------- | ------------- | --------------------------------------- |
| macOS    | Apple Silicon / Intel | `.dmg` / `.zip`                 |
| Windows  | x64           | Installer / portable `.zip`              |
| Linux    | x64 / ARM64   | `.AppImage` / `.deb` / `.rpm`            |

<details>
<summary><strong>Linux compatibility</strong></summary>

Linux packages require **glibc 2.35+** (Ubuntu 22.04+, Debian 12+, Fedora 36+).
Check with `ldd --version`.

</details>

### Run from source

<details>
<summary><strong>Development setup</strong></summary>

<br />

#### Requirements

* Node.js `>= 22.19`
* pnpm (the repo pins the exact version)
* Stable Rust toolchain

#### Start

```bash
git clone https://github.com/minih-git/minih-agent-desktop.git
cd minih-agent-desktop

pnpm install

cargo build -p host-core
pnpm build:js

pnpm dev
```

#### Validate

```bash
pnpm typecheck
pnpm lint
pnpm test
```

</details>

---

## Architecture

```text
Renderer → Preload IPC → Electron Main → Rust Host Core / Agent Runtime → pi-ai / pi-agent-core
```

The renderer owns UI, Electron Main stays a thin orchestrator, and the Rust
`host-core` owns persistence and authoritative host state. Agent execution lives
in the agent runtime — never in the renderer.

Minih-Agent-Desktop is built on the [pi](https://github.com/badlogic/pi-mono)
ecosystem: the agent runtime uses `pi-ai`, `pi-agent-core`, and `pi-coding-agent`.
Pi provides the agent engine; this project builds the persistent desktop
workspace, sessions, permissions, plugins, and orchestration around it.

Read the details:

**[Architecture](docs/spec/02-architecture/01-architecture.md)** ·
[Specification](docs/spec/README.md) ·
[Plugin Development](docs/plugin-development.md) ·
[E2E Test Plan](docs/spec/06-delivery/04-e2e-test-plan.md) ·
[Release Runbook](docs/spec/06-delivery/06-release-runbook.md) ·
[AGENTS.md](AGENTS.md)

---

## Contributing

Issues and pull requests are welcome. For standalone capabilities, consider one
question first:

> **Would this be better as a plugin?**

Keep the core focused. Let the ecosystem grow.

**[Report an issue](https://github.com/minih-git/minih-agent-desktop/issues/new/choose)** ·
[Open issues](https://github.com/minih-git/minih-agent-desktop/issues) ·
[Build a plugin](docs/plugin-development.md)

---

## License

Minih-Agent-Desktop is licensed under the **GNU Lesser General Public License
v3.0**. See [LICENSE](LICENSE) for details.

---

<div align="center">

## Minih-Agent-Desktop

### Build your own agent workspace.

**Your models · Your agents · Your plugins · Your workspace**
</div>
