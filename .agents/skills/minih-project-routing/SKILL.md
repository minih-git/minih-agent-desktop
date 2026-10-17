---
name: minih-project-routing
description: >-
  Minih-Router 与 Minih-Agent-Desktop 双仓库改动路由技能。当任务涉及两项目的
  对接面（minih-router 网关预设、/v1 数据面、/api 控制面、EasyTier 组网、
  AccessKey/余额/模型广场/额度计费），或不确定需求应落在哪个仓库实施时，
  必须先读本技能再动手。
---

# Minih-Router × Minih-Agent-Desktop 改动路由指引

本文件在两个仓库各存一份**内容完全相同**的副本：

- `/Users/minih/Projects/minih/Minih-Router/.agents/skills/minih-project-routing/SKILL.md`
- `/Users/minih/Projects/minih/Minih-Agent-Desktop/.agents/skills/minih-project-routing/SKILL.md`

> **同步约定**：修改任一副本后，必须把相同内容复制到另一仓库，保持两边一致，避免指引分叉。

## 1. 两个仓库的定位

|  | Minih-Router | Minih-Agent-Desktop |
|---|---|---|
| 角色 | AI 模型网关（服务端）：LLM 请求路由、渠道/订阅管理、计费额度 | 桌面 AI Agent 应用（客户端，Electron，**已发布、有真实用户**） |
| 技术栈 | Go 单体 + React 前端（`web/`，构建产物内嵌进二进制） | pnpm monorepo：`apps/desktop`（Electron + React）+ `packages/*` + Rust host-core |
| 本地路径 | `/Users/minih/Projects/minih/Minih-Router` | `/Users/minih/Projects/minih/Minih-Agent-Desktop` |
| 主分支 | `main`（主仓库 gitea.hungraim.com/minih/Minih-Router） | `main` |

强关联方式：Desktop 把 Router 作为**第一方网关预设**（provider 行
`vendorKey: "minih-router"`），通过下面 3 个对接面依赖 Router。

## 2. 对接面地图（改动定位用）

| 对接面 | Router 侧（服务端） | Desktop 侧（客户端） |
|---|---|---|
| 数据面 `/v1/*`：OpenAI Chat Completions / Responses / Anthropic Messages / Gemini 协议转发 | `internal/`（gateway、protocol、channel、subscription、scheduler、ratelimit 等） | 一般无需改：runtime 像普通 provider 行一样调用；仅 Router 行的 Gemini 请求由 Desktop 把 `/v1` 映射为 `/v1beta` |
| 控制面 key-scoped 只读 API：`/api/home`、`/api/usage`、`/api/models`（余额、用量、模型广场价格） | `internal/control/`（`auth.go`、`http_routes.go` 等） | `apps/desktop/electron/main/minih-router-client.ts`（请求与解析）、`ipc/minih-router-ipc.ts`（invoke channel）、`src/components/settings/useMinihRouter.ts`（UI） |
| 组网 bootstrap：`GET /api/easytier/bootstrap`（下发 networkName / networkSecret / gatewayVirtualIpv4 / peers / ttlSeconds）与 EasyTier 只读监控、接入引导 | `internal/control/` + `internal/easytier/`，文档 `docs/operations/easytier-mesh.md` | Rust host-core 内嵌 EasyTier 节点（networkName `minih-router`，虚拟网段 `11.12.0.0/24`，默认 No-TUN）；端点解析 `resolveMinihRouterEndpoint`（`session-launch.ts` 引用） |
| 网关预设与设置 UI（默认地址、格式选项、推荐位、账户卡片） | —（Router 不管客户端展示） | `packages/shared/src/provider-presets.ts`、`packages/shared/src/minih-router.ts`（类型）、`apps/desktop/src/components/settings/`（`minih-router-format.ts`、账户/广场组件等） |

## 3. 需求 → 仓库判定表

