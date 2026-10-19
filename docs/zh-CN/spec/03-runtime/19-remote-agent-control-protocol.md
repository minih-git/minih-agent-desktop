# 19. 远程 Agent 控制协议

- 协议：`PI Remote Agent Control Protocol`（`RACP`）
- 版本：`1.0`
- 状态：目标规格，属于 MVP 之后。MVP 本身不包含远程控制；MVP 后 Gateway 与浏览器
  里程碑已由 D665（ADR 0331）排期为 R4–R6
- 决策：D373 / ADR 0205，经 D374、D375 与 D665 修订
- 英文源规格：[英文源规格](/spec/03-runtime/19-remote-agent-control-protocol)

英文页面是规范源。本页保留协议字段、方法名、错误码和代码结构，便于
中文读者检索；实现必须以英文规范中的完整定义为准。

## 1. 边界与术语

RACP 控制 Agent Host，不是 Electron IPC、`host.proxy`、Rust host-core
协议、provider proxy、本地 MCP 或子代理 A2A/Peer 协议。RACP v1 是桌面本地
能力的严格子集；§3 的远端 Host profile 是让桌面本身成为另一台机器上 `agent-host-cli`
的客户端所需的 v1.1 扩展（D375），仍推迟的操作在保留表中列名。

| Term | Meaning |
|---|---|
| Host | 拥有会话并执行回合的 Agent Host |
| Client | 控制 Host 的 UI、CLI、原生应用或服务 |
| Gateway | 可选的认证路由层 |
| Session | 持久化会话及工作区/项目绑定 |
| Turn | 一次已准入 prompt 的完整生命周期，等于本地 `agent/prompt` 返回的 `turnId`，不是一个 `turn_start`/`turn_end` 模型轮次 |
| Item | 回合中的持久单位：消息、工具调用或压缩检查点 |
| Event | 会话或 Host 的有序状态/进度通知 |
| Durable event | 获得序号并保留用于回放的事件 |
| Ephemeral event | 实时投递、不编号、不回放的进度事件 |
| Epoch | Host 为会话一段连续序列流生成的标识 |
| Cursor | 会话持久事件流中的 `{ epoch, sequence }` 位置 |
| Principal | 认证后的用户、设备、服务或 Gateway 身份 |
| Binding | RACP 操作的传输编码 |
| Host link | Gateway 到 Host 的出站连接，中继多个逻辑客户端连接 |

## 2. 初始化和消息

连接必须先发送 `connection/initialize`，完成响应和
`notifications/initialized` 后才能使用其他方法。响应带有能力、限制和只读的
`policy`（远程权限上限、审批寿命）。JSON-RPC over WSS 每帧一个 UTF-8 消息；
HTTP/SSE 使用 POST 命令和带 `Last-Event-ID` 的事件流。资源以
`packages/shared` 中的 typebox schema 为唯一来源，JSON Schema 与未来的 proto
均由其生成。

```json
{"jsonrpc":"2.0","id":"init-1","method":"connection/initialize"}
```

```json
{"protocolVersion":"1.0","capabilities":{"turnQueue":true,"hostEvents":true,"remoteHostProfile":true,"toolRelay":true,"terminal":true},"bindings":["RACP-WS"],"policy":{"remoteMaxPermissionMode":"ask","applyCeilingToPairedDevices":false,"approvalLifetimeMs":1800000}}
```

```ts
type RequestContext = { requestId: string; idempotencyKey?: string; expectedRevision?: number }
```

```ts
type Session = { id: string; title: string; mode: "agent" | "plan" | "goal"; planningState: string; queuedTurnIds: string[]; revision: number }
```

```ts
type Turn = { id: string; sessionId: string; status: "queued" | "running" | "completed" | "interrupted" | "canceled"; admission: "reject_if_busy" | "queue"; effectivePermissionMode: string }
```

```ts
type EventEnvelope = { scope: "session" | "host"; epoch: string; sequence?: number; afterSequence?: number; revision: number; kind: string; parentToolCallId?: string; payload: unknown }
```

```ts
type SessionSnapshot = { session: Session; items: ItemSummary[]; activeItems: ItemSummary[]; queuedTurns: Turn[]; pendingApprovals: ApprovalRequest[]; cursor: { epoch: string; sequence: number }; revision: number }
```

```ts
type ApprovalRequest = { id: string; kind: "tool" | "plan" | "goal"; allowedDecisions: string[]; allowedPermissionModes?: string[]; expiresAt: string }
type InputRequest = { id: string; turnId: string; questions: Array<{ id: string; question: string; options: string[]; multiSelect: boolean }> }
```

```ts
type Attachment = { id: string; sizeBytes: number; sha256: string; status: string }
```

```ts
type HostSummary = { id: string; label: string; status: "online" | "offline" }; type ProjectSummary = { id: string; label: string }
```

```json
{"sessionId":"ses_01J","role":"controller","after":{"epoch":"ep_7f","sequence":314}}
```

```json
{"session":{"id":"ses_01J"},"replayComplete":true,"snapshot":{"cursor":{"epoch":"ep_7f","sequence":314}}}
```

```json
{"scope":"session","sessionId":"ses_01J","after":{"epoch":"ep_7f","sequence":314}}
```

```json
{"subscriptionId":"sub_01J","starting":{"epoch":"ep_7f","sequence":315},"replayComplete":true}
```

```json
{"sessionId":"ses_01J","idempotencyKey":"turn-client-7f9c","admission":"queue","input":{"text":"Inspect the test."}}
```

```json
{"accepted":true,"turn":{"id":"turn_01J","status":"queued","effectivePermissionMode":"ask"}}
```

```json
{"turnId":"turn_01J","reason":"user_requested"}
```

```json
{"approvalId":"approval_01J","status":"resolved","decision":"allow-session","alreadyResolved":false}
```

```json
{"sessionId":"ses_01J","beforeItemId":"item_01J","limit":100}
```

```json
{"jsonrpc":"2.0","id":"server-request-42","method":"approval/request"}
```

```text
POST /v1/approvals/{approvalId}:respond
```

```ts
type HostLinkFrame = { link: "racp-hostlink.v1"; type: "client.open" | "client.message" | "host.message" | "attachment.chunk" | "host.capabilities" | "device.request" | "device.grant" | "device.revoke"; clientConnectionId?: string; credential?: string }
```

```ts
type RemoteError = { code: string; message: string; retriable: boolean; traceId: string }
```

本地事件到 RACP 事件的映射固定如下；回合范围事件的 `payload.event` 原样携带
共享的 `AgentEvent`：

| Local `AgentEvent.type` | RACP `kind` | Durable | Notes |
|---|---|---|---|
| `agent_start` | `turn.started` | yes | 排队准入时先有 `turn.queued` |
| `agent_end` | `turn.completed` / `turn.interrupted` | yes | 中止或停止时为 `interrupted` |
| `error`（终止） | `turn.failed` | yes | 携带归一化 `AppError` |
| `turn_start`、`turn_end`、`status` | `turn.activity` | no | 模型轮次与活动阶段 |
| `message_start` | `item.started` | yes | `itemType: "message"` |
| `message_update` | `item.delta` | no | 内容在 `item.completed` 中完整 |
| `message_end` | `item.completed` | yes | 完整 `UiMessage` |
| `tool_start` | `item.started` | yes | `itemType: "tool"` |
| `tool_update` | `tool.progress` | no | 部分结果在 `item.completed` 中完整 |
| `tool_end` | `item.completed` | yes | 完整结果 |
| `compaction_start`、`compaction_end` | `item.started`、`item.completed` | yes | `itemType: "compaction"` |
| `planning_state`、`plans.changed` | `session.changed` | yes | 规划投影与契约审批状态 |
| `tool_permission_request` | `approval.requested` | yes | `kind: "tool"` |
| 带 `pending` 提案的 host `plans.changed` | `approval.requested` | yes | `kind: "plan"` 或 `"goal"`；解决时发出 `approval.resolved` 和 `session.changed` |
| `asktool_request` | `input.requested` | yes | 与本地 asktool 卡片相同的问题 |

`turn.completed` 对应本地 `agent_end`，而不是只关闭一个模型轮次的 `turn_end`。
`terminal.changed`（持久）记录终端的打开、关闭或退出；`terminal.output`（瞬态）
携带 pty 字节，只能从终端的有界回放环恢复，绝不来自事件日志。

