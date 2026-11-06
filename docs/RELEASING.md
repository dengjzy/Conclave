# 源码构建与版本

Conclave 当前从源码运行 Web 界面、core 和 daemon，没有自动应用发布工作流。推送 main 或创建 PR 会运行 [CI](../.github/workflows/ci.yml)，检查类型、测试、构建和插件 SDK；这些检查不发布应用。

## 构建与验证

在仓库根目录使用 Node 24（见 `.nvmrc`）和 pnpm 12：

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

`pnpm build` 先通过 `scripts/build-plugins.mjs` 构建 DSH 插件，生成 `packages/dsh-runtime/dist/runtime.tgz`，再用 Vite 生成 `packages/web/dist`。core 和 daemon 仍通过 Node 与 tsx 运行源码。

构建后可用独立数据目录试运行：

```bash
CONCLAVE_HOME=~/.conclave-demo pnpm start
```

`bin/conclave.mjs` 启动或复用 daemon，再启动 core；core 提供 Web 静态资源和 RPC。启动器会补建缺失的 Web 资源与 DSH 插件，但不会自动重建已经存在的产物，源码更新后应重新执行 `pnpm build`。开发时的热重载命令见 [从源码运行](ARCHITECTURE.md#7-从源码运行)。

## 应用版本

只在明确需要调整应用版本时修改版本号。1.0 之前按以下规则判断：

- 有破坏性改动时升第二位、第三位归零，例如 `0.0.1` → `0.1.0`。核对实际行为与提交的 `BREAKING CHANGE` footer。
- 其他新功能、改进或修复升第三位，例如 `0.0.1` → `0.0.2`。
- 预发布可加 `-beta.1` 等后缀，例如 `0.0.2-beta.1`。

应用版本在以下五个文件中保持一致：

- `package.json`
- `packages/core/package.json`
- `packages/daemon/package.json`
- `packages/web/package.json`
- `packages/protocol/package.json`

版本用于命令行状态、连接信息、界面显示和插件兼容性检查。修改后核对并运行上述验证：

```bash
node -e 'for (const d of [".","packages/core","packages/daemon","packages/web","packages/protocol"]) console.log(d, require("./"+d+"/package.json").version)'
```

## 独立包与协议版本

- `packages/plugin-sdk` 的 SDK 版本独立，构建、打包和分发见 [SDK 说明](../packages/plugin-sdk/README.md)。
- `packages/dsh-runtime` 的插件包版本独立，不随应用版本批量修改；它作为本地 tarball 供 DSH 加载，无需发布到 npm。实现与验证见 [DeepSeek Harness](DEEPSEEK.md)。
- 来源插件在各自仓库维护版本和分发 ZIP；模板的 `package.json` 与 `manifest.json` 版本必须一致。详见 [插件开发指南](PLUGINS.md)。
- `PROTOCOL_VERSION`、`DAEMON_PROTOCOL_VERSION` 和 `PLUGIN_PROTOCOL_VERSION` 分别表示客户端 RPC、daemon 通信和插件协议，不能随应用版本一起递增。兼容的可选字段不要求升协议版本；破坏兼容性的协议变更才单独处理版本和迁移。
