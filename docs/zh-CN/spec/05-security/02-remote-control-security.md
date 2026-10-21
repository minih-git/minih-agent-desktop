# 远程 Agent 控制安全规格

- 状态：目标规格，属于 MVP 之后
- 决策：D373 / ADR 0205，经 D374 与 D375 修订
- 英文源规格：[英文源规格](/spec/05-security/02-remote-control-security)

## 1. 安全目标

远程控制必须提供身份认证、会话级授权、TLS、撤销、审计、资源上限、
无重放保证，以及远程权限上限，使远程 controller 无法把会话变成无人值守
执行。prompt、tool result、附件和模型输出均是不可信数据，不能凭自身内容
提升权限。

```text
Remote Client ── HTTPS/WSS ── Gateway
                                  │ outbound mTLS Host link
                                  ▼
                             Agent Host
                             ├── pi sidecar
                             └── Rust host-core
```

## 2. 信任区

| Zone | Trust assumption | Required boundary |
|---|---|---|
| Remote Client | 已认证但 UI 和 prompt 不可信 | 有范围的 session 或 bearer 凭据，不默认给 secret 权限 |
| Gateway | 用户自托管的中继，暴露在网络边界 | auth、授权、限流、审计、仅瞬态缓冲，不访问 raw host RPC |
| Agent Host | 工作区旁的本地权威 | mTLS/device identity、签名 route context、Host policy、远程权限上限 |
| Node sidecar | Agent runtime，不拥有 policy | Main/Host proxy allowlist |
| Rust host-core | 工作区、存储、工具、权限、secret 权威 | 仅 stdio，无公网监听 |

```ts
type HostRouteContext = { tenantId: string; hostId: string; subject: string; clientConnectionId: string; sessionScopes: string[]; roles: string[]; expiresAt: string }
```

## 3. 身份、授权与边界

D385 使远程控制从结构上就是用户本地的：链路中没有任何项目方运营的身份或账号服务，
客户端持有的唯一凭据是用户自己的 Host 在配对时签发的设备 token；Gateway 若由用户
自托管，也只以这些 Host 签发的设备凭据准入，并在路由前校验其 Host id、有效期与撤销
状态。OIDC 联合与 pi-backend 账号服务不在远程控制范围内，该模型中不存在 refresh token。
浏览器无法在 WebSocket/EventSource 上设置请求头，因此 Gateway 提供两种认证
profile：非浏览器客户端用 `Authorization` 头（header profile）；浏览器客户端用
HttpOnly、Secure、SameSite=Strict cookie + Origin 规则 + 每次 mutation 的 CSRF token
（cookie profile；cookie 限定在已配对 Host 的作用域内并带有限 `Max-Age`，最长 400 天，
因此浏览器重启后配对仍然有效），也可改用带头部认证的 `fetch` 流式读取。cookie 鉴权的请求
必须带白名单内的 `Origin`；唯一例外是浏览器同源 `GET`/`HEAD`（`Sec-Fetch-Site: same-origin`），
`Origin` 存在但不在白名单内一律拒绝，修改类请求永不豁免。CORS 只暴露必要的方法、
请求头与响应类型：放行的请求头就是 RACP 客户端实际发送的那一组（`authorization`、
`content-type`、`x-minih-racp-client`、`x-csrf-token`、`last-event-id`），取自同一份
共享清单，两侧不会漂移；`x-trace-id` 在成功与失败响应上都暴露，因为客户端要在错误里
带出它；这两类头只发给白名单内的来源，绝不使用 `*`。两种
profile 都禁止把 token 放进 URL。Gateway 与 cookie profile 随 Gateway 与浏览器
里程碑交付（R4–R6，D665）；首个远程拓扑使用 header profile，设备 token
来自 SSH 引导配对。Host 通过出站 mTLS Host link 连接 Gateway，link 只认证
Gateway，用户权限只来自每个逻辑连接的签名 route context；一次性 enrollment
credential 必须短期、单次使用。注册（D665，ADR 0331）是一次性交换：管理员在
网关上打印 15 分钟有效的一次性注册码，Host 本地生成密钥对，把 CSR 与注册码发到
Host link 端口上仅做服务端 TLS 认证的专用注册接口，用 `--gateway-ca` 固定网关
身份、指纹不匹配即拒绝，网关签发一年期、CN 为 `hostId` 的客户端证书；Host link
随 R4 交付。

