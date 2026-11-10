# 多 Agent 协作模式：现状、统一抽象与路线图

> 分析对象是 Conclave 当前的多 Agent cowork 能力。结论来自仓库里的 `DiscussionService`、`SquadService`、`TaskService`、`WorktreeService`、`WorktreeSetup` 和 Conclave MCP 工具，不是另起一套设想。文中的工期是量级估计，不是承诺。

## 0. 结论

- 你列的 6 个基础模式里，**Fanout、Debate、Squad 已经存在**；真正缺的是 **Pipeline、Critic、Tournament**。
- 5 个进阶方向里，**TDD 闭环、人机门禁**已经有七成零件；**Artifact DAG、Blackboard、MoA Router** 缺的是同一层东西：**一次编排运行（Flow）不是一等公民，产物（Artifact）也不是一等公民**。
- 不建议再加 6 套 service。建议加**一个 Flow 引擎**：节点、边、产物、门禁、工作区租约、事实板；把 11 种模式变成 **recipe（预置图 + 参数）**，而不是 11 个功能。
- 如果只做一件事：**先给 Squad 加 check 门禁和固定 Review 工序**。它不需要新引擎，直接把团队从“靠队长自觉”变成“有质量门禁”，是投入产出比最高的一步。
- “额度不限量”解除的是 token 约束，不是**进程并发（默认总共 20、每款 Agent 6）、worktree 磁盘、人的审批带宽、上下文窗口**的约束。Debate 和 Tournament 的真实瓶颈在这四个，不在额度。

## 1. 现状盘点

| 能力 | 代码位置 | 已经做到 | 关键边界 |
|---|---|---|---|
| 并发提问 Fanout | `DiscussionService`，`maxRounds = 1` | 2–5 个成员同时独立回答，横向对比；总结可关 | 成员只读；一轮结束即完成 |
| 多轮讨论 Debate | `DiscussionService`，`1–5` 轮 | 每轮只发别人新发言；点名回答；主持人总结；匿名互评；立场“维持/已修改” | 成员只读；没有独立裁判和证据核验 |
| 研发小队 Squad | `SquadService` + `conclave_squad_*` | 队长只读协调，2–5 名成员，按需派活，成员共享任务 worktree，开发串行、只读并行，结果回到队长，队长提交后进待验收 | 派活没有依赖边；完成时不跑 `check`；工序靠队长临场发挥 |
| 任务与 worktree | `TaskService`、`WorktreeService` | 每个任务每个仓库独立 worktree、分支、依赖、规划、验收起点、check | 同一仓库只有一份 worktree；worktree 从不自动删除 |
| 单层委派 | `AgentProfileService`、`agentCalls.*` | 主会话可委派一个只读/开发子会话，结果回传，重启恢复 | 只允许一层；开发委派串行 |
| Conclave MCP | `mcp-*.ts` | 终端、浏览器、待办、小队、委派、历史、管理工具 | 工具按会话范围和权限模式裁剪 |

几个会直接影响模式设计的硬约束：

- **并发**：默认同时 20 个 Agent 进程、每款 Agent 6 个；聊天、任务、规划共用额度，等审批的也占额度。额度满时排队，不消耗失败重试。
- **委派只有一层**：不能让子 Agent 再无限往下派。这是对的，但意味着“复杂编排”必须由 core 驱动，而不是靠 Agent 递归。
- **worktree 不自动删**：Tournament 的 N 个尝试，以及采用隔离工作区的 Pipeline 阶段，都会留下目录，必须显式清理。
- **群聊/小队成员数是 5**：不是技术上限，是产品上限；Tournament 的“参赛者”应另算，不要硬塞进群聊。

## 2. 为什么现在“感觉只有聊天和讨论”

不是 UI 少几个按钮，而是三个结构性问题。

### 2.1 会话是执行单元，运行不是

Discussion 和 Squad 各自造了一套编排：自己的表、自己的 `serially`、自己的 `tick/advance/reconcile`、自己的状态机、自己的 UI。再加 Pipeline 就要再加一套，加 Tournament 再加一套。每套都要重新回答“重启怎么办、失败怎么办、审批怎么办、并发满了怎么办”。

聊天之所以是唯一通用界面，是因为**只有会话有完整的生命周期**：启动、流式输出、审批、提问、中断、恢复、移交。其他模式都是在这个生命周期外面又包了一层，却没有一个统一的“运行”对象。

