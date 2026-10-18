# 07. 插件市场

> **翻译说明：** 本页是与 [英文源规格](/spec/07-plugins/07-plugin-marketplace) 一一对应的机器辅助翻译。代码、协议字段和标识符保持原文；如翻译与英文源事实有歧义，以英文版本为准。


## 1. 定位

插件市场是一个**分发层**，而不是运行时核心。

原理：

> 首先让本地插件系统运行，然后集成市场。

市场负责：
- 发现
- 搜索
- 显示元数据
- 下载
- 更新检查

主办方负责：
- 验证
- 授权
- 安装
- 运行
- 安全隔离

## 2. 阶段策略

### A阶段✅
- 协议和数据模型
- 当地官方市场提供商（`plugins/market/catalog.json`）

### B阶段✅
- Browse/search + 下载安装是针对官方提供商实施的
- 官方提供商是本项目自己的插件分发仓库 `github.com/minih-git/minih-agent-plugins`（B 阶段最初指向外部插件中心；见下方「目录来源」与 [ADR 0332](/adr/0332-own-plugin-distribution-repository)）
- 默认目录 URL：`https://raw.githubusercontent.com/minih-git/minih-agent-plugins/main/catalog.json`
- 包 URL 可以是绝对 `https://` / `http://` / `file://`，或相对路径：目录声明了 `artifact_base_url` 时按它解析，否则按目录 URL 解析
- HTTPS 获取在 host-core 中使用 `curl`

### 目录来源

「插件 → 市场」始终使用本项目分发仓库的目录
`https://raw.githubusercontent.com/minih-git/minih-agent-plugins/main/catalog.json`
（ADR 0332），页面不提供来源选择器。旧版本持久化的 `pluginMarketSource` 和
`pluginMarketCustomUrl` 仍保留以兼容设置读取，但会被忽略——`settings.set` 让 host
的市场选择固定为本仓库——无需迁移数据。开发与测试仍可通过
`MINIH_AGENT_PLUGIN_MARKET_URL` 指向本地目录，其优先级最高，但已发布界面不会因此
开放目录配置。

市场目录与安装包下载遵循设置 → 常规 → 网络。系统模式会让 host-core 的 `curl`
通过 Electron 的认证回环 SOCKS 中继，并按当前操作系统代理/PAC 解析目标。直连模式
强制市场请求直连；自定义模式使用所配置的代理与绕过列表。中继凭据仅在运行期使用，
不会传给工作区 Shell。

这个目录背后没有发布平台。仓库里的 `catalog.json` 就是上架契约，它自己给出每个包的
URL 与 sha256，因此安装只抓取该 URL 一次，并按目录声明的摘要校验。没有 resolve
请求、没有设备标识、也没有平台返回的镜像列表：安装包由提供目录的 Git 主机（GitHub，
或同一仓库的 CNB 镜像）提供，相对包 URL 按 `artifact_base_url` 或目录 URL 解析，因此
换镜像主机不会改变已记录的摘要。

缓存目录通过 `plugins/market/cache-meta.json` 按来源记录。分发仓库的目录缓存是市场
快照；旧来源留下的缓存会被忽略但不会删除。远程抓取仍由显式的 `market.refresh`
触发，避免设置写入因市场超时而持有 host RPC 状态锁。

### 包下载

市场的每次安装或更新都只走一条路径：刷新目录、下载目录给出的包 URL、校验声明的
sha256、解包、注册、启用，之前不会先向第二个服务解析。因此安装失败只可能是
`PLUGIN_NETWORK`、`PLUGIN_INTEGRITY`、`PLUGIN_MARKET_INVALID`、
`PLUGIN_MARKET_UNTRUSTED_HOST` 或 `PLUGIN_CANCELLED`。
### 安装进度与取消

