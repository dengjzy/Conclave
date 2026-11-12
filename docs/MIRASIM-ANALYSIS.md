# Mirasim 逆向全量功能盘点、设计优点与借鉴取舍

> 基于 `rea` 对 `Mirasim-0.0.795-linux-x86_64.AppImage`（Electron `44.7.0`，`app.asar` 497 项资产、187 条 IPC 通道、`window.mirasim` 102 个桥接方法）及本地热更新载荷 `~/.mirasim/app/0.0.796/`（`server-main.cjs` + Renderer 资产）的静态逆向分析整理。

---

## 1. 整体架构概览

Mirasim 的定位是 **桌面端多 Agent 研发工作台 + 商业团队协作空间**，采用三层分离但桌面强耦合的架构：

```
Electron Shell (main.cjs + preload.cjs, 7 类 BrowserWindow)
   ├── 内置持久化浏览器分区 (persist:mirasim-browser + CDP + MV3 扩展)
   ├── 原生桌面能力层 (悬浮岛 Turn Island / 截图 OCR / Computer Use AX Helper / SSH 隧道)
   └── 独立本地后端进程 (server.cjs -> server-main.cjs, Node HTTP/WS + SQLite/文件存储)
          └── ~/.mirasim/ (36 个子目录：agenda / agent-homes / sessions / docs / schedules / search ...)
```

**底层工程亮点**：
- **前后端进程解耦**：关闭窗口不杀运行中的 Agent 会话；`server.cjs` 启动时开启 Node 原生 `module.enableCompileCache()` 加速近 20MB 后端 bundle 的冷启动。
- **确定性热更新**：桌面壳不可变，业务层（`server-main.cjs` + `renderer/`）按版本号下载至 `~/.mirasim/app/<version>/`，通过 `current.json` 原子切换，失败自动回退内置 `resources/`。

---

## 2. Mirasim 全量功能清单（8 大模块）

### 2.1 多 Agent 引擎与多账号/额度调度（Agent Harness）
| 功能点 | 实现机制与细节 |
|---|---|
| **12+ CLI 统一接入** | 支持 `claude`、`codex`、`antigravity`、`opencode`、`gemini`、`kimi`、`grok`、`dsh`、`pi`、`zcode`、`omp`、`qwen` 等。 |
| **多账号隔离（Agent Homes）** | 在 `~/.mirasim/agent-homes/` 下为同一 CLI 维护多个独立 `HOME`/凭证目录，支持同一机器登录多个 Claude/Codex 账号并随时切换。 |
| **额度耗尽自动接力（Quota Failover）** | 实时解析各 CLI 用量与限流错误（写入 `usage-readings.json`），触发限额时自动切换备用账号或备用 Agent 续跑（`{from} 的额度用完了，已换到 {to} 接着做`）。 |
| **外部工具一键迁移** | 内置读取 `conductor.db`（Conductor 工作区/会话）与 `.cc-switch/cc-switch.db`（CC-Switch 供应商配置），降低迁移门槛。 |
| **自定义网关与模型包导出** | 支持导出/导入 `ProvidersBundle` 与 `ModelConfig`，统一注入环境变量与 API Key。 |

### 2.2 会话与单轮精细控制（Session & Turn UX）
| 功能点 | 实现机制与细节 |
|---|---|
| **软纠偏 `steer` vs 硬打断 `stopAndRun`** | Agent 正在输出或调工具时，发消息默认可走 `steer`（不杀当前回合，中途注入补充指令），也可显式选 `stopAndRun`（中断重跑）或 `recall`（撤回排队消息）。 |
| **单调序号增量流（`seq` Patch）** | 流式事件采用严格递增 `seq` 的结构化增量补丁（`appendText`、`appendReasoning`、`set`）；前端一旦发现 `seq` 断号，立即调 `getSnapshot` 自愈，杜绝流式乱序或丢字。 |
| **会话分叉与文件级回滚** | 支持 `session.fork`（从任意历史节点分叉探索新方案）与 `session.rewind.files`（回滚某轮 Agent 修改的工作区文件）。 |
| **回合内实时步骤（`plan.steps`）** | 将 CLI 原生步骤映射为只读进度条（`completed` / `inProgress` / `pending`），仅表达“当前这一轮 Agent 做到哪一步”。 |
| **结构化提问卡片（Interactions）** | 将 Agent 的澄清问题渲染成单选/多选交互卡片，而不是纯文本问答。 |
| **终端接管排队保护** | 当用户在内置终端直接接管 CLI 会话时，聊天框发出的消息自动进队列等待，防止并发写冲突。 |

### 2.3 目标编排引擎（`/goal`：从对齐到自治执行）
这是 Mirasim 在“自主完成复杂任务”上最核心的产品设计：

