# 便携式配置同步

> **翻译说明：** 本页是与 [英文源规格](/spec/03-runtime/22-config-sync) 一一对应的机器辅助翻译。代码、协议字段和标识符保持原文；如翻译与英文源事实有歧义，以英文版本为准。

状态：已实现基于 Minih Router 账户的配置备份与同步。

便携式配置同步是由 Host 拥有的加密工作流，它把备份存储在登录账户名下的
Minih Router 后端。它不同步会话历史、项目源文件、附件、运行时状态或模型
权重。Renderer 只接收脱敏状态、预览计数、冲突和激活摘要。

## 1. 所有权与边界

进程路径保持不变：

```text
Renderer → Preload IPC → Electron Main → host-core → Minih Router 后端
```

Host-core 拥有 vault key、router 传输、修订状态、merge base、待审批项、本地
加密暂存和导入应用。Electron Main 只注册 IPC 处理器并转发
`configSync.changed`。Agent Runtime 没有任何同步实现。

远端目的地是 Minih Router 网关按账户划分的 client-backup 对象存储：为聊天
流量签名的同一个 AccessKey 在控制面上认证备份读写，且每个对象都在服务端按
该 key 命名空间隔离。Host-core 从自己的 providers store 解析账户行；token
永远不会到达 renderer 或 Electron Main。

导出路径是 `crates/host-core/src/config_sync/domains.rs` 中按域明确列出的
allowlist。它不会序列化数据库、secrets 目录或任意文件系统树。本地路径、窗口
状态、就绪标记、OAuth 会话、插件二进制文件和设备审批属于本地覆盖或排除数据。
同一模块为每个受支持的域暴露适配器注册表，声明 schema 版本、便携/秘密字段、
本地覆盖、身份与引用、合并粒度、激活方式以及恢复策略。

## 2. 便携域

当前适配器集合覆盖应用偏好、用户所有的 providers、MCP 定义、用户 skills、
全局 subagents、由应用管理的全局/项目指令、插件安装意图、定时自动化任务以及
可选的项目记忆。凭据需要明确选择（opt-in）。只有选中凭据类别时才会包含
provider API key 和 MCP 环境变量/headers；OAuth access/refresh token 与
cookies 永远不会导出。providers 类别包含用户所有的 provider 的名称、vendor、
endpoint、非秘密的账户显示标签、headers、显式 provider reasoning/limit 覆盖
以及有序的模型绑定。模型别名、wire protocol、limit 来源、thinking
档位/默认值、附件能力、subagent 可用性和托管搜索 opt-in 在采集与恢复后保留。
应用偏好携带默认 provider/model 和图像/语音模型绑定；provider 依赖在可用前
保持暂存。实时余额、配额/用量响应、OAuth 会话和就绪标记不会备份。恢复 API
token 需要凭据 opt-in 与本地审批同时满足；缺少任一项时，新导入的带秘密
provider 保持禁用直至配置完成。指令适配器只读取固定的全局
`~/.pi/agent/AGENTS.md` 和每个已注册项目根目录的 `AGENTS.md`；不会扫描嵌套
仓库或任意文件。导入的指令文件只有在明确选择其作用域、完成必要映射并获得
审批后才会写入。指令文件没有单独的字节上限；其内容只受 Host 在上传修订与
校验远端修订时统一检查的便携实体负载上限约束。目录形态的 skills 会将有界的
同级资源作为已认证对象携带。Host 会在写入已审批的资源前校验 package 路径、
symlink、冲突、文件数量和总大小：每个 package 最多 256 个资源、单个资源
2 MiB、整个 package 16 MiB；skill 文档本身仍保持 128 KiB 上限，因为它可能
进入 prompt。脚本按字节存储，导入时绝不执行。

已连接的 Minih Router 账户行与项目列表一样是设备本地的。它是同步传输自身的
身份 —— 每台设备连接自己的账户 —— 因此永远不会被同步或备份采集、应用或写入
tombstone。第二台设备通过在「设置 → 账户」连接同一账户并输入同一 vault 密码
加入同一备份。