### 2.2 产物不是一等公民

阶段之间传的是 prompt、聊天记录和 handoff 文件。没有 artifact id、没有 schema、没有版本、没有“这个产物被谁消费过”。于是：

- Pipeline 的“无损移交”只能靠把聊天记录再讲一遍，隐藏推理和原生会话状态根本交不过去。
- Critic 拿不到“这次到底改了什么”的结构化 diff，只能读聊天，容易被实现者的叙述带偏。
- Tournament 没有统一的“尝试结果”可以比较。
- 动态 DAG 没有“产物已就绪”这个信号，只能靠人点下一步。

### 2.3 门禁挂在 Agent 回合上，不在运行状态里

审批是 `conversation.chat.request`，计划是 `task.plan`，验收是 `task.status`。这些都不是“运行暂停在某个节点，等人或等测试”的持久状态。所以 Critic、TDD、HITL 都只能靠 prompt 自律：队长“应该”先 review，Agent“应该”跑测试，人“应该”在合并前看一眼。没有强制力。

### 2.4 产品入口也强化了这个印象

“新会话”只有单聊、并发提问、多轮讨论三个入口；Squad 藏在任务里；Pipeline、Critic、Tournament 没有入口。引擎和入口都指向“聊天”，用户自然觉得只有聊天。

## 3. 统一抽象：Flow

### 3.1 一句话

**Recipe 编译成 Flow；Flow 是一张有向无环图；节点是 Agent、检查、门禁、合并或路由；边是产物依赖或条件；core 负责调度、持久化、恢复和预算。**

```
Recipe（不可变模板 + 参数）
   │ compile
   ▼
Flow（一次运行，冻结 recipe / roster / budget / workspace plan）
   ├─ Node       agent | check | gate | merge | router
   ├─ Edge       artifact 依赖（数据边） / pass-fail 条件（控制边）
   ├─ Artifact   diff | json | report | check-result（内容寻址）
   ├─ Fact       追加式事实板（观点、决定、证据、未决问题）
   └─ Lease      shared-worktree | isolated-attempt | read-only
```

### 3.2 原语

| 原语 | 含义 | 关键规则 |
|---|---|---|
| **Recipe** | 预置图模板：`pipeline`、`critic`、`tdd`、`tournament`、`squad` | 版本化；参数有 JSON Schema；编译结果存快照 |
| **Flow** | 一次运行 | 冻结成员、模型、权限、预算；可暂停、恢复、取消；重启可对账 |
| **Node** | 最小执行单元 | 有稳定 id；同一节点最多一个活跃回合；输入输出都有契约 |
| **Edge** | 节点间关系 | 数据边只在产物发布且校验通过后触发；控制边按 `done/failed/verdict` 走 |
| **Artifact** | 节点产物 | 内容寻址、只追加；大文件放磁盘，元数据进 SQLite；跨节点传递只给路径和摘要 |
| **Fact** | 事实板条目 | 只追加；有作者、证据、状态（提议/接受/争议）、`supersedes`；读取给“当前接受视图” |
| **Gate** | 门禁 | 持久化在 Flow 上，不依赖 Agent 进程；等人、等测试、等审批都算 |
| **Lease** | 工作区租约 | 同一 worktree 同时只有一个写者；只读者可并行；隔离尝试各自一份 |
| **Budget** | 硬预算 | 最大节点数、最大并发、最大尝试次数、最长墙钟、最大产物数 |

### 3.3 状态机

```
Flow:   draft ──▶ running ──▶ waiting ──▶ running ──▶ review ──▶ done
                    │            │                        │
                    └── failed ◀─┴── cancelled ◀──────────┘

Node:   pending ──▶ ready ──▶ running ──▶ done | failed | skipped
```

`waiting` 至少要有原因：`capacity`、`dependency`、`gate`、`check`、`approval`。UI 显示“在等什么”，而不是只显示一个转圈。

### 3.4 调度规则

1. **只有 ready 的节点会被派发**：所有数据边产物已发布且校验通过，控制边条件为真。
2. **派发是幂等的**：每个节点用稳定 ref（`flow:<flowId>:<nodeId>`）发消息；重启后先看 `chatPage` 里这个 ref 的回合有没有结束，不重复发。
3. **一个 worktree 同时只有一个写者**：写节点拿租约；只读节点不拿；租约随节点结束释放。
4. **失败不自动重试**：节点失败先落 `failed`，由 recipe 决定“重试 / 换人 / 升级给人 / 终止”。重试要记 `attempt`，不能悄悄重发。
5. **终止条件是所有 sink 节点完成**，然后跑可选的最终 `check`，再进 `review` 或 `task.submitChecked()`。
6. **人随时可以停**：停止会中断当前回合、释放租约、保留产物和 worktree；恢复从 `waiting` 或失败节点继续。

