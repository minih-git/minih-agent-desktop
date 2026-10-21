# 远程 Agent 控制目标架构

- 状态：目标规格，属于 MVP 之后
- 决策：D373 / ADR 0205，经 D374 与 D375 修订
- 英文源规格：[英文源规格](/spec/02-architecture/05-remote-agent-control)

本页是英文规范的中文导读。远程控制当前仍不属于 MVP，不会把现有
Electron IPC、`host.proxy` 或 Rust host-core 暴露到网络。

## 1. 范围、顺序与原则

目标是让经过认证的远程客户端查看和控制 Agent Host，同时保持会话、
回合、回合队列、事件游标、审批、附件、工作区和权限都由 Host 掌权。

D375 固定了拓扑的交付顺序：首个远程部署是桌面本身作为远端无头 Host 的
客户端，经 SSH 隧道连接（#176、#140）；第二个是 Host 旁的出站消息集成
（#100）。D665（ADR 0331）把其余拓扑排期：自托管 Gateway 与 Host link 为
R4，桌面作为可连接的 Host 为 R5，浏览器与移动客户端为 R6。

- 客户端可以断开，Agent 回合仍继续。
- 重连使用快照或 `{ epoch, sequence }` 游标回放，不依赖时间戳。
- `RACP-WS` 是 v1 唯一规范绑定，首先部署在 SSH 隧道上；`RACP-HTTP` 是
  浏览器 profile，随 R4 绑定（D665），使用它的浏览器与移动客户端随 R6 交付；
  `RACP-GRPC` 保留。
- Host 是无头模块：会话与回合准入、回合队列、审批代理、事件日志和快照
  构建都不依赖 Electron，桌面 IPC、本地 MCP、RACP 和消息集成都是它的调用方。
- 远程会话完全存在于其 Host 上：transcript、工具、工作区、权限和 provider
  secret 都在运行 Host 的机器上，桌面只展示和控制。
- 用户本地化是结构性的：控制链路中没有任何项目方运营的服务，所有凭据由用户
  自己的 Host 签发，出站连接只有用户的 SSH 主机、用户配置的消息渠道与模型
  provider，以及只读的 GitHub Releases `agent-host-cli` 下载（D385）。
- 本地 stdio NDJSON JSON-RPC、Rust host-core 和 loopback MCP 保持不变。

## 2. 参考实现

设计参考 OpenAI Codex App Server、VS Code Agent Host、MCP Transport 和
Google A2A 的分层方式；SSH 隧道拓扑沿用 VS Code Remote-SSH 与 JetBrains
Gateway 的模式，服务端经用户自己的 SSH 会话引导，客户端通过转发的 loopback
端口连接。不恢复已撤回的子代理 A2A/Peer 协调通道。

## 3. 组件职责

| 组件 | 职责 | 不得拥有 |
|---|---|---|
| Remote Client | 展示状态、发送用户意图、回答审批和输入 | 工作区权限、provider 凭据、最终权限决定、prompt 队列 |
| 桌面 RACP 客户端适配层（Electron Main） | 通过现有 `lib/api.ts` 表面把远端 Host 呈现给 renderer；负责 SSH 引导、配对和端口转发 | 第二份 transcript 存储；在本地执行远端工具 |
| Agent Host | 拥有会话、回合、每会话回合队列、事件游标、附件、工具执行和生命周期 | 浏览器展示状态 |
| 无头 Agent Host 模块（`packages/agent-host`） | 会话/回合准入、回合队列、审批代理、内存事件日志、快照构建；向桌面 IPC、本地 MCP、RACP 和集成暴露同一套 API | Electron、renderer 或传输依赖；第二套权限或持久化实现 |
| `agent-host-cli` 无头包 | 在远端机器上以桌面同版本运行模块、Node pi sidecar 和 Rust host-core，只绑定 loopback，由引导脚本从 GitHub Releases 下载 | 桌面 UI、插件面板、其他 Host 的 secret |
| 消息集成适配层 | 在 Host 进程内订阅 Host 范围事件，把脱敏摘要转发到出站渠道；把固定指令词汇映射到回合与审批操作 | 自己的权限策略、入站监听器、原始 transcript 内容 |
| 自托管 Gateway（R4） | 以 Host 签发的设备凭据准入、路由、Host link、限流、审计、上传字节的瞬态缓冲、（保留）推送脱敏摘要 | provider secret、完整 transcript、host-core 访问、上传窗口之外的附件字节 |
| Node pi sidecar | 运行 pi Agent 和 provider stream | 远程认证、工作区策略、secret storage |
| Rust host-core | SQLite、工具、工作区、权限及待处理权限表、secret 和本地持久化 | 公网监听器 |

## 4. 部署拓扑

### 4.1 当前本地桌面

