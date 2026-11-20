# ADR plugin-host-capabilities：六项宿主能力，各配一个权限

> [英文源 ADR](/adr/plugin-host-capabilities) 是状态与决策内容的最终依据。

- 状态：已接受实施（2026-11-17）。B-0 注册权限；B1 实现凭据，B2 实现入站
  webhook，B4 实现 `notify.center`，B6 实现插件定时；其他能力组按各自文档执行。
- 日期：2026-11-17
- 相关：ADR 0005（用户可安装插件）· ADR 0008 D009（插件进程不是操作系统沙箱）·
  ADR 0074（插件原生通知权限）· ADR 0088（声明的文件范围）·
  ADR 0115（宿主持有的剪贴板历史）· ADR 0208（桌面控制的原生确认）·
  ADR 0211（Plan 安全的插件动作）· ADR 0257（插件实时能力）·
  [ADR bot-sessions-and-steward](/adr/bot-sessions-and-steward)（任务面，§4.19a）·
  ADR 0330（交互请求的持久提醒）
- 规格：[07-plugins/02](/zh-CN/spec/07-plugins/02-plugin-manifest-schema) ·
  [07-plugins/03](/zh-CN/spec/07-plugins/03-plugin-api) ·
  [07-plugins/04](/zh-CN/spec/07-plugins/04-plugin-security) ·
  [07-plugins/13](/zh-CN/spec/07-plugins/13-plugin-permissions-matrix) ·
  [03-runtime/04](/zh-CN/spec/03-runtime/04-data-storage)

## 背景

插件面对于「读取、转换、展示」类插件是完整的：文件、会话、Provider、模型、主题、
面板、总线。对另一类插件则是空的——那类插件的职责是**替用户持有**某样东西：
一个邮件服务器的 API 令牌、一个数据库套接字、一个别人往里投递的信箱地址、一个
时钟、一个插件自己发起的任务、用户收件箱里的一行。

今天这些全部建在**插件进程内部**，因为 `manifest.main` 带着完整的 Node 内置模块
运行（ADR 0008 D009）。插件可以自己开 TCP 套接字、自己监听一个端口、把令牌存在
自己的设置文件里。这不是宿主能审查、审计或收回的边界：用户看不到持有什么，安装页
不会出现任何权限，禁用插件也不一定关掉它开出去的东西。

由此得出的设计规则，与宿主已经自持的几个面（`net.websocket`、
`keyboard.globalShortcut`、ADR 0115 的剪贴板历史）一致：**资源由宿主持有，插件
通过权限和句柄使用。** 密钥、监听套接字、公开路径、定时器、任务、信箱条目，都是
宿主状态。代理 API 不直接交出保存的凭据、套接字或时钟；这不是操作系统隔离（§3）。

六组能力覆盖了第一方插件作者提出的需求。没有一项能用现有权限表达，其中两项若作为
无名的插件行为则相当危险：插件自开的端口不会出现在任何权限列表里，插件自持的密钥
是用户无法在设置里轮换的令牌。

## 决策

### 1. 八个权限，六组能力

| 组 | 权限 | manifest 字段 | 宿主持有的资源 |
|---|---|---|---|
| 凭据 | `credentials.use` | `contributes.credentials` | 密钥值 |
| 原始 TCP | `net.tcp` | `net.tcp` | 套接字 |
| 入站 webhook | `inbound.webhook` | `contributes.webhooks` | 监听、路径、令牌 |
| 定时器 | `scheduler` | `contributes.schedules` | 时钟 |
| 宿主写入列表 | `mail.draft`、`notify.center` | — | 列表及其行 |
| 任务 | `tasks.read`、`tasks.manage` | `tasks` | 任务及其会话 |

每个名字都加进 `PLUGIN_PERMISSIONS`，每个名字都在 `PLUGIN_PERMISSION_RISK`
里有风险等级。等级表是一个
`satisfies Record<PluginPermission, PluginPermissionRisk>` 约束，因此新增权限
却忘了等级是**编译错误**，而不是一个看上去无害的能力混进安装页。**未识别**的
权限名读作 `high`（`pluginPermissionRisk`）：宿主无法归类的能力，绝不能显得比
能归类的更安全。

