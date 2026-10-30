<div align="center">

# Conclave

**Lightweight, Pure-Web Multi-Agent Collaborative Workbench**

Claude Code · Codex · Antigravity · Pi · OpenCode · Cursor · DeepSeek Harness · ZCode · Kimi · Gemini

Quota Telemetry · Concurrent Fan-out · Multi-turn Debates · Agent Squads · Automations & Scheduled Runs · Isolated Worktrees

[![Version](https://img.shields.io/badge/version-0.0.1--web-blue)](CHANGELOG.md)
![Platform](https://img.shields.io/badge/platform-Linux%20%C2%B7%20macOS%20%C2%B7%20Windows-green)
![Agents](https://img.shields.io/badge/agents-10%20supported-8A2BE2)
![Architecture](https://img.shields.io/badge/architecture-Node%20Daemon%20%2B%20Core%20%2B%20Web-orange)

[Quick Start](#quick-start) · [Core Capabilities](#core-capabilities) · [Architecture](#architecture) · [Supported Agents](#supported-agents) · [Shortcuts](#shortcuts) · [Changelog](CHANGELOG.md)

</div>

---

## Why Conclave

Conclave directly drives your locally installed and authenticated Agent CLIs. Configuration and credentials remain seamlessly intact without re-authenticating API keys.

* **No More Copy-Pasting**: Seamlessly hand off conversations across agents, delegate subtasks from a lead agent, and aggregate conclusions automatically.
* **Concurrent Questioning & Comparison**: Broadcast the same prompt to multiple agents simultaneously and inspect real-time streaming answers side-by-side.
* **Multi-Turn Discussions**: Coordinate multiple agents in a structured topic discussion, cross-reviewing proposals and synthesizing consensus.
* **Isolated Git Worktrees**: Every task operates within its own Git worktree, preventing agents from causing branch conflicts.
* **Real-time Quota Telemetry**: The status bar visualizes agent token usage, reset schedules, and rate warnings.
* **Automations & Scheduled Tasks**: Schedule recurring routines (Cron syntax) or one-off reservations with automated queuing and telemetry.
* **Pure Web & Cross-Platform**: Stripped of heavy Electron desktop wrappers, Conclave runs efficiently via a lightweight Node daemon and pure Web UI on Linux, macOS, and Windows.

---

## Core Capabilities

### 1. Concurrent Questioning & Multi-Turn Debates
- **Concurrent Fan-out**: Select multiple agents and broadcast prompts simultaneously for side-by-side comparative review.
- **Multi-Turn Discussions**: Coordinate agents in multi-round structured topic debates, cross-reviewing arguments with an assigned host synthesizing consensus.

### 2. Engineering Squads & Task Delegation
- Configure dedicated agents, models, and roles for Team Lead, Developers, and Reviewers.
- After the Lead approves the plan, assign members to work concurrently in isolated worktrees: read-only analysis in parallel, serialized code editing with automated approvals.

### 3. Contextual Conversation Handoff
- Switch between execution agents within any ongoing conversation; full context and message history transfer smoothly without copy-pasting.

### 4. Quota Telemetry & Rate Pacing
- Real-time status bar monitoring token usage and reset windows for all agent CLIs, offering proactive warnings before hitting rate limits.

### 5. Automations & Scheduled Runs
- **Recurring & One-Off Schedules**: Set up recurring routines (hourly/daily/custom Cron expressions) or one-shot reservations to trigger agents for routine inspections or maintenance tasks.
- **Queue & History Telemetry**: Track real-time execution queues, historical statuses, and execution logs with full traceability.

---

## Architecture

Conclave adopts a modern decoupled multi-process architecture:

```
┌────────────────────────────────────────────────────────┐
│             Web UI (packages/web)                      │
│      React 19 + Vite + xterm.js + CodeMirror 6         │
│     (Accessible via any modern browser on any OS)      │
└───────────────────────────┬────────────────────────────┘
                            │ WebSocket (JSON-RPC 2.0)
                            ▼
┌────────────────────────────────────────────────────────┐
│            Core Engine (packages/core)                 │
│   SQLite · Git Worktrees · Task Dispatcher · Static HTTP │
└───────────────────────────┬────────────────────────────┘
                            │ IPC Socket (Node Socket)
                            ▼
┌────────────────────────────────────────────────────────┐
│           Process Host (packages/daemon)               │
│     node-pty Terminal Host · Agent stdio Management    │
└───────────────────────────┬────────────────────────────┘
                            │ CLI / ACP / stdio
                            ▼
  [Claude Code] [Codex] [Antigravity] [Pi] [OpenCode] [Cursor] ...
```

* **`packages/protocol`**: Shared protocol definitions, Zod schemas, and TypeScript interfaces (Tasks, Conversations, JSON-RPC, Quota pacing).
* **`packages/daemon`**: Robust Node.js process supervisor managing agent stdio pipes and node-pty terminal sessions across restarts.
* **`packages/core`**: SQLite storage, Git worktree orchestration, task pipelines, static asset delivery, and WebSocket JSON-RPC endpoints.
* **`packages/web`**: Responsive browser application with rich terminal, diff views, and multi-agent debate stages.

---

## Supported Agents

Conclave deeply adapts to popular local coding agent CLIs:

| Agent | Connection | Permissions & Modes | Squads | Handoff |
|---|---|---|:---:|:---:|
| **Claude Code** | `claude -p` (stream-json) | Accept Edits · Plan Mode · Ask Before Edit | ✓ | ✓ |
| **Codex** | `codex app-server` | Auto · Plan · Read Only | ✓ | ✓ |
| **Antigravity** | Antigravity CLI / ACP Server | Default · Auto Edit · Bypass Mode | ✓ | ✓ |
| **Pi** | `pi --mode rpc` | Default · Auto · Plan · Read Only | ✓ | ✓ |
| **OpenCode** | `opencode acp` | Build · Auto · Plan · Read Only | ✓ | ✓ |
| **Cursor** | `cursor-agent acp` | Agent · Plan · Ask | ✓ | ✓ |
| **DeepSeek Harness** | `dsh --profile conclave` | Default · Auto · Plan · Read Only | ✓ | ✓ |
| **ZCode** | `zcode app-server` | Ask Before Edit · Autonomous · Plan | ✓ | ✓ |
| **Kimi Code** | `kimi acp` | Default · Plan · Auto | ✓ | ✓ |
| **Gemini CLI** | `gemini --acp` | Default · Auto Edit · Plan | ✓ | ✓ |

---

## Quick Start

### Prerequisites
- Node.js ≥ 22.13
- pnpm ≥ 10.0
- At least one supported agent CLI installed and authenticated

### Setup

1. **Clone repository**:
   ```bash
   git clone https://github.com/dengjzy/Conclave.git
   cd conclave
   ```

2. **Install dependencies**:
   ```bash
   pnpm install
   ```

3. **Build modules**:
   ```bash
   pnpm build
   ```

4. **Start service**:
   ```bash
   pnpm start
   # Or run in development mode:
   pnpm dev
   ```

5. **Open browser**:
   Access the web interface at `http://127.0.0.1:43551/conclave` (or via LAN at `http://<LAN_IP>:43551/conclave` as displayed in the console output).

---

## Shortcuts

| Shortcut | Description |
|---|---|
| <kbd>Alt</kbd> <kbd>N</kbd> | New task dialog |
| <kbd>Ctrl</kbd> <kbd>`</kbd> | Toggle terminal panel |
| <kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>`</kbd> | Toggle browser panel |
| <kbd>Alt</kbd> <kbd>Shift</kbd> <kbd>E</kbd> | Toggle file explorer |
| <kbd>Ctrl</kbd> <kbd>P</kbd> | Quick file switch |
| <kbd>Ctrl</kbd> <kbd>,</kbd> | Open settings |
| <kbd>Ctrl</kbd> <kbd>F</kbd> | Search within chat |
| <kbd>Enter</kbd> | Send message (queues if agent is busy) |
| <kbd>Shift</kbd> + <kbd>Enter</kbd> | Newline |
| <kbd>Esc</kbd> | Interrupt current turn / dismiss dialogs |

---

## Local-First & Data Security

- **Fully Localized**: All conversations, task histories, and worktrees are stored locally under `~/.conclave/`, with zero telemetry or cloud sync.
- **Service Binding & Authentication**: Core service supports local and LAN access (listens on `0.0.0.0` by default, configurable via `CONCLAVE_HOST` or `--host`), with all WebSocket and static asset requests protected by session token authentication.
- **Argument Isolation**: Agent CLI commands are spawned directly using parameter arrays, eliminating shell injection vulnerabilities.
- **Traceable Code Safety**: Git worktrees verify uncommitted changes and unique commits prior to cleanup, ensuring work is never lost.

---

## License

[Apache License 2.0](LICENSE)