## 3. 资源和操作

会话由 Host 持久化并拥有 revision；回合是异步执行单位，可立即准入或进入
Host 队列；持久事件使用每 epoch 递增且不复用的 `sequence`；附件只能通过受
校验的 opaque id 引用。

| Operation | Role | Behavior |
|---|---|---|
| `connection/initialize` | authenticated | 协商协议、能力、限制和策略 |
| `connection/ping` | authenticated | 返回连接健康和服务器时间 |
| `host/list` | authenticated | 列出主体可见的 Host，仅 Gateway 部署 |
| `project/list` | viewer | 列出主体可在其下创建会话的项目 |
| `session/list` | viewer | 列出主体可见会话 |
| `session/get` | viewer | 返回会话元数据和状态 |
| `session/create` | controller | 在授权项目 id 下创建会话 |
| `session/attach` | viewer | 建立会话角色并返回快照 |
| `session/history` | viewer | 从某个 item id 向前分页已完成条目 |
| `events/subscribe` | viewer | 按游标订阅会话流或 Host 流 |
| `events/unsubscribe` | viewer | 移除订阅 |
| `events/ack` | viewer | 确认已应用的最高持久序号 |
| `turn/start` | controller | 立即准入或进入 Host 队列并返回 `turnId` |
| `turn/get` | viewer | 返回回合状态 |
| `turn/stop` | controller | 在当前助手/工具边界后结束回合，幂等 |
| `turn/interrupt` | controller | 立即中止回合，对排队回合等同取消，幂等 |
| `turn/cancel` | controller | 移除尚未开始的排队回合，幂等 |
| `turn/prioritize` | controller | 把排队回合移到会话队列头部，幂等 |
| `approval/respond` | approver | 解决活动审批请求 |
| `input/respond` | controller | 解决活动输入请求 |
| `attachment/create` | controller | 预留有界附件槽位 |
| `attachment/complete` | controller | 校验附件 hash 和大小 |
| `tools/advertise` | owner | 公布在客户端执行的会话工具；替换该连接此前的集合；断开即清除 |
| `session/revoke` | owner | 撤销客户端或会话成员资格 |
| `session/archive` | owner | 归档空闲会话 |

远端 Host profile（v1.1，rollout R2 必需）：当桌面是另一台机器上 `agent-host-cli` 的
客户端时，renderer 期望本地拥有的会话控制。这些操作从 v1.1 起属于契约，通过
`remoteHostProfile` 能力公布，各自保持本地规则：配置与 fork 仅限空闲，删除仅限
owner，工作区读取都按会话持久根、Host 忽略规则和 `PATH_OUTSIDE_WORKSPACE` 边界解析。

| Operation | Role | Behavior |
|---|---|---|
| `session/configure` | controller | 空闲时修改模式、provider/模型、思考等级或权限模式，规则同 `minih-agent-desktop/session/configure` |
| `session/fork` | controller | 将空闲会话（可指定消息 id）fork 为新的空闲会话 |
| `session/rename` | controller | 重命名会话 |
| `session/deriveTitle` | controller | 对仍未命名的会话应用 Host 确定性的首条提示标题；返回 `{ updated }`，永不覆盖重命名 |
| `session/delete` | owner | 删除会话及其在 Host 上的 transcript |
| `session/compact` | controller | 对活动会话执行手动上下文检查点 |
| `workspace/list` | viewer | 有界列出会话根下的条目，遵守 Host 忽略规则 |
| `workspace/read` | viewer | 读取会话根下的一个有界文件，图片以 data URL 返回 |
| `workspace/diff` | viewer | 返回会话根的工作树 diff |
| `terminal/open` | controller | 在 Host 上以会话根为 cwd 打开 pty；返回终端 id 与有界回放环；受策略限制 |
| `terminal/input` | controller | 向已打开终端写入字节 |
| `terminal/resize` | controller | 调整已打开终端尺寸 |
| `terminal/close` | controller | 关闭终端，幂等 |
| `connection/pair` | authenticated | 用升级请求携带的一次性配对令牌换取设备凭证（安全规格 §3.4）；仅在配对连接上有效（D448） |
| `project/register` | owner | 将 Host 上的目录注册为项目：Host 规范化并校验路径，返回项目 id（D448） |
| `project/browse` | owner | 列出 Host 某路径下的目录，有界，供远程目录选择器使用（D448） |

仍推迟的本地操作：

| Reserved operation | Local equivalent | Why deferred |
|---|---|---|
| 逐回合模型或思考等级覆盖 | composer 下一回合配置 | `session/configure` 覆盖空闲情形；逐回合覆盖需单独策略评审 |
| provider、secret 和 vendor 账号管理 | settings 与 secrets IPC | 明确超出范围；远端 Host 的 provider 经 SSH 引导通道配置 |

## 4. 游标、队列、审批和附件

客户端重连时发送 `after: { epoch, sequence }`。游标仍在当前 epoch 的窗口内
则只回放持久事件，epoch 变化或游标被驱逐则返回 `resync.required` 和完整快照，
不能猜测丢失事件。首个实现把持久日志放在 Host 进程内存，Host 重启即开启新
epoch；把日志放入 host-core 需要单独的 ADR。

`turn/start` 默认 `reject_if_busy`，忙时返回 `AGENT_BUSY`；`admission: "queue"`
进入 Host 拥有的每会话队列，所有客户端（含本地桌面）看到同一份队列；`turn/prioritize` 把排队回合移到队列头部
（桌面的“立即发送”），不触碰正在运行的回合，想让它在下一个边界启动的客户端再调用
`turn/stop`。排队回合及其
幂等 key 由 host-core 持久化（D375），Host 重启后按序恢复并保持挂起，直到有
controller 接入才继续释放，重启绝不无人值守地启动工作。远程主体
发起的回合运行在会话权限模式与 Host `remoteMaxPermissionMode`（默认 `ask`）
中较低者之下，结果以 `effectivePermissionMode` 报告，不改变持久会话模式。经 SSH
配对的桌面设备默认豁免上限，Host 策略 `applyCeilingToPairedDevices` 可重新施加。

反向工具中继：作为 `owner` 配对的桌面可用 `tools/advertise` 公布在桌面执行的工具，
即用户配置的 MCP 服务器和不需要会话工作区的插件工具；Host 在公布连接存活期间把
它们并入该会话目录。Agent 调用时 Host 先走正常权限流程，再向公布连接发送
`tool/execute` 服务端请求，客户端在本地插件权限与确认规则下执行并返回有界结果。
中继工具绝不在 Host 运行、绝不收到 Host secret；截止时间是工具自身超时；公布连接
断开则工具以 `TOOL_FAILED` 失败而回合继续；需要工作区或文件系统访问的插件工具不被
接受。

```json
{"jsonrpc":"2.0","id":"server-request-77","method":"tool/execute","params":{"executionId":"exec_01J","toolName":"mcp_corp_search"}}
```

审批决策是本地词汇的超集：工具审批为 `allow-once`、`allow-session`、`deny`；
Plan/Goal 审批为带显式 `permissionMode` 的 `approve` 或 `reject`，且是跨回合的
会话级转换；asktool 回答为 `Array<string[] | null>`，`null` 表示跳过。待处理请求
是 Host 状态，host-core 通过 `permissions.pending` 提供读取，晚接入的客户端在
快照中看到它们；首个有效决定生效，之后的有效响应返回 `alreadyResolved`。审批
寿命由 Host 策略决定：本地桌面权限确认没有自动截止时间，会一直保持待处理直到明确决定、
取消或关闭；有远程订阅者接入时，远程审批记录默认 30 分钟（D375），Host 可在上限内调整，
断线不会延长它。

大附件使用 `attachment/create`、HTTPS 上传和 `attachment/complete`；
远程本地路径、`file://` 和任意 URL 都不允许作为附件来源。经 Gateway 时上传
目标由 Gateway 提供，字节以有界分块经 Host link 到达 Host，Gateway 在
`attachment/complete` 成功或过期后删除副本。

## 5. 传输映射