- **三段式状态机**：`ALIGNING（目标对齐） → REVIEW（方案审阅） → ARMING / RUNNING（武装执行）`。
- **结构化对齐契约（`<mirasim-goal-brief version="2">`）**：
  在进入自动执行前，先由驱动 Agent 与人对齐并提取结构化投影：
  - `brief`（`GoalBrief`）：
    - `outcome`：最终交付结果（一句话可判定）
    - `acceptance[]`：可测试的验收条件列表
    - `boundaries[]`：允许触碰的边界约束
    - `nonGoals[]`：明确不做的内容（防范围蔓延）
    - `unresolved[]`：未决问题（**未决项非空时禁止草率启动自治循环**）
    - `draftPlan[]`：初步拆解步骤
  - `livingSpec`（活文档规格）：`{ summary, assumptions[] }`，随执行动态演进。
  - `adrs[]`（架构决策记录）：沉淀执行过程中的关键取舍，防止多轮重试后失忆。
- **任务派发与团队协作**：支持单驱动 Agent（`goal.agent.set`）或多成员编排（`goal.members.set`、`goal.work.assign` / `goal.work.unassign`）。
- **原地打转熔断（Stall Detection）**：连续 `N` 轮检查卡在同一失败特征时自动暂停并上报原因，避免空烧 Token。

### 2.4 事项工作台（Agenda）与 GitHub / GitLab / PR 深度集成
Mirasim 把外部研发流拆成了清晰的 **Agenda（事项/Issue）** 与 **Change（代码评审/PR & MR）** 两个工作台：

- **零配置复用本地 CLI 鉴权**：优先直接调用本机已登录的 `gh`（GitHub CLI）和 `glab`（GitLab CLI）凭证，无需用户手填 OAuth App 或复制个人 Token；同时也支持 Gitee 与手动 Token。
- **ETag 速率预算轮询器（`mirasim-issue-sync` / `mirasim-pull-sessions`）**：请求携带 `If-None-Match`；`304 Not Modified` 不计入 GitHub API 核心配额消耗，后台高频同步也不会把 API 刷爆。
- **事项（Agenda）闭环操作**：统一映射优先级（`P0–P4`）与状态，支持在工作台内直接评论、表情回应、改状态、指派负责人，并一键拉起 Worktree + Agent 会话处理该 Issue。
- **PR/MR 四合一上下文（Change 工作台）**：拉取 PR 时一次性聚合 `改动文件 diff + 普通评论 + Review 结论 + 行内代码批注（Inline Review Comments）`，支持一键 Checkout PR 分支、让 Agent 逐条修 Review 意见、工作台内直接 Approve / Merge。

### 2.5 代码工作区、Git Worktree 与知识/文档库
- **多仓库/Worktree 管理**：内置 `askpass.cjs` 处理 Git 凭证弹窗，支持分支对比、暂存、提交、合并冲突辅助。
- **本地全量秒级搜索（`~/.mirasim/search`）**：自建分段合并（Segment-merged）倒排索引，毫秒级（`39–118ms`）检索全部历史会话、事项与文档。
- **内置文档与架构历史（`docs` / `doc-history` / `artifact-lib`）**：带版本历史的本地文档库，Agent 产物可直接沉淀为版本化文档。
- **定时调度（`schedules`）**：支持 Cron / 定时唤醒 Agent 执行巡检或日报任务。

### 2.6 浏览器控制与桌面原生交互（Electron 专属层）
- **Turn Island（桌面悬浮岛 `mirasim:island:*`）**：切去别的窗口写代码或看网页时，屏幕边缘悬浮小岛实时显示 Agent 回合状态，可直接点审批（Allow/Deny）或回一句话，无需切回主窗口。
- **内置受控浏览器（`persist:mirasim-browser`）**：支持导入系统浏览器登录态/Cookie、内置 CDP 自动化桥、检测到真人鼠标键盘操作时自动暂停 Agent 操作（防抢鼠标），配套 MV3 Chrome 扩展。
- **Computer Use 桌面自动化**：`screen-lane.cjs` + 原生无障碍辅助进程 `computer-use-ax-helper`（优先读控件树而非纯盲点像素）。
- **原生截图与 OCR 工具链（`mirasim:shot:*`）**：区域截图、滚动长截图、贴图钉在桌面（Pin）、离线 OCR 提取文字、二维码识别，直接拖入会话。

### 2.7 远程连接层
- **SSH 远程工作区**：通过 SSH 连接远端机器并在隧道内转发本地鉴权（`remoteSshPushableAuth`）。
- **多窗口标签拆分**：类似浏览器的标签页拖拽拆窗与合并（注：其 `open-windows.json` 焦点记忆逻辑存在只恢复最后焦点远端窗口的小缺陷）。