项目和项目组列表保留在本机。同步和备份均不采集或应用其名称、置顶、根目录
列表和排序，也不提供 projects 类别。同步和恢复会忽略既有 vault 修订中的旧
`projects` 实体；这不会删除本机项目或远端修订历史。项目级 MCP、skills、
指令、记忆和自动化绑定仍通过本地文件夹映射受支持。需要本地 workspace 的
功能由接收设备自行注册项目和项目组。

项目和 workspace 绑定使用不透明的逻辑标识符表示。Host-core 为每个已注册的
独立项目分配持久逻辑身份；项目组根目录的身份由组身份和有序根位置派生。设备
映射把接收的逻辑 ID 覆盖到本地文件夹，因此不同绝对路径不会产生重复实体。
传入的项目作用域可执行内容在本地文件夹映射和审批存在前保持暂存。加密的
便携实体负载中不会写入本地路径。没有受支持适配器的插件数据会报告为不支持，
而不会被声称为已同步。已审批的插件安装意图保存在 Host 所有的本地覆盖中；
它不会拉取插件字节或权限授予。

## 3. Vault 与 router 协议

每个 vault 都有随机 data key。备份密码使用有界的 Argon2id 参数处理，data
key 使用 AES-256-GCM 包裹。每个 head、revision manifest 和 resource object
都使用按 purpose/vault 派生的对象密钥、域隔离的关联数据和新鲜 nonce 单独
认证。resource object ID 是带密钥的内容标识符，因此不需要明文全局 hash。
vault envelope 版本独立于 SQLite schema；密码派生发生变化时会提升该版本。

远端布局使用一个 wrapped-key header、两个按模式区分的加密 head 和不可变的
已认证 revision/resource 对象，存储在账户的服务端命名空间下：

```text
header
vault/<opaque-vault-id>/head
vault/<opaque-vault-id>/backup-head
vault/<opaque-vault-id>/revisions/<revision-id>
vault/<opaque-vault-id>/objects/<object-id>
```

存储的配置格式是 `minih-agent-desktop-config-sync-router`，版本 1。每个 head
最多索引 30 个修订，最新的在前。同步与备份拥有各自独立的 head、历史和认证
purpose；两种模式都不跟随无界的父图。不可变对象无限期保留。这约束的是历史
查询，**不是存储用量**；客户端不做物理垃圾回收，而是由后端按账户强制配额。

请求使用账户 AccessKey 作为 Bearer token 在网关控制面上认证。对象读取是
`GET /api/client-backup/objects/…`，写入是条件 `PUT`，两者都以原始字节交互
并使用强引号 ETag。初始化使用 `If-None-Match: *`；head 更新要求当前的强
ETag 和 `If-Match`。前置条件被拒绝时会重启协调，绝不盲目覆盖。后端从每个
对象的写入版本派生 ETag，因此每次成功写入都产生新的强 ETag，且条件检查与
写入在同一个数据库事务中原子完成。

能力发现是 `POST /api/client-backup/probe`：后端针对一个保留的探测名自行
执行创建/重复创建/过期 ETag 序列，删除它，并返回 `{ conditionalWrites: true }`。
Configure 与连接测试都要求探测成功。不存在对无条件写入的客户端可见回退、
没有 append-only 模式，也没有第三方对象存储。

只有 GET 404 表示不存在。401/403 是授权失败（轮换或断开的账户会在这里
出现）；413 是账户存储配额。条件 PUT 的 409/412 表示发布竞争失败。错误保持
稳定的 `CONFIG_SYNC_*` 代码，不暴露账户 token、包含它的 URL 或服务端响应体。

网关地址来自已连接账户行的 base URL；当 EasyTier LAN 端点可达时优先使用
它，公网地址作为回退 —— 与聊天路径相同的解析方式。重定向和公共明文 HTTP
被拒绝；LAN HTTP 仅在 Host 的宽松网络策略允许时可用。连接超时 10 秒，请求
超时 60 秒，流式对象上限 64 MiB，后端为每个账户的备份存储设置 1 GiB 上限。
对象名使用有界的安全 ASCII 段；目录穿越和弱 ETag 被拒绝。