风险分级：

- **high** —— `credentials.use`、`net.tcp`、`inbound.webhook`、`tasks.manage`。
  宿主代插件持有密钥、套接字、公开路径或任务，所以授予权限本身就是全部边界。
- **medium** —— `scheduler`、`mail.draft`、`notify.center`、`tasks.read`。
  宿主持有的是一条用户看得见、也能停掉的有界队列；写草稿从不发送，定时器不花
  额度，读取路径没有写入能力。

### 2. 权限是开关，manifest 是范围

与 `net.domains`、`manifest.fs` 同一条规则：权限名回答「能不能做」，manifest
字段回答「能做到多远」，两者在安装页并排展示，而且**字段缺失就什么都不授予**。
没人能用的字段会让 manifest 校验失败，而不是被悄悄忽略。

### 3. 宿主强制执行的边界

以下是护栏。每一条都由宿主执行、不由插件自律，并且都在安装审查里写明。

**凭据（`credentials.use`）。**

- 槽位由用户在设置里填写，插件不能通过宿主 API 写入。**没有凭据读取 API**；
  宿主生成的响应、错误和审计记录不披露保存的值。
- 值存在既有的密钥库，不进 SQLite（规格 03-runtime/04 §10）；静态存储方式不变。
- 只在插件用 `credentialRef` 点名的宿主持有出网路径上注入，且目标必须同时落在
  槽位 `scope` 与插件自己的声明内：HTTP 与 WebSocket 看 `manifest.net.domains`，
  IMAP 登录看 `manifest.net.tcp` 端点。没有 `scope` 的槽位无处注入。
- 这是可审计的 API 边界，不是操作系统沙箱，不能防范具有用户文件权限和原生 Node
  能力的恶意插件；请只安装信任的插件。远端服务可能在响应体、WebSocket 帧或
  IMAP 登录后的 TCP 流中回显凭据，宿主不过滤这些应用数据。
- 设置面板渲染不出来的槽位（没有 kind、没有字段、字段 key 重复）会让 manifest
  校验失败：无法使用的权限是作者的疏忽。

**原始 TCP（`net.tcp`）。**

- 端点是字面的 `{ host, port, tls }`。没有通配符、没有端口区间、没有裸 `*`；
  重复的 `host:port` 被拒。`tls` 必填，因为宿主既不升级也不降级连接。
- **每个插件同时最多四条连接。** 四条是并发上限，不是清单条数上限：端点白名单
  没有条数限制，有十台服务器的作者不必只挑四台。
- 插件拿到的是连接句柄与事件，永远拿不到套接字、流，也没有读取 TLS 会话的途径。
- TCP 连接上的 `credentialRef` 让宿主自己完成 IMAP 登录，且只走隐式 TLS：宿主
  读取 greeting、协商 PLAIN 或 LOGIN，仅交回 `authenticated: true`。登录后的
  字节流保持透明，服务器可能回显凭据。`tls: false` 端点被拒，也不提供
  STARTTLS、XOAUTH2 或 SMTP 相关能力。
- 插件卸载、被禁用或崩溃时，所有连接关闭。
- 用户的出网 HTTP 代理不适用于这些连接，安装审查会写明。

**入站 webhook（`inbound.webhook`）。**

- 监听、路径与令牌都由宿主持有。没有令牌的 webhook 根本不会注册；令牌是宿主生成
  的密钥，用常量时间比较，轮换是设置里的操作。
- 监听边界由 [ADR plugin-webhook-listener-boundary](/zh-CN/adr/plugin-webhook-listener-boundary)
  修订：局域网模式绑定所有接口并按来源地址过滤，不能保证排除所有公网来源。
- 传输是明文 HTTP，安装与设置里都会说明，措辞与非回环 HTTP MCP 端点一致
  （ADR 0142）：路径上的人可以读到内容，令牌是过滤，不是机密性。
- 正文超过 256 KiB 返回 `413`；每个 webhook 每分钟超过 120 次有效请求返回
  `429`。两个上限都能在 manifest 里调低，不能调高。