SSH 引导配对（首个远程拓扑）：桌面经用户自己的 SSH 会话在远端启动 `agent-host-cli`，
SSH 登录已证明对该机器的 shell 访问，配对只是把一个桌面设备绑定到它启动的
Host。配对 token 由 Host 启动时生成，单次使用，在引导窗口内过期，只经 SSH 通道
传递，绝不写入可读文件或 URL；桌面在转发的 loopback 端口上用它一次性换取设备
token 并存入安全存储，Host 把该设备记为 `owner`。Host 只绑定 loopback，只接受
loopback 对端出示的设备 token；非 loopback 绑定要求 TLS 与同样的设备 token。引导脚本经 SSH 上传后，从 GitHub
Releases 下载与桌面同版本、对应远端平台的 `agent-host-cli` 包，校验随发布公布的 SHA-256 后
安装到用户主目录；桌面自身从不上传可执行字节。首版无法引导没有 GitHub 出网能力的
机器。
在 Host 上撤销设备 token 或在桌面移除该 Host 即结束配对，重新配对需要重新
经 SSH 引导。远端 Host 的 provider 配置由引导步骤经 SSH 通道写入为 Host 本地
配置，绝不经过 RACP。

自托管、用户本地的网关场景（D665，ADR 0331）下，route context 的完整性由已认证的
Host link 保证：只有持有匹配客户端证书的已注册网关能发送 Host link 帧，Host 不再
对 context 验证第二个签名；Host 仍校验 `hostId` 等于自身 id、context 未过期、同一
链路上 `clientConnectionId` 不重复使用。最终鉴权方始终是 Host 自己的凭据存储：每条
中继逻辑连接都用 `client.open` 帧的 `credential` 重新认证（见下），网关缓存的令牌
哈希只用于路由前快速拒绝和限流；`credential` 绝不出现在日志或审计记录中。

经网关配对的设备（D665，ADR 0331）：设备记录新增可选 `origin` 字段（`"ssh"` 或
`"gateway"`）；D665 之前持久化的记录没有该字段，按 `"ssh"` 读取，旧凭据文件无需
迁移。每个认证输入还携带连接来源：loopback `RACP-WS` 绑定为 `"ssh"`，Host link
逻辑连接为 `"gateway"`。`"ssh"` 连接上的 `connection/pair` 行为不变：授予
`["owner"]` 并记录 `origin: "ssh"`；`"gateway"` 连接上授予
`["viewer", "controller", "approver"]` 并记录 `origin: "gateway"`，角色由 Host
决定，客户端传的 roles 一律忽略。配对令牌与其铸造的设备同源（ADR 0331）：
`PairingRecord` 新增可选 `origin` 字段，缺省按 `"ssh"` 读取；`--pair`（SSH 引导）
签发的码只能在 loopback `RACP-WS` 上兑换，`remote-pair` 和桌面设置页签发的码只能在
Host link 上兑换，交叉通道兑换一律失败，SSH 引导的配对码无法经网关消耗。设备令牌认证把 `pairedDevice` 设为
`device.origin !== "gateway"`，因此网关配对设备绝不是 SSH 配对的 owner：不豁免
远程权限上限，也拿不到 `allow-session`。对网关来源的主体，以下限制不受 Host 策略
影响，必须用测试锁住而非依赖默认值（ADR 0331）：即使 Host 配置了
`allowRemoteSessionGrants: true` 也不能获得 `allow-session`；永远不带
`approverOverride`；不管 `applyCeilingToPairedDevices` 怎么配都始终受远程权限上限
约束。网关来源令牌只能在 Host link 上认证，
ssh 来源令牌只能在 loopback `RACP-WS` 上认证，交叉通道使用一律拒绝——被盗的
网关令牌无法借 SSH 隧道提权，owner 令牌也无法经网关重放。任意一侧（网关或 Host）
吊销后，新连接被拒绝，已有中继逻辑连接在 5 秒内关闭。

- **D666 修订（2026-10-19，工作包 A2）：网关设备可以改什么。** 维护者决定：登录用户
  自己账户的手机，可以像坐在电脑前的人一样做三件事——新建会话（`session/create`，
  本来就是 `controller`）、把这台电脑的某个文件夹注册为项目（`project/register`）、
  逐级浏览文件夹来选一个（`project/browse`）。后两个操作原本要求 `owner`，本次降为
  `controller`；角色表里其余条目一律不动。网关与账户设备仍然永远拿不到 `owner`，因此
  会重组或暴露这台机器的操作——`workspace/toolExecute`、`workspace/toolShell`、
  `workspace/files`、`session/delete`、`session/archive`、`session/revoke`、
  `tools/advertise`——依旧不可达。
  两个操作都限制在一个根目录（用户主目录）内：Host 先用 `realpath` 规范化路径，再拒绝
  不在该根内的路径，因此 `..`、相对路径、指向根外的符号链接一律 `REMOTE_PATH_FORBIDDEN`，
  不存在的路径报 `REMOTE_PATH_NOT_FOUND` 而不是被创建。注册返回选择器自己使用的规范路径；
  浏览只列目录、上限 500 条，到了根目录就不再给 `parent`。
  每次改状态都会报告发生了什么——哪台设备、以及会话 id 或注册的路径——走的正是设置页
  已经在渲染的设备通知通道（铸造/收编/吊销），同时写入 Host 日志，因此坐在电脑前的人
  会知道手机在这里开了会话或加了文件夹。
  **路径可能落到哪些日志里。** 注册把路径放在请求体（`POST /v1/projects`），因此不会出现在
  反向代理的访问日志里；浏览把路径放在查询串（`GET /v1/projects:browse?path=…`），所以
  那条绝对路径——含主目录里的用户名——会出现在访问日志中。GET 仍然是对的动词（该调用只读目录、
  不改变任何状态），而且路径是用户自己的、由其自己的设备在同一条已由 Gateway 终止的 TLS 连接上
  发出；运营者需要知道的是：浏览路径在访问日志里可见，注册路径不可见，因此日志保留与访问权限
  同样适用于它。
  被否决的方案：给网关设备 `owner`。它只是角色列表里的一个词，但同时会把工作区工具面、
  shell 访问和会话删除交给手机，这既是用户没有要求的，也不是远程权限上限设计来仲裁的。

