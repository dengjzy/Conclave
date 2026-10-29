# Conclave 架构全景与开发者/Agent 演进规范指南

本指南旨在固化 Conclave 的架构设计原则、模块边界、跨平台兼容规范、新功能扩展与 Bug 修复流水线，为后续人类开发者或任何协作 AI Agent（如 Antigravity, Claude Code, Codex, Cursor 等）提供统一的事实标准与执行规范。

---

## 1. 全景架构与分层设计 (Architecture Overview)

Conclave 采用**单向严格依赖、前后端彻底解耦、多进程物理隔离**的轻量架构：

```
┌────────────────────────────────────────────────────────┐
│              Web 前端 (packages/web)                    │
│      React 19 + Vite + xterm.js + CodeMirror 6         │
│     (纯浏览器端渲染，监听 WebSocket 与 HTTP 静态托管)       │
└───────────────────────────┬────────────────────────────┘
                            │ WebSocket (JSON-RPC 2.0 双向推送)
                            ▼
┌────────────────────────────────────────────────────────┐
│             核心服务层 (packages/core)                   │
│   SQLite 存储 · Git Worktree · 任务调度 · HTTP 静态服务  │
└───────────────────────────┬────────────────────────────┘
                            │ IPC Domain Socket
                            ▼
┌────────────────────────────────────────────────────────┐
│             守护进程层 (packages/daemon)                 │
│      node-pty 终端管理 · Agent stdio 管道 · 进程生命周期   │
└───────────────────────────┬────────────────────────────┘
                            │ stdio / ACP / HTTP / RPC
                            ▼
 ┌─────────────┬─────────────┬─────────────┬─────────────┐
 │ Claude Code │    Codex    │ Antigravity │     Pi      │ ... (共 10+ 款)
 └─────────────┴─────────────┴─────────────┴─────────────┘
```

### 模块职责与边界约束

| 包名 | 核心职责 | 依赖限制 |
|---|---|---|
| **`packages/protocol`** | **唯一事实源 (Single Source of Truth)**。<br/>包含全部 TypeScript 类型、Zod 校验模型、AgentKind 枚举、JSON-RPC 方法入参及配额算法。 | **零内部依赖**，不得依赖 core、daemon 或 web。 |
| **`packages/daemon`** | **轻量进程宿主**。<br/>直接负责子进程 Spawn、node-pty 虚拟终端托管、stdio 管道流式监听。即使 core 或前端刷新，daemon 中的 Agent 会话依然长连不断。 | 仅依赖 `protocol`。 |
| **`packages/core`** | **业务大脑与持久化中枢**。<br/>管理 SQLite 数据库（会话、任务、消息、配额）、Git worktree 生命周期、多 Agent 讨论与研发小队协同编排，对外提供 WebSocket RPC 与静态 HTTP 页面托管。 | 依赖 `protocol`，通过 IPC 连接 `daemon`。 |
| **`packages/web`** | **纯前端界面**。<br/>React 19 单页面应用，负责流式渲染、差异比对（Diff）、代码与终端交互、多模型并排展示与快捷键。 | 仅依赖 `protocol`（类型模型），通过浏览器 WebSocket 与 `core` 通信。 |

---

## 2. 跨平台环境与 Agent 扫描机制 (Cross-Platform Discovery)

Conclave 支持在 **Linux、macOS、Windows** 上无差别扫描并识别已安装的 Agent：

### 2.1 扫描实现要点（`packages/core/src/environment-check.ts`）
1. **环境变量与执行路径检索 (`findOnPath`)**：
   * **Windows (`win32`)**：遍历 `process.env.PATH` 时，自动尝试 Windows 专用后缀 `['.exe', '.cmd', '.bat', '.ps1']`，并针对文件使用 `constants.F_OK` 校验存在性；探测版本时配置 `windowsHide: true` 避免弹黑窗。
   * **macOS / Linux (`darwin` / `linux`)**：校验 Unix 可执行权限位 `constants.X_OK`。
2. **应用目录与 App Bundle 扫描 (`applicationDirs`)**：
   * **macOS**：自动扫描 `/Applications` 与 `~/Applications`，探测 `.app` 包（通过读取 `Contents/Info.plist` 校验完整性），如 Cursor.app、Windsurf.app、Goose.app。
   * **Windows**：自动扫描 `%LOCALAPPDATA%\Programs`、`%ProgramFiles%`、`%ProgramFiles(x86)%`。
   * **Linux**：扫描 `/usr/share`、`/opt`、`/usr/local/bin`、`~/.local/share`、`~/.local/bin`。
3. **版本探活 (`probeAgentCli`)**：
   * 以无 Shell 包装形式执行 `--version`，设置 5 秒硬超时与 16KB 截断缓冲区，通过 `\d+\.\d+\.\d+` 正则精准提取版本。

---

## 3. Agent 管控、安装与热插拔机制 (Agent Management & Hot-Reload)

Conclave 已经实现 Agent 的“安装/更新 $\rightarrow$ 动态重探 $\rightarrow$ 热插拔即时生效”的完整闭环：