### 3.5 与现有能力的关系

- **Discussion 不动**。它是“对话型”协作，Flow 是“交付型”协作。两者共享 Conversation，但不要互相硬套。
- **Squad 可以先不动，也可以逐步变成 Flow 的一个 recipe**。短期建议保留 Squad，先把它的调度逻辑抽成可复用的 `RunEngine`；长期让 Squad 成为“队长动态扩展”的 recipe。
- **Task 仍是交付锚点**。Flow 挂在任务上，沿用任务的 worktree、分支、依赖、验收和 check；不另造一套交付模型。
- **委派仍是叶子**。Flow 里的 Agent 是执行者，不再往下递归派活；需要更多人手时由 Flow 加节点。

## 4. 逐个模式分析

### 4.1 并发 Fanout（已有，补强）

**现状**：`discussions.create({ maxRounds: 1 })`。成员只读、同时回答、互不可见；`summarize` 可关。UI 已有并排对比。

**缺口**：结果只是并排文本，没有结构化对比维度，也没有“选一个作为后续输入”的动作。

**建议**：给 Fanout 加一个可选的 `compare` 产物：按 recipe 给的维度（方案、风险、改动面、验证方式）让每个成员输出 JSON；core 汇总成表；用户选一个作为 Pipeline 的种子。不要自动选，选择权留给人。

**成本**：0.5 人周。**风险**：低。

### 4.2 辩论 Debate（已有，补强）

**现状**：1–5 轮，每轮只发别人新发言，点名回答，主持人总结，匿名互评，立场标记。

**缺口**：没有独立裁判，主持人是参与者之一；没有证据核验；同模型多实例容易“回声室”。

**建议**：加两件事。第一，**独立裁判**：裁判不参与讨论，只读全部发言和证据，输出“共识/分歧/未决/证据缺口”。第二，**Grounder**：抽取发言里的 `文件:行号` 和日志片段，对照磁盘标记“已核实/原文不符”（路线图 OPT-06 已有）。异构成员优先，同模型多实例只算一次多样性。

**成本**：1 人周。**风险**：辩论会放大自信而不是提高正确率；没有证据核验时不要把它当裁决。

### 4.3 流水线 Pipeline（缺，Flow 的第一个 recipe）

**现状**：任务依赖能串行，handoff 能传可见历史；但没有阶段图、没有产物契约、没有自动触发。

**缺口**：所谓“无损移交”是个过强的承诺。隐藏推理、原生会话状态、工具上下文都交不过去。能做的是**可审计的移交**：任务 brief、上游产物、已做决定、未决问题、验证证据。

**建议**：静态线性图，阶段例：`规格 → 实现 → 自查 → 审查 → 验证`。每个阶段声明输入产物、输出产物、权限、工作区（默认同一 worktree，写者串行）。阶段之间不传聊天记录，只传产物路径和摘要。Claude 这种绑定目录的会话，换阶段就新开更干净，不要把旧会话硬搬。

阶段边界要有 **checkpoint**：一个阶段成功，core 在任务分支上做一个提交（不靠 Agent 自己记得提交）；失败重试时回到上一个 checkpoint。否则在同一个 worktree 里重试，会在脏工作区上叠加半成品，越修越乱。

**成本**：2 人周（含 UI）。**风险**：阶段切得太细会把上下文切碎；建议 3–5 段，段内让 Agent 自己连续做。

### 4.4 主从编排 Squad（已有，补强）

**现状**：这是目前最强的交付型协作。队长只读、成员按需启动、共享 worktree、开发串行、只读并行、结果回队长、队长提交。

**缺口**：派活没有依赖边（只能靠队长口头排序）；`finish` 直接 `task.submit()`，不跑 `check`；没有固定工序，Review 靠队长自觉；队长是 LLM，图是隐式的，不可审计。

