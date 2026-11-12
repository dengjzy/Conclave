<div align="center">

# Conclave

**面向任务自主完成与递归自我迭代的多 Agent 本机工作台**

Claude Code · Codex · Antigravity · Pi · OpenCode · Cursor · DeepSeek Harness · ZCode · Kimi · Gemini · Grok · omp

契约驱动自治任务流 · 递归自我迭代（RSI） · 独立 Worktree 隔离 · 额度监控与自动换号 · 自动化与定时调度

![Version](https://img.shields.io/badge/version-0.0.1--web-blue)
![Platform](https://img.shields.io/badge/platform-Linux%20%C2%B7%20macOS%20%C2%B7%20Windows-green)
![Agents](https://img.shields.io/badge/agents-12%20supported-8A2BE2)
![Architecture](https://img.shields.io/badge/architecture-Node%20Daemon%20%2B%20Core%20%2B%20Web-orange)

[快速开始](#快速开始) · [核心能力](#核心能力) · [架构设计](#架构设计) · [支持的-agent](#支持的-agent) · [快捷键](#快捷键)

</div>

---

## 为什么使用 Conclave

Conclave 直接驱动你在本机装好、登录好的各 Agent CLI，配置与登录凭据完全沿用本机环境，无需重新配置 API Key。

* **契约驱动自主闭环**：围绕验收契约（Acceptance Contract）自动完成规划、实现、隐藏盲测、重规划与环境异常挂起，无需人工逐轮盯盘。
* **递归自我迭代（RSI）**：内生化 `EvolutionService` 从可复现问题队列出发，在影子 Worktree 中通过 5 重硬门禁完成自我演进。
* **跨 Agent 无缝移交**：支持在单会话或任务执行中随时切换 Agent，聊天上下文与改动现场完整接续，告别手动复制粘贴。
* **独立 Worktree 隔离**：每个任务分配独立的 Git worktree，多任务并行开发互不干扰代码库。
* **额度用量实时把控**：底部状态栏直观展示各 Agent 的使用量、额度重置窗口、节奏预警与多账号自动切换。
* **自动化与定时任务**：支持配置周期性循环任务（Cron 规则）与单次定时预约，自动入队并跟踪执行。
* **纯 Web 跨平台运行**：移除厚重的桌面外壳，基于轻量 Node.js 后台 + 纯浏览器前端，Linux / macOS / Windows 均可秒级启动并流畅运行。

---

## 核心能力

### 1. 契约驱动的自主任务流（Flow）与环境动态补给（HITL）
- **验收契约（Acceptance Contract）**：明确界定任务的完成定义，内置命令级 checks、脚本哈希防篡改与历史 baseline 过滤。
- **TDD 红检与隐藏盲测（Red-First & Hidden Tests）**：独立只读 Agent 提前编写盲测用例并在起点 commit 验证先红后绿，防止实现 Agent 编写假测试。
- **环境异常动态感知与人机补给（Environment Demand）**：当检测到缺少命令工具、环境变量或 MCP 插件时，自动生成结构化需求并挂起等待，用户补给后一键接续推进。

### 2. 递归自我迭代（RSI, Recursive Self-Improvement）
- **Conclave fixing Conclave**：内置内生化自演化引擎（`EvolutionService`），从可复现改进项出发，在隔离影子 Worktree 中自动完成修复。
- **严苛 5 重门禁拦截**：类型检查、完整单测、构建打包、独立 Headless Core 启动冒烟（`self:smoke`）及单测防删防 skip 审查（`self:tests`），全绿灯后自动推进 `self/evolve` 基线。

### 3. 独立 Worktree 隔离与外部事项接入
- 每个执行中的任务自动在 `~/.conclave/worktrees/` 下创建独立 Git 分支与工作树，支持从 GitHub、Jira、Linear、禅道插件同步外部 Issue 并一键转入任务流。

### 4. 会话上下文无缝移交
- 在当前会话或任务中随时切换执行的 Agent，聊天记录与上下文自动传递给新 Agent 继续执行，无需手动复制粘贴。

### 5. 额度感知与多账号自动续跑
- 常驻底部状态栏监控各 Agent CLI 的使用用量与恢复时间，支持多账号轮换与额度耗尽后自动切号续跑。

### 6. 自动化与定时调度（Automations）
- **周期与预约调度**：支持设置周期性循环任务（按小时/天/自定义 Cron 表达式）或单次预约执行，自动唤起指定 Agent 进行自动化巡检或日常维护。
- **任务队列与执行追踪**：实时展示当前排队队列、历史执行状态及详情日志，任务完成或出错均有记录可查。

---

## 架构设计

Conclave 采用现代前后端解耦与多进程隔离架构：

```
┌────────────────────────────────────────────────────────┐
│              Web 前端 (packages/web)                    │
│      React 19 + Vite + xterm.js + CodeMirror 6         │
│         (直接在系统浏览器中访问，如 Linux / Mac / Win)         │
└───────────────────────────┬────────────────────────────┘
                            │ WebSocket (JSON-RPC 2.0)
                            ▼
┌────────────────────────────────────────────────────────┐
│             核心服务层 (packages/core)                   │
│   SQLite 存储 · Git Worktree · 任务调度 · HTTP 静态托管  │
└───────────────────────────┬────────────────────────────┘
                            │ IPC Socket (Node Socket)
                            ▼
┌────────────────────────────────────────────────────────┐
│             守护进程层 (packages/daemon)                 │
│      node-pty 终端管理 · Agent stdio 管道 · 进程生命周期   │
└───────────────────────────┬────────────────────────────┘
                            │ CLI / ACP / stdio
                            ▼
  [Claude Code] [Codex] [Antigravity] [Pi] [OpenCode] [Cursor] [Grok] [omp] ...
```

* **`packages/protocol`**：统一协议规范与 TypeScript / Zod 类型定义（Task, Conversation, RPC, Quota 算法等）。
* **`packages/daemon`**：轻量级后台进程宿主，稳定托管所有 Agent CLI 的进程管道与 node-pty 会话，核心服务或前端刷新均不会导致 Agent 断连。
* **`packages/core`**：核心业务调度枢纽，提供 SQLite 持久化、Git worktree 生命周期管理、任务编排，并通过静态 HTTP 和 WebSocket JSON-RPC 服务对接前端。
* **`packages/web`**：纯前端工作台界面，单页面应用，支持浅色 / 深色主题，集成富文本终端、差异对比视图与快捷交互。

### 自治调度与递归演化架构（Autonomous Flow & RSI Engine）

随着大模型自身规划与推理能力越发强劲，Conclave 秉持 **"Thin Harness（极薄框架）"** 哲学，不再对 Agent 实行保姆式微操，而是将平台聚焦于提供**干净隔离的工作区**、**退出码敏感的硬门禁裁判**与**人机环境补给线**：

```
┌────────────────────────────────────────────────────────────────────────┐
│                   Router 路由层 (高层事件调度 & 痛点建模)               │
│      - 任务需求 / Friction 痛点 ──▶ 动态生成针对性 Harness 评测脚本      │
│      - 签署验收契约 (Acceptance Contract: checks / baseline / risk)    │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ 派生独立 Worker (只读分析/并发测试)
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│               Worker 执行层 (基于独立 Worktree 的自治闭环)              │
│                                                                        │
│   ┌────────────────────────────────────────────────────────────────┐   │
│   │                      The Autonomous Loop                       │   │
│   │                                                                │   │
│   │   [Plan/Hypothesis] ──▶ [Implement] ──▶ [Verify Contract]      │   │
│   │          ▲                                     │               │   │
│   │          │ (重规划 Replanner)                  │               │   │
│   │          └────── [逻辑失败 / 轮换 Agent] ◀─────┤               │   │
│   │                                                │               │   │
│   └────────────────────────────────────────────────┼───────────────┘   │
└───────────────────────┬────────────────────────────┼───────────────────┘
                        │                            │
      [环境/依赖/Token阻断]                          │ [5重死硬门禁全绿通过]
                        ▼                            ▼
┌─────────────────────────────────┐        ┌─────────────────────────────┐
│  HITL 环境总线 (Human-in-the-Loop)│        │   RSI 适者生存与自动推进     │
│   - 挂起: waiting_environment    │        │   - 自动提交干净变异代码     │
│   - 抛出: EnvironmentDemand      │        │   - Fast-Forward self/evolve│
│   - 用户: 注入 MCP / 配环境 / 充值│        │   - 痛点归档与演化报告沉淀   │
│   - RPC: flows.supplyEnvironment │        └─────────────────────────────┘
└─────────────────────────────────┘
```

---

## 参考项目与设计哲学

Conclave 的自主任务编排与自进化循环深度吸纳了前沿自治 Agent 系统的核心思想：

1. **[DeepSeek Harness (dsh-superagent-prototype)](https://github.com/deepseek-ai/dsh-superagent-prototype)**
   * **人类注意力瓶颈（Human Attention Bottleneck）**：人类同时盯盘并发上限仅为 3~5 个会话。系统必须保持异步自治，静默执行，唯有阻断（缺环境）或最终交付时才接入人类。
   * **Router 与 Worker 严格解耦**：Router 只做事件监听与任务建模，绝不写代码；Worker 独占干净上下文与独立工作区，用后即焚。
   * **Thin Framework 极薄框架**：模型推理能力越强，框架越应变薄，避免硬编码复杂 Prompt 状态机成为模型的智力枷锁。
2. **[Andrej Karpathy - autoresearch](https://github.com/karpathy/autoresearch)**
   * **受限变异面（Tight Scope）**：严格约束单代修改的文件范围，保证实验可控。
   * **确定性目标函数与严格预算**：以退出码、单测耗时及死时钟作为客观事实检验，排斥主观幻觉。
   * **适者生存与快速剪枝（Survival of the Fittest & Pruning）**：通过则沉淀新基线，失败则无情回滚清除脏现场。
3. **SWE-bench & TDD Red-First 理念**
   * **隐藏测试防欺骗**：由独立只读 Test Author Agent 提前编写盲测用例，并在起点 commit 上验证红检（必须先红），避免实现者写出永真的无效单测。

---

## 支持的 Agent

Conclave 深度适配主流的本机编程 Agent CLI：

| Agent | 接入机制 | 权限与运行模式 | 任务协同 | 会话移交 |
|---|---|---|:---:|:---:|
| **Claude Code** | `claude -p`（stream-json） | 逐项确认 · 自动接受编辑 · 规划模式 | ✓ | ✓ |
| **Codex** | `codex app-server` | 逐项确认 · 自动 · 规划 · 只读 | ✓ | ✓ |
| **Antigravity** | 本机 Antigravity CLI / ACP 驱动 | 默认 · 自动编辑 · 免授权模式（Bypass） | ✓ | ✓ |
| **Pi** | `pi --mode rpc` | 默认 · 自动 · 规划 · 只读 | ✓ | ✓ |
| **OpenCode** | `opencode acp` | Build · 自动 · Plan · 只读 | ✓ | ✓ |
| **Cursor** | `cursor-agent acp` | Agent · Plan · Ask | ✓ | ✓ |
| **DeepSeek Harness** | `dsh --profile conclave` | 默认 · 自动 · 规划 · 只读 | ✓ | ✓ |
| **ZCode** | `zcode app-server` | 修改前询问 · 自由编辑 · 规划 · 只读 | ✓ | ✓ |
| **Kimi Code** | `kimi acp` | Default · Plan · Auto | ✓ | ✓ |
| **Gemini CLI** | `gemini --acp` | Default · Auto Edit · Plan | ✓ | ✓ |
| **Grok** | `grok agent stdio` | Default · Plan · Auto · YOLO (Bypass) | ✓ | ✓ |
| **omp** | `omp acp` | Default（直接改文件，命令前确认） | ✓ | ✓ |

---

## 快速开始

### 运行环境
- Node.js ≥ 22.13
- pnpm ≥ 10.0
- 本机已安装并登录至少一个上述支持的 Agent CLI

### 一键启动

克隆后安装依赖，执行一行 `pnpm start` 即可自动完成前端按需编译、后台守护进程拉起与服务启动：

```bash
git clone https://github.com/dengjzy/Conclave.git
cd conclave
pnpm install
pnpm start
```

服务就绪后，终端会直接输出带鉴权 Token 的可访问链接：
- **本机访问**：`http://127.0.0.1:43551/conclave?token=...`
- **局域网访问**：`http://<LAN_IP>:43551/conclave?token=...`（启动时加 `--host` 参数）

> **说明**：`pnpm start` 内部已集成一体化启动逻辑，会自动检测并按需编译前端、自动在后台拉起 Daemon 守护进程并启动 Core 服务，**无需手动执行 `pnpm build`**。

#### 常用命令与选项

- **局域网 / 手机访问**：`pnpm start -- --host`（允许通过局域网 IP 跨设备访问）
- **启动后自动打开浏览器**：`pnpm start -- --open`
- **查看运行状态**：`pnpm status`（实时查看 Daemon、Core 进程状态及连接入口）
- **停止服务**：`pnpm stop`
- **Agent 健康自检**：`pnpm doctor`（检查各 Agent CLI 连通性）
- **源码开发模式**（仅限修改 Conclave 自身代码时使用）：`pnpm dev`（提供 Vite 热重载前端开发服务器与内核实时编译）

---

## 快捷键

| 快捷键 | 功能说明 |
|---|---|
| <kbd>Alt</kbd> <kbd>N</kbd> | 新建任务对话框 |
| <kbd>Ctrl</kbd> <kbd>`</kbd> | 打开 / 关闭内置终端面板 |
| <kbd>Alt</kbd> <kbd>Shift</kbd> <kbd>E</kbd> | 打开 / 关闭文件管理面板 |
| <kbd>Ctrl</kbd> <kbd>P</kbd> | 快速文件定位与切换 |
| <kbd>Ctrl</kbd> <kbd>,</kbd> | 打开偏好设置 |
| <kbd>Ctrl</kbd> <kbd>F</kbd> | 在当前会话中搜索 |
| <kbd>Enter</kbd> | 发送输入内容（Agent 繁忙时自动排队） |
| <kbd>Shift</kbd> + <kbd>Enter</kbd> | 输入框换行 |
| <kbd>Esc</kbd> | 中断当前回合 / 关闭弹层 |

---

## 本地优先与数据安全

- **完全本地化**：会话、任务记录与 worktree 均保存在本地目录 `~/.conclave/`，无任何云端上报。
- **服务监听与鉴权**：核心服务支持本地及局域网访问（默认监听 `0.0.0.0`，可通过 `CONCLAVE_HOST` 或 `--host` 指定），所有 WebSocket 及静态资源访问均由会话 Token 严格鉴权保护。
- **参数隔离**：Agent 命令行通过参数数组形式直接 Spawn 启动，避免 Shell 注入风险。
- **改动可追溯**：Git worktree 清理前严格校验未提交改动与独有提交，确保工作成果安全无损。

---

## 许可证

[Apache License 2.0](LICENSE)