- 插件只收到宿主已经接受的请求，以事件形式；插件不能作答，宿主回 `202`。

**定时器（`scheduler`）。**

- 每个声明一个定时器，要么固定间隔、要么五段 cron，二者不能并存。下限一分钟；
  更快的声明直接校验失败，而不是被四舍五入。
- 触发粒度由宿主决定。定时器不是模型回合：一次触发调用插件处理函数，不消耗令牌。
- `runWhen: "idle"` 让宿主等用户空闲，`always` 是默认值。插件被禁用或卸载时不
  触发；错过的时间点合并为下一次机会的一次触发，而不是重放积压。
- 连续失败会停表并在插件页面显示，与受监管后台服务同一条规则。

**宿主写入列表（`mail.draft`、`notify.center`）。**

- `mail.draft` 把草稿写入宿主的草稿列表。**没有发送路径**，本决策不提供，也不藏在
  第二个权限后面。
- `notify.center` 往持久通知收件箱写一行，标明插件。家族有两个 kind：
  **`plugin.alert`** 是用户当下就该看到的一件事，**`plugin.digest`** 是插件汇总
  后代表一整批的一行；超过每小时限额的事件也由宿主折叠。`notify` 只显示横幅或
  系统通知，不落库；这也不是等待回答的 `prompt.*` 行。
- 两者与其它宿主队列一样有界：收件箱保留 200 条上限、由同一个用户操作清空，
  卸载插件会删除它的行。

**任务（`tasks.read`、`tasks.manage`）。**

- `tasks.read` 只读列出脱敏清单与账本事实，不含提示词、对话内容或凭据。
  `tasks.manage` 只创建并推进本插件的任务；其他任务返回 `NOT_FOUND`。
- 生效模式取请求值、manifest 上限、员工模式和 `accept-edits` 的最小值；
  省略请求值或上限时默认为 `accept-edits`。按动作审批落地前显式请求 `auto`
  会被拒绝。manifest 可声明 `auto`，安装或更新时说明当前上限，无单独确认框。
- 宿主对任务会话及其后代实施执行策略：内置低风险只读工具和 `accept-edits`
  下工作区内 Write/Edit 可自动放行，其余每次调用均需逐次批准。插件自报风险、
  子代理权限以及会话或持久授权不能放宽策略。工作区编辑包括覆盖及清空内容；
  命令或外部工具删除以及外部操作均需逐次批准。

### 4. 存储：架构 v43

能力相关的行存放在宿主自有的 SQLite 里：任务面与通知收件箱上的 `plugin_id`
标签，以及三张需要跨重启保存状态的能力表。`notifications` 需要重建，因为
`session_id` 必须变成可为空（插件条目没有会话），而 SQLite 改不了 `NOT NULL`
也放宽不了 `CHECK`。plugin 家族是 `plugin.alert` / `plugin.digest`，字段为
`plugin_id`、`title`、`body`、`link_json` 与 `dedupe_key`，
并用 `CHECK ((kind LIKE 'plugin.%') = (plugin_id IS NOT NULL))` 与收件箱其余
部分绑定——这是家族规则，而不是另一份要同步维护的 kind 清单。**重建时保持外键
约束开启**，因此会丢弃会话已经不存在的收件箱行；用户已授权丢弃它们，因为指向
已删除会话的条目没有任何东西可依附。

同一步还加上 `tasks.plugin_id` 与三张表：`plugin_webhook_events`（每条已接受
投递一行，记录对端地址与 `body_ref`——正文**不**存进 SQLite）、
`plugin_schedules`（上次尝试、连续失败次数与 `paused` 刹车，从不保存声明本身，
声明留在 manifest 里）与 `plugin_tcp_usage`（按插件、主机、端口与日期累计字节，
不是事件日志）。DDL 与幂等规则写在规格 `03-runtime/04-data-storage.md` 的
§4.14、§4.19d、§4.19e 与 §7。

