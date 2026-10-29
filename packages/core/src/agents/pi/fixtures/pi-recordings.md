`pi-mcp-readonly.jsonl` 是 Conclave 自己录的：Pi `1.3.0`，2026-10-22，模型是阿里云百炼的 `qwen3.7-flash-2026-07-15`（免费额度，经 `~/.pi/agent/models.json` 的 OpenAI 兼容服务商 `bailian`）。Pi 以 `--mode rpc` 加载 Conclave 的扩展（`PI_EXTENSION_SOURCE`），扩展用 `registerMcpServer` 注册一个只有 `echo` 工具的最小 MCP 服务（名为 `conclave`，列出工具时写 ready 文件）。第一轮让模型调用 `mcp__conclave__echo`，然后发 `/conclave-mode readOnly`（Pi 回 `handled`，不写进会话文件），第二轮让模型用 `write` 写文件，被扩展拒绝。系统提示（含本机的技能列表）已从 `message_start/end` 和 `agent_end` 里去掉，`get_commands` 只留三条；路径换成 `/work/repo` 和 `/home/user`。

`pi-plan-tools.jsonl` 同样是 Conclave 录的（同一天、同一模型），但直接用 `PiRpc` 和 `piCommand` 驱动真实的 Pi，所以 `out` 帧就是 Conclave 运行时写进日志的样子：以规划模式启动（命令行带 `--skill` 和 `--append-system-prompt`），模型读代码、grep TODO（带 `cd … &&` 的那条被扩展拒绝，它改用纯 grep），交出计划；按计划执行（`/conclave-mode ask` 后发「按这个计划开始执行。」），模型用 `edit` 改文件，结果里带 `details.patch`；最后调用 `mcp__conclave__browser_screenshot`（最小 MCP 服务返回一张 1×1 PNG），并用 `read` 读技能文件答出检查词。去掉了系统提示和工具参数的流式增量（`toolcall_*`），路径同样替换。

其余是 Pi `1.0.4` 的真实 RPC 记录，取自 orca 仓库 `src/main/pi/__fixtures__/`（orca 用 `pi --mode rpc` 录下，登录 `openai-codex`，模型 `gpt-5.5`），按 Conclave 的日志格式改写。

- `pi-steer.jsonl`（来自 `steer-followup.jsonl`）：一条让 bash 跑 20 秒的消息，命令运行中插进两条消息，Pi 在之后的两轮里依次接住。录制时第二条是 `followUp`，这里改成了 `steer`（Conclave 只发 `steer`，排队用自己的队列）；Pi 的 steering 是一次一条（`one-at-a-time`），所以事件顺序和两条都发 `steer` 时一致。
- `pi-abort.jsonl`（来自 `stop-mid-tool.jsonl`）：命令运行中发 `abort`：工具结果 `isError`，回复 `stopReason: error`，`agent_settled` 之后才回 `abort` 的应答。
- `pi-provider-error.jsonl`（来自 `provider-fetch-error.jsonl`）：服务商连不上，回复 `stopReason: error`，`errorMessage` 为 `fetch failed`。
- `pi-signed-out.jsonl`（来自 `signed-out.jsonl`）：未登录：`get_state` 的模型是 `unknown`，模型列表为空。Conclave 在这里就停下，不发消息，所以去掉了录制里之后的 `prompt`。
- `pi-command.jsonl`（来自 `command-only.jsonl`）：扩展命令 `/qa-local` 不调用模型，Pi 发 `setStatus`、`setTitle`、`notify` 后回 `disposition: handled`。
- `pi-dialogs.jsonl`（来自 `dialogs.jsonl`）：扩展命令依次打开 confirm、select、input、editor 对话框。Conclave 一律回 `cancelled`，这里的应答已改成这样；最后那条 `notify` 的内容仍是录制时 orca 给的回答。

改写规则：方向对调（orca 的 `in` 是发给 Pi 的，即 Conclave 的 `out`）；请求 id 换成 Conclave 的（`pi-state`、`pi-models`、`pi-initial-model`、`pi-initial-effort`、`pi-prompt-<n>`、`pi-steer-<n>`、`pi-abort-<n>`）；去掉 Conclave 不发的 `set_auto_retry`、`set_auto_compaction`，以及消息之后 orca 自己查询的 `get_state`、`get_messages`、`get_session_stats` 和它们的应答；Conclave 握手里的 `get_commands` 录制里没有，也就没有补。时间按每帧 10ms 递增。家目录换成 `/home/user`；orca 已把 id、会话文件名换成占位值。

`write`、`find`、`ls` 还没有真实记录，测试里用按文档构造的帧。
