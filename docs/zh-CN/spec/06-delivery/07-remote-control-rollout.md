# 远程 Agent 控制交付与验收

- 状态：目标交付规格，属于 MVP 之后
- 决策：D373 / ADR 0205，经 D374 与 D375 修订
- 英文源规格：[英文源规格](/spec/06-delivery/07-remote-control-rollout)

## 1. 交付边界与顺序

当前 MVP 仍然只提供本地 Electron Main、pi sidecar、Rust host-core、
loopback MCP；不得直接暴露 host-core 或现有 IPC。远程工作先从 typebox
契约、无头 Agent Host 模块、fixture 和状态机测试开始，再在显式 feature flag
之后加入传输绑定。

D375 按已记录的需求而不是传输广度排序：#176 与 #140 要从本地桌面操作远程
Linux 或 WSL 机器上的项目，即 SSH 隧道远端 Host 拓扑；#100 要把任务完成与
审批通知推送到 Telegram、微信、Slack 或 Webhook 并回传简单指令，即 Host 旁的
出站集成；维护者要求从手机跟进执行过程、处理审批和输入请求，并对
`agent-host-cli` 常驻机器与运行中的桌面发起、停止和打断回合，这把 Gateway、
可连接 Host 与浏览器／移动客户端里程碑排期（D665，ADR 0331）。排期顺序为
R0、R1、R2、R3，随后 R4、R5、R6（D665），再之后是 R7——Router 账户绑定（D666，
规划中）；保留的 gRPC 绑定仍不排期，只在有明确消费者时由后续记录在案的产品决策交付。

## 2. 里程碑

- R0：在 `packages/shared` 中以 typebox 定义 RACP v1 资源与操作（唯一契约来源，
  含远端 Host profile），生成 JSON Schema fixture，完成错误、游标、epoch、幂等、
  回合队列、审批（含 `allow-session` 与 Plan/Goal 权限模式选择）、远程权限上限
  及其 SSH 配对豁免的测试向量。
- R1：交付无 Electron 依赖的 `packages/agent-host` 模块，拥有会话/回合准入、
  回合队列、审批代理、带 epoch 的内存事件日志和快照构建；Electron Main 承载它，
  现有 IPC handler 成为适配层。随之交付 host-core 的 `permissions.pending`
  读取，并用由 host-core 持久化的 Host 队列替换 renderer 内存 prompt 队列（需单独 ADR 与
  schema 升级，D375），重启后队列恢复并挂起到 controller 接入。仅提供开发环境的
  loopback RACP-WS 端点。抽取在在途版本发布后开始，`permissions.pending`、
  Host 队列和模块抽取各自独立提交，因为仓库存在并发会话，且 54 个测试按源码
  模式匹配 `electron/main/index.ts`，需要重新指向。
- R2：SSH 隧道上的远端 Host。分两个有序切片交付，桌面侧内核先落地并保持关闭态：
  - R2a — 桌面内核（已交付，见 ADR 0286）：backend-router seam、传输无关的 remote-backend、
    event bridge、per-host coordinator、safeStorage 加密的 remote-host 注册表以及启动引导。
    默认注册表为空即完整 no-op：router 无远程 backend，renderer 每次调用仍逐字节走本地
    handler。`node --test` 用 fake 或真实的 `@minih-agent/racp/test-harness` 覆盖每个模块。
  - R2b — 配对、SSH 引导、终端、反向工具中继。R2 的出口条件保持不变，随 R2b 一并达成；
    R2a 单独不面向用户，且不尝试完成这些条件。

  交付项：`agent-host-cli` 包（模块、Node pi sidecar 与平台
  host-core 二进制，与桌面同版本，只绑定 loopback，由桌面经 SSH 上传的引导脚本从
  GitHub Releases 下载并校验公布的 SHA-256，再经该 SSH 会话启动并配对）；位于 `lib/api.ts` 之下的桌面 RACP 客户端适配层，使远程会话像本地
  一样渲染；转发端口上的 `RACP-WS` header profile，遵守安全规格的 loopback 规则
  与设备 token 配对；远端 Host profile 操作（`session/configure`、
  `session/fork`、`session/rename`、`session/delete`、`session/compact`、
  `workspace/list`、`workspace/read`、`workspace/diff`）；以及远程会话归属划分；反向工具中继（`tools/advertise` 与 `tool/execute` 服务端
  请求，让桌面 MCP 服务器和不需工作区的插件工具在远程会话中于桌面执行）；终端
  （`terminal/open`、`terminal/input`、`terminal/resize`、`terminal/close`、
  `terminal.output` 与有界回放环，在远端机器运行）；设置 → 远程主机为紧凑主机清单加一个 SSH/配对添加表单、不含说明性文案；整项功能在导航与标题上标为实验性，因为远程连接仍可能失败，仅在开发者模式开启时显示（连同其在设置搜索中的命中）（`04-ux/06-settings-ia.md` §1、§3）。
- R3：出站消息集成（#100）。Host 进程内的又一个模块调用方，无传输、无入站
  监听：订阅 Host 范围与会话事件，把 `turn.completed`、`turn.failed`、
  `approval.requested`、`input.requested` 的脱敏摘要转发到出站渠道（先 Webhook，
  再经 Telegram、Slack 的出站轮询或 socket 模式；需要入站回调的渠道推迟）；把固定
  指令词汇从已关联的聊天映射到 `turn/start`、`turn/stop`、`turn/interrupt`、
  `approval/respond`，以关联主体的角色和同一 Host 策略执行，未关联聊天忽略并审计；
  投递失败有界重试，绝不阻塞回合。