**`tasks.origin` 保持 `('steward', 'direct')` 两个值。** 本决策的早期草案想给
CHECK 加 `'plugin'`，这一条**作废**。`origin` 记录的是哪条工作台路径派发了任务
——`steward` 是 1.7.0 之前的确认卡片，`direct` 是人自己用的界面——插件发起的
任务同样走这条 direct 路径。插件的参与是另一种来源信息，因此用可为空的
`plugin_id` 记录：不需要重建表、不改写任何历史行，也不会与既有两个取值混淆。

### 5. B-0 切片实现了什么

B-0 只做注册：

- `PLUGIN_PERMISSIONS` 里的八个名字，以及 `PLUGIN_PERMISSION_RISK` 中每个权限的
  风险等级；
- manifest 字段 `contributes.credentials` / `webhooks` / `schedules`、`net.tcp`
  与 `tasks`，含安装时的形状校验、各自的边界，以及「字段必须配权限」的规则；
- `packages/plugin-sdk` 中上述形状的类型与校验器。

最初的 B-0 切片不执行这些能力。后续 B1 实现凭据存储、状态查询以及宿主持有的
fetch 和 WebSocket 注入，并实现带凭据的 `net.tcp` 连接由宿主完成的 IMAP 登录；
B2 实现入站 webhook；B4 实现 `pi.notify.center`；B6 实现插件定时。`mail.draft`
与 `tasks.*` 按各自文档执行。

## 后果

- 插件可以申请这六项能力，用户能看见、限定并收回每一项。此前同样的行为是看不见的
  插件代码。
- 宿主多出六类它以前不持有的长生命周期资源：密钥、监听套接字、端点清单、定时器、
  收件箱行、任务。每一类都需要所有者和清理路径（卸载、禁用、崩溃、卸载安装、
  重启），这是实现工作量中更大的那一半。
- 权限仍然是契约与告知，不是围栏：带完整 Node 的插件主进程无论 `net.tcp` 怎么写
  都能自己开套接字（ADR 0008 D009）。改变的是：可审查的通道存在了，不可审查的
  通道不再是唯一选择。
- 风险表变成每个权限的必需一行。新增一项能力要在两张表里各加一行，漏掉第二处是
  编译错误。
- 收件箱在会话之外多了第二个所有者（插件）。`notifications` 的每个消费者——列表、
  未读计数、标记已读、清空、裁剪——都必须处理没有会话、没有回合的行。
- B4 已将 `Notification.session_id` 和 `session_title` 改为可选并读取插件字段，
  无会话的插件行不会使整个列表读取失败。
- `idx_notifications_plugin_dedupe` 在提供去重键时保证插件内部去重。

## 备选方案

- **让插件自持套接字、端口与令牌。** 否决：那正是现状，也正是用户无法审查的部分。
  禁用插件不会关掉宿主从不知道的端口。
- **提供密钥读取 API（`pi.credentials.get`）。** 否决：显式读取 API 会让意外
  记录或转发更容易。宿主代用不会主动返回保存的值，但不能隔离恶意插件代码。
- **用一个 `net.raw` 权限覆盖 TCP、UDP 与 TLS。** 否决：字面端点的 TCP 可审查；
  UDP 是另一种失败模式（无连接、源可伪造），需要自己的边界，因此不合并。
- **把 `net.tcp` 白名单限制为四条。** 否决：真正需要限制的是**同时四条连接**，
  它约束宿主的文件描述符与缓冲。限制条数只会限制作者，把有十台服务器的插件推回
  自己开套接字的老路。
- **只在非回环地址要求 webhook 令牌。** 否决：回环地址本机每个进程都能访问，而
  插件需要一条能依赖的规则。令牌在任何地址上都必需。
- **`tasks.origin = 'plugin'`。** 作废——见 §4。它改写了既有列的含义、逼出一次
  `sessions` 式的重建和历史行决策，并且与 `plugin_id` 已经说清的事情重复。
- **把 `auto` 作为 `maxPermission` 的默认值。** 否决：那等于让作者替用户决定
  批准步骤消失。
- **用 `notify` 承载收件箱行。** 否决：`notify` 是无存储、无所有者的瞬时横幅；
  `notify.center` 需要持久行、200 条上限、未读计数和卸载路径。把两者混为一谈，
  等于让每个弹过一次提示的插件都留下永久收件箱条目。