安装或更新是一次请求，因此它在进行期间会报告自己处于哪一步。
`plugin.installProgress` 通知携带 `pluginId`、`version`、`phase`（`download`、
`verify`、`install`、`enable`）、`source` 及其从 1 开始的 `attempt` / `attempts`、
`receivedBytes` / `totalBytes`（`totalBytes` 为 `0` 表示大小未知），以及 `tried[]`
（每项为 `{ source, url, error }`）。从分发仓库安装时只有一个包 URL，因此不报告镜像：
`source` 为 null、`attempt` 为 0、`tried` 为空，这些字段仍保留在协议上以兼容目录驱动的
列表。以失败结束安装的那一条报告还会带上 `error`。报告被限流为每 200 ms 最多一条，
外加每次阶段变化与最终报告，因此字节级进度不会淹没界面。

`market.cancelInstall { id }` 返回 `{ cancelled, id }`，且只取消当前正在运行的安装。
真正能被中断的只有下载：该请求在字节到达时，以及安装包被校验和写入之前的最后一个
安全点被检查。被取消的安装以 `PLUGIN_CANCELLED`（JSON-RPC 码 1019）失败，对话框
静默关闭，而不是报告错误。

对话框只用于手动安装或更新，后台自动更新不会打开它。它显示当前阶段、由
`receivedBytes` / `totalBytes` 得出的确定进度条与传输速度，以及仅在 `download` 期间
可用的取消按钮。安装成功后约 2 秒自动关闭，悬停时暂停该倒计时。Escape 与取消按钮
遵循同一规则：正在下载时不能关闭对话框，安装离开 `download` 后即可关闭。安装失败时
对话框保持打开，显示可读的错误，并提供复制与重试操作。

### 客户端可见的目录策略

保留稳定 ID 以 `demo.` 开头的仅开发示例条目
可用作插件开发的离线装置和直接安装目标，
但桌面客户端会在更新其市场状态之前过滤它们。他们
不显示为卡片、类别或搜索结果。一个已经安装好的
示例在已安装中仍然可见，因此仍然可以禁用或卸载它。

### 目录中的内置插件

ID 同时由某个构建从 `resources/plugins` 随应用打包的条目仍然保留：卡片会解析到内置的行、
显示已安装版本，并在目录中存在严格更新的版本时提供更新。这是用户无需等待应用更新即可
获取上游新版本的受支持途径（ADR 0241）。只有严格更新的版本才算更新——版本相同不算，
目录中更旧的条目也不算，那只会是披着更新外衣的降级。

更新内置插件后它仍然是内置插件。卸载仍按「该构建是否随应用打包」以 ID 拒绝，而不是按
行的 `source` 判断，因此更新过的插件依然不容用户卸载；同时已安装版本会跨过下一次启动，
除非该构建自带严格更新的版本——这样从未安装过任何东西的用户也能拿到应用更新。

### C阶段（部分✅）
- 自动更新策略+实施权限差异门控
- 评级/强制签名仍在计划中

### D 阶段（进行中）

插件源码迁移到发布者自己的仓库，目录升级到 schema v2（ADR 0102）。客户端用
同一条代码路径读取 v1 和 v2；v2 增加源码溯源、审查结论、撤回状态和显式声明的
制品基址。发布流程见本文档第 13 节。

## 3. 市场提供商抽象

```ts
interface MarketProvider {
 id: string
 list(query: MarketQuery): Promise<MarketSearchResult>
 get(pluginId: string): Promise<MarketPluginDetail>
 getDownloadInfo(pluginId: string, version?: string): Promise<MarketDownloadInfo>
 checkUpdates(installed: InstalledPluginRef[]): Promise<MarketUpdateInfo[]>
}
```

已发布客户端目前只提供 `official` 提供商。开发专用的
`MINIH_AGENT_PLUGIN_MARKET_URL` 覆盖允许本地测试目录，但不会在产品界面增加来源控制。

## 4. 数据模型

### 目录 schema v2