**一个必须说清的限制**：Squad 的“并发”只对只读工作成立。开发工作共享同一个任务 worktree，所以同一时间只能有一个写者——这是共享工作区的必然结果，不是实现偷懒。要让多个开发 Worker 真正并行，每个 Worker 需要独立的 attempt worktree 和一次合并，那是 Tournament 的机制，不是 Squad 加个参数就能做到的。

**建议**：先做三件小事，不换引擎：
1. `SquadWork.dependsOn`：派活时可以声明前置工作，core 等前置完成才启动。
2. `SquadRun.workflow`：`free | review | tdd`。`review` 在开发工作完成后自动生成一个只读 Review 工作；`tdd` 自动跑 check，失败回灌给开发。
3. `finish` 前跑项目的 `check`，失败不允提交，把输出末尾交给队长（路线图 OPT-04）。

**成本**：1.5–2 人周。**风险**：低；这是现有代码的增量。

### 4.5 生成-审查 Critic（缺，Squad 工序或 Flow recipe）

**现状**：Squad 可以加一个只读 Review 成员，但队长可以不派、可以派了不看、可以在 Review 没完成时提交。没有 diff 范围的强制输入。

**缺口**：没有 maker–critic 循环、没有 verdict schema、没有“必须引用 diff 里真实存在的文件/行”。

**建议**：Critic 节点只拿四样东西：任务验收标准、`git diff`（相对任务起点）、check 结果、改动文件清单。**不拿** maker 的聊天记录，避免被叙述带偏。输出固定 JSON：

```json
{
  "verdict": "pass | block",
  "blocking": [{ "file": "src/a.ts", "line": 42, "claim": "...", "evidence": "...", "suggestion": "..." }],
  "nonBlocking": [],
  "missingEvidence": []
}
```

core 校验每个 `file` 在 diff 里、`line` 在改动范围内；对不上就降级为 `nonBlocking` 或丢弃。阻塞项回到 maker 修，最多 3 轮；同一问题重复出现就升级给人。Critic 必须和 maker 不同 Agent，最好不同模型家族。

**一个容易忽略的漏洞**：Critic 只能拦“流程的下一步”，拦不住 maker 在节点内部自己 `git commit` / `git push`。如果 maker 有提交权限，“质量守门”就是软的。要让门禁硬起来，提交权要收到 core：maker 只改工作区，Critic 和 check 通过后由 core 提交；或者至少把 `git commit` 纳入审批规则。这个问题不解决，Critic 就只是“事后评论”。

**成本**：2 人周（Squad 工序版 1 人周）。**风险**：Critic 也会幻觉；没有 diff 校验的 Critic 会变成“第二个自信的嘴”。

### 4.6 分支竞速 Tournament（缺）

**现状**：没有多尝试工作区。一个任务一个仓库只有一份 worktree。

**缺口**：N 个独立 worktree/分支、统一评分、盲评、胜者合并、败者保留与清理。

**建议**：每个 attempt 从同一 base 拉一个隔离 worktree（`<task>/attempt-<n>/<project>` 或独立 attempt 记录）。每个 attempt 跑 `实现 → check`，产出 diff 和 check 结果。评分先确定性后主观：check 通过 > 测试通过数 > lint/类型 > diff 大小 > 可选盲评。胜者不自动合并，进人机门禁；败者保留，显式清理。UI 并排 diff + 分数。

**成本**：3–4 人周。**风险**：不是 token，是**环境成本**——N 份 `node_modules`/`.venv`、N 次 setup、N 次测试。路线图 OPT-07（symlink/reflink 共享依赖）是实际前提。没有它，Tournament 会在第三个 attempt 上卡住。

### 4.7 产物驱动的动态 DAG（缺，Flow 的进阶）

**现状**：`task.dependsOn` 是人工的静态 DAG，触发靠人点“开始”。

**缺口**：产物事件、schema 校验、动态 Fork/Join、边界控制。

**建议**：不要让 Agent 直接改图。让一个 planner 节点输出**受约束的扩展提案**：

```json
{
  "nodes": [
    { "key": "api", "role": "backend", "instruction": "...", "needs": [], "workspace": "shared" },
    { "key": "client", "role": "frontend", "instruction": "...", "needs": ["api"], "workspace": "shared" }
  ]
}
```

core 校验：key 唯一、`needs` 无环、深度 ≤ 2、总节点 ≤ 32、role 在白名单、权限不超过父节点。通过才建节点。边只在“产物已发布且 schema 通过”时触发。