- R4（D665）：自托管 Gateway 与 Host link。交付 `apps/remote-gateway`（用户自托管的
  Node 服务）与 `agent-host-cli` 的外连注册和链路：网关模块（含绑定地址校验的配置、
  `--data-dir` 文件存储、本地 CA 与注册/吊销、同 hostId 替换前先校验身份的 wss + mTLS
  Host link 监听器、带 cookie/header 两种 profile 与 Origin、CORS、CSRF 控制的
  `RACP-HTTP` + SSE 客户端 API、配对中继、HTTP 到逻辑连接的路由、按设备与 IP 的限流、
  脱敏审计日志，以及 `serve` / `enroll-code` / `hosts list` / `hosts revoke` /
  `devices list` / `devices revoke` CLI）；`agent-host-cli enroll`（本地密钥对、CSR 加
  一次性注册码、`--gateway-ca` 固定网关身份）、可选的 `--gateway <wss-url>` 外连链路
  （1s–60s 带抖动指数退避）与经现有 admin socket 的 `remote-pair`；loopback `RACP-WS`、
  `--pair` 与 SSH 引导行为不变；协议 §11.4 带 `credential` 字段的 Host link 契约与安全
  规格 §3.7 的设备来源规则（网关配对只授予 `viewer` / `controller` / `approver`，绝不
  授予 `owner`，`pairedDevice: false`，Host 对每条中继逻辑连接重新认证）；可独立运行的
  Gateway 打包产物与部署 README（systemd 示例、透传 SSE 的 Nginx 反代示例
  （`proxy_buffering off`、`X-Accel-Buffering: no`）、注册与吊销步骤）；`RACP-HTTP`
  一致性测试通过后加入 `RACP_SHIPPED_BINDINGS`。网关不保存 transcript、provider
  secret，也不持久化回合命令；Host 离线时不排队非幂等命令。Host link 监听器只绑定
  显式配置的私网或组网地址（RFC1918、`100.64.0.0/10` 或显式配置的 CIDR），拒绝
  `0.0.0.0`、`::` 与公网地址；客户端 API 绑定 loopback（由 TLS 反向代理终结），其他
  地址必须配 TLS。退出条件：E2E-227 通过；绑定规则（安全门 22–23）成立；令牌不出现在
  URL、query string、SSE URL 或事件载荷中，浏览器请求过 Origin 白名单（§5.2、
门 14）且修改类请求带
  CSRF token（门 24）；网关配对设备不能执行 owner 专属操作、受权限上限约束、拿不到
  `allow-session`，其令牌在 loopback `RACP-WS` 上被拒（门 25）；任意一侧吊销后新连接
  被拒、已有逻辑连接 5 秒内关闭（门 26）；网关可清空重注册而不丢 Host 会话数据，审计日志不含
  令牌与内容。
- R5（D665）：桌面作为可连接的 Host。交付桌面的外连网关链路（ADR 0331）：在现有进程内
  Agent Host 之上以 Host link host 承载 Electron-Main 的 `RacpServer` 传输——不新建
  AgentHost、不新增执行路径、不开监听；可选的 `remoteGateway` AppSettings 字段
  （`enabled`、`url`；设备本地、不同步、缺失即关闭）与实验性设置页（开关、网关地址、
  注册码、链路状态、以文本显示并可复制、带 10 分钟倒计时的配对码、已配对设备列表与吊销）；main 进程
  经 `EncryptionPort` 加密保存设备凭据，绝不进 SQLite、不改 host-core schema，mTLS
  密钥与证书单独存储；`minih-agent-desktop/remoteGateway/*` IPC 通道全部加入 MCP 控制
  屏蔽列表；生命周期清理：关闭开关、退出应用与 `before-quit` 都会断开链路并取消挂起的
  服务端请求，不影响本地回合；渲染进程重载保持 main 持有的链路，只让设置页重新订阅状态。
  退出条件：关闭状态下行为与现状完全一致，不发起连接也不开监听（回归测试，安全门 27）；
  开启后只建立一条外连链路，关闭与退出会清理，重载不影响链路；网关主体受远程权限上限
  约束、不能修改本地会话权限模式、不能用 `allow-session`，
  `DESKTOP_PRINCIPAL` 不变；吊销桌面设备即断开链路；mTLS 密钥与证书加密存放在设置与
  SQLite 之外。
