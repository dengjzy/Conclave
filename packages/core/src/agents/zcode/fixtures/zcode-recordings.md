这些记录都是 Conclave 自己录的：`zcode-app-cli 3.16.2-38`（运行时 `0.17.0`，ZCode 3.16.2），2026-10-23。模型是本机的模拟 OpenAI Chat Completions 服务（`ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` 指向的个人服务商 `mock`，模型 `mock-model`），按消息里的关键词回文字或调用工具；`HOME` 和 `ZCODE_DATA_BASE_DIR` 指向临时目录。MCP 服务器是只有 `user_todo_list` 一个工具的最小服务，名为 `conclave`。

录制直接用 `ZCodeAppServer` 驱动真实的 `zcode app-server --stdio`，所以 `out` 帧就是 Conclave 运行时写进日志的样子；`in` 帧是 ZCode 原样发来的，去掉了 Conclave 不读的遥测（`v4/telemetry/event`、`computer-use/operation-event`、`process/mcpTelemetry`、顶层 `state.updated`）和存储迁移进度（只留 `ready`）。`session/resume`、`session/read` 应答里的历史消息只留第一条。路径换成 `/work/repo`、`/home/user`、`/conclave/...`，图片 id 换成合法的附件 id。

- `zcode-session.jsonl`：build 模式新建会话。依次是打招呼；Write 请求审批后批准；`rm` 命令请求审批后拒绝（带理由）；调用 `mcp__conclave__user_todo_list`（driver 直接放行）；AskUserQuestion 提问并回答；切到 bypass、把思考强度改成 low；跑一条普通命令；流式回复中途停止；流式回复中插一条消息。
- `zcode-resume.jsonl`：在新进程里用 `session/resume` 恢复上一个会话（模式停在 bypass，会话选的是 ask，driver 切回去），确认 Conclave 的 MCP 工具还在；再发一条带图片的消息（`session/send`）。
- `zcode-plan.jsonl`：以规划模式新建，模型调用 ExitPlanMode，批准并选「自由编辑」执行。
- `zcode-readonly.jsonl`：只读阶段里模型要写文件，driver 直接拒绝。
