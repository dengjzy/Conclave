# Tailcat 网页连接实验

在独立数据目录里验证：浏览器 → Tailcat WASM → 公共 DERP → 本机 Tailcat → 配对网关 → 真实 Conclave core。实验不会启动 Agent，不使用真实 Conclave 数据，也不向浏览器提供 core 的全局 token。

这是独立原型，尚未接入 Conclave 的正式设置页或手机 App。宿主运行环境暂为 Linux x64；浏览器已实测从公网 HTTPS 入口访问的本机 Chrome；手机真机由扫码测试确认。

## 启动

在 worktree 根目录运行：

```sh
pnpm install --frozen-lockfile
npm ci --prefix experiments/tailcat-web
node experiments/tailcat-web/prepare.mjs /tmp/conclave-tailcat-runtime
node experiments/tailcat-web/run.mjs --assets /tmp/conclave-tailcat-runtime
```

准备脚本需要 `curl`、`tar`，只下载并验证官方产物，不修改系统安装。CLI 固定为 v0.7.0，WASM 与 Go JS 运行时也固定 SHA256。官方 Pages 的 URL 会变化，若哈希变化会拒绝安装，需要另行审查更新；不会自动接受未知版本。

runner 自动创建 `/tmp/conclave-tailcat-test-*`，所有服务只绑定 `127.0.0.1`。在终端提示的 `experiment.json` 中打开 `hostUrl`，点击「生成一次性二维码」，然后点击「在本机打开配对页」或扫描外网二维码。该 URL 带有本机控制凭据，不要分享。

手机大小的网页可执行：配对、中文消息回传、读取真实 core 的版本与任务列表、断开重连。设备凭据在测试浏览器的 localStorage 中；测试网关重启后需重新配对。关闭页面不会停止 core，宿主页面可以撤销设备。

默认二维码地址是 `127.0.0.1`，仅供本机验证。手机外网测试先运行独立静态入口，再将它的 HTTPS 地址传给 runner：

```sh
node experiments/tailcat-web/public-web.mjs --assets /tmp/conclave-tailcat-runtime --state /tmp/conclave-tailcat-public
node experiments/tailcat-web/run.mjs --assets /tmp/conclave-tailcat-runtime --client-url https://实际地址.trycloudflare.com/
```

静态入口需要经官方发布包 SHA256 校验的 `assets/cli/cloudflared`；本次采用官方 2026.10.7，Linux amd64 二进制 SHA256 为 `1f99fb518b83dec2ba8d870a7cc991d82a77e6196295a3d2754ba17ab9f91872`。脚本通过临时 Quick Tunnel 提供客户端文件；公网地址写入状态目录的 `public.json`。只开放明确列出的 HTML、JS、CSS、WASM，不提供 `/host`、`/admin/*` 或 core 接口。管理页仍只在本机。

打开 runner 的 `hostUrl` 并生成二维码，手机关闭 Wi-Fi、用系统相机扫码，在 Safari 或 Chrome 中点击「连接并配对」。网页和约 6.5 MB 的压缩 WASM 经 HTTPS 下载；配对、core 查询、消息回传仍经 Tailcat DERP，不经过静态网页隧道。首次加载需等待网络组件。

二维码 5 分钟内只可兑换一次；成功配对后可在同一浏览器用设备凭据重连。临时静态网址随 cloudflared 进程结束而失效，重启会改变域名；它仅用于此次连通性测试，没有可用性承诺。正式方案应使用固定 HTTPS 静态站点。

在启动 runner 的终端按 Ctrl+C，会关闭本次 HTTP 服务、网关、Tailcat 和临时 core。测试文件保留在临时目录供检查；目录内含私有日志和凭据，应按私密数据保管。它们不在 Git 中。

## 验证

```sh
node --test experiments/tailcat-web/gateway.test.mjs
node experiments/tailcat-web/smoke.mjs /tmp/conclave-tailcat-test-实际目录/experiment.json
```

smoke 使用 workspace 的 `playwright-core` 和 `/usr/bin/google-chrome`，可用 `CHROME_PATH` 指定另一个 Chrome。使用独立临时浏览器上下文，不读取日常浏览器资料。

验证内容：

- 从实际渲染的二维码图片独立解码，核对完整配对链接。
- 浏览器 WASM 经真实公共 DERP 配对，读取独立 core 的 `system.hello` 与 `tasks.list`。
- 浏览器直接连接 core 的 HTTP 和 WebSocket 被测试拦截；没有直连兜底。
- 中文、换行与 4 KiB 文本往返；记录五次加密通道往返耗时。
- 断开、页面刷新后用设备凭据重连，不重新使用一次性票据。
- 第二个浏览器复用已消费票据被拒绝；设备撤销关闭现有连接并拒绝重连。
- 配对后仍不能访问白名单以外的 core 方法。
- 网关单元测试另外覆盖过期票据、并发兑换、撤销在途请求、非法帧和超时。

结果保存为临时目录里的 `smoke-result.json` 和 `client-connected.png`。仓库中的 `verified-result.json` 是本次真实运行的脱敏结果。

## 边界

一次性票据为 32 字节随机值，服务端只存摘要，5 分钟有效且同步核销。设备得到独立可撤销凭据；票据过期不影响已经配对的设备。配对秘密在 URL fragment 内，页面加载后立即从地址栏移除。服务端控制 API 另用随机本机凭据，要求同源。

网关只接受实验消息，不改动正式 RPC 协议。未授权连接仅可配对或恢复授权；已授权也只能查询两项只读 RPC。不能把此网关当作通用端口代理，否则会遇到当前 core 对 loopback 请求自动授权的问题。

实验设备记录仅存在内存，尚无长期密钥管理、完整手机任务界面、真机相机扫码、移动网络切换和后台恢复验证。浏览器的 Tailcat 当前只能走 DERP 中继；本次同机测试验证了真实中继链路，不证明手机跨网稳定性或 P2P 穿透效果。

## 产物来源

- CLI：官方 [v0.7.0 发布页](https://github.com/tailscale/tailcat/releases/tag/v0.7.0)。实测该二进制 `serve` 只接受同号本地端口，因此 runner 不使用主分支文档中的端口映射语法。
- 浏览器：官方 [Pages](https://tailscale.github.io/tailcat/)，本次构建来源提交 `e00cdde6ff787f801361ff85ed085775c775d4c5`；产物哈希在 `prepare.mjs` 和运行资产目录的 `sources.json`。
- Tailcat 大体积二进制不提交到仓库。配对网关和网页本身只使用本目录的固定版本实验依赖。