```
[UI: 点击安装/更新] ──(RPC: agent.install)──> [Core: AgentCliInstaller]
                                                        │ 启动 node-pty 终端执行脚本
                                                        ▼
[UI: 即刻感知可用] <──(WebSocket 广播)────── [Core: EnvironmentService]
   Zustand 响应式更新  system.environmentChanged      主动触发 check(true)
   无需刷新页面                                     清除旧进程与驱动缓存
```

### 具体工作流
1. **安装控制 (`AgentCliInstaller`)**：
   * 通过 `agent-cli-installation.ts` 调用终端服务执行官方安装脚本，或直接下载 Agent 的 ACP 二进制包（如 Antigravity / Cursor）。
2. **生命周期锁定 (`AgentCliMaintenance`)**：
   * 安装与升级期间，利用 `agentCliAccess.reserve(agent)` 锁定该 Agent，防止并发任务产生脏状态；状态机流转（`starting` $\rightarrow$ `running` $\rightarrow$ `done`）持久化记录在 SQLite 中。
3. **热插拔同步 (Hot-Reload Sync)**：
   * 安装完成后，`EnvironmentService.check(true)` 强制刷新环境检查。
   * Core 触发 `conversations.invalidateCli(agent)` 销毁旧的失效进程/缓存，并向所有已连接的前端广播 `system.environmentChanged` 和 `system.agentCliChanged`。
   * 前端收到推送后，React 状态自动变更，选单中的 Agent 状态瞬间由“未安装”变为“可用”，实现真正的零刷新热插拔。

---

## 4. 会话级历史 (Session-level History) 与上下文管控

Conclave 将聊天拆分为四级层次：`Conversation` $\rightarrow$ `Stages`（各 Agent 的接力轮次） $\rightarrow$ `Items`（原子事件帧） $\rightarrow$ `SQLite / 日志`。

### 必须更新/重算上下文的核心场景
1. **跨 Agent 移交与接力 (Agent Handoff)**：
   * 当用户从 Antigravity 切换到 Codex，两者的上下文窗口大小、提示词格式、工具支持不同。
   * **动作**：当前 Stage 优雅结算，启动目标 Agent 的新 Stage；从历史 Items 中提取高层摘要与关键 diff 写入新 Stage，重置操作栏模型列表与 reasoning 档位。
2. **上下文窗口膨胀与熔断 (Token Compaction / Overflow)**：
   * 当上下文用量（`ContextRing`）超过安全阈值（如 80%）时。
   * **动作**：触发滑窗压缩，丢弃冗余的长输出和中间状态，保留核心决策结论与最新 turn，防止模型撞墙。
3. **并发提问与辩论合并 (Fan-out & Debate Aggregation)**：
   * 多 Agent 并发提问回答完毕或多轮讨论结束时。
   * **动作**：收集各子 Stage 的最终产出，生成结构化引用卡片（Quote Items）合并注入主时间线，供主持人总结。
4. **进程异常崩溃与断线重连 (Crash Recovery)**：
   * 后台进程异常断开或 Daemon 重启。
   * **动作**：依据 SQLite 中记录的 `received_sequence`，校准重放中断事件，重置未响应的 `approval` 审批状态。

### 4.2 外部会话导入与全 Agent 管控 (External Session Import & Adoption)

Conclave 支持将开发者在终端或其他工具中聊到一半的会话导入并纳管：
* **当前支持**：Claude Code（`~/.claude/`）、Codex（`~/.codex/sessions/`）、ZCode。
* **扩展至全 Agent 规范**：每个 Agent Adapter 实现 `TranscriptSource` 接口（声明 `list()` 扫描目录与 `read(file)` 解析器）。如 Pi（`~/.pi/history/`）、Antigravity（`<appDataDir>/brain/`）、OpenCode（`.opencode/sessions/`）。
* **纳管后的能力提升**：
  1. **增量双向同步**：通过 SQLite 中记录的 `session_imports` 表（`importedThrough`、`sourceModifiedAt`）自动感知终端外部的新增聊天，UI 标为 `updated`，一键拉取增量。
  2. **断点接管继续**：导入后不仅能看历史，更能直接在 Conclave 输入框继续回复，底层携带原 `session_id` 恢复该 Agent 的真实运行进程。
  3. **跨引擎移交**：导入的历史会话可直接切换为 Antigravity 或 Codex 继续干活，享受研发小队、代码评审和独立 Worktree 保护。

---

## 5. 新功能开发与 Bug 修复执行流水线 (Development & Fix Pipeline)

后续无论是人工开发还是由其他 AI Agent 介入，**必须严格遵循以下四步开发流水线**：

```
[Step 1: 协议先行]   修改 packages/protocol/src/ (Schema / RPC 定义)
        │
[Step 2: 驱动与核心] 修改 packages/daemon/ 或 packages/core/ 实现逻辑
        │
[Step 3: 前端交互]   修改 packages/web/src/ 接入状态与 UI 渲染
        │
[Step 4: 静态门禁]   运行 pnpm typecheck && pnpm test
```