**关键**：**发布产物，不监听文件**。文件 mtime 会在半写状态触发、会风暴、会因格式化循环。Agent 把产物写到 staging，调用 `conclave_flow_publish`，core 校验后原子发布并记事件。外部产物（别的仓库的 OpenAPI）用一个 `watch` 节点轮询哈希后发布，仍然走同一条发布路径。

**成本**：4–5 人周（在 Flow 之上）。**风险**：最容易做成“看起来很智能、实际不可复现”的功能；没有预算和 schema 就是灾难。

### 4.8 物理测试闭环 TDD（部分已有）

**现状**：`submitChecked` 在用户提交验收时跑 `.conclave/project.json` 的 `check`；失败把输出末尾发给 Agent。Squad 的 `submit` 不跑 check。

**缺口**：没有“失败 → 修复 → 再跑”的自动循环；没有 no-progress 检测；没有把 check 结果当产物。

**建议**：`check` 节点输出结构化结果：`{ command, exitCode, durationMs, tail, failures[] }`。失败时生成 `failure` 产物，fixer 节点只拿失败测试名、错误栈、相关 diff，不拿全量日志。同一失败签名连续两次 → 停止循环，升级给人。最大 3–5 轮，超时和输出都要封顶。

**成本**：1.5 人周（Squad 版 1 人周）。**风险**：测试本身不稳定时会把 Agent 带进死循环；先做失败签名和上限。

### 4.9 黑板 / 共享事实态（缺）

**现状**：成员各自保留会话，靠 prompt 传“别人说过什么”；Squad 靠队长转述。上下文随轮数线性增长。

**缺口**：结构化事实板、并发写控制、接受视图、争议处理。

**建议**：不要做“共享可变文档”，做**追加式事实日志**：

```
Fact { id, flowId, key, kind, value, authorNodeId, evidence[], status: proposed|accepted|disputed, supersedes, createdAt }
```

Agent 用 `conclave_flow_fact` 追加；core 维护每个 key 的“当前接受视图”。节点启动时只注入三样：已接受事实摘要、未决问题、与本次节点相关的产物索引。两个节点对同一 key 给出冲突值 → 标 `disputed`，生成一个门禁或让裁判节点裁决。这样既减少上下文，又能审计“结论是怎么来的”。

**成本**：3 人周。**风险**：事实粒度过细会变成另一份聊天记录；只记“会影响后续决策”的事实。

### 4.10 意图驱动的动态 MoA（缺，但不必神化）

**现状**：用户手选成员；Agent 可以委派，但只有一层；`rankAgents` 已能按额度推荐。

**缺口**：意图 → recipe/roster/budget 的路由；临时专家小组；用户确认。

**建议**：Router 是 Flow 前的一个轻量步骤，不是“自动开干”。输入：用户请求、仓库信号（语言、测试、改动面）、任务类型；输出：recipe、成员、预算、理由。用便宜的小模型 + 确定性启发式，失败回退到默认 recipe。**必须给确认卡**：“将用 Pipeline：Claude 规划 → Codex 实现 → Gemini 审查，预算 8 次调用，预计 20 分钟”。用户可改。Router 不能提权，不能绕过门禁。

**成本**：1.5 人周（在 Flow 有 2–3 个 recipe 之后）。**风险**：分类错了比不分类更糟；确认卡是必须的。

### 4.11 人机协同门禁（部分已有）

**现状**：工具审批、计划确认、任务验收都在；但都是“回合级”，不是“运行级”。

**缺口**：运行暂停在某个节点、持久化决策卡、diff/产物预览、批准后分叉、重启后还在。

**建议**：`gate` 节点存 `{ title, body, risk, artifacts[], options[] }`。UI 显示 diff、测试结果、决策理由；选项可以是“批准 / 拒绝 / 换方案 / 只批准这一次”。批准后 core 继续；拒绝走失败边或回退节点。高风险动作（push、合并、部署、删数据）默认插门禁；普通编辑不插，否则人会疲劳。

**边界**：运行级门禁能拦住“进入下一个节点”，拦不住 Agent 在节点内部执行的每一条命令。真正的命令级高危拦截仍然要靠权限模式、审批卡和 `command-rules`。不要对外承诺“所有高危操作都会停”——能承诺的是“流程级决策点会停，命令级高危操作会按权限规则请求确认”。

**成本**：2 人周。**风险**：门禁太多会让人无脑点“批准”；按风险分级，不要按节点数量。