| Operation family | HTTP mapping |
|---|---|
| Capabilities | `GET /v1/capabilities` |
| List hosts (Gateway only) | `GET /v1/hosts` |
| List projects | `GET /v1/projects` |
| List sessions | `GET /v1/sessions` |
| Create session | `POST /v1/sessions` |
| Get/attach session | `GET /v1/sessions/{sessionId}` / `POST ...:attach` |
| Session history | `GET /v1/sessions/{sessionId}/history` |
| Start turn | `POST /v1/sessions/{sessionId}/turns` |
| Get turn | `GET /v1/turns/{turnId}` |
| Stop / interrupt / cancel turn | `POST /v1/turns/{turnId}:stop` / `:interrupt` / `:cancel` |
| Prioritize turn | `POST /v1/turns/{turnId}:prioritize` |
| Session event stream | `GET /v1/sessions/{sessionId}/events` |
| Host event stream | `GET /v1/events` |
| Pair a device (Gateway only) | `POST /v1/hosts/{hostId}/pair` |
| Resolve approval | `POST /v1/approvals/{approvalId}:respond` |
| Resolve input | `POST /v1/inputs/{inputId}:respond` |

`RACP-WS` 是 v1 唯一规范绑定，首个部署（rollout R2）是远端机器上只绑定 loopback
的 `agent-host-cli`，桌面经 SSH 端口转发以 header profile 和 SSH 引导配对得到的设备 token
连接，绑定与对端都是 loopback 时才接受明文 `ws://`；`RACP-HTTP` 是浏览器 profile，
随 Gateway 与浏览器里程碑（R4–R6，D665）交付，绑定在 R4 生效并在任何浏览器客户端
使用前与 `RACP-WS` 一起加入一致性 fixture；`RACP-GRPC` 保留，若采用则 `.proto` 由
typebox 来源生成。

自托管 Gateway（`ADR 0331`）在同一个映射之上加一层 Host 前缀，一个 Gateway 可以同时
服务多个 Host：客户端把 baseUrl 设为 `https://<gateway>/hosts/{hostId}`，表内映射不变。

- 前缀之外的网关级接口：`GET /healthz`（无需鉴权，返回 `{ ok, version }`）、
  `GET /v1/hosts`（调用者设备可访问的 Host，含 `online`）、
  `POST /v1/hosts/{hostId}/pair`，以及仅在账户模式下存在的
  `POST /v1/account/login` 与 `GET /v1/account/hosts`（见 §11.5 账户模式）。这两条账户
  路由是唯一接受 AccessKey 派生凭据的地方：`GET /v1/hosts` 与所有
  `/hosts/{hostId}/...` 路由只接受设备令牌；未启用账户模式的 Gateway 与任何未知路径
  一样对这两条路由返回 `NOT_FOUND`。
- 命令请求体为 `{ jsonrpc, id, method, params, idempotencyKey? }`。`method` 与路由不一致
  返回 `INVALID_ARGUMENT`；`idempotencyKey` 放到该操作 schema 规定的位置，只有
  `turn/start` 有（`params.idempotencyKey`），其它操作携带幂等键同样是
  `INVALID_ARGUMENT`。成功响应为 `{ result }`，失败为
  `{ error: { code, message, data: RemoteError } }`，HTTP 状态码按 §6（错误）映射。
  路径参数是唯一来源：请求体用不同值重复同一个路径参数同样返回 `INVALID_ARGUMENT`。
- GET 路由的非路径参数通过查询字符串传递，路由表逐条声明允许的 key 与类型
  （`RACP_HTTP_QUERY_PARAMS`）：

  | 路由 | 查询参数 |
  | --- | --- |
  | `GET /v1/sessions/{sessionId}/history` | `beforeItemId`（`string`）、`limit`（`integer`） |
  | 其余路由 | 无 |

  未声明或重复出现的 key 返回 `INVALID_ARGUMENT`；`integer` 不是带符号十进制字面量、
  `boolean` 不是 `true`/`false` 同样返回 `INVALID_ARGUMENT`。网关把解析出的值合并进
  转发的参数，路径参数仍然优先。URL 中一律不接受凭据和事件游标：游标走
  `Last-Event-ID`。
- 每条中继逻辑连接都单独执行 `connection/initialize`，`bindings` 为 `["RACP-WS"]`
  （Host link 的帧格式），声明客户端能力 `eventReplay`、`hostEvents`、`history`、
  `turnQueue` 为 `true`，`approvals`、`inputRequests`、`toolRelay`、`terminal`、
  `attachments` 为 `false`。Host 若仍发起服务端请求，网关回答
  `CAPABILITY_UNAVAILABLE`，绝不为用户做决定。
- 浏览器 profile 使用两个作用域为 `Path=/hosts/{hostId}`、`Max-Age=34560000`（400 天，
  Chromium 上限）的 cookie，配对结果因此可以跨浏览器重启保留：`HttpOnly` 的设备令牌
  （`racp_device`）和页面可读的 `racp_csrf`，其值为
  `HMAC-SHA256(gateway-secret, deviceId)`。每个修改类请求都要在 `x-csrf-token` 中重放
  该值。cookie 鉴权的请求必须带白名单内的 `Origin`；唯一例外是浏览器同源
  `GET`/`HEAD`（`Sec-Fetch-Site: same-origin`，H5 的读取与事件流都是这种形态）。
  `Origin` 存在但不在白名单内一律拒绝，修改类请求永不豁免；CORS 绝不返回 `*`。
  撤销仍在服务端生效：已撤销令牌返回 `401`。
- 命令按 `(device, host)` 复用一条逻辑连接，每个事件流单独占一条，每设备最多 4 条流，
  避免占满 Host 的 `maxConnectedClients`。Host link 随 R4 交付（D665，ADR 0331），SSH 隧道拓扑不使用它。
浏览器
无法在 WebSocket/EventSource 上设置请求头，因此非浏览器客户端用
`Authorization` 头（header profile），浏览器客户端用 HttpOnly cookie + Origin 白名单
+ CSRF token（cookie profile）；两者都禁止 URL 中的 token。Host link
（`racp-hostlink.v1`）在一条出站连接上复用逻辑客户端连接，服务端发起的请求按
`clientConnectionId` 中继并在同一逻辑连接上应答；Gateway 不得改写其中的消息。
`client.open` 帧携带 `credential` 字段（客户端原始 bearer token），Host 用自己的
`DeviceTokenAuthenticator` 以连接来源 `"gateway"` 重新验证每条逻辑连接，Gateway 缓存的
令牌哈希只用于路由前快速拒绝和限流；自托管场景下 route context 的完整性由已认证的
Host link 保证，`credential` 绝不出现在日志或审计记录中。注册与配对使用同一监听器：
管理员用 `remote-gateway enroll-code --label <name>` 打印 15 分钟有效的一次性注册码，
Host 本地生成密钥对并把 CSR 与注册码用 `POST /v1/enroll` 发到 Host link 端口（仅服务端
TLS 认证，不要求客户端证书），链路本身是 `wss://<gateway>:<port>/v1/hostlink`，Host 用 `--gateway-ca` 固定网关身份，指纹不匹配即拒绝，
网关签发一年期、CN 为 `hostId` 的客户端证书；配对时 Host 在本机显示 10 分钟有效的
一次性配对码；由于配对接口是 Host 作用域的、cookie 路径又不会暴露 `GET /v1/hosts`，
Host 同时把该配对码打印成票据 `mpt1:<hostId>:<pairingToken>`——一行可复制粘贴的文本，
同时给出 Host 标识和配对令牌（桌面设置页与 `agent-host-cli remote-pair` 都输出它；
票据是机密，绝不放进 URL）。客户端调用 `POST /v1/hosts/{hostId}/pair`，网关以配对令牌作为
`credential` 打开逻辑连接并依次执行 `connection/initialize` 与 `connection/pair`，
Host 签发网关来源（安全规格 §3.7）的设备令牌，网关只记录
`{ deviceId, hostId, sha256(token), label, createdAt }`，并以
`HttpOnly; Secure; SameSite=Strict; Path=/hosts/{hostId}; Max-Age=34560000` cookie
加 CSRF token（浏览器）或在响应体中返回 `{ deviceId, token }`（原生，存入 Keychain /
Keystore）交付令牌。

### 账户模式（D666，账户目录已实现）

账户模式把 Minih-Router 的 AccessKey 绑定到 Host 与设备（ADR
`remote-control-router-account-binding`），是**可追加**能力：上一节的全部条款保持
原义，没有 Router key 的用户继续使用自托管注册码与每 Host 票据。