### 规范细则
* **严禁越级调用**：前端页面严禁直接越过 Core 访问底层文件系统；所有系统级操作必须封装为 JSON-RPC 2.0 方法。
* **状态与模型联动准则**：UI 选项栏必须优先以当前选定 Agent 的动态 Catalog 为准，切忌直接信任历史流中的旧 `state` 帧（防止跨 Agent 状态污染）。
* **文案风格准则**：坚持简单朴素、直白易懂的工程化命名（如“并发提问”、“多轮讨论”），严禁引入空洞浮夸的修饰词。

---

## 6. 未来演进：多节点组网与插件化架构构想

### 6.1 多节点互通设计 (Multi-Node Conclave Mesh)
* **节点定位**：每个物理机运行一个轻量 Conclave Node（管理本地文件、worktree、本地 GPU 和已装 Agent）。
* **拓扑模式**：通过 WebSocket over TLS 或 P2P（Tailscale / WireGuard）建立连接；节点向 Hub 注册能力清单（如机器 A 拥有 64 核与本地 Antigravity，机器 B 拥有 Claude Code 账号）。
* **跨机任务调度**：Hub 可将架构拆解分发至机器 B，将重型编译/训练通过 RPC 委派至机器 A，代码通过 Git Remote 分支无缝对接。

### 6.2 彻底解耦的插件化体系 (Plugin Architecture)
* **Agent 适配器插件**：将各类 Agent 驱动抽取为符合标准规范的 npm 插件，放置于 `~/.conclave/plugins/agents/` 即可动态加载，新增 Agent 无需主仓发版。
* **能力/工具插件 (MCP)**：全面拥抱标准 MCP（Model Context Protocol），本地调试、数据库交互、ADB 自动化等工具均以 MCP Server 方式热插拔注入。
* **工作流插件 (Workflow DAG)**：将并发问答、结对评审、小队流水线抽象为声明式 DAG，支持用户自定义编排多 Agent 协作网络。

---

## 7. Conclave Core 核心子系统剖析、升级时机与维护测试指南

### 7.1 Core 核心子系统职责图谱
Core 是整个系统的状态中枢与业务编排大脑，包含五大关键子系统：
1. **会话与状态机 (`ConversationService` + `ConversationStore`)**：
   * 负责 Stage（Agent 阶段）生命周期、Items 事件流落盘、`received_sequence` 序列号对齐、断点续传、会话分叉与软归档。
2. **上下文与用量引擎 (`QuotaService` + `ContextRing` + `Compaction`)**：
   * 负责多模型 Token 上限测算、用量恢复节奏预警（`quota-pace`）、触发滑动窗口压缩与上下文截断。
3. **任务与隔离调度器 (`TaskService` + `WorktreeService` + `SquadService`)**：
   * 负责独立 Git worktree 建立/清理、任务依赖拓扑（DAG）、研发小队串并行调度与代码合并门禁。
4. **讨论与群体智能仲裁器 (`DiscussionService`)**：
   * 负责并发提问（Fan-out）广播分发、多轮辩论交叉质询与主持人共识总结。
5. **跨进程与外部通信中枢 (`CoreServer` + `DaemonClient`)**：
   * 提供 WebSocket JSON-RPC 2.0 服务，处理系统事件广播、长连接保活与 IPC Domain Socket 转发。

### 7.2 Core 何时需要升级重构？（升级触发时机）
* **编排模式演进**：引入新的人机/机机协作范式（如支持复杂的有向无环图工作流、动态队长竞选机制、跨机多节点路由）。
* **上下文技术迭代**：大模型上下文窗口跃迁（如百万级 Token），需要引入基于语义索引、向量检索或本地小模型的智能上下文修剪与分层记忆（Hierarchical Memory）。
* **工作区隔离拓展**：从单纯的本地 Git Worktree 拓展到 Docker 容器隔离、WSL 子系统或远程 SSH 容器环境。
* **数据库持久化升级**：SQLite Schema 扩展（新增调度字段、分布式节点 ID、任务执行回溯数据等），需要设计向下兼容的增量迁移。
* **Agent 交互范式剧变**：上游主流 Agent 全面转向持久守护进程或深层多智能体自组织调用。

### 7.3 Core 更新、测试与维护标准流程
1. **参考依据**：
   * **数据模型与契约**：以 `packages/protocol/src/` 为基准，不得直接破坏已持久化的 SQLite 结构与 WebSocket 事件名。
   * **安全准则**：Git worktree 清理前必须校验 `hasUncommittedChanges` 和独有提交，绝不替用户硬删未保存代码；系统命令执行严禁拼接未经校验的 Shell 字符串。
2. **测试与回归验证流程**：
   * **类型检查**：`pnpm typecheck`（保证 0 报错）。
   * **单元测试与状态机验证**：运行 `pnpm test`（Vitest），针对 Core 的状态流转、断点续传、Worktree 冲突处理进行单测覆盖。
   * **无界面端到端冒烟验证**：通过无头脚本或 Playwright 模拟用户新建任务、发起会话并接收流式输出，确保 WebSocket 链路稳定。
