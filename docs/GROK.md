# Grok Agent

Conclave 通过官方 `grok agent stdio` 接入 Grok CLI，复用通用 ACP driver。支持聊天、任务、预约运行、原生会话恢复、权限审批、计划审批、MCP 与额度监控。

## 运行要求

- Grok CLI 1.0.70 或更高版本，要求具备对 ACP stdio 模式的原生支持。
- 可在终端运行官方独立安装脚本：
  - Linux / macOS：`curl -fsSL https://x.ai/cli/install.sh | bash`
  - Windows：`irm https://x.ai/cli/install.ps1 | iex`
- 登录使用 `grok login`，或通过环境变量配置 `GROK_DEPLOYMENT_KEY`、`XAI_API_KEY` 或 `GROK_API_KEY`。
- 默认数据目录是 `~/.grok`，尊重 `GROK_HOME`。

## 权限与运行模式

| Conclave / Grok 模式 | ACP 模式 | 行为说明 |
| --- | --- | --- |
| Default | `ask` | 执行命令或修改前逐项询问确认 |
| Plan | `plan` | 先探索代码并制定计划，确认后再修改 |
| Auto | `auto` | 由 Grok 自动批准安全操作，关键操作仍会询问确认 |
| YOLO | `bypass` | 直接运行所有工具与操作，不再询问（仅在用户允许全部放行时可选） |

启动命令只传 `['agent', 'stdio', '--no-auto-update']`，避免自动更新检查污染 stdio 通信流。权限模式通过 ACP 会话初始化与配置动态下发。

Grok 在只读团队阶段（如代码审查与核验）使用 `ask` 模式，确保只读操作按安全边界执行。群聊讨论使用 `plan` 模式。

## 目录、多项目与 MCP

多项目工作区与参考目录通过 ACP `additionalDirectories`（在 `session/new` 时下发）传入，并由 `grokDialect.startNote` 注入提示词。Conclave 拒绝明确写入参考项目的文件请求。

Conclave MCP 与用户选择的 MCP 随 `session/new` 动态传入，不直接改写 Grok 本机配置；设置 → MCP 支持从 `~/.grok/mcp.json` 导入已有服务配置。

## 用量与额度

每周额度读取 `grok-usage.ts` 并显示在底部状态栏。
