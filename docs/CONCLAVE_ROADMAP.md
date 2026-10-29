# Conclave（原 Conclave 纯 Web 化分支）架构改造与演进路线图

> **定位**：纯 Web 跨平台（Linux / macOS / Windows）多 Agent 协同工作台。  
> 抛弃 Electron 桌面壳，保留 daemon + core + protocol 全部精华，并针对“非 Git 原始日志目录会诊”“研发小队强制测试门禁”“本机 agy 直连与引证核验”逐步演进。

---

## 1. 命名方案与目录约定

| 候选名称 | 含义与气质 | 推荐 CLI 命令 | 默认本机工作区路径 |
| :--- | :--- | :--- | :--- |
| **Conclave（首选）** | 意为“枢密院 / 闭门核心议事会”，契合多 Agent 独立盲评、多轮辩论与队长拍板派活 | `conclave` / `ccv` | `/home/swrd/workspace/conclave` |
| **Synod（备选 1）** | 意为“合议庭”，短小精悍，突出跨引擎会诊、质询与共识裁决 | `synod` | `/home/swrd/workspace/synod` |
| **Panoptes（备选 2）** | 意为“百眼巨人 / 全景台”，突出一屏统管五大 CLI 的额度、终端与代码改动 | `panoptes` | `/home/swrd/workspace/panoptes` |
| **Crewbench（备选 3）** | 偏直白工程风，强调研发小队（Squad）与自动化验收流水线 | `crewbench` | `/home/swrd/workspace/crewbench` |

---

## 2. 路径 1：基于 Conclave 的“去 Electron 纯 Web 化”改造方案（Phase 1）

根据 [Conclave 技术架构文档](ARCHITECTURE.md) 与 [AGENTS.md](../AGENTS.md)，core 和 daemon 严格做到零 Electron 依赖。纯浏览器端前端独立为 `packages/web`。

### 2.1 包结构保留与调整对照表

| 模块路径 | 改造策略 | 核心职责与跨平台说明 |
| :--- | :--- | :--- |
| **`packages/protocol`** | 100% 保留（微调扩展） | 唯一类型与 Zod Schema 来源（含 Task、Conversation、群聊、小队、RPC 协议与 quota-pace.ts 额度算法） |
| **`packages/daemon`** | 100% 保留 | 纯 Node 进程宿主，管理所有 Agent 的 stdio 管道与 node-pty 终端，支持 core 或前端重启不断连 |
| **`packages/core`** | 保留并新增 HTTP 静态与鉴权路由 | 负责 SQLite 存储、Git worktree、群聊（DiscussionService）、研发小队（SquadService）与 JSON-RPC 2.0 WebSocket 服务 |
| **`packages/web`** | 新建（提取自 `packages/desktop/src/renderer`） | 纯 Vite + React + xterm.js + CodeMirror 前端，通过 WebSocket 直连 core，支持任意系统浏览器访问 |
| **`packages/desktop`** | 归档或移除 | 彻底抛弃 electron、electron-builder、WebContentsView、macOS 签名脚本、Windows NSIS 安装包与桌面宠物 |

### 2.2 去 Electron 化的 5 个具体替换点

1. **WebSocket 鉴权与 Token 桥接替换 Electron Preload**
   - 原实现：Electron 主进程读取 `~/.conclave/core.json` 中的端口和 Token，通过 Preload 脚本注入渲染进程。
   - Web 化改造：在 `packages/core` 的 HTTP 服务上增加静态资源托管（指向 `packages/web/dist`）和 `/api/auth/session` 接口。本机启动时终端打印带一次性登录 Token 的 URL（如 `http://127.0.0.1:18790/?token=<token>`），前端读取后写入 localStorage，随后建立 JSON-RPC 2.0 over WebSocket 连接。原 `resolveCoreEndpoint()` 本身已支持 `?port=&token=` 参数。
2. **Web 目录选择器替换系统原生文件对话框**
   - 原实现：调用 Electron `dialog.showOpenDialog` 选择本地项目文件夹。
   - Web 化改造：在 `packages/protocol` 和 `packages/core/src/rpc-handlers.ts` 中新增 `fs.listDirectories` 与 `fs.validatePath` 两个 RPC 方法，前端提供一个支持路径直接粘贴（如 `/home/swrd/workspace/工作台` 或 `/home/swrd/temp/pic/csr fail`）、Tab 路径补全与目录树点击的模态框。
3. **浏览器原生通知替换操作系统签名通知**
   - 原实现：依赖 macOS codesign 签名与 Electron Notification、Dock 角标。
   - Web 化改造：封装 `web-notifications.ts`，使用浏览器标准 `Notification.requestPermission()`、Web Audio API 提示音，以及动态修改 `<title>`（如 `(2 待处理) Conclave`）和 Favicon 徽章。
4. **外部链接与编辑器跳转适配 Linux / Web**
   - 原实现：调用 Electron `shell.openExternal` 和 macOS 专用的应用列表。
   - Web 化改造：网页链接直接 `<a target="_blank" rel="noopener">` 打开；“在终端中打开”直接切换到工作台右侧内置的 xterm.js 终端面板；“在 VS Code 中打开”支持通过 `vscode://file/<path>:<line>` 协议或由 core 调用本机 `code -g <path>:<line>`。
5. **瘦身构建与启动脚本**
   - 修改根目录 `package.json`，将 `pnpm dev` 改为并发启动 `@conclave/daemon`、`@conclave/core` 和 `@conclave/web`（Vite 开发服务器），移除 electron-winstaller 等平台耦合包。

---

## 3. 待办优化清单（Phase 2 ~ Phase 4 逐步迭代记录）