```text
Minih-Agent-Desktop
├── Electron Main
│   ├── Renderer
│   ├── Node pi sidecar
│   └── Rust host-core
└── optional loopback MCP
```

### 4.2 SSH 隧道上的远端 Host（首个远程拓扑）

```text
Minih-Agent-Desktop (Remote Client)              Remote machine
├── Renderer ── lib/api.ts ─┐           ┌── agent-host-cli (headless Agent Host)
├── Electron Main           │ RACP-WS   │   ├── packages/agent-host
│   └── RACP client adapter ┼─ over SSH ┼──▶│   ├── Node pi sidecar
└── local sessions          │ forward   │   │   └── Rust host-core (loopback)
    (unchanged)             │           │   └── workspace, ~/.agents, secrets
                            │           └── sshd
```

引导只走用户自己的 SSH 会话，不走 RACP：桌面用现有 SSH 配置登录，上传一段引导脚本，由它从
GitHub Releases 下载与桌面同版本的 `agent-host-cli` 包并校验公布的 SHA-256，启动它并绑定 loopback，经 SSH 通道拿到一次性
配对 token，转发本地端口后以 header profile 连接 `RACP-WS`，用配对 token 换取
设备 token 存入桌面安全存储；Host 把该桌面设备记为 `owner`。远端 Host 的
provider 配置由引导步骤经 SSH 通道写入，是 Host 本地配置，绝不经过 RACP。
Host 只绑定 loopback；只有绑定地址与对端地址都是 loopback且出示有效设备 token
时才接受明文 `ws://`，因为 SSH 通道已提供机密性，SSH 登录也已证明对该机器的
shell 访问。非 loopback 绑定仍要求 TLS 与设备 token。首版无法引导没有 GitHub 出网能力的机器。
已配对 Host 的版本落后于桌面时，桌面会复用同一套经校验的 SSH 引导把它升级到桌面版本，并在原处重新配对（ADR 0327）；
就绪检查比对的是桌面期望的版本，而不是配对时记录的版本，连接后还会核对远端是否提供远程工作区所需的服务。
自动升级每个桌面版本每台 Host 只尝试一次，失败后冷却，用户手动重连可再试，升级无效时仍显示原来的升级提示。

### 4.3 自托管 Gateway（R4–R6）

```text
Client ── HTTPS/WSS ── Gateway
                         │ outbound WSS Host link (relay)
                         ▼
                      Agent Host ── pi + Rust host-core
```

生产模式由 Agent Host 主动建立出站 Host link，Gateway 不要求桌面开放入站
端口。Host link 是中继 profile，复用多个逻辑客户端连接。PI 不运营 Gateway：
由用户在自己的基础设施上运行，并以 Host 签发的设备凭据准入（D385）。交付
范围、绑定规则与退出条件见 `06-delivery/07-remote-control-rollout.md` 的
R4 里程碑（D665，ADR 0331）。

账户模式（规划中，D666，ADR `remote-control-router-account-binding`）新增第二种部署：
Gateway 作为独立进程运行在维护者的 Minih-Router 旁，Host 经 Router 的 EasyTier 组网、
手机经公网 HTTPS 访问它。它服务多个账户，Router 的 AccessKey 只用于发现与注册，中继的
客户端仍以 Host 签发的设备凭据准入。交付见 `06-delivery/07-remote-control-rollout.md`
的 R7 里程碑。

### 4.4 桌面作为可连接的 Host（R5）

Electron Main 可以经出站 Host link 提供其进程内的 Agent Host，让手机观察并
操控运行中桌面的会话（D665，ADR 0331）。链路在现有 `agent-host-bridge.ts`
AgentHost 实例上运行独立的 `RacpServer` 传输：不新建 AgentHost、不新增执行
路径、不开监听。设置为 `AppSettings` 中可选、设备本地的 `remoteGateway`
字段（`enabled`、`url`；缺失即关闭、不同步），标记为实验性且默认关闭。设备
凭据与 mTLS 密钥材料保存在 main 进程，经 `EncryptionPort`（safeStorage）加密，
绝不进 SQLite、不改 host-core schema。中继主体遵守安全规格 §3.7 的设备来源
规则：绝不是 SSH 配对的 owner，始终受远程权限上限约束，不能修改本地会话的
权限模式。关闭开关、退出应用与 `before-quit` 都会断开链路并取消挂起的服务端
请求；渲染进程重载不会断开链路——链路归 main 进程所有，设置页重载后重新
订阅状态。本地回合全程不受影响。

## 5. 角色、队列、归属与事件同步

每个会话允许多个 viewer，但同一时间只允许一个活动回合。controller
可以启动、排队、停止或中断回合并回答输入请求，approver 只能在授权范围内
解决审批，owner 管理成员。排队中的回合是 Host 状态，由 host-core 持久化，重启后恢复并保持挂起直到有
controller 接入，本地桌面和所有远程客户端看到同一份队列。经 Gateway 路由的主体受远程权限上限约束；经 SSH 引导
配对的桌面设备持有 `owner` 并豁免上限，因为 SSH 访问已经超过上限能限制的一切；
Host 策略 `applyCeilingToPairedDevices`（默认关闭）可重新施加。