- R6（D665）：浏览器与移动客户端。交付 `apps/remote-web`（ADR 0331）：基于无 Node 依赖
  的 `@minih-agent/racp/browser` 入口与共享 typebox 契约的 React + TypeScript 客户端，
  不依赖 `apps/desktop` 源码；页面包括配对（粘贴 `mpt1:<hostId>:<pairingToken>` 票据、
  设备名称）、带在线状态的 Host 列表、带运行中／等待审批徽标的会话列表，以及实时时间线
  （消息行、工具调用摘要、可折叠工具详情、带本地决策词汇但不提供 `allow-session` 的审批
  与输入卡片，以及发起、停止、打断回合的输入框）；快照加游标的状态管理，
  `visibilitychange` 时从最后游标续传，修改类操作带幂等 key，提交期间禁用按钮；
  配对票据（`packages/shared` 持有 `mpt1:<hostId>:<pairingToken>` 编解码，Host 在配对码旁
  打印它——桌面设置页与 `agent-host-cli remote-pair`——浏览器靠它配对，因为 Host 作用域的
  cookie 路径不会暴露 `GET /v1/hosts`）；浏览器 cookie profile 修正（两个配对 cookie 都带
  有限 `Max-Age`，浏览器重启后配对仍有效；同源 `GET`/`HEAD` 允许不带 `Origin`
  （安全规格 §5.2），使 H5 读取与事件流可用，其余 cookie 请求仍须自证 `Origin`）；
  移动端适配（`env(safe-area-inset-*)`、不小于 44px 的触控区域、深色模式、PWA manifest 与
  图标）；Capacitor iOS/Android 打包，原生凭据经 `CredentialPort` 存入 Keychain /
  Keystore，可选的脱敏推送只携带 id 与固定摘要类型。
  退出条件：E2E-228 通过（`RACP-HTTP` 与 `RACP-WS` 语义一致、cookie profile 过 Origin 与
  CSRF 校验、URL 令牌被拒）；E2E-266 通过（两种移动视口下的配对、`Last-Event-ID` 续传、
  审批与停止，经由 Electron Chromium 设备模拟与同源反向代理驱动，截图产物不入库）；
  浏览器构建不把令牌存进脚本可读存储，原生构建只存设备专属、不同步 iCloud 的 Keychain
  条目或 Android Keystore，并设 `allowBackup="false"`，使该密文无法恢复到另一台设备
  （PR-5 已完成：原生 `CredentialPort`、发布配置静态测试与
  `E2E-REMOTE-MOBILE-native-shell-credential-storage` 场景覆盖，真机验收仍由用户完成）；
  推送载荷只含 id 与事件类型，未配置凭据时推送关闭（R5 PR-6 已交付：协议 §11.6、安全
  门禁 34；Gateway 推送固定事件类型、两个本地化键与 id，两种服务商协议都由
  `pnpm test:e2e:remote-account-push` 用本地桩真实跑通；原生客户端注册服务商令牌并按点击
  通知中的 id 打开对应 Host 与会话；仓库仍不含 Firebase 文件、Apple 推送 entitlement 与
  后台模式，这些由运营者自备，方法见 `remote-web` README）；仅凭票据即可完成配对（客户端从票据得到 Host 标识，
  两个配对 cookie 都带有限 `Max-Age`，非同源 `GET`/`HEAD` 的 cookie 请求仍须带白名单内的
  `Origin`）。
- R7（D666，规划中）：Router 账户绑定。在 R4–R6 之上交付 ADR
  `remote-control-router-account-binding` 的账户模式；R4/R5 的自托管注册与每 Host
  配对行为不变，账户模式只在 Router 的 bootstrap 应答给出 `remoteGateway` 时启用。
  工作包（每个一个 PR）：

| # | 仓库 | 工作 | 依赖 |
|---|---|---|---|
| A | Desktop | 本决策：ADR、规格更新与决策 D666（仅文档） | — |
| B | Router | bootstrap 应答新增可选的 `remoteGateway {hostlinkUrl, publicOrigin, caPem}`，含系统设置、测试与文档 | A（契约） |
| C | Desktop | Gateway 账户目录：按 key 注册、账户登录、账户主机列表、可信代理客户端 IP、跨账户隔离测试 | A |
| D | Desktop | 设备申请与确认中继：`device.request` / `device.grant` 帧、Host 侧确认与授权校验、`agent-host-cli` 支持 | C |
| E1 | Desktop | host-core：解析 Router 的 `remote_gateway` 对象，并在 No-TUN 模式下安装第二条组网转发 | B |
| E2 | Desktop | Electron main 按该接入点自动注册与 Host link 接线、桌面确认对话框、严格模式与 i18n | D、E1 |
| F | Desktop | 客户端：`apps/remote-web` 的 AccessKey 登录与主机切换 | C、D |
| G | Desktop | 在账户之上叠加推送 | F |
| D-1 | 运维 | 在 Router 旁部署；需要域名与用户授权 | C–F |

B 与 C 可在 A 之后并行。范围说明：Gateway 保持为独立进程，有自己的发布与 `--data-dir`，
不进入 Router 的单实例平滑升级流程；部署需要 Router 把 Gateway 的 loopback 对端列入
`TRUSTED_PROXIES` 并把 `CLIENT_IP_HEADER` 设为 Gateway 发送的头，组网地址上的 Host link
监听需用 `--hostlink-allow-cidr` 放行（组网网段既不属于 RFC1918 也不属于
`100.64.0.0/10`），H5 客户端需要域名或路径前缀——这些都是部署决定；E1 负责安装第二条
No-TUN 转发到组网上的 Host link 地址（provider 配置规格 §3），TUN 模式不需要；新帧只发给
声明支持的 Host，声明方式由工作包 D 定义；设备申请与确认中继从工作包 C 移到工作包 D，
因为中继设备申请、接受已签名授权依赖 D 定义的 `device.request` / `device.grant` 帧与
能力声明，C 只负责账户目录，D 负责中继所依赖的全部基础。

退出条件：`E2E-REMOTE-ACCOUNT-cross-account-isolation`、
`E2E-REMOTE-ACCOUNT-confirm-once-roams-all-hosts`、
`E2E-REMOTE-ACCOUNT-strict-mode-requires-per-host-confirm`、
`E2E-REMOTE-ACCOUNT-key-rotation-keeps-account` 与
`E2E-REMOTE-ACCOUNT-disabled-key-blocks-login` 全部通过（被禁用或删除的 key 登录与注册
都被拒绝，已批准的设备令牌与 Host 证书在撤销前保持有效；组网按 key 签发凭据时，Host
链路最迟在凭据过期时中断，见 ADR 决策 8）；安全规格验收门 29–33 签核，其中 Gateway 绝不
持久化原始 AccessKey、绝不把客户端的 key 转发给 Host，客户端在设备交换后不再保留（门
30）；账户模式不可用（没有 `remoteGateway` 或 bootstrap 返回 `404`）时保持 R4/R5 的
自托管流程、不报错并隐藏账户模式入口。
- 保留的 gRPC 绑定仅在有明确消费者时交付，`.proto` 由 typebox 来源生成。