### Phase 2：破除目录限制与增强日志/文档会诊能力（已完成 ✅）
- [x] **[OPT-01] 解锁“非 Git 任意文件夹”的群聊与多人并行分析**
  - **落地实现**：在 `packages/core/src/workspace.ts` 中放宽多项目 Git 强校验，任意本地目录（如 `/home/swrd/temp/pic/csr fail`）均自动就地作为工作区绑定，支持直接流式读写与大日志会诊。
- [x] **[OPT-02] 增加“一句话多选广播（Quick Fan-out）”快捷栏**
  - **落地实现**：在 `packages/web/src/components/DiscussionDraft.tsx` 与 `styles.css` 中增加“一键广播会诊”与“闭门议事辩论”双模式，提供多 Agent 一键点选 Chips（Codex、Antigravity、Claude、Pi 等），支持 1 轮并发广播与分屏多列网格横向实时对比。
- [x] **[OPT-03] 增强本机 agy（Antigravity CLI）直连适配器**
  - **落地实现**：在 `packages/core/src/agents/antigravity/antigravity-adapter.ts` 与 `antigravity-runtime.ts` 中新增本机 `~/.local/bin/agy` 直连探测与适配，免去 336MB 运行时下载，已与 Codex、Claude Code、Pi 一同达到 `status: ok`。

### Phase 3：强化“研发小队”工程闭环与测试验收门禁
- [ ] **[OPT-04] 为“研发小队（Squad）”补齐强制 check 验收脚本门禁**
  - **痛点**：[ARCHITECTURE.md](ARCHITECTURE.md) 第 6 节明确写明“小队任务暂不运行 check”，导致队长调 `conclave_squad_finish` 时没有强制跑测试脚本。
  - **改造点**：吸取 [Claw Orchestrator](https://github.com/Enderfga/claw-orchestrator) 的 Acceptance Contract 设计，当小队队长调用 `conclave_squad_finish` 时，core 自动在任务的 worktree 中执行 `.conclave/project.json` 配置的 check 命令（例如 `./test.sh`），记录真实退出码与耗时：
    - 若退出码为 0，才允许任务流转到 `待验收（review）`；
    - 若退出码非 0 或超时（可针对卡住的测试配置 `checkTimeoutSec`），自动拦截提交并将报错末尾返回给队长，要求继续派发修复。
- [ ] **[OPT-05] 小队内置“交叉 Review（Cross-Review）”标准工序**
  - **痛点**：希望固定实现“A 写代码 → B 挑刺 Review → C 跑测试验证”的流水线，而不只是完全靠队长临场自由发挥。
  - **改造点**：在 SquadService 中增加可选的小队工序模板（Workflow Policy）：当开发成员完成代码修改后，系统自动将该成员产生的 git diff 派发给指定的 Reviewer 成员（使用只读权限 + 独立异构引擎，例如 Codex 写完强制交由 Antigravity 和 Pi 审查），汇总通过后才释放测试与提交权限。

### Phase 4：事实核查、上下文护栏与体验打磨
- [ ] **[OPT-06] 引入 Grounder（代码行号与日志引证核验员）机制**
  - **痛点**：多 Agent 辩论架构或分析大日志时，个别模型容易“脑补”不存在的函数名、配置项或行号。
  - **改造点**：参考 [cc-debate](https://github.com/STRML/cc-debate) 的 Grounder 角色，在群聊或小队评审结束前，支持用轻量快速模型（或确定性正则脚本）提取发言中引用的 `文件路径:行号` 与关键日志片段，自动比对磁盘原文件并标记 ✅ 已核实 或 ⚠️ 原文不符。
- [ ] **[OPT-07] 测试环境与忽略文件（.venv / node_modules）快速映射**
  - **痛点**：新建 worktree 或 clone 会丢失被 Git 忽略的 `backend/.venv` 和 `frontend/node_modules`，每次重装依赖既慢又占磁盘。
  - **改造点**：扩展 `.conclave/project.json` 的 copy 配置，新增 symlink（软链只读共享依赖目录，如 `frontend/node_modules`、`backend/.venv`）与 copyOnWrite（使用 `cp -a --reflink=auto` 零拷贝克隆），让新 worktree 1 秒内具备完整可跑 `./test.sh` 的环境，同时隔离测试数据库文件。
- [ ] **[OPT-08] 敏感数据脱敏与外发白名单提示**
  - **痛点**：分析包含内网 IP、设备序列号或密钥的 bugreport 时，希望能直观看到哪些内容会发往哪个模型服务商。
  - **改造点**：在群聊和会话发送前增加可选的本地正则脱敏器（自动掩码 Token/私钥，或提示当前勾选的 Agent 分别对应 OpenAI / Google / DeepSeek 等哪些远端服务）。

---

## 4. 实施落地步骤

1. 本机工作区建立在 `/home/swrd/workspace/conclave`，仓库为 `https://github.com/dengjzy/Conclave.git`，本地主分支为 `main-web`。
2. 优先执行 Phase 1：将 `packages/desktop/src/renderer` 迁移为独立的纯 Web 包 `packages/web`，在 `packages/core` 中增加静态资源和 HTTP 访问支持。
3. 验证端到端跑通后，以此前实测的两大场景作为标杆案例推进：
   - 场景 A：`/home/swrd/workspace/工作台/docs` 项目构思与多 Agent 协同 Review（验证 Squad 与 Cross-Review）；
   - 场景 B：`/home/swrd/temp/pic/csr fail` 离线大日志会诊（验证 OPT-01 非 Git 目录会诊与 OPT-02 Fan-out）。