Gateway 账户目录——key 校验、按 key 注册、账户登录、账户主机列表，以及设备申请 / 确认 /
授权中继——已实现（交付 R7 工作包 C 与 D）。能询问本机用户的 Host 在链路上声明
`device.confirm`，账户内任一 Host 上的一次确认即签发一个全账户可用的设备令牌，下列条款
均按定稿实现。

- **key 校验**：Gateway 经 loopback 调用 Router `GET /api/auth/session`，以
  `Authorization: Bearer <AccessKey>` 查询，并把调用者真实地址放进 Router
  `CLIENT_IP_HEADER` 指定的头里转发。Gateway 的 loopback 对端必须在 Router 的
  `TRUSTED_PROXIES` 内，否则 Router 会忽略该头，按 `127.0.0.1` 评估
  `allowed_peer_cidrs`。账户即应答中的 `access_key_id`。只有 `code: 0` 且 `data` 同时
  满足 `authenticated: true`、`principal_type: "access_key"`、`access_key_id` 为正整数
  的应答才算校验通过：管理员主体、未认证应答、Router 自身的错误信封都是拒绝；Router
  不可达、超时、返回 `500` 及以上状态码或无法解析的响应体是**可重试错误，绝不是通过**。
  被锁定是单独的一类结果：Router 对同一地址连续认证失败后返回的 `429`（带 `Retry-After`
  与 `{ code: "AUTH_LOCKED", data: { retry_after_seconds } }`）一律报为
  `RATE_LIMITED`（可重试），延迟取 Router 自己的值并同时写进消息与 `Retry-After`
  响应头，绝不报成 key 无效。Gateway 不保留 AccessKey 的任何摘要：一次登录留下的唯一
  持久状态是它签发的会话凭据哈希，且校验结果绝不缓存——每次登录都重新调用 Router。
- **客户端地址**：Gateway 仅在 TCP 对端位于其配置的可信代理集合内时才从配置的头读取
  调用者地址，否则采用对端地址。头名与可信代理是同一项设置：只配一半则拒绝启动，因为
  没有可信对端的头名永远不会被读取，没有头名的可信对端也解析不出任何地址。
  `X-Forwarded-For` 按链解析——从右向左取第一个不在可信代理集合内的条目，若全部可信则
  取最左条目——其他头只承载一个地址；条目不是 IP 地址时回退到对端，因为畸形链证明不了
  任何东西。该规则与 Router 自身解析器（`internal/platform/utils/client_ip.go`）一致，
  因此 Gateway 转发的地址在两端含义相同。解析出的地址用于按 IP 限流与审计记录，也是
  Gateway 转发给 Router 的值。两个设置都不给时，解析结果就是 TCP 对端地址，与账户模式
  之前完全一致。
- **密钥生命周期**：轮换保留账户，因为 Router 保留 id。被禁用或删除的 key 在
  `GET /api/auth/session` 上失败（Router 只索引 active 的 key），因此用它发起的新登录
  与新注册都会失败。key 状态本身不撤销任何东西：已批准的设备令牌与已签发的 Host 证书在
  经既有撤销路径撤销之前保持有效。Host 的链路仍可能因网络原因中断：组网按 key 签发
  凭据时，key 被禁用或删除的 Host 无法刷新 bootstrap，链路只能维持到该凭据过期。
- **按 key 注册 Host**：Router 的 bootstrap 应答新增可选的
  `remoteGateway {hostlinkUrl, publicOrigin, caPem}`。Host link 端口上的
  `POST /v1/enroll` 从此只接受一种凭据：自托管的 `enrollmentCode`，或
  `Authorization: Bearer <AccessKey>` 且请求体不带该字段。两种方式都必须带 `hostId`
  与 `csr`，不接受其他字段；自托管请求体不变，`agent-host-cli` 与桌面保持兼容。
  Gateway 校验 key 后把 Host 记在该账户下，并签发把 `hostId` 绑定到账户的客户端证书：
  主题 DN 为 `CN=<hostId>` 后接 `OU=account:<accountId>`，Host 从兄弟 Host 的证书读回
  该属性以确认签名者属于同一账户；没有该属性的证书属于自托管流程，不属于任何账户。
  Gateway 拒绝已注册在另一账户下的 `hostId`、以注册码而非该账户 key 提交的已绑定
  `hostId`、以 AccessKey 提交但未证明持有该 Host 现有证书所认证密钥的自托管
  `hostId`、校验不通过的 key，以及不可达的 Router。注册错误码为
  `ACCESS_KEY_INVALID`（401）、`ACCESS_KEY_UNAVAILABLE`（503，可重试）、
  `HOST_ACCOUNT_MISMATCH`（403）与 `RATE_LIMITED`（429，可重试）。该端点的客户端
  地址是 Host link 的 TCP 对端：该端口直接在组网上可达，从不经过客户端代理。应答缺少
  该对象或返回 `404` 表示账户模式不可用，Host 改用自托管注册码。`agent-host-cli enroll`
  从 `--access-key-file <path>`（普通文件、权限 0600、属主为调用者）、`--access-key-stdin`
  或 `MINIH_ROUTER_ACCESS_KEY` 读取该 key，并**拒绝**在命令行上直接给出 key：argv 对机器上
  每个用户可读，还会进入 shell 历史。key 只在 `POST /v1/enroll` 上提交一次且不落盘；
  `gateway-link.json` 只保存签发的证书与 Host 自己的私钥。
- **账户登录**：`POST /v1/account/login` 以 `Authorization: Bearer <AccessKey>` 与
  请求体 `{ client: "web" | "ios" | "android", label? }` 调用，沿用配对路由的浏览器
  规则，并按上一节的命令信封返回
  `{ result: { accountId, keyName?, expiresAt, token?, csrfToken? } }`。账户是
  Router `access_key_id` 的十进制字符串。会话凭据是 `rat1.` 前缀的 bearer 值，有效期
  有界，为十二小时；Gateway 只存其 SHA-256 哈希，撤销始终在服务端完成。原生客户端从
  响应体取得凭据；浏览器收到 `HttpOnly; Secure; SameSite=Strict` 且
  `Path=/`、`Max-Age` 等于有效期的 cookie，外加一个页面可读的 CSRF cookie，其值与配对
  profile 使用同一个 HMAC。校验不通过的 key 返回 `401 UNAUTHORIZED`，Router 不可达返回
  带 `retriable: true` 的 `503 AGENT_UNAVAILABLE`，被 Router 锁定的调用方返回带
  `retriable: true` 的 `429 RATE_LIMITED`，并在 `Retry-After` 响应头里带上 Router
  给出的延迟。
- **账户主机列表**：`GET /v1/account/hosts` 以任一 profile 的账户会话凭据调用，只返回
  `accountId` 等于该会话账户的 Host 及其在线状态。该路由按账户作用域且不接受 hostId，
  因此其他账户的 Host 根本无法在这里被寻址。它不授权任何中继 Host 操作：
  `/hosts/{hostId}/...` 仍要求上一节的设备令牌，把账户会话用在那里会被 `401
  UNAUTHORIZED` 拒绝——与不存在的 Host 返回完全相同的应答，因此不会暴露其他账户的
  Host 是否存在。
- **设备申请、确认与授权**：已登录客户端用 `POST /v1/account/devices` 申请设备。Gateway
  把请求记在会话所属账户下，向该账户内所有声明 `device.confirm` 且在线的主机发送
  `device.request`，并向调用方应答请求 id、截止时间与该账户完整的主机清单。第一个由用户
  确认的 Host 沿用上一节的机制签发设备令牌、只保留其 SHA-256、用自己 Host 证书的私钥对
  `DeviceGrant` 签名，并回送 `device.grant`。Gateway 先用自己的 CA 校验该签名再转发——它
  自己永不签发授权（ADR `remote-control-router-account-binding` 决策 5 已被否决）——然后
  把授权中继给账户内其他 Host。接受方校验签名者证书链到所固定的网关 CA、证书中的
  `OU=account:<accountId>` 绑定、规范化授权载荷上的签名、签名者 `hostId`、`deliverUntil`
  期限、恰为 `viewer` / `controller` / `approver` 的角色集合，以及设备未在本机被吊销；
  其他任何结果都是拒绝，且不改变本机状态（安全规格门禁 32）。客户端最终只持有一个可用于
  账户内所有主机的设备令牌，并丢弃 AccessKey。在途请求按账户（四条）与总量双重设限，超出
  任一上限返回 `RATE_LIMITED` 而不是淘汰旧请求，因此任何账户都无法把其他账户的在途请求
  ——或它已批准、客户端尚未取走的令牌——挤出内存表。
