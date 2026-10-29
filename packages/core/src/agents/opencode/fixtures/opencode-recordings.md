OpenCode `2.1.1` 的真实 ACP 记录，未登录任何服务商，使用免费模型 `opencode/glm-5.3-flash-free`，于 2026-10-21 在 Conclave 开发版（`CONCLAVE_HOME=~/.conclave-demo`）里采集。

- `opencode-session.jsonl`：初始化、认证、新建会话、选模型和「自动」模式（`conclave-auto`）；三个回合依次写 SVG 并调用 `conclave_show_preview`，用 `conclave_browser_navigate` / `conclave_browser_screenshot` 打开本地页面并截图，用 `conclave_terminal_run` / `conclave_terminal_read` 在 Conclave 终端里运行命令，其中终端命令经过 Conclave 自己的审批卡（`ask` / `answer` 记录）。
- `opencode-resume.jsonl`：进程停止后用 `session/load` 恢复同一会话，OpenCode 重放历史，再答一个只靠会话上下文的问题。

Conclave 的 MCP 服务经 `OPENCODE_CONFIG_CONTENT` 交给 OpenCode（`codemode: false`），所以工具调用以 `conclave_<工具>` 的名字出现，而不是 Code Mode 的 `execute`；`session/new` 里的 `mcpServers` 因此为空。

项目路径换成 `/work/repo`，其余家目录路径换成 `/home/user`；会话 id 换成 `ses_0001`，UUID 按出现顺序换成占位值，时间改为从 0 起算，去掉了 daemon 字节偏移。其余协议帧保留原有字段和增量顺序，不含凭据。