账户模式（D666，ADR `remote-control-router-account-binding`）：Router 的
AccessKey 只用于发现与注册。客户端的 AccessKey 只交给 Gateway：Gateway 经 loopback
调用 `GET /api/auth/session` 校验，绝不持久化原始 key，也绝不把它转发给 Host。Host 只
只在注册时持有本账户 key 一次（桌面上即 D661 的 provider 行；`agent-host-cli enroll`
从 `--access-key-file <path>`（权限 0600、属主为调用者）、`--access-key-stdin` 或
`MINIH_ROUTER_ACCESS_KEY` 读取 key，一次性提交后只保存签发的证书与私钥，并**拒绝**在
命令行上直接给出 key——argv 经 `ps` 与 `/proc/<pid>/cmdline` 对全机可读，还会进入 shell
历史，与把 key 写进日志是同一类泄露）。客户端在换取设备令牌后即丢弃 key，此后只
持设备令牌；key 不得出现在 Host 设备存储、日志、审计记录、URL 或错误载荷中。一次登录
留下的唯一持久状态是 Gateway 用已校验 key 签发的会话凭据的 SHA-256 哈希，且有效期有界；
校验结果绝不缓存，每次登录都会重新调用 Router。账户目录（key 校验、按 key 注册、账户
登录、账户主机列表，以及设备申请 / 确认 / 授权中继）已实现（工作包 C 与 D），下列条款均按
定稿实现。Gateway 仅在 TCP 对端位于其配置的可信代理集合内时才从
配置的头读取调用者地址，否则采用对端地址，并把该地址放进 Router `CLIENT_IP_HEADER`
指定的头转发；Gateway 的 loopback 对端必须在 Router 的 `TRUSTED_PROXIES` 内，
`allowed_peer_cidrs` 才能作用于真实调用方。头名与可信代理是同一项设置：只配一半则拒绝
启动，部署无法静默退回代理自身地址。链解析规则与 Router 自身解析器一致，因此转发值在
两端含义相同：`X-Forwarded-For` 从右向左取第一个不在可信代理集合内的条目（全部可信时
取最左条目），其他头只承载一个地址，条目不是 IP 地址时回退到对端。解析出的地址用于按
IP 限流与审计记录；两个设置都不给时，解析结果就是 TCP 对端地址，与账户模式之前完全
一致。密钥生命周期：被禁用或删除的 key 校验失败，不能再发起新登录或注册；key 状态本身
不撤销任何东西，已批准设备与已注册 Host 只能经既有撤销路径撤销（§3.7、门 26）；按 key
签发的组网凭据过期后，key 被禁用的 Host 无法刷新 bootstrap，链路会中断——这是网络层
边界而不是撤销，禁用 key 也不是紧急开关。账户目录（网关 CA 加 Router 的 key 校验）现在
为“兄弟 Host 属于同一账户”背书，因此“确认一次、处处可用”接受如下风险：被攻陷的网关 CA
可以把伪造的 Host 注册进某个账户，用它签发被该账户其他 Host 接受的授权，从而在所有这些
Host 上取得设备。必须同时具备的缓解措施：授权由 Host 签名而不是网关、设备角色与远程
权限上限不变、任一 Host 可撤销且该撤销以签名帧传播到其他主机、每个 Host 显示“新设备”
提示、每次授权都有审计记录、严格模式拒绝兄弟授权（客户端因此不把它算作会接受授权的主机，
也不会对它提供永远无效的“刷新”，而是提示重新申请一次并在那台电脑上批准）。原始设备令牌与 CA 是两件事：它只在
“批准方 Host→Gateway”这一跳传输，Gateway 在转发授权前剥掉它且从不记录、审计或持久化它，
兄弟 Host 只凭令牌哈希收编设备。令牌只交给发起申请的客户端一次，并为重试留三十秒取件窗口，
之后即被丢弃，因此没被取走的令牌不会被后来得知 requestId 的人收走；requestId 也不是凭据，
其他账户或同账户其他会话读取它，得到与不存在 id 相同的 `NOT_FOUND`。Host 在链路断开期间
执行的吊销会进入待发队列，链路恢复后送达账户内其他 Host，丢失的设备因此在所有主机上失效，
而不只是本机。跨账户隔离是硬规则：共享组网上的可达性不构成授权（所有用户的终端
同处一个组网，classic 共享密钥模式下每个调用方持有同一个组网密钥）；任何路由、主机列表、
设备记录、待处理授权与审计查询都不得跨账户，Host 只接受同一账户内由网关 CA 注册的签名
者、针对未撤销设备签发的授权。Gateway 按 IP 的限流（ADR 决策 10）天然跨账户，按账户的
限额彼此独立，任何限流应答都不泄露其他账户的数据。账户登录与按 key 注册共用一个按解析
地址键控的严格凭据桶，调用方无法用命令预算猜测 key。跨账户尝试的错误码在注册上是
`HOST_ACCOUNT_MISMATCH`（403），因为它不指明账户、只暴露 `hostId` 已被注册；按账户
作用域的路由一律返回协议 §13 统一的 `UNAUTHORIZED`（与不存在的 Host 相同），因此列表或
路由尝试都不会泄露其他账户的 Host。经自托管流程注册的 `hostId` 同样不是账户资产：
AccessKey 注册只有在证明持有该 Host 现有证书所认证的密钥时才能接管它，因此得知一个
`hostId` 绝不会让某个 key 把别人的 Host 移入自己的账户。Host 在链路建立后立即用
`host.capabilities` 声明自己支持的能力，新帧只发给声明了对应能力的 Host（因为旧 Host 会
静默忽略未知帧类型），客户端必须被告知哪些 Host 无法确认，否则会一直等待；回退方式是每
Host 配对票据（§3.7、协议 §11.4）。能力声明是 Host 自己的声明：没有确认器的 Host 什么都
不声明，而不是承诺一个没人能给出的答案。