- **设备令牌**：由批准方 Host 签发、只保留哈希、兄弟 Host 以该哈希收编，因此兄弟收到的
  授权里没有原始令牌。令牌只在“批准方 Host→Gateway”这一跳里以 `device.grant` 的
  `deviceToken` 字段传输：Gateway 必须在把授权转发给任何其他 Host 前剥掉它，必须不记录、
  不审计、不持久化它，并把它交给发起申请的客户端。Gateway 只在内存中持有该令牌，在第一次
  返回 `granted` 的读取里交给发起申请的客户端，并在此后三十秒内继续可取，以便客户端重试
  同一请求；超过该窗口即丢弃令牌并返回 `tokenDelivered: false`，丢失令牌的客户端应重新
  发起申请，而不是等待一个已不存在的令牌。Gateway 像上一节那样只记录设备的哈希，但按账户
  而不是按单台 Host 限定作用域，因此它的预路由快速拒绝在账户内每台 Host 上都接受该令牌、
  在其他主机上一律不接受。这样签发的设备是安全规格 §3.7 的网关来源主体：
  `viewer` / `controller` / `approver`、`pairedDevice: false`、始终受远程权限上限约束、
  不提供 `allow-session`。在兄弟 Host 收编授权之前就交给客户端的令牌，会被它们拒绝。
- **客户端路由**：`POST /v1/account/devices` 使用账户会话凭据（绝不是设备令牌），请求体
  为 `{ deviceLabel, client }`，按上一节的命令信封应答
  `{ result: { requestId, expiresAt, hosts } }`。`GET /v1/account/devices/{requestId}`
  应答 `{ result: { requestId, status, expiresAt, hosts, deviceId?, token?,
  csrfTokens?, roles?, signerHostId?, tokenDelivered? } }`，`status` 为 `pending`、
  `granted` 或 `expired`，`tokenDelivered` 表示本次应答是否携带令牌，`token` 仅在
  `granted` 且取件窗口仍开着时出现。浏览器会话拿到的不是 `token` 而是 `csrfTokens`：
  按账户内每台 Host 一个 CSRF 值，见下条。请求属于创建它的那个账户会话：不存在的 id、
  其他账户的请求、以及同一账户其他会话的请求，一律返回相同的 `NOT_FOUND`——因为
  requestId 会发给每台 Host 并写进 Gateway 日志，它本身不是凭据（门禁 29）。所有账户应答
  都带 `Cache-Control: no-store`，因为它们都携带会话凭据、设备令牌或两者。请求体畸形为
  `INVALID_ARGUMENT`，超出预算为 `RATE_LIMITED`，缺少或属于他人的会话凭据为下一节统一的
  `UNAUTHORIZED`。拒绝没有独立状态：拒绝的 Host 不发任何帧，请求保持 `pending` 直到
  `expiresAt`，由客户端自己的截止时间结束等待。`hosts` 每项为
  `{ hostId, label, online, canConfirm, willAcceptGrant }`；`canConfirm` 仅对声明
  `device.confirm` 的在线主机为真，`willAcceptGrant` 仅对声明
  `device.accept-sibling-grant` 的在线主机为真，客户端因此立即知道哪些主机无法应答
  （门禁 33）。
- **浏览器设备交接**：浏览器会话（`client: "web"`）拿到设备令牌的方式与拿到自己的会话
  一样：通过 cookie。第一条报告 `granted` 的状态读取会为账户内每台 Host 各设一个
  `HttpOnly; Secure; SameSite=Strict` 设备 cookie，作用域为 `Path=/hosts/{hostId}`，并在
  响应体里返回 `csrfTokens`——`hostId` 到该 Host 设备 cookie 所配对 CSRF 值的映射——因此
  客户端可以记录账户内每台 Host 而完全不必持有令牌。此时响应体里没有 `token`，但
  `tokenDelivered` 仍为 `true`，因为令牌确实已经交付。原生会话（`client: "ios"` /
  `"android"`）在响应体里拿到令牌，且完全不下发 cookie。走哪条路只取决于登录时创建的
  会话，绝不取决于状态路由的调用方，因此一次状态读取永远不可能往原生 webview 的 cookie
  jar 里写东西。每个 Host 的 cookie 与 `POST /v1/hosts/{hostId}/pair` 下发的完全一致，
  因此上一节所有按 Host 作用域的界面与路由，对账户模式签发的设备无需任何改动即可工作。
- **账户登出**：`POST /v1/account/logout` 以任一种 profile 接受账户会话凭据并结束该会话：
  Gateway 作废自己的会话记录，并用 `Max-Age=0` 清掉账户 cookie 及其页面可读的 CSRF 伴随
  cookie。它不授权任何 Host 操作，按命令信封应答 `{ result: { accountId, revoked } }`，
  且完全不触碰设备令牌——设备是上一节的另一种凭据。它遵循 §11.2 的浏览器规则：`Origin`
  必须在允许列表内，cookie profile 还需 CSRF 头。这条路由之所以存在，是因为浏览器无法
  自己清除 `HttpOnly` cookie：没有它，刚收编完设备的客户端会把一个仍可用的账户会话留在
  服务端最多十二小时。不调用它的客户端也是正确的——会话会自行过期——但它会持有一份不再
  需要的凭据。
- **客户端流程（rollout R7 包 F）**：“确认一次、处处可用”的客户端一半是发现、一次登录、
  一次申请、一次等待、一次收编，然后丢掉会话：
  - **发现**：账户模式由一个不带凭据的 `GET /v1/account/hosts` 探测：`401` 表示该 Gateway
    提供账户模式（路由存在且需要会话），`404` 表示不提供，`403` 表示该 origin 被拒绝——
    也就是说从这里发起的任何账户请求都不会成功。其他任何应答（含传输失败）都让客户端保持
    未决。“不带凭据”对浏览器同样成立：探测既不带 `Authorization` 头，**也不带会话 cookie**
    （`credentials: "omit"`）。存活的会话会让探测被认证，而返回的 `200` 不属于上述任何一种
    应答——被认证的探测因此会隐藏入口，而不是给出入口。只有 `401` 才显示 AccessKey 入口；
    其他应答一律保持上一节的配对流程并隐藏该入口，因此不支持账户模式的 Gateway 行为与从前
    完全一致（rollout 退出标准 7）。
  - **登录**：AccessKey 只在登录调用的 `Authorization` 头里出现一次，并在该调用返回时立刻
    丢弃：绝不写入 `localStorage`、`sessionStorage`、IndexedDB、cookie、原生存储、URL 或
    日志，也不属于该调用产生的会话（门禁 30）。无论成功失败，输入框都会被清空。
  - **花名册**：`POST /v1/account/devices` 应答里的 Host 会立即展示，包括无法确认的那些，
    用户因此一开始就知道哪台电脑能应答。当账户内没有任何 Host 能确认时，客户端明确说明，
    并提供上一节的每 Host 配对票据，而不是等待一个不可能到来的应答（门禁 33）。
  - **等待**：状态路由每两秒读一次。读取失败按指数退避，上限十五秒；`RATE_LIMITED` 应答
    严格按其 `Retry-After` 等待，且不短于正常间隔；连续八次失败即结束等待并报告失败，而不是
    无限轮询。客户端自己的 `expiresAt` 截止时间同样会结束等待（`expired`），且不再发起读取。
    一条 `granted` 应答若既没有令牌也没有 `csrfTokens`——取件窗口在读之前就已关闭——会作为
    独立结果上报，它与 `expired` 一样允许用户在同一会话下重新申请。`NOT_FOUND` 表示 Gateway
    已不认识该请求（已过期，或会话变了），客户端回到登录。由于拒绝没有帧，客户端同时提供
    显式取消：它停止等待，但保留账户会话。
  - **收编**：客户端在 Gateway 点名的每台 Host 上记录该设备——浏览器每台 Host 一个 cookie，
    原生端写入平台安全存储——之后才丢掉账户会话，并在 Gateway 提供登出路由时通过它作废该
    会话。存储失败会作为独立结果上报，且账户会话仍然可用，因为设备在 Gateway 上确实存在，
    只是没有保存在本机。
  - **切换**：上一节的设备令牌在账户内每台 Host 上都被接受，因此用它调用 `GET /v1/hosts`
    即可列出账户内的 Host，客户端无需重新配对即可在它们之间切换。