目的地身份是账户 token 的 SHA-256 指纹。轮换 key 或切换账户会改变目的地，
需要重新设置备份，并创建全新的本地状态身份；进行中的导入必须先解决。重新
保存会保留已有的暂停状态。加入既有 vault 时，若同一备份密码能解锁则采用
远端 header；已持有另一个 vault 的不同账户会被拒绝，直到断开连接。

## 4. 合并与激活

加密 baseline 同时保存已确认的共享修订及其观察到的本地投影。凭据 opt-out
和设备本地覆盖不得制造本地编辑，也不得阻塞远端删除。当另一个实体被审批时，
未确认的本地编辑不会被吸收。

在 `sync` 模式下，采集、远端读取、三方合并、不可变上传、CAS 发布与本地应用
按 vault 串行执行。标量设置按声明的实体单元合并；provider、MCP、skill 和
automation 记录不会作为任意数组合并。Tombstone 携带删除状态和刷新的
digest，并保留在后续 baseline 中。未选择的类别不是删除。

在 `backup` 模式下，一次运行把本地快照发布到 `backup-head`。它会读取 head
元数据用于 CAS/历史，但不会下载或应用远端配置。多台设备在该历史中保持相互
独立的快照，而不是合并后的配置。未变化的快照不会创建新修订。

相同编辑会收敛，不相交编辑可以继续。同一单元编辑以及 delete-versus-edit
会将两个候选都保留为冲突。导入的 MCP、skills、subagents、plugins 和
automations 需要本地激活审批；审批绑定实体 digest。因此命令、endpoint、
脚本、指令或凭据目的地改变后，旧审批会失效。已应用的冲突选择会记录两个候选
digest。下一次同步只把那一对完全未变化的候选折叠为选定的规范实体，并以 CAS
发布。变化的候选仍需要新的明确选择。缺失的 provider 引用会作为依赖审批
保留，而不会被写成不可用的默认值；无关实体仍可继续应用。Host 绝不会仅因为
UI flag 被设置就激活暂存的可执行内容。新导入的 automation 定义同样会被
禁用，直到本设备明确取得执行所有权；已有本地任务继续使用其设备本地启用
状态。

导入路径会在应用每个实体前重新检查捕获到的本地 generation。捕获之后发生的
修改会保留，并在下一轮重新协调。持久化的加密 pending bundle 会记录捕获的
本地 manifest 和 `applying` 标记；重启恢复会完成已审批步骤，或在认为配置已
收敛前保留 bundle 供重试。现有的本地 MCP 直接创建行为不变。

接收方的应用偏好会经过便携字段 allowlist 过滤。凭据 opt-out 在导入时同样
适用，包括 provider key 和 MCP 环境/header 字段。已审批的 skill 资源替换会
校验期望内容、路径和 symlink，保留无关文件，并只移除新 package 省略的先前
同步文件。每个文件原子替换；import journal 是恢复记账，不是横跨整个文件
系统的事务。

## 5. 设置工作流

「设置 → 云同步」目的地在开发版和打包版中均可用，其导轨行与页面标题带有
实验性徽章。开放该入口不改变本文描述的 Host 拥有的同步行为。

「设置 → 云同步」显示已连接的 Minih Router 账户（endpoint 与连接测试）、
vault 密码、设备标签、`sync`（默认）或 `backup` 模式、自动运行选择、类别、
手动运行、解锁、暂停、文件夹映射、审批/拒绝、历史/恢复、密码重包裹和断开
连接。没有已连接账户时，页面说明需要账户并链接到「设置 → 账户」；在存在
账户前设置控件保持禁用。Renderer 以独立状态显示 `notConfigured`、
`locked`、`upToDate`、`localChangesPending`、`syncing`、`offline`、
`unsupportedServer`、`conflict`、`awaitingActivation`、`paused` 和
`error`。断开连接保留本地数据，不删除远端数据。

