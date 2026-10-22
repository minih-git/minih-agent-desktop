<div align="center">

# Minih-Agent-Desktop

### 长期可用的 AI Agent 桌面工作台

**把项目、Agent、模型、插件和工作流，装进一个持久化的桌面环境。**

本地优先 · 模型自由 · 插件驱动 · macOS / Windows / Linux

<br />

[![CI](https://github.com/minih-git/minih-agent-desktop/actions/workflows/ci.yml/badge.svg)](https://github.com/minih-git/minih-agent-desktop/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/minih-git/minih-agent-desktop)](LICENSE)

<br />

**[版本发布](https://github.com/minih-git/minih-agent-desktop/releases)** ·
[文档](docs/spec/README.md) ·
[插件开发](docs/plugin-development.md) ·
[界面预览](docs/guide/screenshots.md) ·
[English](README.md)

<br />
</div>

---

## 为什么需要一个桌面工作台？

终端 Agent 擅长执行，IDE Agent 擅长嵌入编辑器。
Minih-Agent-Desktop 选择了另一个位置：

> **给 AI Agent 一个独立、长期、可扩展的桌面工作空间。**

项目、会话、评审和 Agent 生活在同一个跨启动持久的工作台里——而不是绑死在
某家厂商的一次性聊天线程上。

<table>
<tr>

<td width="25%" valign="top">

### 持久会话

Project → Session → Agent → Work。
置顶、归档、分支、搜索会话；
中断的工作可以恢复。

</td>

<td width="25%" valign="top">

### 模型自由

云端、本地、自建网关、OpenAI Compatible API。
换模型不用重建工作流。

</td>

<td width="25%" valign="top">

### Agent 编排

一个上下文窗口不够时，把独立工作委派给
Subagent，或并行协调完整的 Worker 会话。

</td>

<td width="25%" valign="top">

### 本地优先 · 沙箱

数据留在本机，凭据存 OS 钥匙串，所有特权
操作都经过权限层。

</td>

</tr>
</table>

> **当前发布线：0.25.x（Early Preview）。**

---

## 三种工作方式

<table>
<tr>

<td width="33%" valign="top">

### Agent

**下达任务，让它工作。**

读代码、改文件、跑命令、测试、迭代。

适合日常开发。

</td>

<td width="33%" valign="top">

### Plan

**执行前先审方案。**

Agent 先研究项目，产出实施计划。

适合重构和高风险变更。

</td>

<td width="33%" valign="top">

### Goal

**定义结果，让 Agent 自己选路径。**

锁定目标和验收标准，其余交给 Agent。

适合复杂、长周期任务。

</td>

</tr>
</table>

特权操作始终经过权限层：

```text
Agent → Tool Request → Permission Layer → Allow / Ask / Deny → Execution
```

---

## 插件同时扩展 Agent 和桌面

核心保持专注，工作流通过扩展组装。一个插件可以贡献：

| 能力 | 作用 |
| --- | --- |
| **Command** | 向全局命令系统添加动作 |
| **Panel** | 打开独立的插件界面 |
| **Work Panel View** | 在右侧工作区添加新视图 |
| **Floating Widget** | 语音球、状态灯、计时器等浮动 UI |
| **Agent Tool** | 注册 Agent 可调用的工具 |
| **Skill** | 添加可复用的 Agent 能力和工作流 |
| **Completion** | 复用用户已配置的模型 |
| **Theme** | 定制工作台外观 |
| **MCP Server** | 连接本地或远程 MCP 服务器 |
| **Service** | 运行常驻后台任务 |
| **Message Bus** | 让插件之间互相通信 |

插件以 `.piplug` 包分发，也可以在开发时直接作为开发插件加载。

<div align="center">

### [开发你的第一个插件 →](docs/plugin-development.md)
</div>

---

## 一个 Agent 不够的时候

复杂的工作不应该被塞进一个上下文窗口。

**Subagent** 把独立工作——探索、实现、测试分析、调研、评审——委派给拥有
独立上下文的后台 Agent。

**Session Orchestrator** 更进一步：委派给并行运行、且各自保持可检查的完整
Worker 会话。

```text
Main Session
│
├── Worker A — Frontend
├── Worker B — Backend
├── Worker C — Tests
└── Worker D — Review
```

Worker 是完整的会话：独立上下文、独立执行、完整记录、可复用。

---

## 换模型，不换工作流

Minih-Agent-Desktop 不把工作流绑在某一家模型厂商上。

可以使用 **Anthropic · OpenAI Compatible API · 自建网关 · Ollama ·
LM Studio · 本地模型**，并独立配置每个模型：Provider、Model ID、上下文窗口、
最大输出、Reasoning 设置、Temperature、认证方式。

不同会话可以用不同模型；同一个会话也可以随时切换。

```text
Planning     → Model A
Coding       → Model B
Review       → Model C
Private Task → Local Model
```

已经在用其他 Coding Agent？Minih-Agent-Desktop 可以导入
**Claude Code · Codex · OpenCode · Pi** 的本地会话。

---

## 默认本地优先

| 数据 | 默认行为 |
| --- | --- |
| 项目 | 本地 |
| 会话 | 本地 |
| 设置 | 本地 |
| 日志 | 本地 |
| API 凭据 | OS 钥匙串 |
| 遥测 | 无 |
| 模型请求 | 直连你自己配置的 Provider |

**没有强制账号。没有强制中转。**

使用远程模型时，请求所需的上下文直接发送给该 Provider。

---

## 界面预览

会话、Composer、模型选择与插件市场的截图见
[docs/guide/screenshots.md](docs/guide/screenshots.md)。

---

## 开始使用

### 下载

从 [Releases 页面](https://github.com/minih-git/minih-agent-desktop/releases) 获取构建：

| 平台 | 架构 | 安装包 |
| --- | --- | --- |
| macOS | Apple Silicon / Intel | `.dmg` / `.zip` |
| Windows | x64 | 安装器 / 便携 `.zip` |
| Linux | x64 / ARM64 | `.AppImage` / `.deb` / `.rpm` |

<details>
<summary><strong>Linux 兼容性</strong></summary>

Linux 安装包需要 **glibc 2.35+**（Ubuntu 22.04+、Debian 12+、Fedora 36+）。
用 `ldd --version` 检查。

</details>

### 从源码运行

<details>
<summary><strong>开发环境</strong></summary>

<br />

#### 环境要求

* Node.js `>= 22.19`
* pnpm（仓库锁定精确版本）
* 稳定版 Rust 工具链

#### 启动

```bash
git clone https://github.com/minih-git/minih-agent-desktop.git
cd minih-agent-desktop

pnpm install

cargo build -p host-core
pnpm build:js

pnpm dev
```

#### 校验

```bash
pnpm typecheck
pnpm lint
pnpm test
```

</details>

---

## 架构

```text
Renderer → Preload IPC → Electron Main → Rust Host Core / Agent Runtime → pi-ai / pi-agent-core
```

渲染层负责 UI，Electron Main 保持薄编排层，Rust `host-core` 持有持久化与
宿主权威状态。Agent 执行在 Agent Runtime 中——绝不在渲染层。

Minih-Agent-Desktop 基于 [pi](https://github.com/badlogic/pi-mono) 生态构建：
Agent Runtime 使用 `pi-ai`、`pi-agent-core` 和 `pi-coding-agent`。pi 提供
Agent 引擎，本项目在其上构建持久桌面工作台、会话、权限、插件与编排。

详细文档：

**[架构](docs/spec/02-architecture/01-architecture.md)** ·
[规范](docs/spec/README.md) ·
[插件开发](docs/plugin-development.md) ·
[E2E 测试计划](docs/spec/06-delivery/04-e2e-test-plan.md) ·
[发布手册](docs/spec/06-delivery/06-release-runbook.md) ·
[AGENTS.md](AGENTS.md)

---

## 参与贡献

欢迎 Issue 和 Pull Request。独立能力请先想一个问题：

> **它是不是更适合做成插件？**

核心保持专注，生态负责生长。

**[提交 Issue](https://github.com/minih-git/minih-agent-desktop/issues/new/choose)** ·
[查看 Issue](https://github.com/minih-git/minih-agent-desktop/issues) ·
[开发插件](docs/plugin-development.md)

---

## 许可证

Minih-Agent-Desktop 以 **GNU Lesser General Public License v3.0** 许可。
详见 [LICENSE](LICENSE)。

---

<div align="center">

## Minih-Agent-Desktop

### 组装你自己的 Agent 工作台。

**你的模型 · 你的 Agent · 你的插件 · 你的工作台**
</div>