桌面 Host（工作包 E2）：桌面同样遵守以上条款，并补上了无头 Host 留给宿主应用的部分。账户
AccessKey 只在主进程内从已保存的 `minih-router` provider 行经 host-core 读出，只用于那一次
注册请求，随后丢弃（门 30）：它不进 renderer 载荷、IPC 事件、状态投影、日志、审计记录或
凭据文件——凭据文件里只有 Host 证书与私钥，与自托管流程相同。用户自己的远程控制开关关闭
时既不注册也不监听；账户模式下发不可用时，自托管注册码流程原样保留。只读地判断账户模式
是否可用并不等于注册：状态里带着这个答案——下发端点加已配置的密钥——页面据此才敢把开关
交给用户，而真正让任何东西被注册的只有用户打开那个开关（门 27 依然成立：在此之前不打开、
不拨号、不监听）。严格模式是设备本地
设置、默认关闭，与远程控制开关并列保存；由于能力声明是链路宣告的一部分，切换它会重建
Host link 并重新声明能力，因此链路重连后不会再被提供它本会拒绝的授权。桌面的确认器就是
它自己的窗口：请求以模态呈现设备名、客户端与剩余时间，焦点落在“拒绝”，Esc 即拒绝，
`expiresAt` 到点后对话框自动关闭。不表态即拒绝：窗口关闭、renderer 重载或链路停止会立即
拒绝，没有窗口可显示的请求在过期时拒绝。拒绝不产生任何帧（协议 §11.5），因此除非账户内
另一台 Host 批准，客户端会一直等到自己的截止时间；让它事先知道哪些 Host 能够应答的是
花名册（门 33）。每次签发、收编与吊销都会产生设置页列出的“新设备”类通知（ADR 缓解项），在此
吊销设备走签名帧路径，链路断开时先入队，丢失的设备因此在账户内所有主机上失效。
- **脱敏推送（R5 PR-6）**：推送可以告诉用户有一条审批或问题在等他，或某个回合已完成/失败；
  绝不能携带提示词、工具、记录、路径或会话标题的内容（ADR 0331 决策 7）。载荷由 Gateway
  仅用 id 构造——固定的事件类型、两个本地化键、以及打开对应界面所需的 id——它来源的 Host 帧
  在 schema 上是封闭的，因此 Host 即使在新版本里也无法多塞字段。除非运营者配置了服务商，
  否则推送关闭：注册路由此时应答 `enabled: false` 且不保存任何东西。服务商凭据是启动时读取的
  文件，规则与 Router AccessKey 相同（普通文件、调用方拥有、权限 0600），绝不写入日志、
  回显、审计或任何数据文件；审计只记事件类型、Host 与设备。注册按设备，受众由凭据推导
  （门 29）：§11.4 设备只有它自己的 Host，账户设备只有本账户的 Host；被吊销的设备没有注册，
  因为吊销会删掉它，服务商报告**这个**令牌已消失（`410`、`Unregistered`、
  `UNREGISTERED`）时同样删除。按 Host 与按设备的预算约束陷入循环的 Host，吵闹的 Host 不会
  变成手机上的通知风暴。这条路径有三点是被测试守住的、而不是靠约定的：帧内所有 id 限定于
  `[A-Za-z0-9._:-]`，Host 无法把文字塞进 `sessionId` 让 Gateway 投递出去；注册写入在写入
  内部复查设备，因此设备被吊销时已在途的请求无法重建它的注册；只有针对单个令牌的应答才会
  删除东西，因为 topic 配错或裸 `404` 会影响 Gateway 持有的每一个令牌。接受连接却永不应答的
  服务商由硬性超时收束，卡住的服务商无法拖住 Gateway 的其他工作。