远程会话的归属划分：远端 Host 拥有 transcript 与 SQLite、回合与队列、内置工具
目录与工作区边界、权限与会话授权、provider secret、该机器 `~/.agents` 下的
skills 与子代理定义、该 Host 配置的 MCP 服务器和定时任务；桌面保留窗口与
shell、本地会话、本地应用的设置 UI、插件面板、浏览器预览和通知展示。桌面通过
`tools/advertise` 公布其用户配置的 MCP 服务器和不需要会话工作区的插件工具，它们
以中继工具身份出现在远程会话目录中，经 `tool/execute` 服务端请求在桌面自身的插件
权限下执行；需要工作区或文件系统访问的插件工具被排除，因为它们会作用于桌面的
文件系统。工作面板的文件列表、文件读取和 diff 使用远端 Host profile 操作；终端
通过 `terminal/*` 操作在远端机器运行并带有界回放环；浏览器预览留在本地。

Host 为每个会话生成 `epoch`，并在其中为持久事件分配严格递增的
`sequence`。delta、工具进度和活动阶段是瞬态事件，只带 `afterSequence`，
不进入回放窗口；快照的 `activeItems` 携带它们累计的内容。首个实现把持久
日志放在 Host 进程内存，Host 重启即开启新 epoch。

```text
cursor in current epoch and retained -> replay durable sequence > after
epoch changed or cursor evicted      -> resync.required + snapshot
cursor ahead                         -> reject and refresh snapshot
```

```text
Client -> initialize / attach / subscribe
Client -> turn/start (admission)
Host   -> turn.queued | turn.started, ordered events
Host   -> approval/request or input/request when required
Client -> approval/respond | input/respond
Host   -> turn terminal event, next queued turn starts
```

远程审批使用与桌面相同的决策词汇：工具审批为 `allow-once`、
`allow-session`、`deny`；Plan/Goal 审批为带显式权限模式的 `approve` 或
`reject`；asktool 输入支持逐题回答或跳过。修改持久模式使用远端 Host profile
的 `session/configure`，与本地一样仅限空闲时。审批寿命由 Host 策略决定：本地桌面权限确认
没有自动截止时间；有远程订阅者接入时，远程审批记录默认 30 分钟（D375），有界且可由运维调整。

## 6. 传输档案

| Profile | Intended client | Direction | Status |
|---|---|---|---|
| Local stdio JSON-RPC | Electron Main / sidecars | Full duplex | Existing |
| RACP-WS | 经 SSH 的桌面客户端、Native、Electron | Full duplex | v1 规范绑定，首先部署在 SSH 隧道上 |
| RACP-HTTP | Browser、simple integrations | Commands + server stream | 浏览器 profile，随 R4 绑定（D665），浏览器与移动客户端随 R6 交付 |
| RACP-GRPC | Native service | Unary + server stream | 保留，不在 v1 |
| Host link `racp-hostlink.v1` | Gateway → Host | Multiplexed full duplex | 基于 RACP-WS 帧的中继 profile，随 R4 交付（D665） |

## 7. 故障与迁移

| Failure | Required behavior |
|---|---|
| Client disconnect | 回合继续，保留持久事件回放窗口 |
| Client reconnect | 重新认证，按游标回放或返回快照 |
| SSH tunnel drop | 桌面适配层重建转发并按游标恢复，远端回合继续 |
| Gateway disconnect | Host 有界退避重连 Host link，本地回合继续 |
| Host unavailable | 拒绝新的 mutation，不自动重放 |
| Host restart | 新 epoch，客户端从快照重同步，持久化的队列按序恢复并挂起到 controller 接入，已开始的工作不重放 |
| Host crash | 使用现有恢复策略，已中断工作不自动重放 |
| Duplicate mutation | 相同主体和 key 返回原 idempotent 结果 |
| Durable event gap | 停止应用并请求快照 |
| Slow client | 先丢弃瞬态事件，丢失持久事件前带游标断开 |
| Expired approval | 返回 `APPROVAL_EXPIRED`，不执行工具 |

首个实现交付无头 `packages/agent-host` 模块，Electron Main 承载它，现有 IPC
handler 成为它的适配层；随之落地 host-core 的 `permissions.pending` 读取和用
host-core 持久化的 Host 队列替换 renderer 内存队列（需单独 ADR 与 schema 升级，
D375）。SSH 隧道里程碑再加两件东西而不改线上契约：`agent-host-cli` 包，以及位于
`lib/api.ts` 之下的桌面 RACP 客户端适配层；同一里程碑还包含 `tools/advertise` /
`tool/execute` 中继与 `terminal/*` 操作。消息集成是
模块在 Host 进程内的又一个调用方，不需要任何传输。

