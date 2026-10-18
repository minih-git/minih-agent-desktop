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
type HostLinkFrame = { link: "racp-hostlink.v1"; type: "client.open" | "client.message" | "host.message" | "attachment.chunk"; clientConnectionId?: string; credential?: string }
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

Gateway 账户目录——key 校验、按 key 注册、账户登录、账户主机列表——已实现（交付
R7 工作包 C）；`device.request` / `device.grant` 中继与 Host 能力声明尚未实现，属于
工作包 D，涉及它们的条款已标注。

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
  该对象或返回 `404` 表示账户模式不可用，Host 改用自托管注册码。
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
- **设备申请、确认与授权（工作包 D）**：客户端申请设备后，Gateway 向该账户内所有声明
  支持的在线 Host 发送 `device.request`（新增帧，Gateway→Hosts）；第一个由用户确认的
  Host 签发 `device.grant`（新增帧，Host→Gateway），Gateway 再把该授权中继给账户内其他
  Host，接受方校验签名 Host 在同一账户下由网关 CA 注册、且设备未被撤销。客户端最终只
  持有一个可用于这些 Host 的设备令牌并丢弃 AccessKey。授权时离线的 Host 在链路恢复后
  收到待处理授权，在它接受授权之前不接受该设备令牌。
- **帧能力与旧 Host（工作包 D）**：两个新帧只发给声明支持的 Host（该声明由工作包 D
  定义，当前 Host link 没有 hello 或能力帧）。这是安全要求而非优化：今天的 Host 会
  静默忽略未知 `type`（`packages/racp/src/hostlink.ts` L103-172），发给不支持的 Host
  会让客户端无限等待，因此 Gateway 必须把该 Host 以“无法确认”告知客户端，由客户端退回
  每 Host 票据。
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

| Code | Retriable | Meaning |
|---|---:|---|
| `UNAUTHORIZED` | no | 凭据缺失、过期或无效 |
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
| `CAPABILITY_UNAVAILABLE` | no | Host 未宣告该操作所需的能力 |
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
