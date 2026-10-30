<div align="center">

# Conclave

**轻量纯 Web 架构的多 Agent 本机协同工作台**

Claude Code · Codex · Antigravity · Pi · OpenCode · Cursor · DeepSeek Harness · ZCode · Kimi · Gemini

额度监控 · 并发提问对比 · 多轮讨论 · 任务小队 · 独立 Worktree 隔离

[![Version](https://img.shields.io/badge/version-0.22.0--web-blue)](CHANGELOG.md)
![Platform](https://img.shields.io/badge/platform-Linux%20%C2%B7%20macOS%20%C2%B7%20Windows-green)
![Agents](https://img.shields.io/badge/agents-10%20supported-8A2BE2)
![Architecture](https://img.shields.io/badge/architecture-Node%20Daemon%20%2B%20Core%20%2B%20Web-orange)

[快速开始](#快速开始) · [核心能力](#核心能力) · [架构设计](#架构设计) · [支持的-agent](#支持的-agent) · [快捷键](#快捷键) · [更新日志](CHANGELOG.md)

</div>

---

## 为什么使用 Conclave

Conclave 直接驱动你在本机装好、登录好的各 Agent CLI，配置与登录凭据完全沿用本机环境，无需重新配置 API Key。

* **告别窗口间搬运**：支持跨 Agent 移交聊天记录、主 Agent 委派子任务，并在会话中自动汇总结论。
* **并发提问横向对比**：同一问题同时发给多个 Agent，流式并排输出，快速对比方案优劣。
* **多轮讨论与互审**：支持多个 Agent 共同参与议题讨论，分轮交叉质询与补充，最后汇总共识。
* **独立 Worktree 隔离**：每个任务分配独立的 Git worktree，多 Agent 并行开发互不干扰代码库。
* **额度用量实时把控**：底部状态栏直观展示各 Agent 的使用量、额度重置窗口与节奏预警。
* **纯 Web 跨平台运行**：移除厚重的桌面外壳，基于轻量 Node.js 后台 + 纯浏览器前端，Linux / macOS / Windows 均可秒级启动并流畅运行。

---

## 核心能力

### 1. 并发提问与多轮讨论
- **并发提问**：点选参与的 Agent，一次输入任务要求，各 Agent 同时独立作答，分屏横向对比。
- **多轮讨论**：让多个 Agent 在同一话题下开展多轮交互，互相审查论点，由指定主持人汇总共识与分歧。

### 2. 研发小队（Squad）与任务委派
- 为队长、开发和评审配置不同的外部 Agent、模型与职责。
- 队长确认计划后，安排成员在独立的 worktree 中协同推进：只读分析并行，代码修改串行并自动确认。

### 3. 会话上下文无缝移交
- 在当前会话中随时切换执行的 Agent，聊天记录与上下文自动传递给新 Agent 继续执行，无需手动复制粘贴。

### 4. 额度感知与用量监控
- 常驻底部状态栏监控各 Agent CLI 的使用用量与恢复时间，并在额度紧张或即将重置时给出建议。

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
  [Claude Code] [Codex] [Antigravity] [Pi] [OpenCode] [Cursor] ...
```

* **`packages/protocol`**：统一协议规范与 TypeScript / Zod 类型定义（Task, Conversation, RPC, Quota 算法等）。
* **`packages/daemon`**：轻量级后台进程宿主，稳定托管所有 Agent CLI 的进程管道与 node-pty 会话，核心服务或前端刷新均不会导致 Agent 断连。
* **`packages/core`**：核心业务调度枢纽，提供 SQLite 持久化、Git worktree 生命周期管理、任务编排，并通过静态 HTTP 和 WebSocket JSON-RPC 服务对接前端。
* **`packages/web`**：纯前端工作台界面，单页面应用，支持浅色 / 深色主题，集成富文本终端、差异对比视图与快捷交互。

---

## 支持的 Agent

Conclave 深度适配主流的本机编程 Agent CLI：

| Agent | 接入机制 | 权限与运行模式 | 任务协同 | 会话移交 |
|---|---|---|:---:|:---:|
| **Claude Code** | `claude -p`（stream-json） | 逐项确认 · 自动接受编辑 · 规划模式 | ✓ | ✓ |
| **Codex** | `codex app-server` | 逐项确认 · 自动 · 规划 · 只读 | ✓ | ✓ |
| **Antigravity** | 本机 Antigravity CLI / ACP 驱动 | 默认 · 自动编辑 | ✓ | ✓ |
| **Pi** | `pi --mode rpc` | 默认 · 自动 · 规划 · 只读 | ✓ | ✓ |
| **OpenCode** | `opencode acp` | Build · 自动 · Plan · 只读 | ✓ | ✓ |
| **Cursor** | `cursor-agent acp` | Agent · Plan · Ask | ✓ | ✓ |
| **DeepSeek Harness** | `dsh --profile conclave` | 默认 · 自动 · 规划 · 只读 | ✓ | ✓ |
| **ZCode** | `zcode app-server` | 修改前询问 · 自由编辑 · 规划 · 只读 | ✓ | ✓ |
| **Kimi Code** | `kimi acp` | Default · Plan · Auto | ✓ | ✓ |
| **Gemini CLI** | `gemini --acp` | Default · Auto Edit · Plan | ✓ | ✓ |

---

## 快速开始

### 运行环境
- Node.js ≥ 22.13
- pnpm ≥ 10.0
- 本机已安装并登录至少一个上述支持的 Agent CLI

### 安装与启动

1. **克隆代码仓库**：
   ```bash
   git clone https://github.com/dengjzy/Conclave.git
   cd conclave
   ```

2. **安装依赖**：
   ```bash
   pnpm install
   ```

3. **构建所有模块**：
   ```bash
   pnpm build
   ```

4. **启动服务**：
   ```bash
   pnpm start
   # 或使用开发模式实时编译：
   pnpm dev
   ```

5. **打开浏览器**：
   访问固定本地入口：`http://127.0.0.1:43551/conclave`（支持局域网设备直接访问控制台输出的局域网 IP 入口 `http://<LAN_IP>:43551/conclave`）。

---

## 快捷键

| 快捷键 | 功能说明 |
|---|---|
| <kbd>Alt</kbd> <kbd>N</kbd> | 新建任务对话框 |
| <kbd>Ctrl</kbd> <kbd>`</kbd> | 打开 / 关闭内置终端面板 |
| <kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>`</kbd> | 打开 / 关闭内置浏览器面板 |
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
