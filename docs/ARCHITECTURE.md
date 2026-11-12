# Conclave 技术架构与实现细节

这份文档写给想弄清 Conclave 怎么工作、或者准备参与开发的人。产品介绍、截图和上手方式见 [README](../README.md)。

- [1. 总体架构](#1-总体架构)
- [2. 任务模型](#2-任务模型)
- [3. Worktree 与 Git](#3-worktree-与-git)
- [4. Agent 接入与聊天](#4-agent-接入与聊天)
- [5. 浏览器边界说明](#5-浏览器边界说明)
- [6. 终端与端口](#6-终端与端口)
- [7. 从源码运行](#7-从源码运行)
- [8. 源码构建](#8-源码构建)
- [9. 开发与验证](#9-开发与验证)
- [10. 已知限制与下一步](#10-已知限制与下一步)

## 1. 总体架构

```
┌──────────── 客户端（可以有多个）────────────┐
│  web     React + Vite + xterm.js          │
│          CodeMirror / 聊天界面 / 终端面板 │
└────────────────┬───────────────────────────┘
                 │ JSON-RPC 2.0 over WebSocket（token 鉴权）
┌────────────────▼───────────────────────────┐
│  core    纯 Node 服务，不依赖 Electron       │
│   ├─ TaskStore / ConversationStore  持久化 │
│   ├─ TaskService   状态流转、worktree、启动 │
│   ├─ ConversationService  会话与移交       │
│   ├─ ChatHost  聊天界面的 agent 协议与记录    │
│   └─ RpcServer     推送 changed 等          │
└────────────────┬───────────────────────────┘
                 │ NDJSON over Unix socket / named pipe
┌────────────────▼───────────────────────────┐
│  daemon  持有所有 agent 进程（stdio 管道）   │
│          和终端面板的 shell（node-pty）      │
│          core 重启 / 页面刷新不结束进程   │
└────────────────────────────────────────────┘
```

生产构建由 core 的 HTTP 服务提供 `packages/web/dist`，开发时由 Vite 提供前端。Conclave 本身不提供内嵌浏览器宿主，见第 5 节。

| 包 | 职责 |
|---|---|
| `packages/protocol` | 唯一的类型来源：Task / Contract / Flow / Evolution / Conversation 模型、状态流转规则、RPC 方法与通知的 zod schema、客户端。`/node` 子入口放路径、端点发现、daemon 协议 |
| `packages/core` | 独立的任务、契约自治流（Flow）、自演化（Evolution）与会话存储及业务逻辑；任务创建 git worktree；通过 daemon 启动 Agent CLI；另有给 Agent 用的极简 MCP 服务（`mcp-main.ts`，文件预览、终端与可选历史读取工具），由 Agent 作为独立进程启动 |
| `packages/daemon` | 进程宿主，独立进程：Agent 跑在 stdio 管道上，终端面板的 shell 跑在 PTY 里；缓存最近输出，供重新连接时回放 |
| `packages/web` | Web 前端：看板、详情与契约编辑、自治轨迹、聊天界面、终端面板；纯 Vite + React SPA 直连 core |

运行时数据在 `~/.conclave/`（可用 `CONCLAVE_HOME` 覆盖）：`conclave.db`、`core.json`（端口与 token，权限 0600）、`worktrees/`、`sessions/`、`skills/`（技能库：`skills.json` 锁文件、`repos/` 里的 git 克隆、`bundles/` 里交给 Agent 的目录）、`mcp-servers.json`（用户的 MCP 服务器，不含密钥）、`credentials.json`（任务来源和 MCP 服务器的密钥，权限 0600）。

### 进程边界

- **daemon** 持有每一个 Agent 进程和 PTY，跑在纯 Node 上；node-pty 这类原生模块只在这里加载。
- **core** 持有任务、git 和持久化，不依赖 Electron，可以在没有界面的服务器上单独运行。core 的 MCP 服务（`mcp-main.ts`）是 Agent 启动的独立进程，和 Web 前端一样只是客户端。
- **web** 纯浏览器前端。保持精简：不放任务逻辑、不碰 git、不开 PTY，通过 WebSocket 调用 core；文件、终端和系统操作由服务端执行。

### 通信与版本

- 客户端 ↔ core：JSON-RPC 2.0 over WebSocket，要求 `core.json` 里的 token，因为任何网页都能连本机的 WebSocket。`pnpm start` 默认监听 `127.0.0.1:43551`；直接运行 core（含 `pnpm dev:core`）默认监听 `0.0.0.0:43551`。可用 `--host` / `CONCLAVE_HOST` 和 `--port` / `CONCLAVE_PORT` 调整。本机开发可明确绑定 `127.0.0.1`。Web 客户端通过同源 `/api/auth/session` 或 URL 参数、浏览器存储发现端点；该 HTTP 路由检查回环连接或既有 token/cookie，不是一次性登录票据。
- core ↔ daemon：NDJSON over Unix socket（Windows 上是 named pipe）。只有连接被拒绝才说明 daemon 的 socket 已失效，超时或 EPERM 不能证明什么。
- `packages/protocol` 是唯一的类型来源：RPC 方法和通知都先在这里定义 zod schema，再在 `core/src/rpc-handlers.ts` 实现。客户端和 core 可以是不同版本；增加可选字段是安全的，破坏性改动要提升 `PROTOCOL_VERSION`（daemon 线路是 `DAEMON_PROTOCOL_VERSION`）。版本常量分别以 `protocol/src/rpc.ts`、`protocol/src/node/daemon-protocol.ts` 和 `protocol/src/node/browser-host-protocol.ts` 为准；客户端与服务端跨越不兼容的 RPC 版本时需一起升级。
- 启动 Agent 用 argv 数组，prompt 前加 `--`，从不经过 shell。

### core 的网络请求

core 启动时通过 `system-proxy.ts` 安装全局 undici dispatcher，让自身的网络请求读取代理配置：优先使用 `HTTPS_PROXY`／`HTTP_PROXY` 和 `NO_PROXY`；未设置时，Windows 读取注册表 Internet Settings 的 `ProxyEnable`、`ProxyServer` 和 `ProxyOverride`，macOS 读取 `scutil --proxy`。配置每 30 秒刷新，开关系统代理后无需重启 core。回环地址及配置中的例外直连；系统设置仅有 SOCKS 或 PAC 时不自动解析，按直连处理。

这只影响 core 自己的请求，例如插件下载、服务商和 MCP over HTTP，不修改 Agent 子进程的环境。`network-failure.ts` 为失败请求补充地址、是否经代理及具体原因（超时、中断、证书校验失败等），便于排查浏览器可访问而 core 请求失败的情况。

插件先解压到临时目录再改名到位。Windows 的杀毒软件可能暂时占用刚写入的文件，`patient-rename.ts` 对 EPERM、EACCES、EBUSY 最多重试 10 秒；其他平台直接报告失败。

## 2. 任务模型

### 状态流转

```
未执行 pending ──开始──▶ 执行中 running ──提交──▶ 待验收 review ──接受──▶ 已完成 done
                                                        │
                                                        ├──继续修改──▶ 执行中（同一个 worktree）
                                                        └──重做──▶ 已废弃 abandoned ＋ 新建一个继承它的任务（未执行）
```

状态规则集中在 protocol 的 `checkMove` / `checkStart` / `manualMoves`，界面调用它们，不自己再写一遍。

### 开始任务


未执行的任务只有一个「开始」按钮：规划和执行都在任务自己的聊天里进行，界面和会话的聊天一样，头部和工具栏是任务的。开始前要填好项目和 Agent，详情可以不写（只用标题作 prompt）。

- **开始执行**：依赖都已完成时，Conclave 先建好 worktree 和分支，任务进入「执行中」，Agent 以规划模式在 worktree 里启动：先读代码，有疑问先问你，再拿出计划。计划显示在右侧检查器的「计划」页，按计划执行（自动接受编辑或逐项确认）之后才开始改代码。确认的计划记在任务上，详情页只读显示，你写的详情不会被改。
- **开始规划**：还有依赖没完成时，Agent 只读规划，不建任务分支。它读的是任务分支将来拉出的起点（见「分支起点」）：Conclave 把起点提交检出成一个没有分支的只读副本，放在 `~/.conclave/worktrees/<任务id>/.planning/<项目名>/`；起点就是项目当前检出的分支时，直接在项目里读。Claude Code 用规划模式并禁止改动这些目录里的文件，Codex 用 plan 模式配 `read-only` 沙箱，权限模式只有「规划」。未完成依赖的详情和计划直接写在第一条消息里。拿出计划后可以继续规划，也可以「保存计划」：计划存到任务上，任务仍是「未执行」，列表里标「计划已保存」。依赖都完成后点「开始执行」，Conclave 结束规划用的 Agent，在新建的 worktree 里开一个新会话，把保存的计划交给它，让它先对照当时的代码核对一遍。
- **提交验收**：Agent 退出不会让任务进入待验收，因为 Agent 空闲 30 分钟就会被结束，下次发消息再接着同一个会话启动。觉得做完了就点「提交验收」（Agent 正在处理时不行），检查器会打开到改动。
- **依赖完成后自动执行**：在详情的依赖项下开启「自动执行」，core 将这一次启动放入预约队列，等所有依赖进入「已完成」再运行，待验收、已取消都不算完成。沿用任务的模型、推理强度和服务商，权限采用 设置 → 权限 里的「预约运行的权限」；额度或并发不足时继续等待，启动失败保留预约记录。启动、取消排队或移除全部依赖后开关关闭；删除前置任务也会关闭其后续任务的自动执行，避免把删除当成完成。core 重启后从数据库恢复，手动开始、关闭开关不会重复执行。不支持无人值守的 Agent 暂不支持。
- **其他**：任务的聊天不出现在「会话」列表和搜索里，从任务打开；删除任务时一并删除它的聊天记录，worktree 保留。任务的聊天提供 Conclave 的文件预览与终端工具。

### 验收之后


聊天右侧的**检查器**列出 Agent 从分支起点到现在改了什么：提交记录、每个文件的增删行数（包括还没提交和没加入 git 的），点开文件能看 diff；「分支」标签可管理 worktree 的分支、浏览提交历史和比较分支。选中待验收的任务时它会自动打开，工具栏的检查器按钮可以随时开关。依赖任务的改动不会算进来：起点取分支创建时的提交。看过结果后三选一：

- **接受**：任务进入「已完成」，依赖它的任务这时才能执行。
- **接着改**：直接在聊天里发消息，写下验收时发现要改的地方：任务回到「执行中」，worktree 被删掉的会先重建，Agent 接着原来的会话继续。
- **重做**：把这个任务标记为「已废弃」（worktree 保留），自动新建一个继承标题、详情、项目、Agent 和依赖的任务，从干净的分支开始；依赖原任务的任务改为依赖新任务。可以填一句废弃原因，规划和执行新任务时会告诉 Agent，让它参考但不照搬上次的尝试。

「已完成」的任务也可以接着改或重做。执行过的任务不会回到「未执行」。

### 验收契约、自治执行（Flow）与自我迭代（Evolution）

- **验收契约（`TaskContract`）**：每个任务可定义显式的完成标准（`goal`、命令级 `checks`、人工确认项 `human`、未知风险 `unknowns`、基线失败 `baseline` 与自治级别 `autonomy`）。保存契约时，core 对命令与引用的脚本计算受信哈希，验证阶段在 worktree 中重算并拦截被篡改的测试脚本。
- **契约自治流（`FlowService`）**：围绕任务的验收契约自动驱动 `规划（plan）→ 分步实现（implement）→ 盲测红检（Red-First）与命令校验（verify）→ 失败分类与重规划（replan）`。遇到缺失外部环境、密钥或 MCP 依赖时进入 `waiting_environment` 挂起态，经 `flows.supplyEnvironment` 补给后无缝恢复执行。详细机制见 [AUTONOMY.md](AUTONOMY.md)。
- **递归自我迭代（`EvolutionService`）**：从可复现改进项出发，自动创建基于影子 worktree 的 `Task` 与 `Flow`，通过 `typecheck`、`test`、`build`、`self:smoke` 与 `self:tests` 五重硬门禁后，自动快进更新 `self/evolve` 分支并探测宿主机可用性，异常时自动回滚。详细机制见 [SELF-EVOLUTION.md](SELF-EVOLUTION.md)。

### 多项目与依赖


- **主项目与附加项目**：第一项为主项目，项目选择器里用高亮颜色标出；右键其他项目选「设为主项目」可以把它移到首位，其余项目顺序不变；移除主项目后下一项自动成为主项目。任务执行中、启动准备期间及已废弃时不能调整项目。主项目就是 Agent 会话的工作目录，会话途中不能换：任务的对话开始后主项目就固定了，附加项目仍可增删，下一条消息时 Agent 带上新的目录。
- **多个仓库隔离执行**：每个 Git 仓库各建一个 worktree，放在 `~/.conclave/worktrees/<任务id>/<项目名>/`，分支名相同。Agent 在主项目的 worktree 中运行，通过 `--add-dir` 访问其他 worktree。Conclave 在 prompt 中列出各项目目录和分支，提醒 Agent 先读取附加项目适用的指令，并在对应仓库执行 Git、构建和测试。更换主项目保留已有 worktree 和分支。普通文件夹（非 Git）只能作为任务唯一的项目目录，原地执行。附加项目可以在任务详情的「起点」里勾选「只读参考」（`TaskRepo.reference`）：Agent 在原目录读它，不建 worktree 和分支，也不作为可写目录交给 Agent（不加 `--add-dir`，不进 Codex 的可写目录或 ACP 的 `additionalDirectories`），prompt 里标明只读。各 Agent 的文件编辑工具都改不了它：Claude Code 加读取放行和编辑禁止规则；Pi 和 DeepSeek 把它列为不可编辑；OpenCode 的 Conclave 模式和它自带的 Build 都加上「可读参考目录、禁止编辑」的规则（Build 默认什么都不问，只有这样才拦得住）；Cursor、Codex、Antigravity 和 ZCode 要编辑参考目录时发来的审批由 Conclave 直接拒绝，不交给用户（`reference-paths.ts`）；Antigravity 的文件工具本来就只能访问主项目（见 [ANTIGRAVITY.md](ANTIGRAVITY.md)）。shell 命令写文件拦不住，只靠 prompt 约束。参考项目可以不是 Git 仓库，多项目任务里非 Git 文件夹只能这样用。会话把这些目录记在 `referencePaths`，团队成员同样只读。主项目不能设为参考；已经建了 worktree 的项目不能再改成参考，以免丢下 worktree 里的改动，参考项目随时可以改回可写。
- **分支名**：`conclave/[<issue key>-]<任务id前8位>-<标题 slug>`，slug 取标题里的英文和数字。标题含中文等非 ASCII 字母时，任务创建、改标题或换 Agent 后，由任务 Agent 的便宜小模型概括出几个英文单词作 slug，存在任务上；开始执行时还没生成好就最多等 10 秒，仍没有就只用任务 id。分支只在第一次建出时命名，之后改标题不改名。
- **规划与历史任务**：只读规划以主项目起点的只读副本为 cwd（起点是项目当前的分支时用原目录），只读访问其他项目，不建任务分支。开始执行后这些副本会被移除；副本里若有改动或只有它才有的提交，就留着不动。历史数据沿用原列表第一项作为主项目，无需数据库迁移。
- **依赖**：依赖的任务全部「已完成」（验收通过）后才能执行，「待验收」的不算，不能形成循环。同一个 Git 仓库里恰好有一个依赖留下了分支时，新 worktree 从那个分支拉出，直接用上前置任务的改动；prompt 里也会列出依赖任务和它们的分支。
- **分支起点**：任务分支默认从 origin 的默认分支拉出（依次找 origin/HEAD、origin/main、origin/master），拉出前只拉取这一个分支，不用你当前检出的分支。拉取失败时用仓库里已有的副本；仓库没有 origin 的默认分支时，从项目当前的分支拉出。任务详情的「起点」一栏可以为每个项目另选：项目当前的分支，或任意本地、远端分支（远端分支同样先拉取），选了就不再叠在依赖的分支上。分支建好后这一栏记下从哪个提交拉出、什么时候，拉取失败或没有默认分支也写在这里。任务分支不跟踪它的起点，检查器里的改动从记下的提交算起。重做沿用原任务选的起点。只读规划读的也是这个起点，每次开始时重新拉取；接着同一个规划对话时，读的仍是上次那份。

### 任务图片


截图、设计稿这类图片不放进详情，而是作为任务的**图片**属性单独保存，像依赖一样在详情页单独一行：点「＋ 添加图片」选择文件，或者直接在任务页面上粘贴（包括在详情编辑器里）、拖进来都可以；新建任务对话框里也能贴图。图片自动编号（图 1、图 2…），详情里可以写"见图 2"；点缩略图看大图，名字可以改，当作图片说明。

- **存储**：由 core 保存在 `~/.conclave/attachments/<sha256>.<扩展名>`（权限 600），同一张图只存一份，重做任务时只复制引用。只接受 PNG、JPEG、GIF、WebP（不接受 SVG），单张不超过 10MB、4000 万像素；保存前会去掉 EXIF、文字块等元数据，免得位置之类的信息被发给模型。图片通过 RPC 分块传输，不会卡住别的消息。删除任务或移除图片不会删除图片文件。
- **交给 Agent**：开始、继续时，prompt 会按编号列出每张图片的本机路径，让 Agent 开始前先查看。Claude Code 只被授权读取这几张图片（`--allowedTools Read(//…)`），不会拿到整个图片目录；你加的图片还会附在第一条消息里。
- **导入的图片**：从 Jira 导入时，issue 里的图片附件也会下载下来（最多 20 张，单张 10MB，一共 50MB），显示在原文快照卡片的下方；正文里原来放图的地方写成「（图片：文件名）」。这些图片和原文一样属于外部内容：交给 Agent 时它们和原文一起放在不可信数据块里，也不会附进消息。token 带权限范围但缺少 `read:attachment:jira` 时，图片下载不了，会在附件清单里注明。

### 任务来源与收件箱


任务除了手写，也可以从 issue 系统导入。每种系统是一个**任务来源**，GitHub、Jira、Linear 和禅道都通过独立来源插件接入，在「设置 → 插件」推荐列表选择，从独立 GitHub Release 下载后安装；新安装的 Conclave 不预装任务来源。插件只提供来源，不扩展 Agent 或界面，见 [任务来源插件](PLUGINS.md)。

四个来源的源码分别在独立的 `conclave-plugin-*` 仓库，主仓库只维护 `plugins-recommended.json` 中的推荐名称、说明与仓库地址，不附带来源插件的 ZIP 或程序。core 在用户点击安装时从对应 GitHub 仓库的最新正式 Release 下载 ZIP，校验 ID 与协议后安装；查看列表、启动和构建都不会下载来源插件。旧版已安装的插件继续可用，旧 Jira 配置在主动安装独立插件后继续使用。SDK 在 `packages/plugin-sdk` 维护，协议唯一来源为 `packages/protocol`，来源图片通过可选字段传输。

1. **设置**：在 设置 → 集成 → Jira 里填站点（如 `your-team.atlassian.net`）和 JQL（默认是分给你、还没完成的 issue），保存。
2. **登录**：点「登录」，按提示输入邮箱和 [API token](https://id.atlassian.com/manage-profile/security/api-tokens)（只需要读权限）。登录流程由来源驱动，界面按来源给出的提示一步步渲染。
3. **收件箱**：core 每 15 分钟同步一次，结果出现在侧栏的「收件箱」里（在总览下面；连好来源才出现，数字是待处理的 issue 数，同步失败时显示「!」）。每个 issue 可以**导入任务**，成为一个「未执行」任务；可以先**会话排查**；或者**忽略**（之后在「已忽略」里可以恢复）。

GitHub 在 设置 → 集成 → GitHub 中登录，登录时输入 Personal access token。筛选条件的写法和 GitHub 网页上的搜索一样，默认是 `assignee:@me is:open`，即 token 可访问范围内、分配给当前账号且仍开放的 Issues 和 Pull Requests；条件里没写 `is:issue` 或 `is:pr` 时两种都同步，结果按更新时间排序。导入项使用 `owner/repository#number` 作为来源编号，并保存正文、标签和最近 20 条评论的快照。

**会话排查**适合还不清楚原因的 issue（多半是 bug）：打开新会话页，选 Agent 和项目（默认是这个收件箱上次排查用的项目），可以补一句说明。core 像导入一样拉取 issue 全文和图片，写成一份排查说明放进会话的 `handoffs/` 目录，按移交的方式让 Agent 先读它，所以聊天里只显示你补充的话；说明里同样用 `<untrusted-source>` 包着原文，并要求 Agent 查清根因、给出修复方案后停下。会话默认用 Agent 的只读模式（描述符的 `discussionMode`：Claude 是规划，Codex、Cursor 是只读），调用方没指定时 core 自己补上；确认方案后在同一个会话里批准计划或切换模式就能修。会话以 issue 标题命名，记下来源（`Conversation.source`），页头链接回 issue；收件箱里这条标为「排查中」，按钮换成「看会话」，删掉会话后恢复。Conclave 不回写 issue 系统，修完在那边关掉，下次同步就离开收件箱。

导入的任务详情是空的，留给你写方案，或开始后让 Agent 先规划；issue 的描述、最近 20 条评论，以及来源支持时的附件清单作为**原文快照**单独保存，在任务详情里只读显示，可以「重新拉取」。交给 Agent 时，原文快照被标记为**不可信的参考资料**包在 `<untrusted-source>` 里，其中的指令不会被当作你的要求。执行时分支名带上 issue key（`conclave/PROJ-123-…`），Jira 靠这个把分支关联到 issue。删除导入的任务后 issue 会回到收件箱；重做出的新任务继承原任务的来源和快照。

**凭据**：设置（`~/.conclave/sources.json`）里没有密钥，凭据单独存在 `~/.conclave/credentials.json`（权限 600），只交给对应的来源，永远不会返回给界面，也不会交给 Agent。修改站点会自动退出登录，保存的 token 不会发往新地址。没有界面的机器上，Jira 可以用 `CONCLAVE_JIRA_EMAIL` 和 `CONCLAVE_JIRA_TOKEN`，GitHub 可以用 `CONCLAVE_GITHUB_TOKEN`；环境变量优先于保存的凭据。旧版本的 `~/.conclave/jira.json` 会在 core 启动时自动迁移。

## 3. Worktree 与 Git

### 清理 worktree


Conclave 不会自己删除任务的 worktree，它们可能是 Agent 工作的唯一副本。积累下来的 worktree 在状态栏右下角可以看到：一共几个、占多大空间、几个可以清理，点开是 worktree 页面，按能不能清理分组列出 `~/.conclave/worktrees/` 下的每一个：

- **可以清理**：任务已完成或已废弃，没有未提交的改动。
- **找不到任务**：任务删了，worktree 还在；干净的也可以清理。
- **需要你处理**：有未提交的文件、有只在它里面的提交（比如没有分支的检出上做的提交）、被 `git worktree lock` 锁定、任务的 Agent 还开着，或者它所属的仓库已经找不到了。这些不能在这里清理，每行可以打开任务、在终端里打开或在文件管理器中显示，处理完再清。
- **进行中**：任务还没完成，只看占用。

每行显示任务、分支、提交和 origin 默认分支相比的情况（比如「3 个提交还没合进 origin/main」）以及大小，大小在后台统计。可以清理的默认全选，确认后清理：只删 worktree 目录，**分支和提交都保留**，之后在这个任务上继续修改时，Conclave 从分支重建 worktree；被 `.gitignore` 忽略的文件（如 `node_modules`、`.env`）会一起删除。清理前 Conclave 会对每一个重新检查一遍，删除时不带 `--force`，有变化的会留下并说明原因。已完成、已废弃任务的「⋯」菜单和右键菜单里也有「清理 worktree」。

### Git 分支管理

分支行左侧的星标和右键菜单可收藏或取消收藏本地、远端分支，搜索框旁的星标仅显示收藏。每组当前分支最先、收藏其次，再按名称和目录展示；当前与收藏分支直接显示完整名称，不藏在折叠目录下。本地 `main`、`master` 默认收藏，可取消。收藏由 core 的 `GitFavoriteStore` 保存到数据库 `git_favorites`，以真实的 Git common directory 和完整引用名区分仓库、本地与远端；同一仓库的不同会话和 worktree 共享，独立 clone 不共享。`git.favorite` 显式设置状态，`git.status` 的可选 `favorite` 字段返回结果，`git.changed` 通知其他窗口刷新；通过 `git-favorites` 能力判断支持，旧 core 不展示星标操作。收藏不执行 Git 写操作，Agent 工作时也可修改；在 Conclave 内重命名保留收藏，删除后清除。


检查器的「分支」页按项目展示本地和远端分支树，支持搜索和目录折叠。单击分支查看历史，右键或点「⋯」可切换、新建、重命名、安全删除、与当前分支比较或合并到当前分支。选择提交可看完整说明、改动文件和 diff；merge 提交可选择父提交。右键提交可复制 SHA 或提交信息、从它新建分支、打标签（只在本地）、检出它（分离 HEAD），或与当前分支比较；任务的 worktree 绑着分支，不能检出提交。历史每次加载 100 条，支持按标题、作者和 SHA 搜索。窄栏上下排列，详情可返回历史；拉宽或最大化后是分支树、历史、详情三栏。

工具栏提供 Fetch、Update、Push、Commit 和 Commit & Push。Fetch 获取已配置的远端。Update 照 IntelliJ 的 Update 做，也在本地分支的右键菜单里（「从远端更新」，core 声明 `git-update` 时才有，旧 core 仍是只快进的 Pull）：先 fetch 这个分支的上游；没检出的分支只快进（`update-ref` 带旧值，不用切过去），分叉了就拒绝；检出的分支能快进就快进，分叉时弹框选合并或变基。有未提交的改动时先 `git stash push --include-untracked`（标记 `conclave-update:<分支>`），更新完放回；有冲突时 stash 留到冲突解决、继续或中止之后再放回，放不回去就留在 stash 里并提示。分支列表里每个本地分支显示落后（↓）和领先（↑）上游的提交数，按上次 fetch 计。Commit 提交仓库全部改动；推送失败保留本地提交。Push 照 IntelliJ 的 Push Commits 做（core 声明 `git-push-target` 时）：一行写明「本地分支 → 远端 : 目标」，目标默认是上游的名字，可以改，下拉列出远端已有的分支；目标和本地分支名不同时标黄提示。下面列出这次会推出去的提交（`git.outgoing`：目标存在时是 `本地 ^refs/remotes/<远端>/<目标>`，不存在时排除这个远端的全部分支），远端没有的目标标「新分支」。推送只在分支原来没有上游时设上游，有上游就不改，推到别的分支不会把以后的推送带偏。对话框打开时先刷新状态，请求带上当时看到的本地分支（`from`），core 发现检出的分支已经变了就拒绝（`git-branch-changed`）。不带目标名的推送（会话分支页的「推送」、Commit & Push）只推到同名分支，上游名字不同就拒绝（`git-push-name-mismatch`），照 git 的 `push.default=simple`。推到上游被拒（远端有本地没有的提交，`git-push-rejected`）时弹框问合并还是变基，用 Update 并进来后自动重推；可以记住选择（偏好 `gitPushRejectedUpdate`），之后被拒时直接这样做，Push 对话框里能改回每次询问。推到非上游的分支被拒时只报错，因为 Update 并进来的是上游。本地分支的右键菜单有「跟踪的远端分支」，可以换一个远端分支跟踪或取消跟踪（`track`）。本地删除不强制，未合并时拒绝；远端删除需要输入完整远端分支名确认。

Git 写操作须等关联 Agent 空闲，仓库操作进行时不能启动新回合。任务可以提交、同步、合并和管理其他分支，但保留固定的任务分支及验收起点，不能切换、重命名或删除绑定分支。其他 worktree 正在使用的分支也不能删除。

Merge 前先提交或暂存改动。有冲突时，分支页列出文件，可预览、用外部应用编辑或打开对应目录的终端；解决后逐文件「标记已解决」，再「完成 Merge」，或选择中止。Update 的变基停在冲突上时同样处理，按钮是「继续变基」和「中止变基」（`rebase --continue` 不开编辑器，沿用原提交说明），可能逐个提交停下多次。应用重启后仍会读取 Git 的合并或变基状态。当前不提供单独的 rebase、cherry-pick、reset、stash 管理或三方冲突编辑器。

## 4. Agent 接入与聊天

### 环境检查


core 启动后会在自己的 PATH 里找 `git`、`claude`、`codex` 和 Cursor CLI（`cursor-agent` 或确认属于 Cursor 的 `agent`），问一下版本，再检查登录状态。Claude Code 和 Codex 只读本机凭据；Cursor 使用 CLI 的 `about --format json`。找不到 Git、支持的 Agent 一个都没装或都没登录时，左侧列表上方会有一条红色提醒：Agent 的问题点开是 设置 → 外部智能体，Git 的问题点开是 设置 → 关于。「外部智能体」里所有 Agent 都在一处，分三组：「已安装」的每个显示版本、状态和启用开关：已登录的是「已就绪」，没登录的是「需登录」并给出登录命令，问不了版本的是「需检查」，登录状态不明的不显示状态；安装来源、路径和更新检查收在「详情」里；「可安装」是 Conclave 能运行但这台电脑没装的，已经装了某个 Agent 时默认折叠（一个都没装时展开，那正是要做的事），展开后变灰并给出安装命令，能一键「在终端安装」的把命令收进「详情」；Conclave 自己下载运行时的（Antigravity）按 descriptor 的 `environment.missing` 说明要下载什么，不说成装 CLI；「暂未支持」见下段。命令都可以直接复制，装好或登录后点「重新检测」。「关于」里的 Git 一行显示版本和路径，没装时给出安装命令。只装一个 Agent 不算问题：新建任务和新会话只列出装了的，默认选最近一次新建任务或会话时选的 Agent（任务聊天和定时运行不算），它不在时只装一个就用那一个，否则留空；没装的不能移交过去；已有任务选的 Agent 不在时仍然显示，标为「未安装」。「外部智能体」底部可以展开 core 找命令用的目录：装在别处的，把它所在的目录加进启动 Conclave 的终端环境的 PATH，再重启 core 和 daemon。Windows 上 npm、pnpm 装的 CLI 是 `.cmd` 垫片，core 读出它要运行的程序再问版本（见下文「Windows」）；认不出的垫片只能看到装没装。

设置 → 外部智能体里的「暂未支持」显示 Conclave 认识、但尚未接入聊天的 Agent：从 core 当前的 PATH 查找已知 CLI，并在 macOS 的 `/Applications` 和 `~/Applications` 查找已知应用。Cursor 已支持聊天，应用和 CLI 会合并进「已安装」或「可安装」的一项；只安装编辑器仍需另外安装 CLI。找到 CLI 后会限时执行 `--version`，分别显示命令已响应、版本检测失败或 Windows 命令垫片认不出、无法直接验证；这不检查登录，也不代表 Conclave 已支持该 CLI 的聊天协议。每 5 分钟自动复查，也能手动「重新检测」；新增 PATH 目录仍需重启 Conclave，才能让 core 和 daemon 都用到它。未接入的 Agent 标为「暂未支持」，不能选来运行任务或会话。尚未接入的产品在 `packages/core/src/environment-check.ts` 的发现清单里登记可辨认的命令或应用名；已接入的 Agent 由它的 adapter 声明（见「新增 Agent」）。

跨平台发现由 `environment-check.ts` 统一实现：Windows 按可识别后缀查找 PATH 并检查文件存在，Unix 检查可执行权限。应用候选目录包括 macOS 的 `/Applications`、`~/Applications`，Windows 的用户 Programs 与 Program Files，以及 Linux 的 `/usr/share`、`/opt` 和常见 bin/share 目录。发现位置不等于已支持聊天或已登录；CLI 版本探测通过 `launchFile`，限时执行，并在 Windows 隐藏探测窗口。

### Windows 上启动 Agent

Agent 的命令从不经过 shell，Windows 上也一样，而 npm、pnpm 装的 `claude`、`codex`、`npx` 在 Windows 上是 `.cmd` 垫片，`child_process` 只能经 cmd.exe 运行它，cmd 又会把参数重新切一遍。所以 daemon 和 core 启动命令前都走 `protocol/node` 的 `planLaunch`：按 PATHEXT 找到文件（不先试无扩展名的那个，那是 npm 给 sh 写的脚本）；是认得的 npm / pnpm 垫片，就读出它要运行的东西，直接起 `node.exe <脚本>` 或它包着的 `.exe`，pnpm 加的 `NODE_PATH` 照样加上；旁边有同名 `.ps1` 的（Cursor 的安装方式）用 `powershell -File` 运行；都不是就报 `command-needs-shell`，不退回 cmd。识别规则参照 Orca 的同名实现，认不全就拒绝，宁可不启动也不运行错的程序。

源码运行时，`mcp-command.ts` 使用当前 Node 可执行文件，通过 tsx 加载 `mcp-main.ts`；启动命令作为 argv 交给 Agent，不经过 shell。Claude 的只读围栏和读取授权在 Windows 上按 Claude 的写法转换路径：`C:\Users\me` 写成 `//c/Users/me`。

### Agent 并发


设置 → 运行 可以限制同时运行的 Agent 进程总数（默认 20）和每款 Agent 的进程数（默认各 6）。聊天、任务、规划共用额度；等待你批准的 Agent 也占额度，终端面板和外部浏览器宿主不占。调低上限不会结束已运行的进程。手动启动超过上限时会提示等待或预约；预约保存在 core 中，额度满时留在等待队列，不消耗失败重试次数，有会话结束便再次尝试。正在运行的进程由 daemon 持有，core 重启后会重新接管并计入额度。

### 页面与关闭

主区域一次显示一个页面。总览是兜底页：启动时打开，本身没有关闭按钮，别的页面关闭后都回到这里；只有任务例外，它回任务看板。规则在 `core-store.ts` 的 `openOverview()`，页面的关闭都调用它，任务的关闭走 `selectTask(null)`。

| 关闭的页面 | 关闭后 |
|---|---|
| 总览 | 无关闭按钮 |
| 收件箱（重连后已没有在用的收件箱时也算关闭） | 总览 |
| 例行任务 / 预约 | 总览 |
| Worktree 管理 | 总览 |
| 会话、新建会话 | 总览 |
| 任务（含任务会话，按 Esc 也算） | 任务看板 |
| 设置 | 打开前所在的页面：它盖在整个界面上，不算主区域的页面 |

### 界面语言

设置 → 外观 → 界面语言支持「跟随系统 / 简体中文 / English」，保存在当前浏览器的 `conclave.preferences.language`，默认简体中文；选择跟随系统时，`zh-*` 使用简体中文，其他系统使用英语。切换即时生效，通过 storage 事件同步同源页面。它与 Agent 回复和提示词独立，不改用户内容或历史数据。审批在会话页面处理，不提供原生独立审批窗口。

界面文案集中在 `packages/web/src/shared/messages.ts`，使用语义键与命名参数；普通文本走 `t`，带行内 React 元素的句子走 `tr`，英语计数使用 `one / other` 复数形式。模块级展示表通过 `localized` 按当前语言缓存，React 根节点订阅语言，涉及展示文字的 memo 包含语言依赖。CodeMirror 只重配文字，不重建编辑器，保留草稿、选择和撤销历史。

Agent 描述符可提供英语展示文本，客户端传入语言读取，执行规则不变。来源设置及登录提示可附加 `translations.en`（包括选项、链接、提示和重试错误），core 只验证和传递；缺少翻译时使用原字符串，旧客户端忽略这些可选字段。

### 聊天界面


会话和任务都在 Conclave 的聊天界面里和 Agent 对话；任务怎么走见「开始任务」。点「＋」会打开一个新会话页面：在中间选 Agent，在输入框上方选项目，在输入框下方选起始的权限模式（「自动判断」要等 Agent 启动后按模型提供）、模型和推理强度（列表取自这个 Agent 最近一次聊天报出的模型；从没用它聊过时，Conclave 会先问一下 CLI，约一秒），发出第一条消息时才创建会话并启动 Agent。

输入框里可以粘贴、拖入图片，或点输入框下方的「＋」选「添加图片」（PNG、JPEG、GIF、WebP，一条消息最多 10 张，上传后先显示缩略图，发送时一起发出）：Claude Code 在消息里直接收到图片，Codex 收到图片文件的路径，Cursor 在 ACP 声明支持图片时收到图片内容；超过 4MB 的大图会先缩到 2000px 以内，Claude Code 只接受 5MB 以内的图片。排队的消息也带着图片。发出的图片显示在自己的消息里，点开可以放大；图片和任务附件存在同一个 `~/.conclave/attachments/` 里，移交给另一个 Agent 时它只知道那条消息附了几张图片。

**分屏**

两条会话可以并排：会话右键「在右侧分屏打开」、⌘ 点击会话，或把会话从侧栏拖到正在看的会话右半边。前面那一列（当前列）就是 `selectedConversationId`，侧栏高亮、终端引用、检查器都跟着它；另一列只是还在屏幕上。两列各是一个完整的 `ConversationView`，包在 `ConversationPaneContext` 里：只有当前列响应 ⌘F 这类聊天快捷键，另一列的输入框折成一行「回复这一列…」（输入框本身仍挂着，草稿不丢），等待批准的卡片照常显示、可以直接回答。检查器只有一个，放在最右边，标着它属于哪一列。点一列、在里面打字或按 ⌘1 / ⌘2 把它换到前面；⌘\ 退出分屏，再按一次把上次那一对按原来的左右找回来；关掉一列就剩另一列。两列都在屏幕上，所以哪一列跑完都不算未读。

规则在 `conversation-split.ts`（纯函数，有单测）：从侧栏选另一条会话时，它替换当前列；从总览、任务等别处选会话，分屏收起；两列的会话存在偏好里（`splitPanes`），重启后选中其中一条就恢复分屏。只有普通会话能分屏，任务聊天、定时运行、已归档的不行（`canSplit`）。每列至少要 400px，放不下两列（比如开着检查器的窄窗口）时只显示当前列，另一列从侧栏或 ⌘1 / ⌘2 切过去。

**`@` 引用与跨会话引用**

@ 菜单在输入框上方按「文件 / 项目」分标签（允许读取 Conclave 记录且 core 声明 `conversation-references` 时另提供「会话」分类），数量表示当前查到的匹配项。输入框使用 CodeMirror 编辑器，将文件、目录、项目与会话引用绘制为不可分割的行内标记；点击文件在文件面板中打开、目录或项目在文件管理器中显示，会话打开原聊天。跨会话引用复用 `history_read` 工具，按需读取引用会话记录，不切换当前工作目录。

会话不需要「停止」：发消息就会接着聊，状态只有运行中、等待确认和空闲。Agent 空闲 30 分钟后（没有回合在跑、没有后台命令或子 Agent 在跑、没有等你处理的请求、没有排队的消息），Conclave 会结束它的进程，下次发消息时再接着同一个会话启动，这一次要多等几秒。进程异常退出时，会话显示「异常退出」，发消息会重新启动它。

Claude Code 以 `claude -p --input-format stream-json --output-format stream-json` 运行，Codex 以 `codex app-server` 运行，Cursor 以 `cursor-agent acp` 或 `agent acp` 运行，OpenCode 以 `opencode acp` 运行，Pi 以 `pi --mode rpc` 运行。它们由 daemon 托管：关闭窗口、重启 core 都不会中断 Agent，core 重启后会接着读它的输出，没回答的确认请求也还在。

- **显示**：Markdown 格式的回复；工具调用卡片，包括命令和输出、文件改动的 diff；每个回合是完成、中断还是失败。等你处理的确认请求、提问和计划固定在输入框上方，不会被滚走：确认请求可以允许、本会话都允许或拒绝（可以附一句理由告诉 Agent）。输入框上方还有项目里未提交的改动（点开检查器）和 Agent 的待办进度，↑ 跳回你的上一条消息。
- **回复里的链接和图片**：网页链接（`http://`、`https://`）用系统浏览器打开。本机文件链接和行内代码中的文件名，点击后在右侧的文件面板中打开；支持多个标签、代码高亮、行号定位、搜索、自动换行、调宽和最大化。Markdown 显示源码，超过 2 MiB 或非 UTF-8 文本的文件会说明无法预览。图片文件（PNG、JPEG、GIF、WebP、SVG）仍显示缩略图，点开放大；网络图片不加载，只显示链接。连接旧版 core 时，文件点击仍在文件管理器中定位。
- **文件面板**：右侧工具栏的「文件」面板（状态栏按钮或 <kbd>⌘</kbd> <kbd>Shift</kbd> <kbd>E</kbd>）浏览和编辑当前会话或任务所在的那份代码：会话的项目目录、任务的 worktree，头部写明项目名和分支，切换会话时跟着换。没有会话时（总览等页面），或想看别的项目，可在头部选择最近用过的项目主目录；所选只在看同一个会话或页面时有效，换走就回到跟随。打开的文件按目录记录，同一 worktree 上的几个会话共用一组标签。<kbd>⌘</kbd> <kbd>P</kbd> 按名称在这些目录里查找文件（`projects.searchFiles`），在面板中打开。面板和检查器、终端、端口占同一侧，打开一个会收起另一个。`files.*` 方法除会话 id 外也接受目录列表 `roots`（core 声明 `project-files`），旧 core 只能浏览带会话的目录。
- **聊天右键菜单**：选中文字可复制选区，未选中时可复制所在消息或工具内容，工具输出复制完整原文；代码块和网页链接各有复制操作。文件右键可预览、复制绝对／项目相对路径、在文件管理器中定位，以及用系统默认应用打开；系统打开只在选择该菜单项时发生。文件标签和滚动位置按会话分别保留在当前窗口，重启后不恢复。
- **当前聊天搜索**：普通会话和任务聊天按 ⌘/Ctrl+F 打开搜索栏，匹配文字高亮，Enter / Shift+Enter 切换结果，Esc 关闭（不会中断 Agent）。输入搜索词时临时展开折叠内容并读取更早的聊天页，关闭或清空后恢复原有折叠状态；切换聊天会清空搜索。检查器、终端和弹窗的快捷键不被接管。
- **下一步建议**：Claude Code 回复完后，输入框里用灰字显示它预测的你下一句话，按 Tab 或 → 填入，直接打字就忽略。生成建议要再发一次简短请求（复用对话缓存，花费很少，但计入用量），在 设置 → 外部智能体 →「回合结束后建议下一步」里可以关掉。Codex 没有这个功能。
- **会话标题**：设置 → 会话 →「会话标题命名」默认「首轮总结」（第一轮成功完成后生成一次），也可选「每轮更新」（每轮成功完成后概括最新一轮主题）或「关闭」（沿用首条用户消息）。后台复用同一 Agent 的轻量任务模型，独立请求、不进主会话上下文，每次计入用量；失败保留原名。手动重命名始终锁定优先，任务、定时运行等固定标题不变。模式从之后完成的回合生效，不补跑旧记录；回合水位与轮数持久化，恢复历史不重复请求，旧结果不覆盖新标题，生成标题不改变列表的最近活动排序。
- **后台命令**：Claude Code 和 Codex 有，Cursor（ACP，Conclave 不提供终端能力）没有。Claude Code 是 `run_in_background`，靠 CLI 的 `task_started` / `task_notification`。Codex 是 unified exec（0.160.1 实测，默认开启）：命令带着短的 yield 返回、进程留在它的会话里，`commandExecution` 条目在回合完成后仍是 `inProgress`，输出照常流过来，进程退出时才 `item/completed`（录制样本 `codex-unified-exec.jsonl`）；Conclave 把回合完成时还在跑的命令记为后台命令，并且这期间不算空闲，否则空闲 30 分钟结束进程时会把它一起带走。Codex 不报时长上限，也不在命令结束后自己开一轮。模型用 `nohup … &` 自己脱离出去的进程，Codex 和 Conclave 都看不到。命令留在后台时，对话底部那行写出它是什么，几件时能点开列表跳过去（见 DESIGN.md）。Agent 给了 `timeout` 时，它就是这条后台命令的时长上限（Claude Code 2.1.288 实测：`timeout` 15 秒的命令正好 15 秒后被停掉），记为 `backgroundLimitMs`；没给时 CLI 有默认上限（实际观察到 30 分钟），但 CLI 不报这个数，所以不显示。CLI 停掉命令时状态都是 `stopped`：到上限的摘要写「…reaching its background time limit」，Agent 用 TaskStop 停的和会话结束时带走的只写命令本身，Conclave 据此只把前者记为 `stopReason: 'timeLimit'`（录制样本 `claude-background-limit.jsonl`）。
- **停止单个后台任务**：后台命令和 Claude Code 的后台子 Agent 在跑时，对话底部那行、它的列表和命令卡片上有「停止」，只停这一件，不碰回合（`conversations.stopBackground`，条目带 `stoppable`）。Claude Code 用 `stop_task` 控制请求按任务 id 停；Conclave 在 `initialize` 里声明 `perTaskStopAffordance`，CLI 因此在用户停回合时不再连带停掉后台子 Agent。停掉后报 `task_notification` 状态 `stopped`、摘要只有命令本身，不另开一轮（2.1.288 实测，录制样本 `claude-background-stop.jsonl`）。Codex 用实验接口 `thread/backgroundTerminals/terminate`，按 `commandExecution` 条目里的 `processId` 停，返回 `{terminated: true}` 后条目以 `failed`、退出码 -1 结束（0.160.1 实测，录制样本 `codex-background-stop.jsonl`）。要批准的命令在批准前就发了 `item/started`，`processId` 为空，之后也不补；这时驱动发一次实验接口 `thread/backgroundTerminals/list`，按 `itemId` 对上进程号再标 `stoppable`，每条命令只问一次（0.160.1 实测，`codex-background-approved-stop.jsonl`）。两边都记为 `stopReason: 'user'`，显示「已手动停止」，不算失败。
- **发消息**：Enter 发送，Shift+Enter 换行，Esc 或输入框右下角的按钮中断当前回合。Agent 处理时按 Enter，消息会排到这个回合结束后再发（再写一条会接在后面），发出前可以编辑或取消；回合被中断或失败时它不会自动发出，等你决定发还是不发。
- **权限模式、模型和推理强度**：在输入框下方切换。Claude Code 有逐项确认、自动接受编辑、规划和自动判断（模型支持时）；Codex 有逐项确认（`untrusted` 审批）、自动（`on-request` 审批加 `workspace-write` 沙箱，并且允许联网，和 Claude Code 一致）、规划（Codex 自己的 plan 模式，配 `read-only` 沙箱）和只读（`read-only` 沙箱）。权限模式随时可换，模型和推理强度要等回合结束。会话沿用它最后所处的权限模式（比如按计划执行后的「自动接受编辑」），以及你选过的模型和推理强度；Agent 进程不在时也可以改，下次发消息启动时生效。Codex 不继承 `config.toml` 里的审批和沙箱设置，会话的其他项目作为可写目录。
- **Cursor**：需要已登录且支持 ACP 的 CLI，最低接受版本为 `2026.10.01`，已实测 `2026.10.01-e373342`。先按官方说明安装 CLI 并运行 `agent login`，再「重新检测」。提供原生 Agent / Plan / Ask；模型与模型对应的推理强度来自 CLI 实时接口。Ask / Plan 是 Cursor 的原生行为，不代表 Conclave 提供操作系统沙箱；不提供自动接受编辑、全部放行或无人值守预约与例程；用量按月轮询（`DashboardService`），运行中没有实时上报。Conclave MCP 通过 `session/new` / `session/load` 的 `mcpServers` 逐会话注入，不改项目或用户的 MCP 配置；未成功加载时启动会明确失败。发出消息后 30 秒还没有任何事件，聊天里提示「还没有回应」并给出「停止并重试」；60 秒仍没有就停止这一轮（先取消，再按宽限结束进程），只提供「重新连接并重试」，不自动重发。Cursor 只在一轮有了进展后才保存会话，所以这样停下的会话 `session/load` 会报不存在：这时改用 `session/new` 开新会话，之前的记录按移交带过去，没得到回答的那条不带（重试会再发它）。仅规划阶段的 Conclave MCP 只提供只读工具。
- **OpenCode**：需要 OpenCode 2.x（1.x 的配置格式不同，显示为需要升级），已对照 2.1.1 的 ACP 源码实现。它没有自己的账号，能不能回答取决于 `opencode auth login` 配过的模型服务商，所以不检查登录。权限模式就是它的 primary agent：逐项确认对应 Build，规划对应 Plan；自动、只读和全部放行对应 Conclave 启动时加的 `conclave-auto`（项目内编辑、跑命令直接做，访问项目外和读 `.env` 直接拒绝而不是问：OpenCode 一被拒绝请求就结束整个回合，按规则拒绝则只是工具报错、接着做，无人值守的运行因此不会被请求打断）、`conclave-readonly`（拒绝编辑，运行命令和访问项目外前先问；OpenCode 自带的 Plan 只拦编辑，仍能跑 shell）和 `conclave-bypass`（什么都放行，只在设置允许全部放行、且不是规划或只读阶段时才加）。OpenCode 的 agent 默认什么工具都放行，Build 不会弹审批卡，除非用户在自己的 OpenCode 配置里设了 `ask`；所以 Conclave MCP 的终端命令由 Conclave 在聊天里确认（`mcpApproval: 'conclave'`）。模型和推理强度来自会话的 config options，模型 id 是 `provider/model`；还没聊过时用 `opencode api --standalone GET /api/model` 列模型，只取启用的（`opencode models` 会列出所有服务商的所有模型）。你拒绝请求时，它不带理由地结束这一轮，所以理由作为下一条消息发过去（`denialAsMessage`）。附加项目和可写的知识库走 ACP 的 `additionalDirectories`，用户 MCP 走 `mcpServers`；加的这几个 agent、技能 bundle 和 Conclave 自己的 MCP 服务写进 `OPENCODE_CONFIG_CONTENT`（2.x 的格式，服务器在 `mcp.servers` 下），只对这个进程生效，不改用户的 `opencode.json`。Conclave MCP 不走 `session/new`，因为 OpenCode 2 默认把 MCP 工具收进 Code Mode（模型写一段调用 `tools.<服务器>.<工具>()` 的 `execute` 脚本），聊天里就认不出预览、截图这些 Conclave 工具；只有配置里能给服务器设 `codemode: false`，这时工具名是 `<服务器>_<工具>`，dialect 按 ACP 的 `name` 把 `conclave_x` 认成 `conclave.x`（`AcpDialect.ownMcpOnCommand`）。配置里的服务器和会话并行加载，第一条消息可能赶在工具注册之前：服务器带 `--ready-on-list`，在 OpenCode 列出工具后写 ready 文件，阶段等它出现、再等 1.5 秒让 OpenCode 收进工具（它防抖 100ms 后重载，实测不到 1 秒），之后才发第一条消息。可以定时和例行运行，但读不到它的额度，所以「自动选择 Agent」的例行任务不会选它。它的 `session/fork` 只能复制整个会话：从最新一轮分叉时原生 fork，从更早的消息分叉时按可见记录开新会话。不接它的表单提问（它会让模型自己说明假设后继续）；子 Agent 的工具调用带着子会话标题前缀显示在父会话里。
- **Pi**：需要 Pi 0.99 以上（`pi.registerMcpServer` 从 0.99 起才有），说的是 Pi 自己的 RPC 模式（stdin 一行一条命令，stdout 一行一条应答或事件，`agents/pi/pi-rpc.ts`），不经 ACP 桥（社区的 pi-acp 不把 `mcpServers` 交给 Pi，也没有审批）。事件形状对照 orca 录下的 Pi 1.0.4 真实会话实现：`agent_end` 之后还可能重试或压缩，`agent_settled` 才是一轮结束；中止后回复的 `stopReason` 是 `error`，按停止处理。它没有自己的账号，不检查登录；`get_state` 报出的模型是 `unknown` 又没有可用模型时，提示去终端 `/login`。Pi 不做任何审批，所以「默认」和「全部放行」都是 Pi 原样运行；「自动」「规划」和「只读」由 Conclave 自己的扩展守着，都是直接拒绝而不是问，所以「自动」也能用于定时任务和例程（全局的无人值守模式默认就是它）：启动前把扩展源码（`agents/pi/pi-extension.ts`，纯 JS，无构建）写进会话目录，以 `--extension` 交给 Pi（`launch.prepare` 返回的 `args`），配置经环境变量 `CONCLAVE_PI` 传入。扩展做三件事：用 `registerMcpServer` 注册 Conclave MCP 和用户选的 MCP，`exposure` 设为 `direct`（默认的 `codemode` 会把工具藏起来，聊天里认不出预览、截图）；注册 `/conclave-mode <模式>` 命令，切模式不经模型（Pi 对它回 `disposition: handled`）；在 `tool_call` 里拦下：自动模式下用 edit、write 改工作目录、其他项目和可写知识库以外的文件（bash 拦不住，命令照常跑）；规划和只读模式下的编辑、写入、不在白名单里的 bash（只认不带管道和重定向的只读命令）、不在只读清单里的 MCP 工具；任何模式下对只读文件夹（规划阶段、只读成员的目录，不可写的知识库）的编辑。Pi 没有规划模式，规划模式下每条消息前在线路上加一句说明（聊天和日志里只有消息本身），回合结束时把最后的回复当作计划，按 Codex 的方式交出。Pi 的扩展对话框（select、confirm、input、editor）一律回 `cancelled`，`notify` 显示成提示。Conclave MCP 的终端命令由 Conclave 在聊天里确认（`mcpApproval: 'conclave'`）。会话是一个文件：`get_state` 的 `sessionFile` 就是会话 id，Pi 写入第一条消息后才算有会话可接；续接用 `--session <文件>`，从最新一轮分叉用 `--fork <文件>` 整个复制，更早的分叉按可见记录开新会话；会话绑定目录。文件不在时 Pi 不报错，而是在原路径开一个空会话（1.3.0 实测），所以续接时 `get_state` 报 0 条消息就当作会话丢失，改用交接。edit 的卡片用它结果里的 `details.patch`（带行号和上下文的统一 diff），没有时才按参数拼。模型 id 是 `provider/id`，推理强度按 Pi 的规则列出（推理模型默认有 off 到 high，`thinkingLevelMap` 里设为 null 的去掉，xhigh、max 要在映射里才有）；没聊过时用 `pi --mode rpc --no-session` 列模型，不留会话文件。记住的模型和推理强度在握手后用 `set_model`、`set_thinking_level` 设置，不放命令行。Conclave 的启动说明、其他项目文件夹和只读文件夹走 `--append-system-prompt`（Pi 没有附加目录的参数，靠绝对路径访问），技能 bundle 走 `--skill`。正在跑的回合可以插话（`streamingBehavior: steer`），排队用 Conclave 自己的队列。每轮的 token 和花费来自每条助手消息的 `usage`。读不到额度，「自动选择 Agent」的例行任务不会选它。不在服务商上时，用的是用户在 Pi 自己的 `~/.pi/agent/models.json` 里配的服务商和模型；在服务商上见下文。
- **全部放行**：支持它的 Agent（Claude Code、Codex）都提供这个模式，但从不默认选中，对应 Claude Code 的 `bypassPermissions`，以及 Codex 的 `never` 审批加 `danger-full-access` 沙箱：Agent 不再请求确认，也不受沙箱限制。
- **规划**：Agent 在规划模式下拿出计划时，右侧的检查器会自动打开到「计划」页显示全文，每一版计划和它的处理结果都留在那里；输入框上方可以按计划执行（之后自动接受编辑，或者逐项确认），也可以附上意见让它继续规划。Cursor 使用原生 `cursor/create_plan` 审批，确认后等待 Agent 模式切换成功再接受计划。Cursor 的分叉会复制可见历史并新建会话，让新会话读自己的分叉记录，不使用原生 fork、也不按移交处理；OpenCode 只在从最新一轮分叉时原生 fork（见上）。Codex 的计划在回合结束时交出，按计划执行就是用选定的模式（自动或逐项确认）接着发一回合；直接发消息算作继续规划。Pi 同样在回合结束时交出计划，执行前先发 `/conclave-mode` 切到选定的模式（默认或自动）。
- **上下文**：输入框右下角的圆环显示上下文窗口用了多少，超过 60% 变黄，超过 85% 变红。
- **无人值守**：定时任务、例行任务和预约的消息由 core 标记为无人值守（`ConversationService.markUnattended`），之后这条会话里 Agent 问的事都由 core 按运行模式代答，不会停在「等你确认」：全部放行时允许这一次（不选「总是允许」，那可能超出这次运行，比如 OpenCode 会把它记到项目里）；自动模式下拒绝，并告诉 Agent 换一种在项目内的做法，做不到就写进总结；提问不作答，让它按合理假设继续并在总结里写明；计划直接批准。代答在 ChatHost 算出「等你确认」之前完成，所以不会闪一下或发通知。你在这条会话里发消息或回答请求后，就改回由你处理。标记只在内存里，core 重启后请求照旧等你。规则在 `unattended-answer.ts`。
- **通知**：窗口不在前台时，Agent 等你允许或回答、这一轮做完、异常退出，都发一条系统通知，点它回到那条会话或任务（任务的聊天用任务的标题）。Dock 图标上的数字是等你处理的会话和任务有几个：Agent 在等你、你没看到的做完的回合、任务里等你回复的 Agent，一个任务的聊天只算一次（macOS 和 Linux；Windows 没有角标）。设置 → 通知 可以关掉通知，角标不受影响。macOS 第一次会问要不要允许 Conclave 通知。
- **记录**：每个聊天阶段把收发的每一帧写进 `sessions/<id>/stages/<阶段 id>.jsonl`，聊天界面就是从它重建的。用户消息和最终回复也记进会话消息，标题、搜索和移交都靠它们。Cursor 的 ACP 流式增量落盘，用于重建中途停止的回复；其他 Agent 的增量依各自协议处理，Codex 被中断的回合里只流式显示过的半截回复，重新打开后就没有了。
- **和 Agent 自己的终端界面的区别**：没有 Agent 自己的快捷键；斜杠命令在输入框里输入 / 选用（Codex 只有 /compact、/review 和技能）。Claude Code 在 `-p` 模式下不会弹出「是否信任这个目录」的确认，请只在你信任的项目里用 Conclave。Codex 的 app-server 还在实验阶段，版本太旧、没有 app-server 时会明确提示。
- **需要新的 daemon**：聊天界面依赖 daemon 的新方法。如果运行中的 daemon 是更早的版本，新建会话会提示重启它（`pnpm dev:daemon`）；重启 daemon 会结束它正在托管的 Agent 和终端。
- **提交并推送**：会话空闲时，点标题旁的分支，在项目下选择「Commit & Push」，确认提交信息后即可提交这个仓库的全部改动并推送当前分支；没有 upstream 时自动使用 origin。多项目会话分别操作每个仓库。

### 额度节奏与建议

服务方只给每个窗口的已用百分比、长度和重置时间，不给 token 数，所以建议全按百分比算。判断是确定性的算法，不问模型：问模型本身就花额度，而且选择器、启动确认和例程都要当场有结果。规则在 `packages/protocol/src/quota-pace.ts`，core 和客户端共用：

- **节奏**（`windowPace`）：按窗口已过去的时间外推到重置。窗口过去不到 10% 不判断；预计超过 110% 是「偏快」，给出照这个速度用完的时间；剩不到四分之一的时间、预计至少 25% 用不上是「用不完」。
- **建议**（`agentAdvice`）：5h 窗口用完或偏快时等重置；周、月窗口偏快时放慢或把轻活交给别的 Agent；按模型的限额（如 Opus 本周）到 80% 或偏快时换其他模型；周、月窗口用不完、5h 也不紧时多用，并指出哪个模型的限额也宽裕。共享窗口已用完、数据过时（超过 `QUOTA_STALE_MS`）时不劝多用。只提示，不替用户换 Agent 或模型。
- **排序**（`rankAgents`）：先按有无额度，再把偏快的往后放，快过期还剩很多的往前放，最后看剩余；全用完时先重置的在前。例程的「自动」按它挑 Agent。`recommendAgent` 只在第一名明显好过第二名时给出推荐。
- **客户端**：用量卡片显示建议和每个窗口的节奏，状态栏上有建议的 Agent 带一个小圆点；新会话、新任务、开始任务和任务执行者的选择里标「推荐」，默认选中的不变；启动确认框推荐换用排第一的 Agent。窗口不在前台时，周、月额度 24 小时内重置且会剩很多、或照现在的速度会提前用完，每个窗口周期各通知一次（已发的记在 localStorage），用完的窗口恢复时也通知一次；点通知打开那个 Agent 的用量卡片。设置 → 用量额度 →「额度建议与提醒」可以全部关掉。

### 小模型用量与节省估算

深度用量分析、额度预测和按账号自动化见 [用量账本与额度自动化](USAGE-ANALYTICS.md)。它在总览统计中单独汇总 Conclave 内外的消耗，不改变任务验收率等工作指标。

Web 前端已移除回复翻译入口与翻译设置；core 的 `conversations.translate` RPC 和历史用量仍保留，供兼容客户端使用。总览「统计」里的「小模型省下」和用途明细继续统计翻译、提交说明与会话标题。美元均标注「按 API 标价折算」，不代表订阅账号的实际扣款。按完成日期、客户端时区和所选时间范围汇总，分别注明有多少次能计价和估算；未知金额不作为零参与合计。标题用途通过 `includeTitleCosts` 显式请求，旧客户端不接收新枚举项。

- **模型差价**：同一份输入、输出和缓存用量按主模型计价，减去小模型花费。
- **上下文节省**：开始时主会话上下文 token × 模型调用次数 × 主模型缓存读取单价。提交说明计入，翻译不计入。
- **约省**：两部分相加后逐次取 `max(0, 差额)`，不计负值；小模型花费只扣一次。假设缓存仍热，不算这些问答以后留在主会话里的开销。缺少主上下文时只算模型差价，缺少价格或可计价用量时不估金额。失败、中断只记录已报告的用量和花费。

`SmallModelStore` 保存独立的 SQLite 账目（`small_model_jobs`），在请求实际开始时保存主模型、上下文及价格表快照，完成时保存金额；删除会话不删除账目，价格表更新不重算历史。从此功能上线起记录，不补旧费用。翻译缓存命中、分支名生成不新增这些账目。

完整价格表按内容哈希保存在 `small_model_price_versions`，同一版本只存一份，账目引用开始时的版本；计算结果只保留本次使用的去重单价。升级时分批迁移已有快照，不重新计算历史金额，未结束的请求恢复后仍用原版本计价。「统计」只读取独立的精简摘要，按模型合并 token，不加载每笔的完整用量和计算依据。目前保留全部账目，未设置明细过期或按日归档。

Agent adapter 解析一次性命令的结构化输出：Claude 的 JSON、Codex 的 JSONL（答案仍读输出文件）、Cursor 的 JSON。回合的可选 `metering` 保留缓存读写和实际模型；Claude 用 `num_turns`，Codex 从去重后的累计用量增长保守估算调用，无法识别时按一次。说 ACP 的 Agent 在回合结束时读 `session/prompt` 返回的标准 `usage`：输入算上缓存读写（OpenCode 的 `inputTokens` 不含命中缓存的部分），输出算上推理，回复底下显示 ↑ / ↓；花费取 `usage_update` 里会话累计的 `cost`，一轮的花费是这轮前后两次累计之差，恢复的会话在第一轮里还不知道之前的累计，就记为未提供。OpenCode 两样都报。Pi 不走 ACP，每条助手消息带自己的 `usage`（含缓存读写和 `cost.total`），一轮按模型累加，调用次数就是助手消息数。Cursor CLI（实测 2026.10.01）都不报，所以 Cursor 的回合仍没有用量，等它的 CLI 报了自然就有。`usage_update` 的上下文大小只用于上下文占用，不能视作消耗的 token。缓存写入时长或长上下文档位无法确定时保留已有 token，金额降级为未提供。

模型价格是 Agent 描述符引用的纯数据，来源及更新日期见 `protocol/src/agents/model-prices.ts`，支持缓存类别、长上下文档位和已公布的生效日期；未解析的别名、未知模型不猜价格。协议增加 `small-model-stats` feature 和可选字段，不提升版本。新客户端用 `dashboard.stats.includeSmallModels` 请求新统计，同时将翻译、提交说明 token 加入原合计、每日趋势和模型明细。老客户端未请求此字段时保留原统计口径。

### 上下文与恢复边界

会话由 `ConversationService` / `ConversationStore` 管理，阶段记录当前 Agent 与原生会话 id；`ChatHost` 和各 driver 将输入、输出及事件写入可回放日志。core 重启可重新连接 daemon 中仍存活的进程；daemon 本身退出则不能保住原进程，后续能否原生恢复由 adapter 与上游 CLI 决定。

`ChatOptionsBar` 的 `ContextRing` 只展示 Agent 上报的上下文占用，不会在达到 80% 时触发统一的滑窗压缩。压缩事件和原生命令由对应 driver 处理；跨 Agent 移交传递可见历史，不能替代原生上下文。阶段结束、会话停止和 worktree 删除是不同生命周期：任务完成或删除不自动删除工作树，清理规则见第 3 节。

### 会话与 Agent 移交

普通新会话的首条消息使用 `durable-initial-message` 能力：客户端先创建延迟启动的会话，再用稳定的 `ref` 调用 `conversations.submit`。core 将正文、图片、引用和投递状态存入会话的 `initial_message` 后立即回执，再独立启动 Agent 并投递。页面只显示 core 的状态；回执前保留本地乐观副本，断线时用相同 `ref` 和内容重试。旧 core 仍走客户端 `continue`、`send` 流程。任务与自治流仍由各自的调度器投递。

首条消息经历 `accepted → starting → sending → sent`；`sent` 表示 daemon 已确认写入进程输入，不代表模型已经回答。启动或发送前失败保留内容和错误，用户明确重试后重新启动。相同 `ref` 和内容的重复请求返回已有状态，不再投递；更换内容或再提交另一条首条消息会被拒绝。投递中不能修改 Agent、配置、项目或归档、删除、停止会话，避免改变已接受消息的目标。core 重连 daemon、接回存活进程后，自动恢复 `accepted`、`starting` 的消息，并等握手完成才发送。出站日志写在 daemon 写入之前，不能证明进程已接收；`sending` 跨重启或有出站记录的写入失败显示 `uncertain`，不自动重发，由用户检查会话后决定后续消息。

dsh 启动环境保留已有 `NODE_OPTIONS` 并追加 `--report-exclude-network`。dsh 的文件锁依赖为判断 glibc 调用完整 Node 诊断报告，网络诊断可能对已连接地址做反向 DNS 查询并等待超时；该选项仅省略报告的网络诊断，保留 glibc 检测和普通联网。选项只作用于 dsh 子进程及其后代，不修改 core 的全局环境。

侧栏在「会话」中展示普通会话历史，沿用排序、分组、置顶、归档与全文搜索设置。

任务在看板里管理：点侧栏的「任务」打开（入口上的数字只数等你处理的任务：Agent 在等批准或回答、等你回复，或异常退出；执行中和只等验收的不算），按 未执行 / 执行中 / 待验收 / 已完成 分列，卡片上给出当前这一步的操作，顶部可以搜索、筛选、排序。侧栏的「进行中」列出执行中和待验收的任务，方便来回切换；下面是「会话」列表。两个入口都把用户选择的代码目录称为「项目」，都可选多个。新建会话可选 Claude Code、Codex 或 Cursor；不选项目时使用持久的 `~/.conclave/sessions/<会话 id>/workspace/`，不会在 home 或 Conclave 仓库中隐式运行。选多个项目时，第一项是主项目，项目选择器里用高亮颜色标出；创建前可以右键其他项目，选「设为主项目」调整。主项目是默认工作目录，其余项目作为附加目录开放给 Agent（Claude Code 用 `--add-dir`，Codex 通过协议设置目录权限；Cursor 仅在 ACP 声明支持附加目录时接受多个项目，当前验证版本不支持）；所有目录均原地使用，不创建 worktree 或分支。会话创建后不能更换项目列表或主项目，后续继续或移交仍使用相同的项目列表和 Agent 自身的交互审批。

会话直接在你的项目目录里工作，所以切分支切的是你自己的 checkout。会话标题栏的分支标签点开后，每个 Git 项目下有「切换分支」和「新建分支」：切换时列出本地和远端分支（可搜索，选远端分支会建一个跟踪它的本地分支），当前分支和已在其他 worktree 里检出的分支（比如任务的 `conclave/*` 分支）不能切：后者写明被谁占着（主目录、哪个会话，已归档的会注明，或其他工具建的 worktree 的目录名，由 core 的 `branchHolders` 判断），点开说明原因，并给出打开那个会话、去 worktree 管理或在访达中显示；新建分支从当前提交拉出，未提交的改动一起带过去。Agent 在工作时不能切换，要等这一轮结束；有未提交的改动时不切换，先提交或暂存；还有别的会话开着 Agent 用同一个目录时会提醒你。切换后检查器里的改动从新的 HEAD 算起。Agent 会在你下一条消息前看到一句说明，告诉它每个项目现在在哪个分支。

会话头部的检查器按钮打开右侧的**检查器**（有项目时才有）：「本次会话以来的提交」以新建会话时记下的各项目 HEAD 为起点；「还没提交的改动」和当前 HEAD 比较，包括没加入 git 的文件，点开能看 diff。项目目录是和你共用的，所以这里也可能包含你自己的改动。旧会话没有记录起点，只显示还没提交的改动。

「移交」会先在 Agent 工作时请你确认停止，然后启动另一种 Agent。Conclave 将已记录的可见用户消息、最终回复和本次补充说明写入 `sessions/<id>/handoffs/`，提示新 Agent 阅读文件并检查当前目录、Git 状态和测试。切回曾用过的 Agent 时，恢复它原来的 provider 对话（Claude session / Codex thread / Cursor session），并补上它离开期间的结构化历史。隐藏推理、未暴露上下文及 provider 专属能力无法移交。

在输入框里选好接手的 Agent 后，旁边可以选它启动用的权限模式、模型和推理强度（`conversations.handoff` / `tasks.handoff` 的 `permissionMode`、`model`、`effort`，权限模式要 core 有 `handoff-mode`）。权限模式的候选是这个 Agent 新会话能用的模式（`startModes`）；默认沿用会话当前的模式，它没有这个模式时（比如从 Claude 的「自动接受编辑」交给 Cursor）预选它自己的默认模式，所以移交前就能看到会退回到什么模式。core 会在停掉原来的 Agent 之前检查选的模式它有没有。还在规划中的任务移交后仍然只能规划，所以不提供选择。

设置 → 会话 →「自动归档不活跃的会话」默认关闭；打开后选 7、14、30、60 或 90 天。core 启动一分钟后检查一次，之后每小时一次，设置变了也立即检查：最后一条消息（`updated_at`）和从归档取出的时间（`restored_at`）都早于这个天数的普通会话，按手动归档的同一路径归档。置顶的、任务的会话不在其列；Agent 正在工作、正在启动或在等批准、回答问题的会话归档时会被拒绝，留到下次检查。从归档取出不改 `updated_at`（列表顺序不变），但自动归档把它算作一次活动，不会马上又被收回去。

在会话列表里右键选「删除会话」。core 收集会话各阶段的原生会话，停止相关进程后清理原生历史、关联索引及 Conclave 聊天记录。仍被其他会话使用的原生记录延后到最后一个引用删除时清理。**无论外部还是 Conclave 托管的工作目录及 worktree 都会保留**，因为其中可能有唯一的工作成果。停止或归档会话保留原生历史。

`ConversationDeletion` 将删除清单和每项进度存在 SQLite；删除期间禁止继续发消息、恢复和分叉。清理失败保留定位信息，界面显示原因并可「重试清理」，core 重连 daemon 后继续未完成任务。适配器通过独立的 `nativeSessions` 能力定位、枚举子会话和删除；不能用外部导入扫描代替，因为它会过滤自建和子 Agent 记录。原生清理需要的 CLI 和 ACP 进程由 daemon 托管；共享历史目录按实际路径和会话标识识别。

阶段日志中的明确原生子会话事件也参与归属收集。Conclave 进程通过 `CONCLAVE_NATIVE_SESSION_LOG` 将归属日志传给工具进程；DSH 的专用 runtime 在创建会话时登记 ID、目录及 DSH home，包括没有发消息的诊断会话。未经过此登记的历史脚本会话不能按标题或创建时间推断归属；不会扫描并删除其他用户会话。

### 导入终端里的会话

设置 → 导入会话（首次打开时新手引导和总览也会列出最近几个，见「首次使用环境引导」）列出 Claude Code、Codex、ZCode、Pi 和 Antigravity 在 Conclave 之外跑过的会话（`session-imports.ts`），勾选后各导入成一条会话，下一条消息用 Agent 自己的恢复接着聊。读哪里、怎么读归 adapter 的 `transcripts`（`agent-transcripts.ts`），没有它的 Agent 不出现在列表里：

- **Claude Code**（`claude-transcripts.ts`）：`$CLAUDE_CONFIG_DIR/projects/*/<会话 id>.jsonl`（默认 `~/.claude`），会话 id 取文件名，目录取记录里的 `cwd`，不从目录名反推。从最后一条主线记录沿 `parentUuid` 往回走（压缩处接 `logicalParentUuid`），/rewind 丢掉的分支和 sidechain 不算；`isMeta`、压缩摘要和 CLI 自己注入的用户轮次（`<local-command-…>`、`<system-reminder>`、`<task-notification>` 等）跳过，斜杠命令显示成 `/命令 参数`。标题依次取 `custom-title`（用户 /rename 的，导入后锁定）、`ai-title`、`summary`、第一条提问。`<id>/subagents/` 不是会话。
- **Codex**（`codex-transcripts.ts`）：`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl`，旧的已压成 `.jsonl.zst`，两份都在时读没压的那份（Codex 还在写它）。第一行 `session_meta` 的 `source` 是对象（子 Agent、审查）、`thread_source` 不是 `user`，或 `originator` 是 Conclave 自己（`CODEX_CLIENT_NAME`）的线程不算。内容按回合读 `event_msg` 里的 `item_completed`，回合以 `task_complete` / `turn_aborted` 收尾；更早没有这些事件的 rollout 只显示消息。标题取 `session_index.jsonl` 的 `thread_name`，没有就用第一条提问。

Claude 和 Codex 扫描会话文件头并缓存摘要；其他格式由各 adapter 处理。Pi 读取 `~/.pi/agent/sessions`（可由 Agent 配置覆盖），ZCode 读取本机 SQLite 会话库，Antigravity 读取 `~/.gemini/antigravity/brain` 及摘要数据库。隐藏的有：`conversation_stages` 里已有、却不是导入来的会话（Conclave 自己跑的），目录在 `CONCLAVE_HOME` 或临时目录下的。目录已不存在的列出但不能选，因为 Claude 只能在原目录恢复。

导入新会话时建一条不启动的会话（`create(..., deferStart)`，项目就是原目录，不建 worktree），再由 `ConversationService.importStage` 补一个已结束的 stage：`provider_session_id` 是原会话的 id，聊天记录写成 `item` 记录（各 driver 原样放进条目，不写 `exit`，否则会被当成没启动成功），用户消息和每轮最终回复写进 `conversation_messages`（Claude 恢复要先看到这些消息，标题、搜索、`history_read` 和移交也读它们）。之后和重启后继续一样：`startStage` 找到这个 stage，Claude 用 `--resume`，Codex 用 `thread/resume`；原会话不在了照常退回移交文件。

`session_imports` 表记每个导入的会话导到哪条记录（`imported_through`）和当时文件的修改时间。文件之后又改过，而改动时间不落在这条会话任何 stage 的 `[开始, 结束 + 2 秒]` 里，就算在终端里又聊过，列表标「有更新」；Conclave 自己恢复时也写同一个文件，这段时间的改动不算。再导入一次，只取时间晚于 `imported_through`、又不在这些区间里的记录，作为一个新的已结束 stage 接在后面，原会话 id 不变，下一次仍从它恢复。会话的 Agent 正在运行时不导入。删除导入会话时，`purgeImported` 会尝试通过 adapter 的 `transcripts.delete` 删除底层原生会话存储，并移除导入标记。源记录不可找到或删除失败时不保证原生记录消失；失败会写入 core 日志。

### 新增 Agent

一个 Agent 的全部知识分在三处注册表里。三处都写成 `satisfies Record<AgentKind, …>`，漏掉任何一处都过不了 typecheck。除注册那一行外，其余代码只问注册表，不判断 Agent 的名字：

1. **protocol**：在 `packages/protocol/src/agent.ts` 的 `AGENT_KINDS` 里加 id，新建 `packages/protocol/src/agents/<id>.ts` 写一个 `AgentDescriptor`，再登记进 `agents/index.ts` 的 `AGENT_DESCRIPTORS`。descriptor 是纯数据，core 和各客户端共用，内容包括名称、它怎么称呼 Conclave 的权限模式、新会话的起始模式、只读排查模式（`discussionMode`）、能力开关（`unattended`、`bypass`、`autoMode`、`pathMentions`、`optionsWhileBusy`）、安装和登录提示、用量重置在哪里用，以及它在 limitreset.net 上对应的产品（`resetTracker`，可选）。core 每小时请求一次 `https://limitreset.net/api/v1/status`（手动刷新用量时也请求，至少隔 5 分钟）；它的 Codex 数据转自 Codex Resets，所以当它连不上，或它自己同步 Codex Resets 失败、超过 6 小时没成功（`discovery`）时，Codex 改问 `https://codex-resets.com/api/v1/status`（没有概率，其余照常），两边都失败就保留上次的结果。把各产品最近一次全员重置、已预告但未生效的重置、48 小时内再次重置的估算概率，作为 `AgentUsage.globalResets` 随用量推给客户端；设置 → 用量额度里可以关掉（`ChatSettings.resetAnnouncements`，默认开），关掉后不再发请求。数据由社区汇总自 X 上的公告，未经核实，界面注明非官方并按 LimitReset 的要求注明来源。界面只读这些数据，不自己编码规则。
2. **core**：新建 `packages/core/src/agents/<id>/`，写一个 `AgentAdapter`（`agents/agent-adapter.ts`），再登记进 `agents/index.ts` 的 `AGENT_ADAPTERS`。adapter 负责以下几项，大多可选，没给就走默认实现：
   - 必填：driver（实现 `ChatDriver`）、启动命令（argv 数组，需要时加环境变量 `env`）、能用的权限模式、会话策略（是否预先指定会话 id、会话是否绑定目录、原生 fork 能从任意一轮、只能整个会话复制（只用于从最新一轮分叉），还是不支持）。
   - 可选：模型目录、环境检测、登录检查、用量读取、使用重置卡（`useResetCredit`，没有它就只能在 Agent 自己的应用里用）、CLI 安装命令、应用发现。
   - 可选 hooks，用于命令行之外的特殊需求：启动前后的准备（`launch`，`prepare` 可以换可执行文件，也可以追加它刚写出的文件的参数，比如 Pi 的扩展）、回合处理（`turns`：串行发送、取消后分阶段停止进程、首帧超时、换新进程重试、拒绝理由作为消息发送）。注册时 `checkAdapter()` 会检查这些 hooks 是否配套，比如声明了首帧超时，就必须同时能停进程、能重试。
3. **web**：放一个图标资源，登记进 `packages/web/src/components/icons.tsx` 的 `AGENT_MARKS`。

说 ACP 的 Agent 不用另写 driver：`agents/acp/acp-driver.ts` 讲标准协议，Agent 自己的部分写成一份 `AcpDialect`，然后用 `new AcpDriver(dialect, …)` 创建 driver。dialect 至少要有显示名、请求 id 前缀（会写进日志，定下后不能改）和权限模式映射；扩展认证方式、模型列表、提问、计划审批、子 Agent、工具命名、写进回复的传输错误等，都按需声明。Cursor 的 dialect（`agents/cursor/cursor-dialect.ts`）扩展最多，OpenCode 的（`agents/opencode/opencode-dialect.ts`）几乎只用标准协议，都可以作参照。`agents/acp/acp-driver.test.ts` 用一个什么扩展都不带的 dialect 跑完一整个回合，新 dialect 可以从它开始。说自有协议的 Agent 要写自己的 driver，Pi 的 `agents/pi/pi-rpc.ts` 是最小的一份：一切从 `apply()` 来，流式增量不进日志，由完整消息补齐，所以从日志重放和实时得到同样的条目（`pi-rpc.test.ts` 逐份 fixture 对比两者）。

`agents/agent-registry.test.ts` 检查每个 adapter 提供的权限模式和 descriptor 里写的完全一致，并检查声明的 hooks 都有对应实现。

DeepSeek Harness 使用同一 ACP driver；`packages/dsh-runtime` 在官方导出的 ACP `apply` 上接入消息 stream，保留官方会话、模型、MCP 和取消实现，补充权限模式、提问及计划审批。服务商和技能作为启动覆盖层，文件与命令提供者按当前模式和项目范围实施限制；恢复会话先重设权限再交给 driver。插件随构建打包成 tarball，首次使用时准备 DSH 的专用 `conclave` profile，按内容摘要更新，不修改其他 profile。安装和兼容边界见 [DeepSeek Harness](DEEPSEEK.md)。

Antigravity 也只是一份 dialect（`agents/antigravity/`）：`agy` 本身不说 ACP，跑的是 Google 发到 ACP registry 的 Antigravity ACP 服务。它没有安装器，Conclave 按版本钉住各平台压缩包的 SHA-256，用 adapter 的 `installation` 下载到 `~/.conclave/runtimes/antigravity-acp/<版本>/`；`installWithoutApplication` 让这条安装命令不必先检测到 Antigravity 应用。细节见 [Antigravity](ANTIGRAVITY.md)。ACP 恢复优先使用旧 Agent 已声明的 `loadSession`，仅声明 `resume` 时使用 `session/resume`。

Gemini CLI 也复用通用 ACP driver（`agents/gemini/`）：文本模式通知、缺少 rawInput 的工具摘要、按文件路径审批的计划、缓存已包含在输入 token 的用量口径由 dialect 声明。计划正文从已完成工具 diff 保留的完整 newText 取，不读磁盘。adapter 的 `session.nativeResume: false` 让停止后继续和重启走历史移交，避免 CLI 的晚到历史重放混进新回合；其他 Agent 缺省沿用原生恢复。源码运行的 MCP 使用当前 Node 和 tsx；每日额度按模型读取 Code Assist API，客户端声明支持 daily 后才接收。细节见 [Gemini CLI](GEMINI.md)。

ZCode 不说 ACP，有自己的 driver（`agents/zcode/zcode-app-server.ts`），讲它桌面端用的 ZCode Protocol：命令走 `v4/command`，会话内容是订阅来的快照加行增量，审批和提问是 ZCode 发来的请求。协议没有公开的 schema，`zcode-schema.ts` 只宽松地写用到的部分。细节见 [ZCode](ZCODE.md)。

Kimi Code 使用官方 `kimi acp` 和通用 ACP driver，dialect 负责四种原生模式、工具命名，以及由权限请求承载的单选提问和计划审批。需要 Node.js 版 CLI 2.3.2 以上，恢复会话沿用标准 ACP；原生 fork 会保留来源 MCP，改用交接以隔离会话权限。安装、权限及用量边界见 [Kimi Code](KIMI.md)。

Grok CLI 也复用通用 ACP driver（`agents/grok/`）：通过官方 `grok agent stdio` 接入。启动命令仅传递 `['agent', 'stdio', '--no-auto-update']`，多项目目录通过 ACP 协议 `additionalDirectories` 与 `startNote` 提示词告知；支持 Default、Plan、Auto 和 YOLO（Bypass）四种权限映射，通过环境变量 `GROK_DEPLOYMENT_KEY`、`XAI_API_KEY`、`GROK_API_KEY` 或 `~/.grok/auth.json` 校验认证状态，并支持每周额度展示。细节见 [Grok Agent](GROK.md)。

omp 也复用通用 ACP driver（`agents/omp/`）：通过 `omp acp` 接入，启动时固定 `--approval-mode write`，让普通文件写入直接进行、命令与破坏性编辑交给 ACP 权限请求；多项目目录在命令行用 `--add-dir` 交给它。omp 的 ACP 只有 Default 与 Plan：Plan 会在同一回合里自行批准并离开，不能保证规划阶段只读，所以只把 Default 映射为 Conclave 的「自动接受编辑」，不提供规划、只读、无人值守和全部放行。模型目录来自 `omp models --json`，默认模型取 `modelRoles`；MCP 服务器随 `session/new` 传入，ACP 模式不自动读取磁盘上的 omp MCP 配置（设置页只把 `~/.omp/agent/config.yml` 标为它自己的来源）。细节见 [omp](OMP.md)。

### 项目 Star

设置 → 支持与反馈集中提供项目地址、GitHub Star 和 GitHub Issues 反馈入口，交流尚未开放时显示文字占位；关于页显示 Web 端版本、协议版本、Conclave core 连接状态和 Git。支持页可查询并为 `dengjzy/Conclave` 点 Star。Web 客户端仅调用 `support.starStatus` / `support.star`，通过 `project-star` 能力判断 core 是否支持；旧 core 只提供 GitHub 网页入口。状态不写入本机偏好，进入支持页或返回窗口时自动检查，以 GitHub 的响应为准，不提供手动检测按钮。

`ProjectStar` 优先通过无交互的 `gh auth token --hostname github.com` 取得本机 GitHub CLI 的凭据，不可用时复用已加载 GitHub 来源插件的 token 凭据（含默认实例的环境凭据），插件关闭或卸载后不使用遗留凭据。来源实例是否同步收件箱不影响用户主动 Star。`SourceService.credentialsFor` 是 core 内部接口，凭据不出 RPC；仅 GitHub 集成解释官方插件的 `{kind: 'token', payload: {token}}` 格式，不要求更新插件。

查询先验证 `/user`，再读取固定仓库的 Star 状态；写入前重新核对上次检测的来源、实例与账号，不静默换号。界面平时不展示来源和账号，仅在点击 Star 失败时说明原因。请求固定发往 `api.github.com`，拒绝重定向，总时限 15 秒，gh 子进程上限 5 秒；并发查询合并。只有 GitHub 确认成功才显示感谢，权限或网络失败保留重试和网页入口。接口语义见 [GitHub Starring REST API](https://docs.github.com/en/rest/activity/starring)。

### 首次使用环境引导

Web 前端在首次连接且环境、供应商和任务来源数据到齐后启动检查，不再自动打开整篇指导。引导只检查一个 Agent 的安装和可用条件，再提出接着聊终端里的会话、询问是否配置任务来源，自己不创建会话、不发送模型请求。`agent-readiness.ts`（protocol）统一供引导和外部智能体 设置页使用：先看启用、安装及兼容性，再看原生登录或兼容且有密钥的供应商。供应商已配置与连接测试成功是两件事，测试结果按配置 revision 保留在前端，编辑后旧结果不再使用；已知测试失败会展示原因并留在 Agent 配置步骤，原生账号或其他供应商可用时仍可继续，不强制发起测试。侧栏环境提示也识别供应商配置，避免误报未登录。descriptor 的 `setup` 声明原生账号、原生供应商或首次使用授权，客户端不按 Agent 名称判断。core 在环境检查中可选返回 `problem`，区分 `incompatible-version` 与 `probe-failed`；旧 core 未说明的原因保持未知。

`setup-progress.ts` 计算当前步骤，本机偏好保存状态、所选 Agent、原生配置确认、接着聊和任务来源选择。原生配置未知时用户可自行确认；确认按 Agent、实际路径和版本绑定，不改写检测事实，不能越过已知未登录、检测失败或版本不兼容。首次使用才授权的 Agent 可以明确推迟授权，不为此创建会话。已看过旧指导或已有任务、会话的用户不会自动触发，完成或主动退出后也不会自动重弹，可从左下角帮助 → 检查使用环境手动继续。任务来源凭证及必填设置保存后即可完成，是否启用同步、同步成功和导入任务不属于完成条件。

Agent 可用之后、任务来源之前是「接着聊」一步：从零用一个新工具，不如在已有的工作上接着做。引导一开始就在后台调 `sessionImports.list`（`external-sessions.ts`，失败不报错，当作没有），到这一步时多半已有结果；还没回来时停在这一步显示「正在找」，不先跳到任务来源再跳回来。可接着聊的会话（`resumable-sessions.ts`）是未导入、目录还在、所属 Agent 已启用且没被确认未登录的；数量按全部算，列出最新的 3 个，每个目录只取一个。点「接着聊」导入这一个并打开它，「查看全部」去设置 → 导入会话，「从新会话开始」跳过；没有可接着聊的会话或 core 不支持导入时整步跳过。总览在还没有任何任务和会话时显示同样的「接着聊」卡片，引导这一步还没做完时不显示，免得重复；退出了引导，它还在。

环境引导在工作区下方预留固定区域，进入设置仍可见，输入、弹层和终端保持原有交互。设置页导航读取 store 中的目标，支持引导在设置已打开时切换到正确章节。左下角齿轮旁的帮助菜单提供「使用指南」和「检查使用环境」；关于页显示版本、连接状态与 Git。使用指南是静态配置与功能查阅，不读取完成状态、不创建会话。阅读时暂时隐藏环境引导并保留进度，离开文档后恢复；从帮助启动环境检查会关闭文档。技巧的场景提示独立于首次引导。

### Agent CLI 版本与升级

设置 → 外部智能体 打开时调用 `system.agentCliStatus`，按需查询版本；成功缓存一小时，失败五分钟，手动检查绕过缓存。不做启动通知或自动升级。`agent-cli-maintenance` feature 区分新旧 core，daemon 的 `info.features` 单独声明升级能力；旧 daemon 保留版本检查，只禁用升级，设置页在列表顶部提示一次，不逐项重复。有新版本时才在 Agent 一行显示「升级」；升级进度、失败原因、挡住升级的会话和输出入口在行内，其余收在「详情」。

安装与更新事实属于各 Agent adapter 的 `maintenance`。core 的 `agent-cli-target.ts` 从环境检测选中的实际路径开始，验证包管理器的全局包名、bin 与真实路径，或 Homebrew 的安装前缀与安装记录；不按路径里出现 `homebrew` 就判断来源。npm/pnpm/bun 使用原管理器，Homebrew 使用原 formula/cask，已确认的原生安装必须在 help 中声明自更新子命令。应用内置、项目本地和归属不明的 CLI 只给手动指引。确认了来源的，状态里带上可复制的终端升级命令（`upgradeCommand`，就是应用内升级会运行的那条）；不按 Agent 猜一条通用命令，免得装出第二份、PATH 仍指向旧的。Cursor 的日期版本保留完整构建标识，同一天不同 hash 不推断先后；没有最新版本接口时显示由 CLI 检查，查询失败不显示「已是最新」。默认查询稳定版本，拒绝降级。

`AgentCliMaintenance` 在 core 管理查询、全局串行升级、结果复核和 `agent_cli_operations` 中的操作记录。`AgentCliAccess` 协调 core 内的检测、模型探测、临时调用、登录和退出；daemon 会话附带可选 `agent`，`spawnCliUpgrade` 原子检查目标 Agent 的存活进程（包括空闲驻留会话）并启动升级 PTY。升级会话带 `upgradeId`，其存活期间 daemon 拒绝同种 Agent 启动；其他 Agent 和普通终端照常运行。无法归属的旧 pipe 会话保守阻止升级。不扫描外部终端中的 CLI，不主动结束现有会话。

升级命令是 argv，不经过 shell，终端面板保留输出。五分钟超时和取消由 daemon 处理，升级进程实际退出前不释放限制。关闭窗口不影响升级；core 重连按 `upgradeId` 找回 daemon 会话，必要时重建尚未持久化的终端标签，再复核版本。已被用户关掉的标签不自动打开。命令退出码为零还需确认真实版本增长并达到查询到的目标，才显示成功；未变化、无法验证、取消和失败分别展示。结束后重新检测环境和登录状态，并让模型目录下次从 CLI 重读。

### 本地知识库

设置 → 集成 → 知识库 支持「Markdown 文件夹」和「Obsidian」两种模式，存在聊天设置的 `knowledgeBase`（路径、是否允许写入和可选的 `kind`）。新选择默认 Markdown 文件夹，用普通 Markdown 和相对路径链接，遵循已有笔记格式；Obsidian 模式用双链和 frontmatter，core 读 Obsidian 自己的注册表列出它打开过的库，也可以选任意文件夹。旧配置缺少 `kind` 时继续按 Obsidian 工作；旧客户端更新同一路径的写入权限时保留已保存的模式。core 用 `knowledge-base-kind` 声明支持两种模式，新客户端连接旧 core 时只显示原来的 Obsidian 入口。切换模式保留路径和写入权限，从下次启动 Agent 生效。

每次启动 Agent，core 都把知识库的**原目录**交给它：不算项目，不进 `projectPaths`，任务里也不建 worktree，所以 Agent 写进去的笔记其他笔记应用立刻能看到。仅在用户要求时写入，只新建或追加，不删除、不改名。只在普通阶段可写：规划和只读阶段只读。各家 adapter 自己决定怎么交（`AgentLaunch.knowledgeBase`）：

- Claude Code：可写时 `--add-dir`，只读时加一条 `Read(//库/**)` 允许规则（不作为工作目录，就不会连带加载库里的 `.claude/skills`）；路径、所选笔记格式和「只新建或追加、不删除、不改名」的规则用 `--append-system-prompt` 告诉它。
- Codex：可写时作为每个回合 `sandboxPolicy` 的可写根；只读沙箱不收可写根，所以规划和只读阶段写不了。规则用 `-c developer_instructions=…` 传入。
- Cursor：可写时 `--add-dir`；ACP 没有系统提示词，规则拼在进程第一条提示的 `wire` 上，`logged` 不带，聊天记录、搜索和移交都看不到。

回复里的 `obsidian://` 链接交给浏览器处理，由浏览器和操作系统决定是否打开对应应用；它是回复链接解析器允许的应用协议。

### 技能库

设置 → 任务 → 技能 管理 Agent Skills（`SKILL.md` 目录）。core 从 https 地址 `git clone` 到 `~/.conclave/skills/repos/<id>/`，固定在安装时的提交（detached HEAD），把扫描到的技能写进 `skills.json`。依次递归扫描 `skills/`、`.agents/skills/`、`.claude/skills/`、`.codex/skills/`，取第一个包含 `SKILL.md` 的集合，支持 `skills/<分类>/<名字>/SKILL.md` 等多层布局；都没有再看根目录的 `SKILL.md`，整个仓库是一个技能，名字取 frontmatter 的 `name`（目录是仓库名，对不上也不算错）；仍没有就递归扫描仓库的其他子目录，兼容插件里的技能。遇到 `SKILL.md` 后不再扫描该技能内部的示例等文件，跳过隐藏目录、`node_modules`、`vendor` 和目录软链接，普通分类目录不列为缺失技能。同一集合中重名的技能标为不可用；没有可用技能时 core 返回具体的校验错误。「检查更新」只 fetch 并从 git 对象里读新版本的技能列表，使用同一套扫描规则；用户确认后才移动 pin，并记住上一个提交供回退。不改用户自己的 `~/.claude`、`~/.codex`。

推荐列表是 core 里写死的一小份（`skills-recommended.ts`），不是市场。除此之外，「搜索技能市场」查开放索引 [skills.sh](https://skills.sh) 的公开 `/api/search`（feature `skills-search`，由 core 出网，无需密钥；`/api/v1` 的排行榜要 token，不用）。registry 一条记录是某个仓库里的一个技能，core 按仓库（GitHub `owner/repo`）归并成一行并校验是干净的 `owner/repo`（`skills-search.ts`）；安装走的还是上面的 `git clone` 整仓库、固定提交那条路，所以命中的是技能所在的仓库，不是单个技能。GitHub 仓库的大小写、`.git` 后缀和尾斜杠统一成同一个身份，其他 Git 服务器保留原地址语义；core 安装去重、推荐和搜索的已安装状态共用 `skillRepositoryUrl`。页面分为「已安装」和「发现技能」，发现页里的推荐、搜索和填地址安装用标签切换；推荐中的已安装仓库保留并显示管理入口。

启用策略（feature `skills-activation`）存在每个仓库可选的 `activation` 字段，由 `skills.setActivation` 修改：`mode: all | selected` 决定全部启用还是自选 `skills`；`agents: null` 表示全部兼容 Agent，自动覆盖以后新增的技能兼容 Agent，数组则只包含指定的 Agent。新安装默认自选空列表、适用全部兼容 Agent，安装后打开启用设置；自选与指定 Agent 都有全选和清空。支持情况来自 descriptor。保存前 core 与界面都检查技能名和 Agent 范围的交集，同一 Agent 中重名的来源不能同时启用，界面可跳转管理冲突来源。旧锁缺少 `activation` 时继续由可写 Obsidian 知识库选择 `obsidian-markdown`；一旦显式保存就以用户设置为准，清空选择可关闭这一旧行为。

检查更新跟随远端当前的默认 HEAD，从提交对象读新列表，预览新增、移除和修改（包含技能目录里的脚本、参考文件变化）。更新先检查目标版本是否可用以及是否引入重名；已启用技能被移除或失效时需要显式确认。自选模式保留仍可用的选择，新增默认关闭；全部启用模式在用户确认更新后包含新增技能。切换或保存失败会恢复原 checkout，重启时以锁文件里的提交恢复，回退时也恢复上一次启用策略。运行中的 Agent 保留原 bundle，配置变化在下次启动生效。

交给 Agent 的是**bundle**（`bundles/<key>/`）：`SkillsLibrary.bundleForAgent` 按仓库策略、兼容能力和目标 Agent 选技能，再复制技能自己的目录（仓库本身是技能时就是整个仓库；跳过软链接和 `.git`，限 32 MiB），同时写成 Claude Code 插件（`.claude-plugin/plugin.json` + `skills/`）和 `.agents/skills/` 两种布局；`key` 是技能及其提交的哈希，同样的选择得到同一个目录，提示词缓存得以保温，更新或回退后自然换新目录。descriptor 的 `capabilities.skills` 说明这个 Agent 能否接收 bundle，adapter 决定怎么交（`AgentLaunch.skills`）：Claude Code 用 `--plugin-dir`，Cursor 用 `--add-dir`，OpenCode 写进 `OPENCODE_CONFIG_CONTENT` 的 `skills`，Pi 用 `--skill`，DeepSeek Harness 写入运行配置；Codex、Antigravity 暂不支持。损坏或手动修改的锁若含重名，启动时跳过冲突名并记日志，仍加载其他技能；bundle 建不出来只记进 wire log，不阻止 Agent 启动。

### 用户的 MCP 服务器

设置 → 任务 → MCP 维护一份全局的 MCP 服务器列表（`mcp-servers.ts`）：本地命令（stdio）或远程地址（streamable HTTP，远程只接受 https），每个选好交给哪些 Agent，可以单独停用。设置存在 `mcp-servers.json`；环境变量和请求头的值都当密钥，存进 `credentials.json`（`mcp/<名字>`），客户端只看得到键名。名字 `conclave` 留给 Conclave 自己的服务器（工具名靠它识别）。

和技能库一样，**每次启动时注入，不改 Agent 自己的配置**：descriptor 的 `capabilities.userMcp` 说明能不能接，adapter 用交 Conclave MCP 的同一条路交出去（`AgentLaunch.userMcp`）——Claude Code 合进 `--mcp-config`（仍不加 `--strict-mcp-config`，用户自己配的照常加载），Codex 是整条 `-c mcp_servers.<名字>={...}`（同名时盖过 config.toml 里的那条），Cursor 和 OpenCode 进 ACP `session/new` 的 `mcpServers`，Pi 由 Conclave 的扩展 `registerMcpServer`（用户自己 `~/.pi/agent/mcp.json` 里的照常加载）。有密钥的服务器交出去的是 Conclave 的启动器（`mcp-main --run <名字>`，`user-mcp-launch.ts`）：它启动时才从 Conclave 的文件读出密钥，命令带上环境变量直接接管 stdio，远程地址则由它在 stdio 和 HTTP 之间转发（`mcp-http.ts`），所以密钥不进 Agent 的命令行、配置和 Conclave 的日志；没有密钥的远程地址直接交给 Agent。改动从下次启动 Agent 起生效。

- **测试连接**（`mcpServers.probe`，`mcp-probe.ts`）：像 Agent 一样连上去 `initialize` → `tools/list`，命令在独立进程组里跑、结束即杀，60 秒超时，失败时带上 stderr。
- **没连上**：Claude 的 init 里 `source: dynamic` 且失败的、Codex 的 `mcpServer/startupStatus/updated` 里失败的用户服务器，聊天里各出一行提示；记进日志的帧带着这个判断，重放结果一致。
- **审批**：Claude 和 Cursor 的 MCP 工具本来就走审批卡；Codex 对它认为会影响外部的工具发 `mcpServer/elicitation/request`（`_meta.codex_approval_kind: mcp_tool_call`），Conclave 接成审批卡：允许一次、本次运行内不再问（`persist: session`）、拒绝；「永远允许」不提供，那会写进 Codex 自己的配置。
- **只读过滤**：交给只读阶段的每个服务器都走启动器（没有密钥的远程地址也是），加 `--read-only`（`mcp-read-only-filter.ts`）：`tools/list` 只留服务器标了 `readOnlyHint: true` 的工具，调用别的工具由启动器直接回错误，不到服务器。没标注的算会改东西的。
- **导入**（`mcp-import.ts`）：读 `~/.claude.json`、`~/.cursor/mcp.json` 和 `codex mcp list --json`（跳过 ChatGPT 应用和 Codex 插件自带的、已停用的），列表只给键名；导入时 core 重读一遍连同值一起存，默认不再交给它原来所在的 Agent，免得启动两份。SSE 和 Codex 从环境变量取令牌的不能导入。

### 服务商

服务商（model provider）是第三方编程套餐的接口和 Key，比如火山方舟 Agent Plan、智谱 GLM Coding Plan。设置 → Agent → 服务商（`model-providers.ts`）维护列表：预设（火山 Agent Plan / Coding Plan、智谱、Z.ai、Kimi Code、MiniMax 国内和海外、阿里云百炼 Token Plan，`protocol/src/model-provider-presets.ts`）或自定义。预设的地址不存，每次用时从预设表取，发版修了地址就自动生效；模型列表也一样：保存时和预设的列表（按名字和顺序）一样就不存，默认模型、小模型和预设相同的也不存，用时从预设表取，发版加了或下线了模型，已有的服务商跟着变；改过的列表照存，设置里可以一键恢复成预设的（`ModelProvider.modelsFromPreset` 告诉客户端是不是在跟随）。跟随的列表里没了用户选的默认或小模型时，改用预设的。自定义的地址只接受 https（http 只能连本机），不许带账号密码、`?` 和 `#`。Key 存进 `credentials.json`（`model-provider/<id>.<revision>`），每次换 Key 都是新记录：先写新 Key，再写列表，最后删旧 Key，启动时清掉没人引用的。客户端只看得到 `hasKey`。

和技能库、MCP 一样，**每次启动 Agent 时注入，不改 Agent 自己的配置**，Key 只进子进程的环境变量（唯一的例外是 ZCode，见表里那一行）：

| Agent | 协议 | 怎么注入 |
|---|---|---|
| Claude Code | Anthropic | 全走 env：`ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN`（Kimi 用 `ANTHROPIC_API_KEY`，另一个置空），加 `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1`，否则用户 settings.json 里的 `env` 会盖过进程环境（2.1.288 实测）。Bedrock/Vertex 等路由开关、`CLAUDE_CODE_OAUTH_TOKEN`、`ANTHROPIC_MODEL` 置空（daemon 删不掉继承的变量）。opus/sonnet/haiku 别名映射到服务商的模型；≥1M 上下文的模型 id 加 `[1m]`，其余用 `CLAUDE_CODE_MAX_CONTEXT_TOKENS`。不设 `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`：它会把权限模式强制改回 default，而 Bash 工具本来就拿不到这两个 Key。 |
| Codex | Responses | `-c model_providers.conclave-<id>={…, env_key="CONCLAVE_MODEL_PROVIDER_KEY"}` 加 `model_provider`、`model`、`model_context_window`；名字固定，恢复 thread 时找得到。Codex 的 shell 会继承整个环境，所以再加 `shell_environment_policy.set.CONCLAVE_MODEL_PROVIDER_KEY=""`。 |
| OpenCode | Chat（优先）/ Responses / Anthropic | `OPENCODE_CONFIG_CONTENT` 里加一个 `provider`，`apiKey: "{env:CONCLAVE_MODEL_PROVIDER_KEY}"`，配置文本里没有 Key；`small_model` 是服务商的小模型。它的 shell 能读到这个变量，没有配置能挡。 |
| Pi | Chat（优先）/ Responses / Anthropic | Conclave 的扩展用 `pi.registerProvider` 注册 `conclave-<id>`（`CONCLAVE_PI` 里的配置不含 Key），Key 从 `CONCLAVE_MODEL_PROVIDER_KEY` 读出后立刻从环境里删掉，所以 Pi 的 bash 和它启动的 MCP 服务都读不到（百炼实测）。Anthropic 去掉地址末尾的 `/v1`（Pi 自己加 `/v1/messages`），要 Bearer 的服务商另加 `authorization` 头。服务商没给的上下文长度和输出上限按 128K / 16K 填，推理强度只保留 Pi 有的档位。握手后用 `set_model` 切到服务商的模型，切不过去就拒绝启动。 |
| ZCode | Anthropic（优先）/ Chat / Responses | ZCode 只从它的服务商文件读 Key：没有变量或参数能交 Key，文件里写 `${VAR}` 会原样发出去（3.16.2 实测）。所以阶段在自己的启动目录（见下）里放一份 ZCode 数据目录，`.zcode/v2/provider_config.json` 只含这一个服务商 `conclave-<id>`，用 `ZCODE_DATA_BASE_DIR`、`ZCODE_PERSONAL_PROVIDER_CONFIG_FILE`、`ZCODE_CLI_CREDENTIALS_FILE` 指过去，同时挡住用户自己的服务商和 Z.ai 登录；会话、设置、日志照旧在用户的 `~/.zcode/cli`。ZCode 监听这个文件，删了就丢模型，所以它留到进程退出。Anthropic 去掉末尾的 `/v1`（ZCode 自己加 `/v1/messages`，Bearer 和 x-api-key 都带）。新建或恢复后不在服务商的模型上，拒绝启动。 |
| Cursor | — | 不支持，只用自己的账号。 |

谁能用什么协议写在描述符的 `capabilities.modelProviders` 里，适配器的 `providerModels` 给出这个 Agent 叫服务商模型的名字（OpenCode、Pi 和 ZCode 都是 `conclave-<id>/<model>`）。

**阶段的启动目录**（`stage-launch.ts`）：适配器启动前要写、又不能比进程活得久的文件（ZCode 的服务商文件），放在 `sessions/<会话>/launch/<阶段>/` 里。`launch.prepare` 拿到这次的 `AgentLaunch`，可以返回要加的环境变量。目录只给当前用户：POSIX 上 0700、属于当前用户、不能是链接，文件用 `wx` 新建、0600；Windows 上关掉继承、只给当前用户的 SID 完全控制，再用 icacls 读回核对，做不到就拒绝启动。目录归 core 管，适配器只往里写。有确证时直接删：daemon 报告这个阶段的进程退出了（`handleExit`，或重连时列表里标着已退出），或者 daemon 明确拒绝了启动。其余没有会话认领的目录（正在准备或运行的阶段不算）一律走同一条路（`settleLaunches`）：能看到别的进程环境变量的平台上（macOS 用 `ps -E`，Linux 读 `/proc/*/environ`），没有进程的环境变量指着它才删；Windows 看不到，就从这个目录第一次被发现没人认领时起等 30 秒，找不到阶段记录、且 daemon 还跑着没人认领的 Agent 进程（可能是应答丢失的那次启动）时一直留着。还留着的目录（包括这次没删掉的，比如 Windows 上文件被占用）每 30 秒按 daemon 当时的列表再看一次，直到全部清掉。重连对账只管向 daemon 要列表之前就已启动的阶段，之后才启动的不受这份旧列表影响；daemon 报告已退出的，即使接回聊天失败也照删。重连对账、删会话都走这条路，所以删会话不会从还在跑的进程脚下删掉文件；daemon 重启后旧进程不在新列表里、可能还在退出的，也由它把关。daemon 在会话列表里报告每个管道进程启动时的归属（`CONCLAVE_OWNER`）：重连对账时，归属某个会话、却没有会话认领、也不在启动途中的进程（启动失败而停进程的请求没送到，或启动的应答随断线丢了），core 会停掉它，core 重启过也一样。驱动在服务商上只列服务商的模型、只许切到它们，CLI 报的费用（按官方价）丢掉、token 照记。

**路由**（`conversation-route.ts`）：会话创建时定下服务商（`conversations.model_provider`），之后不改；fork 跟着来源（fork 可以用 `agent` 换一个 Agent 接着跑，此时它按可见记录开始，不走原生 session）。每个阶段记一份不含 Key 的路由快照（`conversation_stages.provider_route`：服务商、协议、地址、模型列表），重放和重启后接回运行中的进程只读快照。下一阶段怎么走只在 `decideRoute` 一处算：服务商服务这个 Agent 就用它；不服务就用 Agent 自己的账号（移交到 Cursor 时就是这样）；这个 Agent 在会话里跑过的，按跑过的方式继续——服务商被删、没 Key 或不再服务它时拒绝启动（`model-provider-unavailable`），不悄悄回到官方账号。会话上次用的模型服务商不再提供时（列表改了或预设下线了它），阶段改用服务商的默认模型启动，并在聊天里提示一句（`rememberedOnProvider`）；推理强度只在默认模型也有时保留。仍然只在这个服务商的模型里换，不换到别处。原生 session 只在同一条路由（服务商 + 协议 + 地址，`providerRouteKey`）上恢复或 fork，换了就按移交重开。`Conversation.route` 告诉客户端下一阶段走哪：标题栏、每轮开头、输入框里的小标，移交菜单里每个 Agent 是沿用还是用自己的账号。任务用 `TaskLaunchOptions.modelProvider`（不传沿用，`null` 是官方账号），任务一有会话就以会话为准（`model-provider-fixed`）。

**周边**：标题、翻译、提交说明、分支名在服务商会话里直接对服务商发一个请求（`provider-request.ts`，和测试连接共用），用它的小模型，不走 Agent 的 CLI；记成「未计价」，只记 token，不算费用和节省。服务商阶段的用量上报不算 Agent 官方账号的，定时任务和用量上限后的自动续跑也不看官方额度。用户 MCP 服务器经启动器启动时，进程带 `CONCLAVE_MODEL_PROVIDER` 标记就去掉 Key 变量，以及指向 ZCode 服务商文件的那几个变量。

- **测试连接**（`modelProviders.probe`，`model-provider-probe.ts`）：每个接口、默认模型和小模型各发一个最短的请求，30 秒超时，不跟随重定向，返回服务端原话（截断、去掉 Key）。
- **预设是否「已验证」**：用真 Key 在 Conclave 里把支持它的 Agent 都跑过才标，记下 CLI 版本；现在都还是未验证。额度不在 Conclave 里显示，只给控制台链接。
- **mock 端到端**：Claude Code、Codex、OpenCode 的注入都用一个本地模拟服务（三种协议、记录请求）实跑过，包括 settings.json 里指向别处的地址和工具能否读到 Key。改了注入方式或升级 CLI 后要重跑。Pi 没走模拟服务，而是用百炼的真实接口（OpenAI 兼容和 Anthropic 两种，后者走 Bearer）当自定义服务商跑过：模型切到服务商的、bash 和 MCP 服务读不到 Key、命令行和日志里没有 Key、花费不计。

### 账号

Claude Code 和 Codex 可以登录多个账号（描述符的 `capabilities.accounts`，适配器的 `accounts`），设置 → Agent → 账号（`agent-accounts.ts`）维护。和服务商走同一条路：**每次启动注入环境变量，不改 Agent 自己的配置**——每个账号一个配置目录，进程带 `CLAUDE_CONFIG_DIR` / `CODEX_HOME` 指向它。只作用于 Agent 自己的路由；走服务商的阶段不看账号。

- **本机账号**（id `default`）就是用户自己的目录（`$CLAUDE_CONFIG_DIR` 或 `~/.claude`，`$CODEX_HOME` 或 `~/.codex`），不注入任何变量，删不掉。其它账号在 `<CONCLAVE_HOME>/agent-accounts/<agent>/<id>/`，路径创建后不变：Claude Code 2.1 起在 macOS 钥匙串里按 `CLAUDE_CONFIG_DIR` 的原文起名（`Claude Code-credentials-<sha256(NFC(路径)) 前 8 位>`），换个写法就找不到登录。列表、当前账号和自动换号开关存在 `agent-accounts.json`；登录凭据由 CLI 自己存（钥匙串或目录里的文件），Conclave 只读、从不刷新 token。
- **共享**（`agent-account-home.ts`）：账号目录里的条目是指向本机目录的软链（Windows 上目录用 junction），所以会话历史只有一份，换号后原生 session 原样恢复，不走移交。Claude 链 `projects`、`file-history`、`todos`、`plans`、`shell-snapshots`、`session-env`、`paste-cache`、`tasks`、`transcripts`、`history.jsonl`（本机没有就先建）和 `skills`、`plugins`、`agents`、`commands`、`output-styles`（有才链）；不链 `sessions/`（CLI 自己的运行进程登记）。`settings.json` 每次启动前复制一份（CLI 写它是写新文件再改名，软链会被换成普通文件），`CLAUDE.md` 是一行 `@<本机目录>/CLAUDE.md`，`.claude.json` 合进本机的 `mcpServers` 和各项目的 MCP、信任设置，`oauthAccount` 等账号自己的键不动。Codex 除 `auth.json` 和数据库的 `-wal`/`-shm`/`-journal` 外，本机目录顶层每一项都链过去（`sessions`、`archived_sessions`、`history.jsonl` 本机没有就先建）。链之前账号目录里已有的同名目录，里面的东西先挪进本机目录。
- **登录**：添加账号时 core 在终端面板里跑 `claude auth login` / `codex login`（argv，不经 shell），带该账号的环境变量；终端结束后读登录状态和邮箱（Claude 的 `.claude.json` 里 `oauthAccount.emailAddress`，Codex `auth.json` 里 id token 的 email）。删除账号先用它的环境变量跑 `auth logout` / `logout`，再删软链和目录，不碰链到的本机文件。
- **启动**：每个阶段启动时取 Agent 的当前账号（`AgentAccountStore.launch`），先补齐目录再注入，账号记进 `conversation_stages.account`。标题、提交说明这类小任务和模型列表探测也用当前账号。状态栏手动切换只影响之后启动的进程，运行中的阶段保持原账号。
- **额度**：`UsageService` 按 Agent + 账号读，每个账号用自己的凭据请求用量接口；运行中的阶段上报的额度记到它所在的账号（`AgentUsage.account`）。定时任务、自动续跑和例程看的是当前账号的额度；开着自动换号且所有账号都用完时，看最早重置的那个。
- **自动换号**（默认开）：一轮撞上额度上限时（`UsageLimitResumes.observe`），阶段在账号 X 上、当前账号还是 X，就按 `pickAccount`（有余量的优先、再看用得少的，跳过未登录和已用完的）换当前账号；别的会话已经换走、新账号还有额度，就直接用它。然后建一个立即执行的续跑（`ScheduledTarget.switchedTo`），续跑先把空闲在旧账号上的阶段停掉（`leaveSpentAccount`），再在新账号上恢复同一个 session、发「继续」；卡片显示「已换到账号…继续」。没有可换的账号就和以前一样等重置。轮询发现当前账号已用完时也会换。
- **待实测**：两个真实订阅账号下，钥匙串命名、跨账号恢复同一个 session（Claude 的思考签名、Codex 的加密推理是否被另一个账号拒绝）、Codex 的 sqlite 经软链读写。若跨账号恢复被拒，就把账号并进 route key，换号改走移交。

## 5. 浏览器边界说明

**Conclave 是纯 Web 工作台，本身不提供内嵌浏览器宿主或书签服务。** 运行 Web 客户端不会创建受控内嵌网页标签页，Conclave 也不会向 Agent 注入托管浏览器 MCP 工具。当任务或会话需要网页访问或浏览器自动化时，直接由外部 Agent CLI 调用其原生内置浏览器能力，或由用户在「设置 → MCP」中接入独立的浏览器 MCP 服务器。`packages/protocol` 仅保留少量历史线路常量供协议向后兼容使用。

## 6. 终端与端口

### 终端面板


状态栏右下角的终端按钮（或 Ctrl+`）打开右侧的终端面板，里面是你自己的登录 shell，可以开多个标签。新终端的工作目录跟着当前选中的内容走：任务的 worktree、会话的项目，都没有时是 home。shell 由 daemon 托管，隐藏面板或关闭窗口都不会结束它；关闭标签或在 shell 里 `exit` 才会结束。面板可以拖动调宽，也可以最大化。用鼠标在终端里选中一段文字，松开处会出现「引用到对话」，点一下就把这段作为引用放进对话的输入框：Agent 自己开的终端引用到它的会话，否则引用到当前打开的会话或任务聊天；打字、滚动或取消选中时按钮收起。

**颜色**：终端像别的终端应用一样告诉程序自己能显示颜色：`TERM=xterm-256color`、`COLORTERM=truecolor`、`TERM_PROGRAM=Conclave`，你没设 `CLICOLOR` 时补上 `CLICOLOR=1`（macOS 的 `ls` 靠它上色）。Agent 跑命令和安装 CLI 的标签也一样。

**彩色提示符**（设置 → 外观，默认开）：shell 是 zsh、而你从没设置过提示符时，Conclave 的终端换成带颜色的提示符：当前目录、git 分支，上一条命令失败时 `%` 变红。做法同 VS Code 的 shell 集成：新终端的 `ZDOTDIR` 指向 `~/.conclave/shell/zsh/`，那里的 `.zshenv`、`.zprofile`、`.zshrc` 依次先读你自己的同名文件（你设了 `ZDOTDIR` 就从那里读），`.zshrc` 读完把 `ZDOTDIR` 还回去，所以 `.zlogin` 和在里面再开的 shell 都只读你的。只有提示符仍是 macOS 或 zsh 的默认值才替换；自己设过 `PROMPT`、用 oh-my-zsh 或 starship 的不受影响。不写你的任何文件，只影响 Conclave 里新开的终端。bash、fish 和 Windows 的 shell 保持原样。想要更多信息的提示符，可以装 [starship](https://starship.rs)，或在 `~/.zshrc` 里自己写一行 `PROMPT`。

终端栏的书签按钮是**常用命令**：点一条就打进当前终端。每条命令可以选「直接执行」（自动按回车）或只填到命令行、按回车前再改；可以对所有终端显示，也可以只在某个项目的终端里显示（任务的 worktree 算作它的项目）。先在终端里选中一段文字再点「添加常用命令」，会直接带进命令框。命令存在 core 里，多个窗口同步，最多 200 条。

### 开发服务端口


状态栏右下角的端口按钮打开独立的端口面板，列出 Conclave 托管终端和 Agent 子进程正在监听的 TCP 端口，按任务、会话或终端分组。可以切换为只看当前任务 / 会话、在系统浏览器新标签打开端口地址、定位所属终端或停止监听进程；打开端口直接使用 `window.open`，不依赖浏览器宿主。停止前会重新核验进程身份和端口归属，不会结束其他终端或 Agent。普通终端里的 shell 保留，Agent 命令结束后标签保留输出。面板打开时每两秒刷新，隐藏后停止扫描。

端口归属优先跟随终端 / Agent 的进程树。用户自己的 shell 只有在实际工作目录能唯一对应任务 worktree 或会话时才关联，多个会话共用目录时仍按终端显示。macOS 和 Linux 能读取实际工作目录；Windows 的普通 shell 按终端显示。core 启动 Agent 和终端时会在环境变量 `CONCLAVE_OWNER` 里写上归属（`conversation:<会话 id>` 或 `terminal:<终端 id>`），它们启动的进程都会继承。进程树断了的服务（启动它的 shell 退出、Agent 已停止，进程被系统接管），daemon 会读它的环境变量，仍归到原来的会话或还开着的终端下，也能停止；Agent 让终端里的命令起的服务归到会话，关掉标签也找得到。环境变量在 macOS 上用 `ps -E` 读，只读得到当前用户、非 Apple 自带程序的进程；Linux 读 `/proc/<pid>/environ`；Windows 读不到，只看进程树。没有归属的系统服务、Docker 容器内服务、只监听 unix socket 的进程，以及环境变量被清空后启动的服务不在列表中。端口发现依赖 macOS 的 `lsof` / `ps`、Linux 的 `ss`（或 `lsof`）/ `ps`、Windows 的 PowerShell。

可以在项目或任务 worktree 的 `.conclave/ports.json` 中给端口命名：`{"ports":[{"port":3000,"label":"Frontend"},{"port":8080,"label":"API"}]}`。配置只给已发现的端口加标签，修改后自动生效，格式有误时仍显示端口。端口面板不分配端口，也不提供远程转发。

### 项目配置：setup 与 check

项目可以在仓库里提交 `.conclave/project.json`，三个字段都可选：

```json
{ "copy": [".env", "apps/web/.env.local"], "setup": "pnpm install", "check": "pnpm typecheck && pnpm test" }
```

- `copy`：新建 worktree 时，从项目里复制到 worktree 的文件或目录，只认相对路径。默认不复制任何东西，也不按 gitignore 复制，因为被忽略的文件里还有缓存、构建产物和本机凭据。源头缺失的路径跳过，worktree 里已有的不覆盖，指向项目外（`..`、符号链接）的路径不复制。
- `setup`：复制完成后，在新建的 worktree 里运行。只在这次启动新建 worktree 时运行一次，复用已有 worktree 不再运行。任务的 Agent 等 setup 结束后才收到第一条消息；setup 失败不阻止启动，失败输出的末尾会附在第一条消息里。在 worktree 里开始的会话同样会先运行 setup。
- `check`：用户提交验收时，在每个 worktree 里运行。全部通过后任务才进入待验收；任何一个失败，任务保持执行中，输出末尾发给 Agent 修复。

配置始终从项目本身的 checkout 读取，不读 worktree，所以 Agent 改 worktree 里那份不会改变要运行的命令。命令由用户的登录 shell 执行，cwd 是 worktree 根目录，另有环境变量 `CONCLAVE_ROOT_PATH`（项目）和 `CONCLAVE_WORKTREE_PATH`。命令显示在终端面板的独立标签里（`Terminal.purpose`），Agent 也能用 `terminal_read` 读取；用户可以在面板里停止。

命令来自仓库，不一定是用户写的，所以第一次运行前要用户确认：core 在 `~/.conclave/project-trust.json` 里按仓库记下 setup 和 check 的哈希，哈希对不上时拒绝启动或提交（`project-config-untrusted`）。Web 客户端随后显示这些命令，用户允许后再试一次。只改 `copy` 不需要重新确认。文件格式有误时同样拒绝（`project-config-invalid`），不会悄悄跳过 setup。

这个文件也可以在应用里填：设置 → 项目，每个最近用过的项目一行，显示配置了哪几项，「项目配置」打开表单（复制的文件每行一个，setup 和 check 各一个文本框）。保存由 core 写回项目里的 `.conclave/project.json`（`projects.writeConfig`，格式化后写，空项不写，全部清空则删除文件；原文件损坏也直接覆盖），并把写入的命令记为已允许：是用户自己填的，不必再确认。不是 Git 仓库的目录用不到 worktree，拒绝写入。表单上的「按项目填入建议」请 core 看项目根目录（`projects.suggestConfig`）：已有给 Superset（`.superset/config.json`）或 Conductor（`conductor.json`）写的 setup 就沿用；否则按清单文件认项目类型——Node 按锁文件选 pnpm、yarn、bun 或 npm，check 用 package.json 里的 typecheck 和 test 脚本；Go、Cargo、uv / Poetry / pip、Maven / Gradle、Bundler、Composer 各有一套命令，认出几种就依次串起来；根目录下的 `.env`、`.env.local` 这类本地文件列进复制。只填表单里还空着的项，不改用户已经写的；只看根目录，子目录里的项目（如 `server/go.mod`）认不出来。

第一版不做服务启动编排、拆除和端口自动分配，这些和端口面板、浏览器的职责重叠。

## 7. 从源码运行

使用 Node 24（见 `.nvmrc`）和 pnpm 12。在仓库根目录执行：

```bash
pnpm install --frozen-lockfile
pnpm dev          # 同时启动 daemon、core 和 Vite Web 开发服务
```

Web 开发服务默认使用 5173 端口，连接 core 提供的 RPC。也可以分开启动，方便查看日志：

```bash
pnpm dev:daemon
pnpm dev:core
pnpm dev:web
```

手动测试或截图时，用 `CONCLAVE_HOME` 指向独立数据目录，避免修改 `~/.conclave` 中的真实数据。daemon 和 core 使用该目录下的数据库、socket、worktree 和 core.json，Web 页面连接这套 core：

```bash
CONCLAVE_HOME=~/.conclave-demo CONCLAVE_HOST=127.0.0.1 pnpm dev
```

Windows 的 PowerShell 使用 `$env:CONCLAVE_HOME = "$HOME\.conclave-demo"; pnpm dev`。分开启动时，给 daemon 和 core 设置相同的 `CONCLAVE_HOME`；core 可额外设置 `CONCLAVE_HOST=127.0.0.1`。

## 8. 源码构建

```bash
pnpm build
CONCLAVE_HOME=~/.conclave-demo pnpm start
```

`pnpm build` 先运行 `scripts/build-plugins.mjs`，将 DSH runtime 构建为 `packages/dsh-runtime/dist/runtime.tgz`，再由 Vite 生成 `packages/web/dist`。core 的 HTTP 服务直接提供这个目录中的静态资源。

`pnpm start` 通过 `bin/conclave.mjs` 启动或复用 daemon，再用 Node 和 tsx 运行 core。Web 资源或 DSH runtime 缺失时启动器会补建；产物已经存在时直接复用，源码更新后需重新构建。前端页面刷新不重启 daemon 持有的 Agent 进程。

当前仓库没有自动应用发布工作流。应用版本、SDK/runtime 独立版本及协议版本的维护规则见 [源码构建与版本](RELEASING.md)。

## 9. 开发与验证

```bash
pnpm typecheck          # 构建插件 SDK，再检查各包类型
pnpm test               # 构建插件 SDK，再运行 Vitest
pnpm build              # 构建 DSH runtime 和 Web 静态资源
pnpm verify:plugin-sdk  # 独立消费者验证 SDK 打包、类型和插件协议
```

涉及 RPC 或跨进程数据的新功能先在 `packages/protocol` 定义 schema，再实现 core/daemon，最后由 Web 通过 RPC 接入。前端不得直接越过 core 操作服务端文件、Git 或 PTY；模型与推理选项以当前 Agent 的实时目录为准，不能拿上一阶段的旧状态覆盖。仅文档或局部展示修改不需要为此虚构协议变更。

维护时按职责定位：`ConversationService` / `ChatHost` 管会话与恢复，`TaskService` / worktree 服务管任务隔离，`FlowService` 管契约自治运行，`EvolutionService` 管自我迭代，RPC server 与 daemon client 管连接。数据库变更使用增量迁移，保留旧记录可读性。进程恢复、权限、发送去重或 worktree 生命周期的修改应覆盖相应回归测试；UI 及构建改动还需构建检查。

[CI](../.github/workflows/ci.yml) 在 PR 和 main 推送时运行这些检查，不发布应用或安装包。SDK 与外部来源插件的打包验证仍是独立能力，见 [插件开发指南](PLUGINS.md)。

## 10. 已知限制与下一步

- **验收**：按项目配置的测试命令在 worktree 里跑，结果放进检查器；合并分支
- **SSH / WSL 执行宿主**：给 git、PTY 操作加上 `hostId`
- **Windows**：有针对平台分支的单元测试，尚未做 Windows 实机验证，也没有 Windows CI；named pipe 没有设 ACL。