| 需求关键词 | 去哪个仓库改 |
|---|---|
| 请求转发、重试/熔断/故障转移、渠道(channel)、订阅、上游供应商、倍率/计费、额度、限流、请求日志 | **Minih-Router** |
| 网关 Web 控制台页面（模型广场、渠道管理、系统设置等，`web/` 目录） | **Minih-Router**（前端有改动时发布需 `deploy.sh --ui`） |
| `/api/home` `/api/usage` `/api/models`、bootstrap 的**字段或接口增删改** | **两个仓库联动**：Router 改响应，Desktop 同步改解析与展示（见第 4 节流程） |
| Desktop 设置页里网关账户/余额/模型广场的展示、文案、布局、交互 | **Minih-Agent-Desktop** |
| provider 行的默认 baseUrl、API 格式选项、预设注册、vendorKey 匹配行为、模型选择 UI | **Minih-Agent-Desktop** |
| EasyTier 客户端节点行为：No-TUN/TUN、LAN 优先与公网回退、bootstrap 缓存、本地端口转发 | **Minih-Agent-Desktop** |
| EasyTier 服务端能力：状态监控展示、接入命令生成、bootstrap 下发参数 | **Minih-Router** |
| 新增模型协议 / API 风格 | **Minih-Router 为主**（转发内核实现）；Desktop 仅在需要新 UI 格式选项时联动 |
| 网关部署、发布、更新服务器 | **Minih-Router**（先读 `minih-router-deploy` 技能） |

## 4. 跨仓库契约变更流程

任何 `/api/*` 字段或 bootstrap 协议的增删改都是**契约变更**，按以下顺序执行：

1. **先定契约**：明确 Router 响应结构。Desktop 侧契约文档是
   `docs/spec/03-runtime/12-provider-config-schema.md`（英文）与
   `docs/spec/zh-CN/spec/03-runtime/12-provider-config-schema.md`（中文镜像），两份都要同步更新。
2. **Router 先实现**，保持向后兼容：旧版 Desktop 会长期连接新版 Router。
   - 新增字段可以；删除字段或改语义前，必须评估已发布 Desktop 的行为。
   - bootstrap 返回 `404` 在 Desktop 是**受支持的合法状态**（网关未实现该端点），不是故障。
3. **Desktop 后消费**，必须优雅降级：
   - bootstrap 失败/404 → 回退本地配置；LAN 不可达或 502/503/504 → 回退公网 `baseUrl` 重试。
   - 字段缺失 → 按"网关未提供"处理并隐藏对应展示，不得报错阻断。
4. **真实链路验证**：本地起 Router（或用测试服务器），Desktop 指向它实测新增/降级两条路径，
   不要只看单侧代码。涉及现场时注意 Router 实际数据库为 `/opt/gpt-load/data/gpt-load.db`。

## 5. 各仓库的规则入口

**Minih-Router**：
- 部署发布类改动先读 `.agents/skills/minih-router-deploy/SKILL.md`。
- Go 改动跑 `go test ./...`；前端改动跑 `cd web && pnpm run build` 验证。

**Minih-Agent-Desktop**：
- 根目录 `AGENTS.md` 是权威规则（与 `CLAUDE.md` 有 policy-sync gate：`pnpm check:agent-policy`）。
  已发布软件：正确性 > 用户数据安全 > 安全 > 向后兼容，优先级高于交付速度。
- 改动前读 `docs/spec/06-delivery/03-ai-development-workflow.md` 与 `05-change-checklist.md`，
  并按其要求跑对应检查。

## 6. 常见误判

- **不要在 Desktop 里实现网关职责**（计费、额度判定、渠道选择、请求重试路由）——那是 Router 的内核；Desktop 只是消费方。
- **不要在 Router 里写 Desktop 专属逻辑**（如针对 Desktop 的特殊分支）；对 Router 而言 Desktop 就是一个普通 AccessKey 客户端。
- 改 `/api/*` 只改一侧 = 半成品：数据源在 Router，消费在 Desktop，字段变更两边都要动并保持兼容。
- Desktop 的"Minih Router 预设行为"（vendorKey 匹配、默认地址、推荐位）归 Desktop，不要去 Router 仓库找。
- 两仓库 `main` 各自独立演进，不要假设提交同步；对接行为以线上 Router 版本与已发布 Desktop 版本为准。