- **尚未收编该设备的 Host**：一台尚未接受该设备的 Host——授权签发时它离线，或它处于严格
  模式且本机用户尚未确认——会拒绝该令牌，Gateway 把这次拒绝作为 `401 HOST_UNAUTHORIZED`
  报告给客户端，它刻意不同于“凭据已不存在”的 `401 UNAUTHORIZED`。只有账户模式设备会被这样
  报告：经 §11.4 配对的设备被某台 Host 拒绝，说明该设备已在那台电脑上被吊销，凭据确实已经
  失效，应答仍是 `UNAUTHORIZED`（安全门禁 26）。客户端必须区分两者：`HOST_UNAUTHORIZED`
  表示设备本身完好、只是这台电脑尚未同步，下一步是重试或在那台电脑上本地确认；
  `UNAUTHORIZED` 表示凭据已经失效（被吊销，或从未有效），唯一的下一步是重新配对或重新
  申请设备。把前者当作后者上报的客户端会丢弃一个仍然可用的设备。
  但“重试”只对还可能自己追上来的 Host 成立。严格模式的 Host 会永久拒收所有兄弟授权
  （ADR 决策 9），因此客户端绝不能给出一个永远不可能成功的“刷新”：当花名册对某台 Host
  返回 `online: true, willAcceptGrant: false` 时，客户端要提示用户重新申请一次并在那台电脑上
  批准，并把该申请作为可执行的动作提供出来。新的授权会签发一个新设备，由该严格 Host 自己
  签名、账户内其他 Host 照常收编，因此新令牌在所有 Host 上都能用；客户端会用它替换此前在
  每台已知 Host 上保存的设备（浏览器 cookie、原生安全存储、registry 条目），而不是两份并存。
  授权时离线的那台 Host 不属于这种情况：它回来时可能自行收编待处理授权，对它说“重试”是诚实的。
- **浏览器能覆盖到的 Host**：浏览器拿到的设备是每台 Host 一个 `HttpOnly` cookie，而 Gateway
  只为**授权签发时已存在**的账户内 Host 设这些 cookie。因此之后才加入该账户的 Host，在这个
  浏览器里既没有 cookie 也没有 registry 条目，用户必须重新申请设备（或为该 Host 使用配对
  票据）才能从该浏览器访问它。原生客户端不受此限：它持有一个按账户作用域的令牌，向哪个
  Host id 发请求就带哪个，因此后加入的 Host 只要已收编该授权就无需重新申请。
- **能力声明**：Host 在链路建立后立即在每条链路上发送 `host.capabilities`，携带它支持的
  能力串：接上确认器时含 `device.confirm`，接受兄弟授权时含
  `device.accept-sibling-grant`。没有确认器的 Host 什么都不声明，严格模式的 Host 只声明
  `device.confirm`（ADR 决策 9）。Gateway 必须只把 `device.request` 发给声明
  `device.confirm` 的 Host、只把转发的 `device.grant` 发给声明
  `device.accept-sibling-grant` 的 Host，并且必须把账户内其他主机以“无法确认”告知客户端
  而不是让它空等（门禁 33）；客户端随后对这些主机退回上一节的每 Host 票据。一台 Host 接受
  什么，只有它声明之后才知道，因此 Gateway 在**收到新链路的能力宣告时**才投递待处理授权与
  待处理吊销，而不是在链路建立时；以严格模式重连的 Host 因此不会被投递它会拒绝的授权。
- **待处理授权**：授权签发时离线的 Host 在链路恢复后收到该授权：Gateway 按账户保留这份
  已签名的授权（不含令牌），并在每次重连时再次投递。批准方 Host 签名的 `deliverUntil`
  必须**原样**转发——它是签名载荷的一部分，任何改写（哪怕只是缩短）都会让所有兄弟 Host
  拒绝该授权；Gateway 用另一个不参与签名的 `relayUntil` 限定自己的保留期，取签名期限与
  24 小时中较早者。重复投递是幂等的——已收编该设备的 Host 应答 `already-adopted` 且不做
  任何改变——而在 Host 收编授权之前，它不接受该设备令牌。
- **吊销**：账户内任一 Host 都可吊销设备，且吊销会传播到其他主机。Host 先在本机吊销，让
  本机用户的决定不必等待网络，再用自己的 Host 证书签发 `DeviceRevoke`。发不出去的帧——链路
  已断或正在重连——会持久化在 Host 数据目录下的待发队列里，并在下一条链路上重新投递，直到
  投递窗口结束；协议没有确认帧，而吊销绝不能随一次断链丢失。重复投递是幂等的。Gateway
  校验签名后把帧中继给账户内**所有宣告过能力帧**（即拥有设备目录）的其他 Host，而不只是
  声明了 `device.accept-sibling-grant` 的那些：一台 Host 可能在非严格模式下、或还带着确认器
  时收编过该设备，随后以严格模式、或不再带确认器的方式重启，若按
  `device.accept-sibling-grant` 过滤，恰好会让这台 Host 继续接受一个已吊销的令牌。从未收编
  该设备的 Host 也会记录该设备已吊销，因此在途的授权无法把它复活；而早于这些帧的 Host 从不
  宣告，也就永远不会收到。
  Gateway 同时吊销自己持有的该设备记录，使其快速拒绝立即停止接受该令牌，并在转发吊销之前
  丢弃该设备任何待处理授权。
- **桌面 Host（包 E2）**：桌面就是这些 Host 之一，并补上了无头 Host 留给宿主应用的部分。
  当 Router 下发账户模式时，桌面自动用账户完成注册（见上文账户登录与 provider 配置规格
  §3）：AccessKey 只在主进程内从已保存的 `minih-router` provider 行读出，只用于那一次注册
  请求，随后丢弃——它不会进入 renderer 载荷、日志、审计记录或凭据文件，后者只保存 Host
  证书与私钥。承载这份答案的 bootstrap 请求在**启动时**就用已保存的 provider 行作为凭据源
  发出，而不是等用户改一次设置：不带凭据源启动的版本永远学不到哪个 Gateway 服务这个账户。
  用户自己的远程控制开关关闭时，既不注册也不对外提供任何服务；下发不可用时
  自托管注册码流程原样保留。但“关闭”不会让账户模式从页面上消失：它是否可用——下发端点加上
  已配置的账户密钥——是只读算出的，不注册、不拨号、不开任何东西，并写入状态，页面据此才敢把
  开关交给用户；每次读取状态都重新问一次（并发读取共用一次调用，但已得结果绝不复用），因为
  组网与账户密钥都可能在页面首次打开之后才就绪。免驱动（No-TUN）模式下请求打到隧道安装的
  回环转发——Router 的组网地址在这种模式下不可路由；隧道起来后若仍无答案，会再经该转发询问
  一次，并只重启一次隧道，让应答里的身份生效。TUN 模式请求配置的 Router 地址，其路由让该地址
  可达。账户模式不可用时总会给出原因：有 bootstrap 失败就用该错误，否则说明配置尚未拉取。真正完成注册的是用户打开那个开关；若开关要等
  注册、注册又要等开关，这台桌面就永远进不来。它的确认器就是桌面自己的窗口：
  显示设备名与客户端，焦点落在"拒绝"上，Esc 即拒绝，请求的 `expiresAt` 到点后对话框关闭。
  不存在“不表态”：主动报告即将消失的窗口（关闭、重载）会立即拒绝所有等待中的请求，这正是
  桌面通过 `remoteGateway/devicePresence` 与 `remoteGateway/deviceDecision` 告知 Gateway 的
  内容；而没有窗口能显示时不会提前给出答案——请求保留到自己的 `expiresAt` 才被拒绝，因此
  客户端是等到窗口过期，而不是被告知一个没人看到的对话框已被关闭。每次签发、收编与吊销都会
  产生设置页列出的通知（ADR 决策 6），在此吊销设备走上文那条签名帧，链路断开时先入队。
  该链路要拨的地址在每次连接时从当前的 `EasyTierStatus.remoteGateway` 解析（provider 配置
  规格 §3）：凭据记录的是下发端点，因此组网重新分配的转发端口既不会让桌面重新注册，也不会
  让链路失联。