### 4.12 成本汇总

| 模式 | 状态 | 新增量级 | 前置依赖 |
|---|---|---:|---|
| Fanout | 已有 | 0.5 周 | — |
| Debate | 已有 | 1 周 | — |
| Pipeline | 缺 | 2 周 | Flow 核心 |
| Squad 补强 | 已有 | 1.5–2 周 | — |
| Critic | 缺 | 1–2 周 | diff 产物 |
| Tournament | 缺 | 3–4 周 | 多 worktree + OPT-07 |
| Artifact DAG | 缺 | 4–5 周 | Flow + 产物发布 |
| TDD 闭环 | 部分 | 1–1.5 周 | check 产物 |
| Blackboard | 缺 | 3 周 | Flow + 事实模型 |
| MoA Router | 缺 | 1.5 周 | 2–3 个 recipe |
| HITL 门禁 | 部分 | 2 周 | Flow 状态机 |

全部做完大约 20–25 人周；先做 P0–P2 大约 6–9 人周，已经能覆盖 80% 的日常价值。

## 5. 关键设计决策

1. **编排在 core，不在 prompt。** 队长/规划者可以提议，但“下一步跑不跑、跑谁、能不能写”由 core 决定。否则重启、审计、预算、权限都无从谈起。
2. **Agent 提议，core 裁决。** 动态扩展只接受受约束的 JSON：白名单角色、无环、深度和扇出上限、权限不放大。自由文本永远不能变成控制指令。
3. **发布产物，不监听文件。** 文件 mtime 不是事件；半写、格式化、编辑器临时文件都会误触发。显式 `publish` + schema 校验才触发边。
4. **事实板只追加。** 共享可变文档的并发写一定会丢更新；追加日志 + 接受视图 + 争议状态才能既并发又审计。
5. **工作区租约。** 同一 worktree 同时一个写者；只读并行；隔离尝试各自一份。不要用“大家小心一点”代替租约。
6. **门禁持久化。** 人机门禁、check 门禁都存 Flow，不存 Agent 会话；Agent 进程可以停，门禁不能丢。
7. **异构优先。** 同模型多实例的多样性有限；Critic、裁判、Tournament 评委尽量跨模型家族。否则只是“同一个偏见说五遍”。
8. **预算是硬约束。** 最大节点、最大并发、最大尝试、最长墙钟、最大产物；超了停，不偷偷续。额度不限量不等于可以无限开进程。
9. **不自动合并、不自动删除。** 胜者进人机门禁；败者 worktree 保留，显式清理。这是仓库现有的安全规则，Flow 必须继承。
10. **跨节点内容默认不可信。** 产物是数据，不是指令；只有通过 schema 校验的控制字段（枚举、节点 key、白名单角色）才能被 core 当控制用。其余内容进 prompt 时明确标为“上游产物，作为数据阅读”。

## 6. 路线图

### P0：Squad 质量门禁（1.5–2 人周）

**目标**：不新增引擎，把已有的团队从“靠自觉”变成“有门禁”。

- `SquadWork` 增加 `dependsOn`、`kind: work | review | verify`。
- `SquadRun` 增加 `workflow: free | review | tdd`。
- `finish` 前跑 `check`，失败不提交，输出回给队长。
- `review` 工序：开发工作完成后自动生成只读 Review 工作，Review 未完成不能 `finish`。
- UI：工作列表显示依赖和 check 结果；失败可重试。
- 验收：check 失败的任务进不了待验收；Review 未完成时 `finish` 被拒绝；重启后依赖关系还在。

### P1：Flow 核心 + Pipeline + 门禁（3–4 人周）

**目标**：让“运行”成为一等公民。

- `protocol/src/flow.ts`：Flow、Node、Edge、Artifact、Gate、Recipe、预算。
- `core/src/flow-store.ts`：`flows`、`flow_nodes`、`flow_artifacts`、`flow_events`。
- `core/src/flow-service.ts`：`tick / advance / reconcile / control`，复用 ConversationService 和稳定 ref。
- `core/src/flow-recipes.ts`：`pipeline`（3–5 段）；`critic`、`tdd` 留到 P2。
- `core/src/flow-prompt.ts`：节点 brief、上游产物、输出契约。
- UI：新会话入口加“编排”；运行时间线；门禁卡；产物查看。
- 验收：三段 Pipeline 用三个不同 Agent 跑通；中途重启能继续；门禁能停能恢复；产物可追溯。