R2 的设计决定（D375，2026-09-10 记录）：远端 Host 的 provider 配置经 SSH 引导通道
写入，不经 RACP；桌面用户 MCP 服务器与不需工作区的插件工具在本里程碑通过反向工具
中继进入远程会话，需要工作区或文件系统访问的插件工具排除；工作面板终端在本里程碑
以 `terminal/*` 操作交付，在远端机器运行；`agent-host-cli` 由桌面经 SSH 上传的引导脚本按
平台从 GitHub Releases 下载桌面版本并校验公布的 SHA-256，版本不匹配即
`PROTOCOL_MISMATCH` 并提供重新下载，首版不支持没有 GitHub 出网能力的机器；SSH 配对
的桌面设备持有 `owner` 并豁免远程权限上限，除非启用 Host 策略
`applyCeilingToPairedDevices`；R2 作为一个里程碑整体交付，不拆分。

R1 退出条件包括模块测试不依赖 Electron、晚接入的客户端能在快照中看到已打开
的审批且其决定能关闭本地桌面卡片。R2 退出条件包括 E2E-231 通过、SSH 会话中断
恢复后按游标续传不重复回合、远程会话的模式/模型/思考等级变更与本地一致且仅限
空闲、远端工具目录不含需要工作区的桌面插件工具、公布中继的桌面 MCP 工具在远程回合
中于桌面执行且桌面中途关闭时工具失败而回合继续、远程会话终端在远端机器的会话根内
运行且 SSH 中断后从回放环续传、引导下载校验 checksum 并拒绝被篡改的包、版本不匹配
被拒并提供更新。R3 退出条件包括
E2E-232 通过、载荷只含摘要与 id、未关联聊天的指令无效、Host 无新监听器。

## 3. 实现规则

RACP 服务只调用无头 Agent Host 模块，模块再调用 renderer 使用的同一套
host 与 sidecar 路径；不从网络监听器调用 renderer、`host.proxy` 或 host-core；
`agent-host-cli` 在另一台机器上运行模块与监督而不改 RACP。Host 拥有活动回合、回合
队列和事件游标，客户端、浏览器标签、Electron 窗口与 SSH 会话的生命周期都不
控制 Agent 执行，结束回合必须显式调用 `turn/stop` 或 `turn/interrupt`。队列
只存在于 Host。renderer 保持与传输无关：它只经 `lib/api.ts` 访问后端，桌面
适配层为远端 Host 实现同一表面，远端 Host profile 未覆盖的功能按能力协商隐藏
而不是打桩，renderer 除展示徽标外不知道会话是本地还是远程。回放测试记录初始
快照游标、命令与幂等 key、每个已应用的持久序号、断开点、回放请求和最终快照
哈希；瞬态事件不参与顺序断言，但必须能从快照的 activeItems 重建。每个已发布
绑定必须保持相同的准入/拒绝、授权范围与权限上限、幂等结果、持久事件顺序、
队列顺序、审批生命周期与决策词汇、附件校验和终止状态。

## 4. 验证

必须覆盖生成的 schema 校验、会话/回合/队列/审批/输入/附件状态机、幂等、
游标回放与 epoch 变化、含权限上限及其 SSH 配对豁免与 `allow-session` 策略的
角色矩阵、待处理请求读取与集成载荷的脱敏、已发布 binding 一致性；集成层面
覆盖 Electron Main 内的模块、Linux 测试机上经 SSH 端口转发的 `agent-host-cli`（含引导、
配对、版本不匹配、重新配对）、不变的 renderer 经桌面适配层渲染远程会话、远程
回合运行中 SSH 会话中断与恢复、Host 重启（含排队回合，验证持久化队列恢复并挂起）、SSH 中断下的中继工具执行与终端
流式、引导下载的有效与篡改 checksum、针对 Webhook 接收端与
长轮询 bot fixture 的集成适配层，排期后再覆盖 Gateway 路由、cookie profile 下的
浏览器重连和 NAT 下的 Host link 中继。安全验证覆盖无效、过期、撤销、错误 Host
- 无效、过期、撤销、错误 Host
的设备 token，`agent-host-cli` 上非 loopback 对端与无 TLS 的非 loopback 绑定，配对 token
复用与非 SSH 通道配对，以及 D665 起的配对码交叉通道兑换：ssh 来源的码经网关、
gateway 来源的码在 loopback `RACP-WS` 上（安全规格 §3.7，门 17 与 28），错误角色/会话/Host/revision，含 `workspace/read` 越界的
SSRF 与路径攻击，超限与哈希不符的上传，试图选择 secret 或权限的注入请求，
未关联聊天与重放的集成指令，慢读者与连接耗尽，审计脱敏与保留，排期后再覆盖
Origin、CORS、CSRF、cookie 与 Gateway 中继。运营指标记录准入延迟与队列深度、
SSH 转发上的事件延迟与序号滞后、回放/重同步/epoch 变化次数、审批等待与过期、
Host 连接健康与引导时长与版本不匹配、认证与授权失败、集成投递延迟与重试、
瞬态/持久分别统计的事件丢弃数，以及活动 Host/会话/客户端数。

## 5. 发布与回滚

先发布 typebox 契约、生成的 fixture 和禁用代码路径；R1 只在开发 profile 启用；
SSH 隧道拓扑先对 allowlist 用户以 feature flag 启用再普遍开放；集成适配层作为
默认不配置任何渠道的可选设置启用；R4–R6 作为独立启用的面交付（D665）：Gateway
是用户自行启动的独立服务，桌面链路与移动客户端是默认关闭的可选设置；保留的
gRPC 里程碑只由后续记录在案的产品决策排期；R7（D666）按 Router 启用：只有 Router 返回
`remoteGateway` 对象时才开启账户模式，移除该对象即回滚，桌面随之保持自托管流程。kill
switch 拒绝新的远程连接并取消远程主体提交的排队回合，不影响本地桌面。回滚必须停止接受
新的远程连接并停止集成适配层，远端 `agent-host-cli` 进程按用户选择保留或停止但绝不删除
其 transcript，保持本地 stdio、renderer 与 MCP 路径可用，保留本地已完成的 transcript，
且绝不因远程 feature flag 变化而重放回合。