- **角色与隔离**：账户模式签发的设备属于网关来源主体，沿用安全规格 §3.7 的角色与
  限制（`viewer` / `controller` / `approver`、`pairedDevice: false`、始终受远程权限
  上限约束、无 `allow-session`）；处于严格模式的 Host 拒绝兄弟授权并逐台确认。任何
  路由、主机列表、设备记录、待处理授权与审计查询都不得跨账户，每次路由决定与缓存查找
  都按账户限定。Gateway 按 IP 的限流（ADR 决策 10）天然跨账户；按账户的限额彼此独立
  （安全规格 §8），任何限流应答都不泄露其他账户的数据（安全规格 §9）。账户登录与按 key
  注册共用一个按解析地址键控的严格凭据桶，调用方无法用命令预算去猜测 key。共享组网上的
  可达性不授予任何权限。经自托管流程注册的 `hostId` 不是账户资产：AccessKey 注册只有在
  证明持有该 Host 现有证书所认证的密钥时才能接管它，因此得知一个 `hostId` 绝不会让某个
  key 把别人的 Host 移入自己的账户。跨账户尝试的错误码在注册上是
  `HOST_ACCOUNT_MISMATCH`（403），因为调用方本身持有另一账户的有效 key、Host 必须知道
  自己的 `hostId` 已被占用；该码不指明账户，只暴露 `hostId` 已被注册。按账户作用域的
  路由一律返回下一节统一的 `UNAUTHORIZED`，因此列表或路由尝试都不会泄露其他账户的
  Host。

### 脱敏推送（R5 PR-6；ADR 0331 决策 7）

推送是可选的、脱敏的：它只在用户注册过的设备上告诉他“有事需要你”，绝不携带会话里说过
什么。所有决定都归 Gateway——推送是否存在、该通知谁、通知里写什么——因此 Host 不决定
受众，客户端也拿不到内容。

- **Host 声明**：会报告事件的 Host 在每条链路的 `host.capabilities`（§11.5）里声明
  `push.notify`。没有通知器的 Host 什么都不声明，Gateway 也就不期待它发 `host.notify`。
- **事件帧**：`host.notify` 精确携带
  `{ link, type: "host.notify", notify: { notifyId, kind, sessionId, approvalId?,
  occurredAt } }`，其中 `notifyId` 是 Host 对该事件的自身标识（上限 128 字符，使一次重试
  仍只对应一条推送），`kind` 为 `approval.requested`、`input.requested`、
  `turn.completed`、`turn.failed` 之一。该对象是封闭的：提示词、工具名、路径、记录、会话
  标题都加不进去，携带它们的帧会被丢弃而不是投递。所有 id 还额外限定于
  `^[A-Za-z0-9._:-]{1,128}$`——UUID、`<prefix>_<uuid>` 与十进制 id 都在其中。只限长度
  会让 Host 有办法把一句话塞进 `sessionId`，再被 Gateway 原样送到锁屏上。早于该帧的
  Gateway 会丢弃它并保持链路（§11.4 规则 6）；早于它的 Host 不发送，也一切照旧。
- **哪些事件**：四种就是全部——有人必须对审批作出决定、回答一个问题，或得知回合完成/失败。
  被中断或取消的回合是用户自己在屏幕上做的动作，因此不通知；消息、工具、token 计数同样都
  不是通知。
- **注册**：`PUT /v1/push/registration` 使用**设备令牌**（绝不是账户会话），请求体
  `{ platform: "ios" | "android", token, appId? }`，按 §11.2 命令信封应答
  `{ result: { enabled, platform, hostIds } }`。`token` 是服务商令牌（APNs 设备令牌或 FCM
  注册令牌），上限 4096 字符，使该路由无法被当作存储；它只被保存，绝不回显，也绝不写入
  日志。注册属于“设备”，受众因此由凭据决定：§11.4 设备只有它配对的那台 Host，账户模式
  设备（§11.5）是账户内所有在线 Host。`hostIds` 就是 Gateway 解析出的该受众，之后新注册
  进账户的 Host 不会悄悄扩大它——重新注册才会。一台设备只有一条注册：再次注册替换它的
  令牌，因为一台设备就是一个平台。设备状态在写入内部复查，因此设备被吊销时已在途的注册
  请求会得到 `UNAUTHORIZED`，而不是把吊销删掉的注册又写回去。`DELETE
  /v1/push/registration` 删除调用方自己的注册并应答 `{ result: { removed } }`。两个路由都遵循 §11.2 的浏览器规则（`Origin`
  必须在允许列表内，cookie profile 需 CSRF 头），并携带 `Cache-Control: no-store`。
- **推送关闭**：未配置任何服务商时 Gateway 不保存任何东西，注册路由应答
  `enabled: false` 与空的 `hostIds`，客户端因此可以停止询问，而不是误以为注册已存在。为
  Gateway 没有服务商的平台注册会得到 `CAPABILITY_UNAVAILABLE`（501）——保存一个永远投递
  不出去的令牌是一种静默失败。
- **载荷**：推送只包含 `{ kind, titleKey, bodyKey, hostId, sessionId, approvalId?,
  notifyId }`，别的一概没有。`titleKey` 与 `bodyKey` 恒为
  `push.notify.<kind>.title` 和 `push.notify.<kind>.body`，由客户端从自己的词条解析——
  Gateway 从不发送句子。APNs 收到的是 `aps.alert.title-loc-key` / `loc-key`，FCM 收到
  `android.notification.title_loc_key` / `body_loc_key`，同一组 id 也在 `data` 里，因此
  可见文字是应用自己的、用用户的语言，而 id 会随通知到达以驱动点击跳转。HTTP v1 的
  `message.notification` 只有 `title`、`body`、`image` 三个字段，所以定位键属于 Android
  块；放在别处会让每一台设备都收到 `400 INVALID_ARGUMENT`。这些键的值是 Android 资源名
  （`push_notify_<kind>_title`），因为资源名不允许含点号。
- **渲染发生在应用包内**：应用在后台或已关闭时，通知由**系统**渲染，因此这八个 key 必须
  存在于应用自己的资源里：`ios/App/App/en.lproj/Localizable.strings`、
  `ios/App/App/zh-Hans.lproj/Localizable.strings`、
  `android/app/src/main/res/values/strings.xml` 与 `values-zh-rCN/strings.xml`。它们由
  `apps/remote-web/scripts/generate-push-strings.mjs` 从客户端词条生成，并有测试守着，
  所以改词条不会让锁屏显示原始 key。这些文件里只有固定文案，也不属于运营者提供的材料。
- **受众（门禁 29）**：只有当某台设备能打开某台 Host 时，才会收到关于该 Host 的推送：
  §11.4 设备只有它自己的 Host，账户模式设备只有它自己账户内的在线 Host。被吊销的设备根本
  没有注册，因为吊销会删掉它。
- **一个事件一条推送**：Host 可能重发同一帧（重连、重试的读取），Gateway 对每个
  `notifyId` 只投递一次，因此重试不会变成第二次打扰。去重按 Host 与 id 进行，窗口有界。
- **预算**：按 Host 与按设备各有令牌桶，用来约束陷入循环的 Host：先检查 Host 桶，因此吵闹
  的 Host 花不掉设备的额度；单个设备超预算只丢它自己，不影响其他设备。
- **清理**：设备被吊销时删除注册——包括 Gateway 自己吊销与从 Host 传播过来的吊销
  （§11.5）——服务商报告**这个令牌**已消失时也删除：APNs 的 `410` 或原因 `Unregistered`，
  或 FCM 的 `UNREGISTERED`。除此之外都不删除。`DeviceTokenNotForTopic`
  （`--apns-topic` 配错，或用另一个 bundle id 的构建）、`BadDeviceToken`（APNs 环境不匹配时，
  例如生产令牌发到沙箱端点，每个令牌都会得到这个答复）、FCM 的裸 `404`/`NOT_FOUND`
  （project id 写错、路径写错、代理返回 404）、`PERMISSION_DENIED`，以及服务商凭据被拒，
  都是配置问题：它们影响 Gateway 持有的每一个令牌，若据此删除，一次调用就能清空整个平台。
  临时失败同样保留注册。