多账户部署：§1、§3.1 与 §8 描述的是用户本地、单租户、链路中没有项目方账号服务的
Gateway，自托管部署的读法不变；账户模式还允许由运营 Router 的人运行一个服务多个账户的
Gateway，并让 Router 的账号服务进入链路——但只用于发现与注册，设备凭据仍由 Host 签发。
每个账户在路由、列表、设备记录、授权、审计查询与按账户限额上都是独立租户。后果明说而非
隐藏：选择账户模式即信任该运营方中继本账户的流量与授权请求，也接受它可以拒绝服务；但它
不因此获得审批权——授权仍由 Host 签名——且 §10 仍要求中继消息在传输中携带的 prompt 与
工具数据不进入日志、审计记录与持久化存储。

| Operation | Viewer | Controller | Approver | Owner |
|---|---:|---:|---:|---:|
| List/get/subscribe/history | yes | yes | yes | yes |
| Create/attach as viewer | yes | yes | yes | yes |
| Start or queue a turn | no | yes | optional | yes |
| Stop/interrupt/cancel a turn | no | yes | optional | yes |
| Resolve tool approval (`allow-once`, `deny`) | no | no by default | yes | yes |
| Resolve tool approval with `allow-session` | no | no | policy | yes |
| Resolve Plan/Goal approval with permission mode | no | no by default | explicit policy | yes |
| Answer an input request | no | yes | optional | yes |
| Upload attachment | no | yes | optional | yes |
| Revoke membership | no | no | no | yes |
| Archive session | no | no | no | yes |
| Provider secrets | no | no | no | no |
| Raise the remote permission ceiling | no | no | no | no |
| Open or use a session terminal | no | policy | policy | yes |
| Advertise relayed tools | no | no | no | yes |

客户端不能通过字段指定 workspaceRoot、permissionMode（Plan/Goal `approve`
上的显式选择除外，且须在 `allowedPermissionModes` 内）、toolName、provider
secret 或其他 principal / clientConnectionId；`admission: "queue"` 只能进入有界、
可取消的 Host 队列。远程主体发起的回合运行在会话模式与 Host
`remoteMaxPermissionMode`（默认 `ask`，顺序 `ask` < `accept-edits` < `auto`）中
较低者之下，只有持有 `approver` 且策略允许时才可超出。上限只作用于经 Gateway
路由的主体：经 SSH 引导配对的桌面设备持有该 Host 的 `owner` 并豁免，因为 SSH
登录已授予该机器的 shell 访问，上限无可限制；Host 策略 `applyCeilingToPairedDevices`
（默认关闭）可对配对设备重新施加上限。`allow-session` 只在
Host 策略允许远程会话授权时出现在 `allowedDecisions` 中。所有工具继续走
Host 的 workspace、permission、secret 和 approval 边界；不得暴露 `host.proxy`、
raw IPC 或任意命令执行。

原生客户端存储（PR-5）：iOS / Android 打包版只把设备 token 放在平台安全存储里，
绝不写进 webview 存储。iOS 使用 `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`
（或更严格）且关闭 iCloud 钥匙串同步，token 不会随备份或同步迁移到另一台设备；
Android 使用 Keystore 支撑的存储（密钥在 AndroidKeyStore 内），并设置
`android:allowBackup="false"`、不配置会复制该密文的数据提取规则，因此恢复到另一台
设备也得不到可用 token。应用先写安全存储、再登记 Host；启动时清理孤儿条目（安全
存储在重装后仍存在，而 webview 存储不会）。原生客户端所有请求走 header profile，
不携带任何 ambient cookie，`client: "ios"` / `"android"` 配对只在响应体中返回
token，不返回 `Set-Cookie`。