## 6. 生产准入

已排期的功能集只有在 E2E-221 至 E2E-226、E2E-229、E2E-230、E2E-231 通过，
集成适配层的 E2E-232 通过，适用于已排期里程碑的远程安全门签核，故障注入证明
含 SSH 会话中断在内的重连不重复执行，桌面发布流水线发布的每个 Linux 平台都有带
checksum 发布到 GitHub Releases 的 `agent-host-cli` 包且版本不匹配与篡改下载路径已测试，Host 运营指标可用，且新的发布/回滚
runbook 写明 feature flag、配对撤销路径、远端机器上的数据保留和事件负责人之后，
才可进入生产。绑定 parity 与 E2E-227 / E2E-228 在其里程碑排期后成为门槛。

R4–R6 准入（D665）：E2E-227、E2E-228、E2E-265 与 E2E-266 针对打包后的 Gateway、
可连接的桌面 Host 与移动客户端全部通过；`05-security/02-remote-control-security.md`
的安全门 22–27 签核通过（含桌面关闭态回归）；部署 README 的 Nginx 示例经实测透传
SSE 不缓冲。

R7 准入（D666）：五个 `E2E-REMOTE-ACCOUNT-*` 场景针对本地 Router 测试实例与打包后的
Gateway 全部通过，且 `05-security/02-remote-control-security.md` 的安全门 29–33 签核。

## 7. 实现状态

记录于 `feat/remote-agent-host` 分支，2026-09-10：

- R0 已交付：`packages/shared` 中以 typebox 定义的 RACP 契约（`racp.ts`）、生成的
  JSON Schema fixture、本地到 RACP 的事件映射、远程权限上限和共享错误码。
- R1 已交付：host-core 的 `permissions.pending`；无头 `packages/agent-host` 模块（epoch
  事件日志、有界扇出、审批代理、回合队列、快照构建）；在现有 IPC handler 之上承载该
  模块并把每个 agent 事件送入它的 Electron 桥接层；以及 schema v15 的持久化
  `turn_queue` 与其 RPC 方法（D386 / ADR 0213）。
- R1 已交付：renderer 的内存 prompt 队列已退役；composer 经 `agent/queue/push` 推入，
  镜像 `agent/event/queueChanged`，“立即发送”即 `turn/prioritize` 加优雅停止。
- R1 部分完成（2026-09-18）：运行时级别的逐回合权限上限已在 JS 端全链路串通（`AgentPromptRequest.permissionMode` → agent-ipc → `RuntimeService.startTurn` → sidecar `agent.prompt`），桥接层不再对每一处会话/生效模式不一致直接拒绝。生效模式比会话更宽的请求（提权）仍作为深度防御拒绝；更窄的上限透传并在 sidecar 侧作为文档化的占位收下。turn 级的真正执行还差 host-core 一步（`session.beginTurn` 接受覆盖参数），因此本地回合上的收紧目前尚未夹紧工具决策。
- R2 已开始（2026-09-18，D447 / ADR 0284）：`packages/host-runtime` 承载与 Electron 无关的运行时层 —— host-core 与 sidecar 的 stdio 传输、重启监督器、`RuntimeService`（模块的 `RuntimePort`，含持久回合生命周期）、转录持久化、无头启动解析器与已批准 Plan/Goal 的派发 —— Electron main 通过薄适配层运行其上。
- R2（2026-09-18，D448 / ADR 0285）：`packages/racp` 承载 `RACP-WS` 服务端与客户端核心、回环上的 `ws` 绑定与设备令牌配对；握手、鉴权、幂等、队列顺序、审批、游标重放、驱逐、epoch 变更、慢客户端与不重复执行的重连都是包内测试。`agent-host-cli` 包、桌面适配器与 SSH 引导此后均已开始：R2a 桌面内核（D449 / ADR 0286）带来了适配器与 `agent-host-cli` 包，SSH 引导随后在 D453 / ADR 0292 落地。
- R2b 部分完成（2026-09-19，D453 / ADR 0292）：桌面使用用户自己的 `ssh` 客户端并以 `BatchMode=yes` 在远端安装并配对 `agent-host-cli`，用户的配置、agent 与跳板机照常生效，应用不持有任何 SSH 密钥。`remote/agent-host-cli-release.ts` 承载纯发布坐标（远端平台、桌面版本、已发布的 SHA-256、拒绝未发布的目标），`remote/agent-host-cli-bootstrap-script.ts` 生成唯一的 `umask 077` 脚本：下载、校验、安装到远端 `$HOME`、以 `--pair` 在回环上重启主机，并回显 `AGENT_HOST_CLI_READY` / `AGENT_HOST_CLI_PAIRING_TOKEN`；`remote/ssh-transport.ts` 是可注入的传输端口，`remote/ssh-tunnel.ts` 为每台主机维护一条持久的 `ssh -N -L` 转发，每次启动重新建立，并在引导时被收编（adopt），使配对只建立一条隧道。记录以 `metadata.transport = "ssh"` 加 SSH 描述符取代 URL，`minih-agent-desktop/remoteHost/bootstrap` 加入 `list` / `pair` / `remove`。终端工作面板客户端、反向工具中继，以及经 SSH 通道下发 provider 配置均不在本次范围内。
- R4 已由 PR-2（`feat/remote-gateway`）交付：`apps/remote-gateway` 提供自托管网关，包括
  绑定地址校验（gate 22–23）、`--data-dir` 文件存储（目录 0700、文件 0600、原子 rename）、
  本地 CA 与注册/吊销、先校验身份再替换同 `hostId` 旧链路的 wss + mTLS Host link 监听、
  带 header 与 cookie 两种鉴权及 Origin/CORS/CSRF 控制的 `RACP-HTTP` + SSE 客户端 API、
  配对中继、每个 `(device, host)` 复用一条命令连接且每设备最多 4 条事件流的
  HTTP→逻辑连接路由器、按设备与 IP 的令牌桶、闭集审计日志，以及基于 owner-only 管理
  socket 的 `serve` / `enroll-code` / `hosts list|revoke` / `devices list|revoke` CLI。
  `agent-host-cli` 新增 `enroll`（本地密钥对、CSR、固定网关 CA、0600 的
  `gateway-link.json`）、可选的 `--gateway` 外连（1s–60s 抖动退避）、走原管理 socket 的
  `remote-pair`，以及吊销时调用 `RacpServer.closeConnectionsForSubject` 的接线；loopback
  监听、`--pair` 与 SSH 引导行为不变。`RACP_SHIPPED_BINDINGS` 现已包含 `RACP-HTTP`：
  一致性测试对同一个 `RacpServer` 分别经 `RACP-WS` 与网关跑同一组确定性命令，比较结果、
  错误码与会话状态。`scripts/e2e-remote-gateway.mjs`（`pnpm test:e2e:remote-gateway`）
  覆盖 E2E-227：打包后的网关与打包后的 `agent-host-cli` 加真实 host-core，验证注册与外连、
  header 与 cookie 两种配对、跨 SSE 续传只应答一次的审批、网关重启后 Host 自动重连与
  游标续传、任一侧吊销在 5 秒内生效，以及网关令牌在 loopback 绑定上被拒绝。附件中继仍延后
  （`RacpServer` 声明 `attachments: false`），E2E-227 第 5 步不在 R4 执行。