## 8. 验收要点

远程客户端不能取得 host-core、IPC、`host.proxy` 或 provider secret；回合
断线后仍可继续；晚接入的客户端能看到已打开的审批；经 Gateway 的回合不超过
权限上限；远程会话的 transcript、工具、工作区和 secret 都在远端 Host，桌面
只保留展示状态；远程会话的目录包含远端 Host 的工具与桌面公布的中继工具，中继
工具只在桌面执行；会话终端在远端机器的会话根内运行且只对策略允许的主体开放；回放、审批、幂等和
所有已发布绑定的一致性测试必须通过；无头模块的测试不依赖 Electron。

D665（2026-10-17，ADR 0331）排期 Gateway 与浏览器拓扑：R4 为自托管 Gateway 与
Host link，R5 为桌面作为可连接的 Host，R6 为浏览器与移动客户端。§4.3 去掉
不排期状态，§4.4 新增桌面可连接 Host 拓扑（设备本地的 `remoteGateway` 设置、
`EncryptionPort` 加密凭据），归属一节记录 Gateway 的具体存储布局。

详见英文源规格中的完整组件归属、迁移边界和验收条款。

## 2026-10-21 新增：同账号电脑自动接入（R8，D675）

ADR `remote-control-router-account-binding` 修订 3 在 R7 之上加一条拓扑：同一账号的
另一台电脑不再依赖 SSH，而是经 Gateway 接入兄弟电脑。

- **客户端传输**：桌面作为 Remote Client 走 `RACP-WS`
  （`GET /v1/hosts/{hostId}/ws`），命令、事件与服务端请求共用一条连接；`RemoteHostTransport`
  新增 `"account"`。手机继续用 `RACP-HTTP` + SSE，不变。
- **设备类别与证明**：`device.request` 新增 `client: "desktop"` 与 `hostProof`（申请方
  `hostId`、Gateway 为本次请求签发的一次性 nonce，以及用本机 Host 证书私钥对
  `{requestId, nonce, applicantHostId, accountId, expiresAt}` 的签名）。**由目标 Host
  自己校验**：证书链到它固定的 Gateway CA、`OU=account:<accountId>` 与本账号一致、
  签名正确、nonce 未用过且未过期；Gateway 的预检只是快速拒绝，不是授权依据（ADR 0331
  「Gateway 从不做批准决定」仍然成立），被攻破的 Gateway 不能凭空造出 `owner` 设备。
- **自动接入与开关**：目标电脑开启「允许同账号电脑自动接入」（默认开、设备本地、不同步）
  时无需人工确认即授予；关闭时或处于 strict mode 时回落到 R7 的逐设备确认，且不按桌面类
  采纳。兄弟 `device.grant` 由每台接收的 Host 重新校验证明并检查自己的开关后才以 `owner`
  采纳。目标电脑须先声明 `device.desktop-auto`，否则不发新帧，申请方显示「该电脑需要升级」。
  每次自动接入都会通知并写审计；账号内有新电脑注册时，其他每台电脑都显示「有新电脑加入
  账号」并写审计。
- **角色**：桌面类设备持有 `owner` 并豁免远程权限上限（与 SSH 配对的桌面设备同级），这是
  ADR 0331 网关来源限制的唯一例外，已记录在该 ADR；`owner` 依附于申请方的证书，证书被
  吊销则其接入的设备一并失去。手机与浏览器设备仍是 `viewer` / `controller` / `approver`，
  仍受上限约束、仍不给 `allow-session`。具体开放哪些桌面操作由 Host 逐项决定（R8 工作包 D）。
- **Agent 运行位置**：选中 B 的项目时回合在 B 上运行，使用 B 自己的 provider 配置与
  B 自己的 Router 账号调用模型；A 只是远程界面，凭据不跨机器。Gateway 路径不需要
  `workspace/toolExecute`：工具由 B 自己的 Agent 在 B 上执行。SSH 主机保留既有
  「本地 Agent + 远程工具」形态。
- **默认开关**：Router 公布 Gateway 且账号 key 可解析时，桌面的远程控制开关对「从未选择
  过」的用户默认开启；用户明确关闭过的保持关闭。自托管流程仍默认关闭（安全规范 §3.7/§3.8
  与 gate 27 相应修订，新增 gate 35）。

本页仍是英文源规格的中文导读；完整的帧定义、退出条件与验收场景见英文
`02-architecture/05-remote-agent-control.md` §5.3/§5.4/§6、`03-runtime/19-…` §11.4/§11.5、
`06-delivery/07-remote-control-rollout.md` R8 与
`E2E-REMOTE-ACCOUNT-desktop-auto-joins-sibling-desktop`。