### P2：Critic + TDD + 证据校验（2–3 人周）

- Critic verdict schema + diff 行号校验。
- check 结果结构化 + 失败签名 + no-progress 停止。
- maker–critic 最多 3 轮；同一阻塞重复出现升级给人。
- 验收：预置一个真实 bug，Critic 或 check 能拦住；修复循环收敛；误报可降级。

### P3：Tournament（3–4 人周）

- attempt 级 worktree/branch，复用 WorktreeService 的扫描、清理和归属。
- 确定性评分 + 可选盲评。
- 胜者进人机门禁；败者保留；清理 UI。
- 前置：OPT-07 的依赖共享（symlink/reflink），否则环境准备成本会吞掉收益。
- 验收：3 个 attempt 并行跑完，评分可解释，胜者可合并，败者不丢。

### P4：Blackboard + 动态 DAG + Router（6–8 人周）

- 事实板 + `conclave_flow_fact` + 接受视图 + 争议门禁。
- planner 节点扩展提案 + core 校验 + 产物发布事件。
- Router：意图 → recipe/roster/budget + 确认卡。
- 验收：10 节点动态图跑通；每个节点的上下文有上限；无环、无 runaway；用户能看懂为什么这样编排。

## 7. 第一个里程碑的文件级改动

如果现在就要落 P0，建议按这个顺序：

1. `packages/protocol/src/squad.ts`：`SquadWork.dependsOn`、`SquadWork.kind`、`SquadRun.workflow`、`SquadWorkflow`。
2. `packages/core/src/squad-store.ts`：持久化新字段，旧数据默认 `free` / `work`。
3. `packages/core/src/squad-service.ts`：`advance` 尊重依赖；`review` 自动建工作；`finish` 调 check。
4. `packages/core/src/worktree-setup.ts`：把 `check` 的结果整理成 `{ exitCode, durationMs, tail, failures }`。
5. `packages/core/src/task-service.ts`：抽出 `submitChecked` 的可复用部分，供 Squad 调用。
6. `packages/core/src/squad-prompt.ts`：告诉队长依赖和 Review 工序，不要让它自己猜。
7. `packages/core/src/mcp-squad-tools.ts`：`dispatch` 接受 `dependsOn`；`finish` 的拒绝原因写清楚。
8. `packages/web/src/components/SquadWorkPanel.tsx`：显示依赖、check、Review 状态。
9. `packages/core/src/squad-service.test.ts`、`packages/protocol/src/squad.test.ts`：依赖、门禁、重启恢复。

P1 的 Flow 再另开一套文件，不要和 Squad 混在一起；等 P2 稳定后再考虑把 Squad 迁成 recipe。

## 8. 不建议做的事

- **不要为 11 种模式写 11 套 service。** 状态机、恢复、并发、审批会重复 11 遍。
- **不要先做可视化 DAG 编辑器。** 先用 recipe + 参数 + 动态扩展；编辑器是 P4 之后的事。
- **不要让 Agent 递归编排 Agent。** 一层委派已经够用；再往下会失去预算、审计和权限边界。
- **不要把完整聊天记录当阶段输入。** 用产物 + 决定 + 未决问题；聊天记录只做审计。
- **不要用文件监听做 DAG 触发。** 半写、格式化、临时文件会让图抖。
- **不要自动合并或删除 Tournament 的败者。** 仓库现有规则就是“可能只有这一份成果”。
- **不要把“额度不限量”当成“并发不限量”。** 进程、内存、磁盘、人的注意力都是硬约束。
- **不要让 Router 自动提权或跳过门禁。** 路由只决定“怎么做”，不决定“能不能做”。

## 9. 开放问题

1. 你更想要“个人研发质量”（先 Critic/TDD）还是“可复用的团队编排”（先 Flow/Pipeline）？两者的第一刀不同。
2. Tournament 的磁盘和环境成本你接受吗？如果接受，OPT-07 要不要一起做？
3. 门禁的粒度：哪些动作必须停人（合并、push、部署、删数据、改架构），哪些可以自动？
4. 你要不要跨机器/远程 worker？如果要，Flow 的租约和调度器现在就要按“工作区不在本机”设计，后面改代价很大。
5. Recipe 是只给内置几种，还是允许用户用 JSON 自定义？后者需要 schema 版本化和信任模型。