- **运营者配置**：`--apns-key-file`、`--apns-key-id`、`--apns-team-id`、`--apns-topic`、
  `--fcm-service-account-file`；APNs 四个参数必须同进同退，半配置的服务商拒绝启动，两个
  文件都必须是调用方拥有、权限 0600 的普通文件——与 `--access-key-file` 同一条规则。凭据
  绝不出现在日志、审计记录或错误信息里；审计记录事件类型、Host 与设备，这正是 §11.6 允许
  一条推送说出的全部内容。
- **在途凭据**：APNs 走 HTTP/2 并用 ES256 服务商 JWT（`kid` = key id、`iss` = team id，
  有效期一小时，远早于到期就刷新）；FCM 走 HTTP v1，用服务账号 RSA 密钥换取 OAuth2 访问
  令牌，并缓存到到期前一分钟。OAuth2 换取是 single-flight，消息端返回 `401`/`403` 时丢弃
  缓存的令牌，使下一次推送重新换取。服务商端点必须是绝对 `https:` URL，并在启动时校验。
- **投递超时**：每次服务商调用都有硬性上限（默认 10 秒）。服务商接受连接后不再应答时，本次
  尝试在上限处结束，APNs 的会话被销毁而不是复用，因此卡住的服务商只花掉一次超时，而不是
  泄漏连接。一条通知以固定的小并发（4）投递，单个设备的失败或超时既不会拖住其他设备，
  也不会跳过审计记录。APNs 会话在两次推送之间复用（Apple 明确要求复用连接），并在出错或
  收到 `GOAWAY`、空闲五分钟、Gateway 停止时丢弃。

## 6. 限制和错误

| Limit | Target |
|---|---:|
| JSON request or event frame | 1 MiB |
| Prompt payload | 256 KiB |
| Attachment | 50 MiB |
| Host link attachment chunk | 256 KiB |
| Durable session event replay | 10,000 events or 24 hours |
| Ephemeral events | 不保留 |
| Queued turns per session | 8 |
| Concurrent subscriptions per connection | 8 |
| Connected clients per Agent Host | 16 |
| `connection/initialize` deadline | 10 seconds |
| Read/metadata operation deadline | 15 seconds |
| `turn/start` admission deadline | 5 seconds |
| Approval lifetime, local default | 无自动截止时间；必须明确决定或取消 |
| Approval lifetime, remote policy | 有远程订阅者接入时默认 30 分钟；Host 配置、有界，以 `approvalLifetimeMs` 公布 |
| Heartbeat interval | 30 seconds |
| Terminal output replay ring | 每终端 128 KiB |
| Open terminals per session | 2 |
| Relayed tool execution deadline | 工具自身超时 |
| Push notifications per Host | 突发 20 条，之后每 5 秒一条 |
| Push notifications per device | 突发 10 条，之后每 10 秒一条 |
| Remembered push event ids (de-duplication) | 每个 Gateway 进程 4,096 个 |
| Push provider request deadline | 每个请求 10 秒 |
| Concurrent push deliveries per event | 每事件 4 台设备 |
| Idle APNs session reuse | 5 分钟后关闭 |

| Code | Retriable | Meaning |
|---|---:|---|
| `UNAUTHORIZED` | no | 凭据缺失、过期或无效 |
| `HOST_UNAUTHORIZED` | no | Gateway 后面的那台 Host 拒绝了它尚未收编的账户模式设备（§11.5），下一步是重试，或重新申请并在那台电脑上批准。经 §11.4 配对的设备被 Host 拒绝时仍是 `UNAUTHORIZED`，因为那份凭据确实已经失效 |
| `FORBIDDEN` | no | 主体没有操作或会话范围 |
| `PROTOCOL_MISMATCH` | no | 协议主版本或能力不支持 |
| `INVALID_ARGUMENT` | no | 请求结构或字段无效 |
| `NOT_FOUND` | no | Host、项目、会话、回合、审批、输入或附件不存在 |
| `AGENT_UNAVAILABLE` | yes | Host 或 runtime 离线 |
| `AGENT_BUSY` | no | 请求的准入模式下不能接受回合，或队列已满 |
| `CONFLICT` | yes | revision 过期或回合已不在所需状态 |
| `IDEMPOTENCY_CONFLICT` | no | 同一 key 使用了不同输入 |
| `CURSOR_EXPIRED` | no | epoch 已变化或游标不在回放窗口内 |
| `CLIENT_TOO_SLOW` | yes | 有界事件队列溢出 |
| `APPROVAL_EXPIRED` | no | 审批已不可执行；旧版本地 Host 的 `PERMISSION_TIMEOUT` 或 `PLAN_APPROVAL_TIMEOUT` 映射为此错误码，当前本地权限提示不会过期 |
| `APPROVAL_STALE` | no | 审批响应针对旧 revision |
| `PAYLOAD_TOO_LARGE` | no | 请求、事件或附件超限 |
| `RATE_LIMITED` | yes | 主体、会话或 Host 超额 |
| `PAIRING_FAILED` | no | 配对令牌未知或已被兑换 |
| `PAIRING_TOKEN_EXPIRED` | no | 配对令牌的引导窗口已过 |
| `CAPABILITY_UNAVAILABLE` | no | Host 未宣告该操作所需的能力；在 `PUT /v1/push/registration` 上表示该 Gateway 未配置该平台的服务商（§11.6） |
| `REMOTE_PATH_NOT_FOUND` | no | Host 侧路径不存在 |
| `REMOTE_PATH_FORBIDDEN` | no | Host 侧路径超出主体可达范围 |
| `INTERNAL` | maybe | 带 trace id 的内部错误 |

错误必须同时携带稳定 code、可重试标记和 trace id。重复 mutation 使用同一
idempotency key 时返回原结果；使用相同 key 发送不同输入则失败。

## 7. 兼容性与修订

新增字段只能追加，不能复用已有字段含义。可选能力必须通过初始化协商。
终止状态不能回到活动状态；每个已发布 binding 的行为都必须通过相同 fixture
验证，`RACP-WS` 是参考绑定。D374 于 2026-09-10 修订了 D373 草案：补齐本地
审批词汇、引入 epoch 与瞬态事件、加入 Host 队列与 `permissions.pending`、
新增 `host/list`、`project/list`、`session/history`、`turn/stop`、`turn/cancel`
和 Host 流订阅、收敛为单一规范绑定与单一 IDL、定义浏览器认证 profile、Host link
中继、远程权限上限和远程审批寿命。D375 又加入远端 Host profile、`RACP-WS` 的
SSH 隧道部署与 loopback 规则、SSH 配对 owner 设备的上限豁免，并把 `RACP-HTTP`、
cookie profile 与 Host link 标记为不排期；终端流式操作、`tools/advertise` 与
`tool/execute` 中继、host-core 持久化的队列、远程订阅者 30 分钟默认审批寿命和
`applyCeilingToPairedDevices` 策略同属该修订。D665（2026-10-17，ADR 0331）排期
Gateway 与浏览器里程碑（R4–R6）：`RACP-HTTP`（§11.2）随 R4 绑定并在任何浏览器客户端
使用前加入一致性 fixture，HTTP 映射在既有 `GET /v1/hosts` 旁新增
`POST /v1/hosts/{hostId}/pair`；Host link（§11.4）随 R4 交付，`client.open` 新增
`credential` 字段，Host 以连接来源 `"gateway"` 用自己的 `DeviceTokenAuthenticator`
重新验证每条中继逻辑连接，自托管场景下 route context 的完整性由已认证的 Host link
保证；注册（15 分钟一次性注册码、固定网关 CA、CN 为 `hostId` 的一年期证书）与网关
配对（Host 本机显示的 10 分钟配对码、网关只存哈希、cookie 或响应体交付令牌）在同一
监听器上规定。

D666（2026-10-18，ADR `remote-control-router-account-binding`）新增规划的账户模式：
经 loopback 调用并转发调用者地址的 Router key 校验；密钥生命周期规则（被禁用或删除的
key 不能再发起新登录或新注册，但本身不撤销任何东西）；以 AccessKey 加 CSR 并按
bootstrap 的 `remoteGateway` 注册 Host；账户作用域的登录与主机列表；经
`device.request` 与 `device.grant` 两个新帧完成的设备申请／确认／授权；以及这两个帧
只发给声明支持该能力的 Host 的强制要求。自托管注册码与每 Host 票据保持不变，账户模式
设备仍受 D665 的网关来源角色与限制约束。

完整状态机、示例和验收条款见英文源规格。