没有 `schemaVersion` 的目录即 v1，含义不变。`schemaVersion: 2` 增加下列字段；
它们全部可选，因此 v1 目录解析行为完全不变，而客户端把缺失字段当作"未声明"，
不会当成默认放行。

```jsonc
{
  "schemaVersion": 2,
  "providerId": "official",
  "catalogId": "pi-plugin-center",
  "generatedAt": "2026-08-18T02:00:00Z",
  "policyVersion": "2026.08.1",
  // 可选。分发仓库的目录会声明自己的基址；目录省略它时，相对包 URL
  // 按目录文件所在目录解析，因此 GitHub raw 与 CNB 镜像各自提供自己的
  // 安装包，不会跨提供方。把安装包放在别处的镜像或企业源，在这里声明
  // 自己的基址。
  "artifact_base_url": "https://raw.githubusercontent.com/minih-git/minih-agent-plugins/main",
  "plugins": [
    {
      "id": "acme.todo",
      "publisherId": "acme",
      "trust": "verified | community | unknown",
      "repository": "https://github.com/acme/pi-plugin-todo",
      "versions": [
        {
          "version": "1.2.0",
          "url": "packages/acme.todo-1.2.0.piplug",
          "shasum": "<sha256 hex>",
          "sizeBytes": 40960,
          "permissions": ["fs.read"],
          "minMinihAgent": "0.8.0",
          "yanked": false,
          "yankedReason": null,
          "provenance": {
            "sourceRepository": "https://github.com/acme/pi-plugin-todo",
            "sourceRef": "refs/tags/v1.2.0",
            "sourceCommit": "<40 位 commit>",
            "sourcePath": ".",
            "builder": "pi-plugin-center-builder@1.0.0",
            "builtAt": "2026-08-18T01:55:00Z"
          },
          "review": {
            "decision": "approved",
            "risk": "low",
            "policyVersion": "2026.08.1",
            "reviewedAt": "2026-08-18T01:58:00Z"
          },
          "signature": "<base64>",
          "signatureAlg": "ed25519",
          "keyId": "pi-center-2026"
        }
      ]
    }
  ]
}
```

v2 的客户端规则：

- 解析相对包 URL 时 `artifact_base_url` 优先于目录文件所在目录。绝对 URL 按原样
  使用，但仍须通过下载域名白名单。
- `trust` 仅用于展示，绝不从发布者提供的文本推导。仅当当前生效的目录就是本项目自己的
  分发仓库时，`verified` 才会被采信；来自其他目录时降级为 `community`，无法识别的
  等级显示为 `unknown`。见第 8 节。
- `yanked: true` 的版本从安装和更新选择中移除，但保留在版本历史里并附带原因；
  已安装该版本的插件会被标记为需要注意。
- `minMinihAgent` 高于当前应用版本时，在下载前就拒绝安装。
- `provenance` 随已安装插件一起保存并在详情面板展示，因此可以追溯到具体仓库和
  commit。
- `signature` 校验规则见 [08-plugin-signing-updates.md](08-plugin-signing-updates.md)，
  在签名阶段落地前保持可选。无法验证的签名绝不当作有效签名。

### MarketPluginSummary
```ts
type MarketPluginSummary = {
 id: string
 name: string
 description: string
 author: string
 iconUrl?: string
 latestVersion: string
 downloads?: number
 updatedAt: string
 categories?: string[]
 permissionSummary: string[]
 verified?: boolean
 installable?: boolean
}
```

### 市场插件详细信息
```ts
type MarketPluginDetail = MarketPluginSummary & {
 readmeMarkdown?: string
 versions: Array<{
 version: string
 publishedAt: string
 changelog?: string
 minMinihAgent?: string
 }>
 screenshots?: string[]
 homepage?: string
 repository?: string
 permissions: string[]
 safetyNotes?: string
}
```

