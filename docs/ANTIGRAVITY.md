# Antigravity

Conclave 直接通过官方 `agy` CLI（`>= 1.5.0`，内置 `agy acp --stdio`）接入 Antigravity。

## 运行时与升级

- Conclave 自动探测 `PATH` 与标准安装路径（Linux/macOS 的 `~/.local/bin`、`/usr/local/bin`，Windows 的 `%LOCALAPPDATA%\agy\bin`）中的 `agy` CLI，校验其支持 `acp` 子命令且版本 `>= 1.5.0`。
- 启动时直接以 `agy acp --stdio` 运行；用户只需在终端执行 `agy update`（或在 设置 → 外部智能体 点击升级），新模型、思考档位、权限模式与斜杠命令即通过 ACP 握手自动生效。
- 未安装或版本低于 `1.5.0` 时，设置 → 外部智能体 会提供官方安装命令（macOS/Linux：`curl -fsSL https://antigravity.google/cli/install.sh | bash`；Windows PowerShell：`irm https://antigravity.google/cli/install.ps1 | iex`）。

## 登录与多账号隔离

Conclave 用 `oauth-personal`（Google 账号）认证：

- **默认账号（本机账号）**：直接复用 `~/.gemini/antigravity-cli` 与系统钥匙串中的登录态；通过 Conclave 发起默认账号登录时，会预先写入 `cache/antigravity-keyring-unavailable` 以便凭据可持久化到 `antigravity-cli/antigravity-oauth-token`。
- **托管多账号（设置 → 账号）**：每个新增账号使用独立状态目录 `~/.conclave/agent-accounts/antigravity/<id>`。
  - Conclave 通过 `--gemini-dir <accountHome>` 启动 `agy acp --stdio`，并写入 `<accountHome>/antigravity-cli/cache/antigravity-keyring-unavailable` 标记，强制该进程将 OAuth 凭据隔离保存在 `<accountHome>/antigravity-cli/antigravity-oauth-token`（权限 `0600`），既不会读取默认账号在系统钥匙串里的登录，也不会覆盖它；同时无需改动进程的 `$HOME`，Git/SSH/`gh`/`glab` 等工具配置在任何项目工作目录（`cwd`）下均完全正常。
  - 账号之间共享 `config`、`skills` 以及 `conversations`（`antigravity-cli/conversations`），而 `brain`、`cache` 与摘要库保持各账号私有。某个账号额度耗尽后，在 Conclave 切换到另一账号即可无缝续聊同一会话（恢复时按需安全拷贝该会话已登记的 `brain/<id>` 产物）。
- 重新登录在独立临时目录 `.conclave-login` 中完成，成功后才原子替换凭据；取消或关闭登录终端保留原登录。

## 权限模式

| Conclave | `agy` CLI | 行为 |
|---|---|---|
| ask | `default` | 修改文件、运行命令前先请求批准 |
| acceptEdits | `accept-edits` | 自动批准修改文件，运行命令仍需批准 |
| plan | `plan` | 只读规划模式 |
| bypass | `auto` | 自动批准工具调用（受安全策略约束） |

## 多目录与会话能力

- 当 `agy` 在 `initialize` 中声明 `sessionCapabilities.additionalDirectories` 时，Conclave 直接在 `session/new` 传入附加项目目录；否则回退为在首条消息线路帧附上附加目录说明。
- 会话期间自动接收 `available_commands_update` 透出的会话斜杠命令（如 `/compact` 等），并从 `configOptions` 与 `models.availableModels` 提取每个模型可用思考档位。

## 用量额度

设置 → 用量额度和底部用量栏显示 Antigravity 的额度与订阅方案：

- 读取 `antigravity-cli/antigravity-oauth-token`（兼容嵌套 `{ token, auth_method, id_token_email }` 格式；本机默认账号还支持从系统钥匙串读取 `service = "gemini"` / `username = "antigravity"`，兼容 macOS `security find-generic-password` 的 `go-keyring-base64:` 编码及 Linux `secret-tool`），直接使用 `id_token_email` 或回退请求 Google `userinfo` 接口获取邮箱。
- 若访问令牌已过期，Conclave 使用随附的 `refresh_token` 在内存中换取新访问令牌并缓存至提前一分钟过期，从不改写磁盘上的凭据文件。
- 当本地缺少 `cache/default_project_id.txt` 时，先调用 `v1internal:loadCodeAssist`（`ideType: "ANTIGRAVITY"`）解析 `cloudaicompanionProject` 与订阅层级（`plan`），再向 `v1internal:retrieveUserQuotaSummary` POST `{"project": project_id}`（依次尝试 `daily-cloudcode-pa` 与 `cloudcode-pa`），使用 `antigravity/acp/<version>` 格式的 `User-Agent`。
- 每个桶按 `window`（或 `bucketId` 的后缀）分成 5 小时和每周两种窗口，`remainingFraction` 换算成已用百分比，标了 `disabled` 的桶不显示。通用 Gemini 桶（`gemini-5h`、`gemini-weekly`）计为账号自己的额度；其余模型专属或共享分组桶（如 `Gemini 4 Argon`、`Claude and GPT models`）以组名标出。
- Google 拒绝刷新（`invalid_grant`）时显示登录已过期，可以在 设置 → 账号 里重新登录。

## 已知边界

- 发送后 30 秒没有任何回合事件时显示等待提示，6 分钟仍无事件则停止并提供重试入口，不自动重发。该计时只针对首次响应；工具已开始后，后续模型请求仍可能较慢。
- 模型调用失败（例如额度用尽）不会作为 JSON-RPC 错误返回，而是作为一段回复文字，回合照常以 `end_turn` 结束。
- 只读参考项目：文件工具碰不到它，所以改不了；Default 模式下发来的编辑审批也由 Conclave 直接拒绝。Auto Edit 和 Auto 下编辑不发审批时，命令行写入仍受外部智能体安全边界限制并由提示约束。