- R5 已由 PR-3 与 PR-3b（`feat/desktop-gateway-link`）交付：Electron Main 通过一条出站
  Host link 提供现有 Agent Host，只有设备本地的 `remoteGateway` 打开且已注册时才创建——
  关闭状态下不写凭据文件、不创建 `RacpServer`、不建立 socket，桌面端始终不监听。
  `racp-gateway-link-port.ts` 注入 PR-2 的 `enrollHostLink` / `startHostLink`，把
  `HostLinkError.code` 转成 IPC 层读取的 `errorCode`，让设置页能指明 CA 不对、注册码已用
  或本机已被吊销，而不是笼统失败。经设置页或 `session/revoke` 吊销设备会立即关闭该设备
  已打开的逻辑连接。`scripts/e2e-desktop-gateway-link.mjs`
  （`pnpm test:e2e:desktop-gateway-link`）覆盖 E2E-265：打包网关下验证关闭态不注册、不开
  监听、注册与外连、viewer/controller/approver 角色配对、经网关只会应答一次且本地卡片同时
  关闭的审批、拒绝 `allow-session`、会话配置、工作区读取与终端、任一侧吊销 5 秒内生效、
  开关关闭与恢复链路、`dispose()` 后无残留定时器与 socket，以及两端日志不含凭据。

- R7 工作包 C 已交付（2026-10-18，D666 / ADR `remote-control-router-account-binding`）：
  Gateway 账户目录——可信代理客户端地址解析、Router AccessKey 校验器、按 key 注册并把
  账户绑定写入签发的证书、账户登录与账户主机列表（会话凭据只存哈希且有界）、按客户端
  IP 的凭据限流，以及针对 stub Router 的跨账户隔离测试。本包确定的路由、错误码、会话
  形态、证书绑定与客户端 IP 规则已写入协议 §11.5、安全规格 §3.8 与 Gateway README。
  仍缺：`device.request` / `device.grant` 帧与能力声明（工作包 D）、Electron main 自动注册
  与 Host link 接线、确认对话框与严格模式（工作包 E2）、客户端 key 登录与主机切换（工作包 F），
  以及在 Router 旁的部署（D-1）。
  `E2E-REMOTE-ACCOUNT-*` 场景仍为 Draft：目前只覆盖了跨账户隔离的第 1–4 步与第 6 步，
  由 Gateway 自身的集成测试承担。

- R7 工作包 E1 已交付（2026-10-18，D666 / ADR `remote-control-router-account-binding`）：
  工作包 E 的 host-core 部分。bootstrap 应答里可选的
  `remote_gateway { hostlink_url, public_origin, ca_pem }` 对象采用宽松解析——两种拼写都接受，
  对象畸形绝不让组网失败：组网身份照常生效，账户模式报告为不可用并给出原因。Host link 目标
  由该端点推导：端点是域名而非 IP 时用同一应答的 `gatewayVirtualIpv4` 作为组网地址；No-TUN
  模式为它安装第二条回环转发，端口绝不复用 Router 转发端口；TUN 模式不装。`EasyTierStatus.remoteGateway`
  暴露 `available`、端点与 CA、拨号地址、证书服务名、转发端口，以及账户模式不可用的原因。
  字段规则、目标与端口规则、状态形状写入 provider 配置规格 §3。仍缺：Electron main 自动注册
  与 Host link 接线、确认对话框、严格模式与 i18n（工作包 E2），客户端 key 登录与主机切换
  （工作包 F），以及在 Router 旁的部署（D-1）。`E2E-REMOTE-ACCOUNT-*` 场景仍为 Draft：
  E1 自身不改变任何用户可见流程。