`installable` 表示 `latestVersion` 是否带有安装所需的包元数据（`url` 与
`shasum`）。发布者可以先登记版本、稍后再上传安装包；这样的版本仍然可以被发现，
但市场列表和详情面板会禁用安装按钮并标注「尚未发布安装包」，而不是发起一个
host 必然拒绝的下载。批量更新会跳过这类版本，而不是让整批更新失败。

### 目录发布闸门

发布或排查一次发布之前，先在仓库里跑预检：

```bash
pnpm check:marketplace -- \
  --url https://raw.githubusercontent.com/minih-git/minih-agent-plugins/main/catalog.json \
  --plugin <plugin-id>
```

预检刻意比发现流程更严格：每个已发布版本都必须有合法且在该插件内唯一的语义化
版本号、64 位 SHA-256 校验和、包 URL、正数包大小以及权限数组。目录没过这道闸门
时，应当先在市场发布方修好，而不是去改客户端的更新行为。

### 市场下载信息
```ts
type MarketDownloadInfo = {
 pluginId: string
 version: string
 url: string
 sizeBytes: number
 shasum: string // sha256
 signature?: string // mandatory later
 signatureAlg?: "ed25519"
 publishedAt: string
}
```

## 5. 安装路径（市场）

```text
browse/search
 → detail
 → install
 → download to cache
 → verify shasum/(signature)
 → hand to local packaging installer
 → permission review
 → enable?
```

任何验证失败时：中止并可选择清理缓存。

### 下载域名白名单

v1 目录把所有安装包都放在同一个仓库下，因此校验和是唯一需要的控制。目录 v2 的包
URL 描述的是一个受发布者影响的 release，所以宿主还必须约束**请求发往哪里**，而不
只是约束收到什么。

在下载市场安装包之前，host-core 解析该 URL，并在不满足下列全部条件时拒绝：

1. 协议是 `https`，本地开发目录可以是 `file://`。
2. URL 不携带内嵌凭证。
3. 主机在下表白名单中，或者就是当前生效目录的来源主机。

| 主机 | 用途 |
| --- | --- |
| `github.com` | release 资产下载入口 |
| `objects.githubusercontent.com` | GitHub 重定向 release 资产的去处 |
| `release-assets.githubusercontent.com` | 当前的 release 资产源站 |
| `raw.githubusercontent.com` | 目录文件与仓库内托管的安装包 |
| `codeload.github.com` | 仓库归档下载 |
| `cnb.cool` | 镜像目录与镜像资产 |

重定向被限制为 HTTPS 并重新校验：跳转后的最终 URL 必须满足与初始 URL 相同的规则。
自定义或企业目录只被信任其自身主机——把客户端指向一个私有目录，并不会为任意第三方
主机放宽白名单。

白名单之外的包 URL 在任何网络请求发出之前就以 `PLUGIN_MARKET_UNTRUSTED_HOST` 失败，
错误信息会指出被拒绝的主机，便于运维区分配置错误的私有源和恶意目录条目。

`.piplug` 软件包现在可以在本地生产：`pnpm pi-plugin pack <dir>`
（同样，`PluginPack` 代理工具）写入 `dist/<id>-<version>.piplug` 和
打印其 sha256，插件页面通过相同的方式安装该文件
作为市场下载的验证和权限审查。分布通过
因此，市场是可选的——为个人使用而编写的插件永远不会
必须离开机器。参见
[插件开发者体验](/zh-CN/spec/07-plugins/10-plugin-devex)。

其插件声明 `contributes.skills` 的目录条目也必须声明
`permissions` 中的 `agent.prompt.inject`；没有它，技能就会变得惰性，
权限审查不会提及它们。 `pi-plugin check` 对此发出警告
组合。

## 6. 更新路径

1. 启动后或按计划执行 `checkUpdates`
2.将安装的版本与最新版本进行比较
3. UI显示可用更新列表
4、用户确认后下载升级

策略：
- MVP 之后的第一个版本：手动更新
- 稍后：可选自动更新（低风险插件或仅限官方插件）

## 7. Marketplace UI 信息架构