## 4. 网络、附件和多租户

公网 HTTP、SSE 和 WebSocket 必须使用 TLS，保留的 gRPC 同样适用；绑定 loopback
并经 SSH 端口转发访问的 `agent-host-cli`，在绑定地址与对端地址都是 loopback 且出示
有效设备 token 时可接受明文 `ws://`，SSH 通道提供机密性，与 ADR 0203 的 loopback
规则一致，任何非 loopback 绑定都要求 TLS；生产 Host link 必须双向认证。Origin、CORS、CSRF、cookie、WebSocket upgrade、token URL 和
SSRF 都要在边界处校验。附件使用大小、hash、MIME 和过期时间校验，不能接受
本地路径；经 Gateway 时 Gateway 只校验大小、分块中继到 Host，并在
`attachment/complete` 成功或过期后删除副本。首个部署为单租户，路由已携带
`tenantId`，跨租户隔离测试在多租户 harness 就绪后执行。账户模式（规划中，D666，见
§3）新增一种部署在 Router 旁的多账户形态：每个账户是一个租户，门 29 是它的跨账户隔离
测试；Gateway 按 IP 的限流按调用者地址而非账户计数，是各账户唯一共享的限额。

打包原生客户端（PR-5）同样是跨源调用方，其 webview origin 需要单独加入白名单：
iOS 版为 `capacitor://localhost`，Android 版为 `https://localhost`，这两个值是
此类 webview 唯一可能的取值。允许它们是安全的：header profile 仍需有效 bearer
token，cookie profile 还需要跨站 `localhost` 页面永远不会发送的 `SameSite=Strict`
cookie。`capacitor://localhost` 是白名单唯一接受的非 http(s) scheme；通配符、带端口
的写法以及其它自定义 scheme 一律拒绝。

| Resource | Initial target |
|---|---:|
| Control requests per principal | 120/minute |
| Turn starts per Session | 20/minute |
| Queued turns per Session | 8 |
| Concurrent clients per Host | 16 |
| Concurrent subscriptions per connection | 8 |
| Request/event frame | 1 MiB |
| Prompt payload | 256 KiB |
| Attachment | 50 MiB |
| In-flight attachment uploads per principal | 4 |
| Event send queue | 4 MiB or 1,000 durable events |
| Open terminals per Session | 2 |

## 5. 审计、撤销和验收

待处理审批是 Host 状态：host-core 保有待处理权限表和计时器，Agent Host 通过
`permissions.pending` 读取并脱敏，晚接入的客户端能看到已打开的请求；首个有效
决定生效。远程会话的目录包含远端 Host 的工具以及配对桌面通过中继公布的工具，即用户配置的
MCP 服务器和不需要会话工作区的插件工具；中继工具在桌面自身的插件权限与确认规则下
执行，绝不在 Host 运行、绝不针对远程工作区，Host 的权限决定先于中继请求，Host 只传
Agent 的参数不传 secret，中继连接丢失则工具失败而回合继续。会话终端是以 `agent-host-cli`
用户身份在 Host 机器上运行的 shell，工作目录为会话根，只有 SSH 配对的 owner 设备或
持有显式 `terminal` scope 的主体可以打开。provider secret 在任何方向都不经过 RACP。审批寿命是 Host 策略：本地桌面权限确认没有自动截止时间；有远程订阅者接入时，远程审批记录默认
30 分钟（D375），Host 可在上限内调整，断线不会延长它。

审计记录包含 principal、tenant、Host、clientConnectionId、Session、Turn、
operation、准入模式与 `effectivePermissionMode`、授权决定、epoch 与序号范围，
但默认不记录 provider secret、原始 prompt、tool 参数、tool 输出或附件字节。
撤销用户、Host、连接、成员或附件后，新的 mutation 必须被拒绝，被撤销主体的
排队回合被取消，已完成回合不能因撤销而重放。