页面把状态、最近成功、手动运行、暂停和内联解锁置于维护操作之前。连接测试
探测账户的备份存储；设置只需要 vault 密码和设备标签。已保存配置重新打开时
收起；未完成草稿重新打开供编辑。自动运行使用共享开关。类别选择在首次保存
前就可在连接设置内使用，凭据和记忆仍是 opt-in。历史、预览、映射和安全/
连接维护按需展开；错误、手动进度和待审批保持可见。折叠内容不会重置表单值，
也不会发起 Host 请求。

重新打开页面时先绘制缓存的脱敏状态/历史和一个已校验的非敏感草稿，然后在
后台刷新。草稿键是 `pi.desktop.configSyncRouterDraft.v1`；旧 S3 草稿键在
下一次保存时移除。只有模式、设备标签、自动运行选择和类别会被持久化。密码
保持在瞬态输入内存中，并在成功保存后清除。切换账户或模式会使历史和未完成的
历史读取失效。未保存的模式选择不改变恢复行为。

手动运行通过 `configSync.progress` 上报 `capture`、`download`、`merge`、
`upload` 和 `apply`；没有 cleanup 阶段。传输期间 `done`/`total` 按对象
计数，其他阶段按实体计数。total 为 0 表示未知，`bytesTotal` 为 0 表示字节
大小未知（下载时这是正常情况）。上报被节流，但阶段变化永远不会被丢弃；Host
状态事件和调用返回是终止信号。后台轮询不上报任何内容，而 Host 拥有的手动
同步独立于视图上报进度。

`configSync.syncNow` 没有聚合 RPC 截止时间。操作由 Host 拥有，因此离开
设置页面不会取消它。返回页面时读取 Host 的 `syncing` 状态，禁用重复操作，
并订阅剩余的进度上报。各个后端请求保留各自的超时；正常的 Host/进程关闭仍是
生命周期边界。

凭据和记忆默认未选中。设置预览上报 supported、excluded、secret-bearing、
mapping-required 和 pending-activation 计数。原始导出秘密和 vault key
永远不会返回给 renderer；备份密码只作为瞬态输入跨 IPC，账户 token 在同步中
根本不跨 IPC。

Host 拥有启动时的即时检查、30 秒本地变更防抖，以及自动同步启用时有界的
五分钟远端轮询。失败的网络请求使用带 jitter 且有上限的指数重试；paused、
locked、不兼容、认证和错误密码状态不会启动重试循环。worker 随 Host 取消；
应用退出后没有额外的 daemon。

## 6. 持久性与兼容性

配置存储在 Host `kv` 存储的 `configSyncRouter/config`。vault key 使用现有
的加密 Host 秘密存储。该实现使用加密文件和同一数据目录下的 `.machine-key`，
而不是 OS Keychain 后端；复制整个数据目录不是受保护的云备份。账户 token
保留在由「账户」管理的 providers store 中；同步不保留第二份拷贝。

本地状态位于 `config-sync/router/<state-id>/` 下。加密的 shared/observed
baseline、pending bundle 和恢复点使用临时文件重命名写入。格式损坏或未通过
认证的 bundle 是错误，而不是空状态。仅支持 router-account 格式。旧 S3
配置和本地状态不会被检测、解释或迁移；它们保持原样，既有云端对象也不会被
删除。不需要 SQLite 迁移。

恢复会先保存加密的本地恢复点。同步恢复要求 `acknowledgePropagation: true`
并立即发布新的共享修订；敏感的本地激活仍需每台设备单独审批。备份恢复仅限
本地，不移动任何远端 head。也可以恢复最近一次备份。两种模式都不会悄悄覆盖
待处理的导入。

密码变更通过 CAS 更新并认证 wrapped-key header，不改变 vault data key。
之前已解锁的设备保留访问权；这是重包裹，不是设备撤销。没有可信 head 历史的
新设备无法证明恶意服务器返回的是最新的有效备份。对这种服务器的可用性和
新鲜度不做保证。

协议与连接契约有意只支持 router-account。共享 vault 的所有设备必须使用本
实现连接同一账户。先前的 WebDAV 与 S3 后端已被移除而不是模拟；它们的云端
对象保持原样。见
[router-account 决策](../../../adr/router-account-configuration-backup.md)。