```text
Extensions
├─ Installed
│ ├─ Search + result count
│ └─ Groups: Needs attention · Updates available · Active · Turned off
├─ MCP
├─ Skills
├─ Marketplace
│ ├─ Search
│ ├─ Categories
│ └─ Card grid
├─ Detail sheet (shared by both tabs)
└─ Permission dialog (install / upgrade)
```

所有五个表面都处于一个分段控制之下，该控制承载相关的
每个选项卡计数。没有单独的数字概览带；更新警报，
选项卡计数和已安装组计数保留可操作状态，无需
将其复制到静态卡行 (D196) 中。标头保留单个
上下文主要操作（浏览市场/刷新市场）和移动
检查更新、应用自动更新、安装包和加载本地
插入溢出菜单（D169）。

安装的行故意默认为安静的两行摘要，其中包含
插件名称、可选的本地源标记、id 和版本。国家集团
标题包含“活动”/“已关闭”/“可用更新”/“需要注意”，以及
加载错误保持内联。能力、居民服务状况以及
带有风险色彩的权限芯片在折叠的本机详细信息中呈现
披露；扩展它可以暴露现有的完整读数，而无需进行每一个
排高。安装的行使用一个当前状态范围触发器；打开显示
三个范围选择及其解释，并选择此项目
打开现有的项目选择器。行图标操作在静止时保持可见，并且
在悬停和键盘焦点时显示其标签。这是一个仅渲染器
演示选择；插件
权限和激活合同不变。

详细信息表必须显示：
- 权限，按风险等级分组和标记
- 作者
- 版本（可选版本列表）
- 更新时间
- 风险描述（安全说明标注）
- 安装按钮

市场卡呈现字母组合字形，而不是获取 `iconUrl`；的
渲染器不执行远程图像加载（D169）。

按 Escape 关闭详情面板时，清除市场卡片详情按钮的焦点，与鼠标关闭一致：卡片不残留横线或焦点框。随后使用 Tab 导航时，浅色和深色主题下都应在圆角详情按钮内部完整显示焦点框，不能被裁剪成安装区域上方的一条横线。

## 8. 信任模型

| 级别 | 含义 |
|---|---|
| 已验证 | 官方或认证出版商 |
| 社区 | 社区插件 |
| 未知 | 定制来源/未经认证 |

UI 必须使信任级别可见。
社区不得伪装成经过验证的。

在目录 v2 下，信任等级是对发布者的断言，因此客户端只在能够归因时才采信。仅当当前
生效的目录就是本项目自己的分发仓库（`OFFICIAL_CHANNEL_CATALOG_URL`）时，
`verified` 才会被接受；同样的取值来自其他目录时降级为 `community`，无法识别的
等级显示为 `unknown`，任何目录都不能自我提升等级。本仓库当前重新分发社区插件，
因此条目声明 `community`。v1 目录的布尔 `verified` 仍按原义映射为 `verified` /
`community`，因为 v1 目录只有市场维护者能写入。

## 9. 私有来源（未来的企业支持）

已发布客户端不提供或持久化私有目录来源。`MINIH_AGENT_PLUGIN_MARKET_URL` 覆盖仅供本地
开发与测试使用，不是产品设置。企业来源支持需要未来的产品决策，并需明确设计安全与授权。

## 10. 远程 API 草稿 (HTTP)

> 选秀（后 MVP）。不是最终的实现绑定；仅协议草案。

- `GET /v1/plugins?query=&category=&page=`
- `GET /v1/plugins/:id`
- `GET /v1/plugins/:id/versions`
- `GET /v1/plugins/:id/download?version=`
- `POST /v1/updates/check`

所有下载元数据必须包含 `shasum`。

## 11. 明确不做（市场 v1）

- 应用内付费结账
- 远程插件代码热补丁
- 静默自动安装
- 未经验证的下载和执行
- Comment/social系统（可延期）

## 12. 接受（市场只读+安装）