安全验收必须覆盖 TLS、角色矩阵、过期 token、重复 mutation、游标回放、慢客户端、
上传边界、日志脱敏、Host/Gateway 重启、远程权限上限、浏览器 cookie/header
profile 与 URL token 拒绝（浏览器里程碑排期后适用）、中继审批请求只应答一次
（Gateway 里程碑排期后适用）、绑定 loopback 的 `agent-host-cli` 只接受出示有效设备
token 的 loopback 对端且无 TLS 的非 loopback 绑定无法启动、配对 token 单次使用且
只经 SSH 通道传递、远程会话只暴露远端 Host 的工具目录与配对桌面公布的中继工具、中继工具绝不在 Host
执行且 Host 审批先于中继请求、会话终端只对 SSH 配对 owner 或持有 `terminal` scope
的主体开放，以及多租户 harness 就绪后的跨租户隔离。自 D665 起还需覆盖验收门
22–27：Host link 监听器拒绝 `0.0.0.0`、`::` 与公网地址，只绑定显式配置的私网或
组网地址（RFC1918、`100.64.0.0/10` 或配置的 CIDR）；客户端 API 默认绑定 loopback，
未配置 TLS 的非 loopback 绑定拒绝启动；令牌不出现在 URL、query string、SSE URL
或事件载荷中，浏览器会话用 `HttpOnly; Secure; SameSite=Strict` 且带有限 `Max-Age` 的
cookie 加 CSRF token，且 cookie 请求按 Origin 规则自证来源（仅同源 `GET`/`HEAD` 且
`Sec-Fetch-Site: same-origin` 时可省略 `Origin`），原生客户端用 header profile；
`owner` 角色、受权限上限约束、无 `allow-session`，其令牌在 loopback `RACP-WS`
上被拒，ssh 令牌在 Host link 上被拒）；任意一侧吊销后新连接被拒且已有逻辑连接
5 秒内关闭；以及桌面网关链路设置关闭时不发起连接、不开监听的回归证明。D665
补充：gate 17 收窄为只约束 ssh 来源的配对码（交叉通道兑换在任何来源上都失败），
新增 gate 28 约束网关来源的配对码（`remote-pair` / 桌面设置页签发的码只在 Host
link 上兑换，ssh 来源的码绝不经网关兑换），以及网关来源主体不受 Host 策略放宽的
限制（`allowRemoteSessionGrants` 下无 `allow-session`、无 `approverOverride`、
上限与 `applyCeilingToPairedDevices` 无关），须用测试锁住。

自 D666 起还需覆盖验收门 29–33（均为规划中）：账户模式端到端隔离——一个账户的 key
不能列出、注册、路由到或取得另一账户 Host 的授权，即使所有用户的终端同处一个组网；
Gateway 绝不持久化原始 Router AccessKey、绝不把客户端的 key 转发给 Host，客户端在设备
交换后不再保留，且 key 不出现在 Host 设备存储、日志、审计、URL 或错误载荷中；Gateway
仅在 TCP 对端位于其可信代理集合内时才从配置头读取客户端地址，并经 Router
`CLIENT_IP_HEADER` 指定的头、从 Router `TRUSTED_PROXIES` 内的对端转发，使 key 的
`allowed_peer_cidrs` 拒绝策略外调用方；兄弟 Host 只在签名者属于同一账户、由网关 CA
注册且设备未被撤销时接受授权，严格模式不接受任何兄弟授权，签发的设备仍为
`pairedDevice: false`、受远程权限上限约束且无 `allow-session`（沿用门 25）；两个新帧
只发给声明支持的 Host，且客户端被告知哪些 Host 无法确认。

自 R5 PR-6 起还需覆盖门 34：推送只携带固定事件类型、两个本地化键与 id（id 限定字符集，
因此塞不进文字），不含提示词、工具、记录或会话标题内容；无运营者凭据时推送关闭；只推给能
打开该 Host 的设备；被吊销设备与服务商报告已失效的令牌都没有注册，写入注册时在写入内部
复查设备状态；只有针对单个令牌的服务商应答才会删除注册；服务商调用有硬性超时；任何服务商
凭据都不出现在日志、审计记录或错误信息中。

## 6. 修订记录

D374（2026-09-10）新增浏览器 cookie/header 认证 profile、两种可接受的身份源、
远程权限上限、本地决策词汇、远程审批寿命策略、Host link 与 Gateway 附件中继
规则、单租户优先条款以及验收门 13–15。

D375（2026-09-10）新增 SSH 引导配对、经 SSH 端口转发的 `agent-host-cli` loopback 规则、
SSH 配对 owner 设备的上限豁免、远程工具目录与 provider 配置规则、验收门 16–18，
并把 Gateway 与 cookie profile 条款标记为属于不排期的里程碑。

D375 同日记录的设计决定把身份源定为 PI 账号服务，`agent-host-cli` 从 GitHub Releases 下载，
补充中继与终端规则及验收门 19–20、远程审批 30 分钟默认寿命和
`applyCeilingToPairedDevices` 策略。

D385（2026-09-10）撤回第一方身份源：远程控制从结构上就是用户本地的，所有凭据由用户
自己的 Host 签发，Gateway 只能是用户自托管的中继。