- R7 工作包 E2 已交付（2026-10-18，D666 / ADR `remote-control-router-account-binding`）：
  账户模式的桌面侧。设置 ▸ 远程网关读取 `EasyTierStatus.remoteGateway`，当 Router 公布可用端点
  且用户的远程控制开关已打开时，用账户 AccessKey 完成注册——key 经 host-core 从已保存的
  `minih-router` 记录读入，只用于这一次请求，绝不进入任何 renderer 载荷、日志或凭据文件。桌面端
  改为在公布的服务名下经 No-TUN 转发拨号（`tlsServerName`，安全 §5.1），不再用回环地址。注册
  身份取下发端点——`hostlinkUrl`、其 CA 与该名字——因此 host-core 在下一次组网启动时重新分配
  的转发端口既不会让桌面重新注册，也不会让链路失联：拨号地址在每次连接与每次重连时重新解析，
  已持有的证书即使 Router key 已被禁用也继续可用（ADR 决策 8）。确认对话框在桌面窗口询问用户
  ——设备名、客户端、剩余时间，焦点落在“拒绝”，Escape 即拒绝，`expiresAt` 到期即关闭——主动
  报告即将消失的 renderer 会立刻拒绝等待中的请求，而没有窗口能显示的请求则等到 `expiresAt`
  才被拒绝。严格模式是设备本地开关，默认关闭，通过重建链路生效，使能力
  列表不再声明 `device.accept-sibling-grant`。每次铸出、收编与吊销都给出一条通知（ADR 决策 6），
  设置页发起的吊销以签名帧传播，链路断开期间排队。`device.request` 这条路径由 main 进程测试、
  Electron 渲染的页面与弹窗测试，以及现有的 remote-host 与 remote-gateway 套件覆盖。
  仍缺：客户端 key 登录与主机切换（工作包 F）、账户之上的推送（工作包 G），以及在 Router 旁的
  部署（D-1）。`E2E-REMOTE-ACCOUNT-*` 场景推进为 Partial：跨账户隔离与“确认一次”步骤现在跑在
  真实桌面 Host 上，经真实 Router 的路由仍是部署门禁。

- R7 工作包 D 已交付（2026-10-18，D666 / ADR `remote-control-router-account-binding`）：
  账户模式设备中继。新增 Host link 帧 `host.capabilities`、`device.request`、
  `device.grant`、`device.revoke`；每条链路建立后声明能力；由批准方 Host 签名的授权，兄弟
  Host 按所固定的网关 CA 与签名者证书里的 `OU=account:` 绑定校验，原始令牌只出现在
  “批准方 Host→Gateway”这一跳；一个令牌通用于账户内所有主机；按账户作用域的客户端路由
  `POST /v1/account/devices` 与 `GET /v1/account/devices/{requestId}`；Gateway 只向声明
  支持的主机扇出，并立即把无法确认的主机告知客户端；授权时离线的主机获得持久化的待处理
  授权，在新链路宣告能力时幂等重投；吊销以签名帧传播到账户内其他主机，链路断开期间排入
  Host 本地待发队列、恢复后重新投递；请求记录按账户与发起会话限定作用域，令牌只在很短的
  取件窗口内交付一次；`agent-host-cli` 通过其 admin socket 完成设备确认
  （`devices pending` / `approve` / `deny` / `revoke`），由 `--confirm-devices` 与
  `--strict-devices` 控制，并支持按 AccessKey 注册——key 由 0600 文件、stdin 或环境变量
  读入，绝不从命令行参数读取。本包确定的帧形状、规则、路由与错误码已写入协议
  §11.4、§11.5、安全规格 §3.8 与门禁 32–33、Gateway README 与 `agent-host-cli`
  README，`E2E-REMOTE-ACCOUNT-confirm-once-roams-all-hosts` 有了任务候选 E2E
  （`pnpm test:e2e:remote-account-device`）。仍缺：Electron main 自动注册与 Host link
  接线、桌面确认对话框、严格模式 UI 与 i18n（工作包 E2），客户端 key 登录与主机切换
  （工作包 F），以及在 Router 旁的部署（D-1）。
  桌面 Host 目前不声明任何设备能力，因此账户模式确认暂只由 `agent-host-cli` 承担；
  `E2E-REMOTE-ACCOUNT-*` 场景仍为 Draft，因为它们的桌面与 webview 步骤需要工作包 E2 与 F。

- R7 工作包 F 已交付（2026-10-18，D666 / ADR `remote-control-router-account-binding`）：
  `apps/remote-web` 的账户模式客户端。账户模式由一个不带凭据的 `GET /v1/account/hosts`
  探测——只有 `401` 才显示 AccessKey 入口，因此不支持账户模式的 Gateway 完全保持原有配对
  流程、不多显示任何东西；AccessKey 只提交一次，绝不写入存储、日志或 URL；申请设备时立即
  展示账户内完整的 Host 花名册（包括无法确认的主机），一台都确认不了时提供协议 §11.4 的
  票据；状态路由每两秒轮询一次，失败按指数退避、连续八次失败即结束，`RATE_LIMITED` 时严格
  遵守 Gateway 给的 `Retry-After`，客户端自己的截止时间也会在不发起新读取的情况下结束等待。
  拿到授权后按 profile 保存设备——浏览器每台 Host 一个 `HttpOnly` cookie，原生端写入平台
  安全存储——随后通过新增的 `POST /v1/account/logout` 作废账户会话，因为浏览器无法自己清除
  `HttpOnly` cookie。Gateway 侧新增了该登出路由、按 Host 的浏览器设备交接（含
  `csrfTokens`），以及“Host 尚未收编该设备”时新的 `HOST_UNAUTHORIZED`（401）应答——仅限
  账户模式设备，因此经 §11.4 配对的设备被 Host 拒绝时仍是 `UNAUTHORIZED`。客户端把它显示为
  “未就绪”，并给出真正可行的下一步：还没追上来的 Host 可以刷新；而花名册已表明永不接受兄弟
  授权的 Host 则提示“重新申请，并在那台电脑上批准”，新设备会替换掉客户端已知每台 Host 上的
  旧设备。客户端流程、两种凭据 profile、两个 401 的区别，以及浏览器交接能覆盖到哪些 Host，
  已写入协议 §11.5、`remote-web` README 与 Gateway README。工作包 E2 已先行交付，
  仍缺的是推送（工作包 G）与在 Router 旁的部署（D-1）。`E2E-REMOTE-ACCOUNT-*` 场景的客户端
  步骤已实现，并已在真实 Gateway、Router 桩与 `agent-host-cli` Host 上通过浏览器交互验证，
  但目前还没有提交进仓库的套件驱动 Web 客户端，经真实 Router 的运行仍是部署门禁。

