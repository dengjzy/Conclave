# omp

[omp](https://omp.sh)（oh-my-pi）是一个终端编码 Agent，通过官方 ACP 服务接入 Conclave。Conclave 用 `omp acp` 启动它，进程由 daemon 托管。

## 安装与登录

```sh
curl -fsSL https://omp.sh/install | sh
omp --version
```

Windows 使用 `irm https://omp.sh/install.ps1 | iex`。Conclave 接受 **18.18.8 及以上**版本；更早的版本不保证具备本文依赖的 ACP 会话控制。

omp 使用自己的模型服务商凭据：在终端运行 `omp` 或 `omp login` 登录，或给它可见的环境变量（如 `ANTHROPIC_API_KEY`、`OPENAI_API_KEY`）配置 API key。Conclave 不读取或迁移这些凭据；设置里的「服务商」不会给 omp 提供模型。

## 权限与模式

omp 的 ACP 会话只有 **Default** 和 **Plan** 两种模式。Conclave 只映射前者，显示为「默认」（`acceptEdits`）：

| Conclave 模式 | omp 行为 |
|---|---|
| 默认 | 普通文件读写直接进行；运行命令、删除或移动文件前通过 ACP 权限请求询问 |

启动命令固定加 `--approval-mode write`，不沿用用户全局 omp 配置里的审批模式。这样无论 `~/.omp/agent/config.yml` 里是 `yolo` 还是 `always-ask`，Conclave 看到的边界都一致：写入不打断，命令与破坏性操作进入聊天里的确认卡片。

以下能力**不提供**：

- **规划（Plan）**：omp 的 Plan 模式会在同一回合里自行批准计划并离开只读状态，无法保证规划阶段不写文件。
- **只读**、**无人值守** 和 **全部放行**：没有可切换的对应原生模式。只读阶段和定时/例行运行都不会选到 omp。
- **依赖未完成的计划阶段**：这类任务需要先以只读方式规划；等依赖完成后再启动 omp 执行。

## 模型与推理

模型目录来自 `omp models --json`，只列出当前凭据可用的聊天模型；默认模型取 `omp config get modelRoles` 的 `default` 角色。会话里的模型和思考等级通过 ACP 的会话配置切换，回合进行中不能改。

## 会话、恢复与移交

- 会话按项目目录保存；重启或继续时通过 ACP `session/load` 恢复，不新开会话。
- 原生 fork 不启用：分叉和跨 Agent 移交走 Conclave 的历史移交，新阶段有自己的权限和工具范围。
- 聊天记录、工具卡片和用量都由 Conclave 从 ACP 帧重建；omp 的 `available_commands_update` 会显示为输入框里的斜杠命令。
- 删除会话时，Conclave 会清理对应的 omp 原生会话记录与伴随日志（位于 `~/.omp/agent/sessions/`）。

## MCP 与多项目

- Conclave 的 MCP 服务器和用户在「设置 → MCP」里选中的服务器随 `session/new` 传给 omp。omp 在 ACP 模式下不自动读取磁盘上的 omp MCP 配置；`~/.omp/agent/config.yml` 只作为来源提示显示。
- 会话的附加项目通过 `--add-dir` 在启动时交给 omp，首次提示里也会按绝对路径说明。
- Conclave 的终端工具仍由 Conclave 在聊天里确认（`mcpApproval: 'conclave'`）。

## 用量

Conclave 不整合 omp 的额度读取。可在 `omp usage` 或所用模型服务商处查看；聊天回合的 token 与花费仍按 ACP 返回的 `usage` / `usage_update` 计入统计。

## 排查

- `omp acp` 手动运行时会停在等待 stdin，这是正常的；应由 Conclave 启动。
- 找不到 `omp`：确认 daemon 的 PATH 能看到它，然后在设置 → 外部智能体里「重新检测」。
- 命令一直等确认：在聊天输入框上方的确认卡片里允许或拒绝；拒绝会作为消息告诉 omp。
- 版本过旧：`omp update` 后重新检测。

验证：`pnpm exec vitest run packages/core/src/agents/omp packages/core/src/agents/agent-registry.test.ts`。