D665（2026-10-17，ADR 0331）排期 Gateway 与浏览器里程碑（R4–R6）：§3 的 Gateway 与
cookie profile 条款去掉不排期状态并补充注册交换；§3 补记自托管场景下 route context
的完整性由已认证的 Host link 保证、最终鉴权方是 Host 自己的凭据存储；新增经网关
配对的设备规则（可追加的 `origin` 字段、网关配对绝不授予 `owner` 与
`pairedDevice`、交叉通道令牌拒绝）；多租户隔离条款自 R4 起生效；新增验收门
22–27，覆盖绑定地址规则、令牌与 cookie profile、网关配对主体限制、吊销 5 秒
传播，以及桌面关闭态回归。D665 审查补充：配对令牌来源（§3.7；gate 17 收窄为
只约束 ssh 来源的配对码，新增 gate 28），并把网关来源主体不受 Host 策略放宽的
限制（`allowRemoteSessionGrants` 下无 `allow-session`、无 `approverOverride`、
上限与 `applyCeilingToPairedDevices` 无关）锁定为测试规则。

D666（2026-10-18，ADR `remote-control-router-account-binding`）新增规划的账户模式条款
与验收门 29–33：AccessKey 作为账户身份（桌面按 D661 规则解析），Gateway 经 loopback
并在仅当对端属于可信代理时转发调用者地址来校验 key；密钥生命周期规则（被禁用或删除的
key 不能再发起新登录或注册，但本身不撤销任何东西）；以 AccessKey 加 CSR 和 bootstrap
的 `remoteGateway` 对象完成注册；账户作用域的登录、主机列表，以及经 `device.request` /
`device.grant` 两个新帧完成的设备申请／确认／授权；多账户部署（并在多租户条款中加入
指引）；账户目录为兄弟 Host 背书所带来的已接受风险及必须同时具备的缓解措施；以及严格
模式。§3 的既有条款、D665 的网关来源限制与自托管的注册配对路径均保持不变。

D675（2026-10-21，ADR `remote-control-router-account-binding` 修订 3）新增桌面类设备：
§3.7 记录「凭**目标 Host 自己校验**的证明接入的设备持有 `owner` 并豁免远程权限上限」，
这是网关来源主体唯一可以持有 `owner` 的途径，也是 ADR 0331 网关来源限制的唯一例外
（已记录在该 ADR）；Gateway 的预检只是快速拒绝、不是授权依据，因为「Gateway 从不做批准
决定」仍然成立，被攻破的 Gateway 不能凭空造出 `owner` 设备。证明**携带申请方证书**，由
目标 Host 验链：目标 Host 没有别的途径拿到它（只有 Gateway 在注册时见过），这与 TLS
客户端出示证书同形，可信性来自证书链能验到本机已固定的 CA、以及证书里的账号与 `hostId`
与请求一致，而不是来自 Gateway 诚实；Gateway 持有该 CA 私钥，因此被攻破的 Gateway 能为
不存在的电脑签发证书，这正是 D666 已记录的「CA 被攻破」风险，不是新增风险。设备记录以
增量方式保存 `deviceClass` 与 `applicantHostId`（旧记录没有这两个字段，行为不变），
`owner` 依附于申请方证书：吊销该 Host 时，Gateway 通过 `host.revoked` 通知账号内其他
声明了 `device.desktop-auto` 的 Host（离线者重连后补发），收到方吊销该电脑接入的桌面类
设备；该帧无需签名，因为它只收权、伪造最多导致错误吊销。**一个请求只产生一个设备**：
账号内每台电脑都会收到同一请求与同一证明，可能同时自动批准并各自铸造令牌，而 Gateway
只保留第一份 grant、客户端只拿到那一个令牌，因此也批准过的那台会吊销自己铸造的设备并
采纳存活的那份——否则账号里会留下没人能用的设备，而最先同意的那台恰好令牌失效。nonce
仍按「每个请求一次」判定，同一证明用于该电脑从未批准过的另一个请求仍算重放。§3.8 记录
同账号电脑的自动接入、每台电脑的开关、`device.desktop-auto` 能力闸门、账号模式下远程
控制开关的默认值（三态：从未选择默认开、开过保持、关过不再被默认打开，设置里以可选
`decided` 区分），
并明确写出已接受的风险：**泄露的 AccessKey 可以注册一台假电脑（决策 5 允许凭 key 注册
Host），再用它的证书在所有开着自动接入的电脑上拿到 `owner`** —— 这是「同账号电脑自动
接入」的直接代价；对应的缓解措施包括由目标 Host 校验证明、新电脑注册时通知账号内其他每台
电脑并写审计、可在 Gateway 上 `hosts revoke` 那台 Host、可在任一台电脑上撤销设备、关闭
每机开关或 strict mode 即退回人工确认、以及拒绝过期或重放的 nonce。gate 27 重写为
「从未选择」与「明确关闭」两种情况，新增 gate 35 覆盖证明校验（含证书链与账号／hostId
绑定）、时效与各类拒绝。手机、浏览器、自托管流程，以及 gate 25、26、28 均不变。