- R7 工作包 G 已交付（2026-10-18，D666 / ADR 0331 决策 7）：账户模式之上的脱敏推送，
  它同时就是 R5 PR-6，因此关闭了退出条件 4。Host 通过新的 `host.notify` 帧报告协议 §11.6 的
  四种事件——`approval.requested`、`input.requested`、`turn.completed`、`turn.failed`——
  且必须先宣告 `push.notify` 才能发；该帧在 schema 上封闭，提示词、工具、路径、记录、标题都
  带不进去。Gateway 把它变成一条只含固定事件类型、两个本地化键与 id 的推送，只发给能打开该
  Host 的设备（§11.4 设备：它自己的 Host；账户设备：本账户的 Host），按事件去重，对 Host 与
  每个设备分别限额，并在设备被吊销或服务商报告令牌失效时删除注册。`PUT`/`DELETE
  /v1/push/registration` 是客户端一侧；在运营者配置 `--apns-key-file`/`--apns-key-id`/
  `--apns-team-id`/`--apns-topic` 或 `--fcm-service-account-file` 之前推送关闭——应答
  `enabled: false` 且不保存任何东西——这些文件在启动时一次性读取，规则同 `--access-key-file`
  （0600、调用方拥有）。APNs 走 HTTP/2 配 ES256 服务商 JWT，FCM 走 HTTP v1 并用服务账号换取
  OAuth2 令牌，两者都只用 Node 自带模块，不引入服务商 SDK。原生客户端申请权限、按设备注册
  服务商令牌（账户设备一条，每个 §11.4 配对一条）、在授权 `DELETE` 的令牌被删除之前注销，
  并按点击通知中的 id 打开对应 Host 与会话；浏览器构建不实现 Web Push。通知文案放在应用
  包内——en 与 zh-Hans 的 `Localizable.strings`、en 与 zh-rCN 的 `strings.xml`——由客户端
  词条生成并有测试守着，因为应用在后台时是系统在渲染通知。本包的审查关闭了六个漏洞，每个
  都有测试：HTTP v1 里非法的 `notification.title_loc_key` 结构（它让所有 Android 推送静默
  失败）、服务商调用没有硬性超时（卡住的服务商泄漏一条 HTTP/2 会话并拖住其余投递）、注册
  写入可能重建已吊销设备的记录、id 只限长度不限字符、客户端在忘记主机时从不注销，以及把
  `DeviceTokenNotForTopic` 或裸 `404` 当成死令牌（一次配置错误就会清空一个平台的全部注册）。本包确定的形状与规则写入协议 §11.6、安全门禁 34、两份 README，以及
  `pnpm test:e2e:remote-account-push`（真实审批、真实 HTTP/2 APNs 桩校验 JWT、真实 OAuth2
  交换、`410` 清理、被吊销设备不再收到推送）。仍缺：在 Router 旁的部署（D-1）与用运营者
  自己的 Apple、Firebase 材料做的真机验收。

## 8. 修订记录

D374（2026-09-10）用无头 Agent Host 模块替换 Electron facade 里程碑，加入
Host 队列与 `permissions.pending`，将 `RACP-WS` 定为 v1 唯一规范绑定并加入
浏览器 profile、保留的 gRPC、Host link 中继与身份源决定，并把租户隔离测试改为
依赖多租户 harness。

D375（2026-09-10）按已记录的需求重排里程碑：R2 为桌面作为客户端的 SSH 隧道
远端 Host，R3 为出站消息集成，Gateway、浏览器与 gRPC 里程碑不排期；并加入
`agent-host-cli` 包、桌面适配层规则以及作为验收目标的 E2E-231 / E2E-232。同日记录的设计
决定把反向工具中继与终端放进 R2 并整体交付，`agent-host-cli` 从 GitHub Releases 下载，
回合队列持久化到 host-core，远程审批默认寿命 30 分钟，配对设备豁免改为 Host 策略，
Gateway 身份源定为 PI 账号服务。

D385（2026-09-10）撤回身份源条款：远程控制从结构上就是用户本地的，Gateway 只能由
用户自托管并以 Host 签发的设备凭据准入。

D665（2026-10-17，ADR 0331）在维护者要求从手机跟进并操控 `agent-host-cli` 常驻
机器与运行中桌面两边的回合之后，把 Gateway 与浏览器里程碑排期为 R4–R6。它命名了
`apps/remote-gateway` 与 `apps/remote-web`；`client.open` 的 `credential` 字段与
Host 侧对 Host link 的重新认证；把网关配对主体压在远程权限上限之下、排除在 owner
角色之外的设备来源规则；Gateway 存储、配对与注册设计；桌面默认关闭的可连接 Host
设置；以及带可选脱敏推送的 Capacitor 移动打包。gRPC 绑定保持保留、不排期。

D666（2026-10-18，ADR `remote-control-router-account-binding`）在 R4–R6 之上把账户模式
加入本交付序列（R7）：§1 的排期顺序、工作包 A–G 与在 Router 旁的部署、绑定五个
`E2E-REMOTE-ACCOUNT-*` 场景与安全规格验收门 29–33 的退出条件、§5 的按 Router 启用、
§6 的 R7 准入，以及“Router 不返回 `remoteGateway` 时保持 R4/R5 的自托管流程并作为
回退”这条规则。gRPC 绑定保持保留、不排期。