1.可以浏览插件列表
2.可以查看权限和版本
3.可以下载安装
4. 验证失败无法安装
5.安装后出现Installed


## 12. 实施情况

桌面扩展页面现在包含一个市场选项卡，该选项卡调用：

- `market.search`
- `market.getDetail`
- `market.install`
- `market.checkUpdates`
- `market.applyUpdates`

安装在启用之前始终通过校验和验证和权限审查。


## 13. 分发仓库

存储库：[minih-git/minih-agent-plugins](https://github.com/minih-git/minih-agent-plugins)（public）。
它是市场唯一的来源，也是客户端完整的分发契约（ADR 0332）。布局：

```text
catalog.json                 # schemaVersion 1，providerId 为 "official"
packages/<id>-<version>.piplug
plugins/<id>/                # 插件源码
README.md
```

目录声明 `artifact_base_url` 为
`https://raw.githubusercontent.com/minih-git/minih-agent-plugins/main`（也可写相对值），
包 URL 使用相对路径，因此无论安装包由 GitHub raw 还是同一仓库的 CNB 镜像提供，
目录记录的 sha256 都能校验通过。目录不由任何服务生成，由维护者提交。

本仓库当前重新分发第三方社区插件（由各发布者自己的源码构建），因此条目声明
`trust: "community"` 与 `verified: false`。再分发方并不认证发布者，第 8 节说明了
为什么这是正确等级而不是 `verified`。

### 发布

一次发布是一次提交，而不是向某个服务提交申请：

1. 用 `packages/plugin-devkit` 把插件打包为 `packages/<id>-<version>.piplug`，
   再重新生成 `catalog.json`，写入新版本条目及其 sha256、大小、权限与
   `artifact_base_url`。
2. 把安装包与重新生成的目录放进**同一个 commit** 提交并推送。目录列出的版本与它
   指向的字节永远不会分处两个提交，客户端不会看到一个安装包尚未发布的版本。
3. 发布前用第 4 节的发布闸门对已发布的目录 URL 做一次预检：
   `pnpm check:marketplace -- --url https://raw.githubusercontent.com/minih-git/minih-agent-plugins/main/catalog.json --plugin <plugin-id>`。

市场分发始终是可选的：第 5 节描述了不经过本仓库、直接安装本地打包 `.piplug` 的方式。
原先负责发布的外部插件中心已退役；[15-plugin-center.md](15-plugin-center.md) 仅作为
上游背景保留，不再是客户端契约。

使用 env 覆盖目录 URL：

```text
MINIH_AGENT_PLUGIN_MARKET_URL=https://raw.githubusercontent.com/<owner>/<repo>/<ref>/catalog.json
```


## 14. 市场细节用户体验

扩展目标将详细信息打开为右侧表（稀松布 + Escape + 外部
单击“dismiss”），加载 `market.getDetail` 并显示：

- 关于文本、作者和存储库/主页链接（在作品中打开
  面板浏览器，绝不是系统浏览器）
- 安全说明作为警告标注
- 按风险等级分组的权限，每个权限都有简单的语言解释
- 版本列表作为可选择的行，所选版本驱动粘性
  安装/更新操作
- 自述文件降价

从任一选项卡都可以通过权限对话框进行安装，该对话框将
请求进入高/中/低风险部分并标记新条目
相对于已安装的版本，因此升级不能默默地扩大访问范围
（D169）。

插件开发文档随宿主仓库维护，发布则是向分发仓库提交：

- 宿主指南：`docs/plugin-development.md`
- 发布：通过第 4 节的 `check:marketplace` 预检后，把打包好的 `.piplug` 与重新生成的
  `catalog.json` 一起提交到
  [minih-git/minih-agent-plugins](https://github.com/minih-git/minih-agent-plugins)
- 内置模板：`panel-basic`、`agent-tool-basic`、`skill-pack`、`full-demo`
- 贡献指南：分发仓库的 `README.md`