### 2.8 商业化与重型团队协作层（SaaS 载荷）
- **多人共享空间（Spaces）与 `Mira Bot`（“幕僚长”）**：多人频道协作、共享会话与实时协同（`collab` / `mirachannel-v2`）。
- **7 大 IM 机器人网关**：飞书、钉钉、企业微信、QQ、Discord、Slack、Telegram 双向消息接入。
- **应用一键发布（`publish-cli.cjs` → `pub.mirasim.ai`）**：将本地生成的前端/全栈应用打包发布到官方托管域名。
- **算力租赁与官方商业网关**：`chatRentalLink`、`wokey-provider-node` 订阅计费与中转 Token 体系。

---

## 3. Mirasim 最值得肯定的 6 个设计优点

1. **概念边界极其干净，没有“多个待办/多个看板打架”**：
   - 外部/内部待办事项叫 **Agenda（事项）**；
   - PR 代码评审叫 **Change（变更）**；
   - 需要多步自治交付的大任务叫 **Goal（目标）**；
   - 聊天回合里 Agent 自己的小步骤叫 **`plan.steps`（回合进度）**。
   四个概念各司其职，用户一眼知道去哪看什么。
2. **“先对齐（Align）再自治（Arm）”的防跑偏机制**：
   很多 Agent 工具一上来就盲目建分支狂改代码；Mirasim 的 `<mirasim-goal-brief>` 强制把 `outcome`、`acceptance`、`nonGoals`、`unresolved` 对齐清楚，未决问题清零才进入无人值守循环，返工率大幅降低。
3. **增量契约演进（`LivingSpec` + `ADR`）**：
   长周期任务不是一份静态文本写死，而是把“当前规格假设”和“中途做出的架构决策”结构化存下来，换 Agent 或跨多轮重试时不会丢失上下文决策。
4. **对第三方 CLI 与外部平台的“零摩擦寄生”**：
   直接复用 `gh` / `glab` 登录态 + `If-None-Match` ETag 缓存，比手写一堆 OAuth 配置页面实用十倍；多账号目录隔离 + 额度耗尽自动换号接力直击重度用户痛点。
5. **会话流控手感极佳**：
   `steer`（不断流插话）与 `stopAndRun` 分离 + `seq` 增量补丁断号自愈，让长回合交互非常跟手。
6. **UI 信息密度克制且聚焦**：
   把状态归纳成极简漏斗，操作按钮始终只暴露当前阶段唯一需要的主动作（例如对齐阶段主按钮就是 `审阅方案`，审阅阶段主按钮就是 `开始执行`）。

---

## 4. 面向 Conclave 的取舍清单（只留“自主完成 + 自我迭代”核心价值）

结合你的明确目标（**聚焦任务自主完成 + 自我迭代 RSI、无远端服务器不搞多节点、保持 Web + Core + Daemon 轻量架构**），取舍非常清晰：

### 必抄 / 深度吸收（高价值、低负担）
1. **领域分层与单主线交互**：合并冗余概念，建立清晰的 `事项来源 → 任务契约对齐（Brief/Contract） → 自治运行（Run/Flow） → 单轮步骤` 四层模型（详见 [CONCLAVE-FRAMEWORK-REDESIGN.md](file:///home/swrd/workspace/conclave/docs/CONCLAVE-FRAMEWORK-REDESIGN.md)）。
2. **`GoalBrief` 式前置对齐字段**：给 Conclave 的 `TaskContract` 补齐 `nonGoals`（不做事项）、`unresolved`（未决问题清零门禁）以及跨轮次保留的 `decisions/ADRs` 摘要。
3. **零配置 GitHub / GitLab 接入与 PR 四合一闭环**：直接调本机 `gh` / `glab` CLI + ETag 增量同步 Issue/PR，一键把 Issue 或 PR Review 意见转成带验证契约的自治任务。
4. **多账号额度接力（Quota Failover）融入自治流**：Conclave 已有用量读取与多 Agent 切换基础，将其与 `Flow` 深度打通——自治长跑或夜间自我迭代遇到限流时自动切备用账号/模型继续跑，而不是直接挂起失败。
5. **会话 `steer` 软纠偏与浏览器通知替代悬浮岛**：Web 架构不引 Electron，用 Web Notification + 页面顶部全局待响应横幅（Awaiting Banner）替代桌面悬浮岛即可达到 80% 效果。

### 明确不做 / 直接砍掉（避免陷入商业客户端泥潭）
1. **砍掉远程多节点 / Tailscale WASM / 多人共享空间（Spaces）**：单机本地 `127.0.0.1` 零延迟最稳，真需远程时用系统级 SSH 端口转发即可。
2. **砍掉 7 大 IM 机器人网关、应用托管发布、算力租赁与计费网关**：纯商业 SaaS 包袱，与个人极客自治研发无关。
3. **砍掉 Electron 壳、原生截图 OCR、Computer Use 桌面控制**：坚守 Conclave 的 `daemon + core + web` 纯净边界，浏览器验证需要时走外部 Playwright/Chrome DevTools MCP 即可。
