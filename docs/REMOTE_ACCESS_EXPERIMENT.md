# 多端远程连接（实验）

设置 → 远程连接（实验）开启后，点击「添加设备」，默认展示 agents-go App 配对码。安装 APK 后，在 App 内点击「扫码连接」，扫描电脑上的码，自动读取节点地址与名称、提交手机名称并配对。无需填写服务器地址、端口或口令，也不会访问二维码中的网页地址；连接后任务和聊天始终在 APK 内操作。

二维码同时提供「App」和「浏览器」入口；浏览器页签显示发布状态，发布成功后可用系统相机打开。设置页可以单独发布、停止或重试浏览器网页，也可以点击「连接其他节点」在当前电脑打开连接端。App 的页面、JS 和 Tailcat WASM 随安装包提供，网页发布失败不会影响 App 连接。

当前支持 Linux x64 宿主。Android 与手机浏览器使用 agents-go；电脑浏览器和桌面客户端连接其他节点时使用原版 Conclave 工作区。两种界面共用配对与 Tailcat 传输，可新建不依附任务的会话、查看会话/任务/项目、配置 Agent 与模型、移交给其他 Agent、委派子会话并查看进度，以及发送消息、停止本轮和处理确认。任务启动使用「逐次确认」权限模式；其他配置受协议的安全权限范围限制。业务操作复用 core 原有处理器和检查，Agent 与 PTY 仍由 daemon 持有。

## agents-go 的手机界面

连接端名为 `agents-go`，沿用 dsh-go 的聊天、抽屉和节点选择交互，同时保留 Conclave 的会话与任务区别。手机和 Android 共用界面，小屏使用抽屉与弹层。电脑默认进入原版 Conclave；如需试用 agents-go，仍可显式打开 `/mobile.html`。布局按设备类型选择，缩窄电脑窗口不会自动切换成手机版。

| 位置 | 职责 |
|---|---|
| 会话 | 不必先建任务或选择项目；选择 Agent 后发送第一条消息即可建立独立会话。也能选已有项目作为工作目录 |
| 任务 | 创建、查找、启动和继续任务；移交使用任务自身的状态与依赖规则 |
| 项目 | 显示主机已有项目及会话/任务数量，选中后筛选工作区；不远程创建任意文件路径 |
| 聊天 | Markdown、过程折叠、审批和问题；模型、推理强度、权限与 Agent 预设取自主机实际能力 |
| 详情 | 当前 Agent、项目、执行阶段、移交、委派与子会话；可打开子会话、返回父会话或取消委派 |
| 节点选择 | 粘贴配对链接、切换、命名、重连、移除本机记录；更换节点时清除旧节点的数据视图 |
| 设置 | 当前客户端的显示和连接偏好；主机管理设置仍在 Conclave 本机 |

草稿按节点、对象类型和 ID 隔离。独立会话首次发送依次创建、启动、发送；创建成功后立刻保留会话 ID，后续失败可继续原会话。节点切换后迟到的读取与操作结果不会覆盖新节点。断线不会自动重放写操作；同一客户端进程内，用户明确重试时使用原请求标识防止重复。尚未持久化客户端未确认请求：浏览器刷新或 App 进程被系统回收后，若此前操作结果未知，应先核对主机会话/任务再决定发送；不能把同进程重连的防重保证扩大到跨进程恢复。

节点返回可用方法与能力，客户端据此展示操作。连接旧版节点仍可使用原有任务功能，缺少的方法不会盲目发送。受管理的子会话保留查看和审批入口，目标由父会话或团队管理。

这里的节点是运行 Conclave 的电脑。手机只连接 Conclave，不运行本地 DSH、daemon 或 PTY；dsh-go 的本地运行模式不在 agents-go 范围内。

连接状态与任务状态分别显示：手机断线不表示 Agent 停止，任务正在执行也不表示手机仍然在线。写操作等待确认期间禁用重复提交；结果未知时先重连、刷新状态，不自动重放。审批和问题留在对应任务中，服务端确认后才按已处理展示。

## 授权与有效期

- 二维码五分钟有效，只能兑换一次；页面读取后会移除地址栏里的配对内容。
- 每台手机有独立凭据。Android 使用 Keystore AES-GCM 加密保存并禁用应用备份；浏览器使用 localStorage，受限浏览器不能保存时仅保留本页连接。电脑可查看设备在线状态并撤销授权。
- 节点身份、Tailcat 密钥和设备授权持久保存。关闭远程连接会断开通道，重新开启后已配对 App 可恢复连接；撤销设备才使其凭据失效。一次性二维码仍会过期，且不能重复兑换。没有自动开启或永久后台服务。
- 实验网页使用临时 Cloudflare HTTPS 域名。它随远程服务停止而失效，再次开启会换域名。Cloudflare 只提供静态网页，任务和聊天通信通过 Tailcat 的加密 DERP 通道。
- 浏览器存储按 origin 隔离，Quick Tunnel 换域后，新页面读不到旧域保存的电脑列表、凭据和偏好；旧数据不等于被删除，也不会自动迁移。多台电脑能保存在同一个网页 origin 下，不代表不同临时网址会共享列表。
- App 保存节点 ID 和对应的 Tailcat 加密端点。节点 ID 只用于应用归属，传输身份由 Tailcat 地址绑定；同一节点 ID 的地址变化不会静默覆盖已信任节点。旧 Web 邀请保持原有载荷，App 邀请额外包含节点信息，两者都在认证握手后读取节点信息。
- 手机浏览器切后台可能中断网络，回到页面可重新连接；不会自动重放写操作。

远程授权能操作任务，应只把二维码给自己的设备。撤销或停止会断开通道并拒绝新的请求，但已经交给业务处理器的操作不会回滚，Agent 也不会因此自动停止；可以在手机或电脑明确停止本轮。手机端「移除电脑」只移除本地保存的连接，设备授权应在电脑端撤销。

## 研究对照

以下为本次核查的官方源码快照，借鉴的是交互与能力边界。它们的客户端协议、账户和配对机制并不与 Conclave 直接兼容，二维码有效期也不能互相套用；Conclave 保持上面的五分钟一次性票据和独立设备撤销规则。

| 项目 | 客户端路线 | 值得借鉴的部分 |
|---|---|---|
| dsh-go | Flutter/Dart 原生应用，也有承载 DSH Web 的网页模式；不是 React DOM 客户端 | 主机切换时同时显示名称与状态；凭据通过异步 SecretStore 接口交给系统安全存储；网页模式仍单独处理通知、分享与会话跳转 |
| Orca | 手机端使用 Expo/React Native，并有 Web 平台适配；不是把桌面 DOM 页面直接套壳 | 扫码后确认目标主机、多主机设备凭据、Web 与原生分开的存储实现；远程推送有独立网关。LAN 配对与 relay 登录有各自流程 |
| Paseo | Expo/React Native 客户端覆盖 iOS、Android 和 Web，Web 使用 react-native-web | 主机身份与多条连接线路分离；前台恢复时验证连接并补同步；发送与审批保留确认状态。原生推送和 Web 能力仍分开实现 |

固定源码证据：

- dsh-go `0579295f1b74f12607d435e4b6c1f677da9c1c41`：[主机切换](https://github.com/ccch1mneyyy/dsh-go/blob/0579295f1b74f12607d435e4b6c1f677da9c1c41/app/lib/ui/remote/host_switcher.dart)、[异步凭据存储](https://github.com/ccch1mneyyy/dsh-go/blob/0579295f1b74f12607d435e4b6c1f677da9c1c41/app/lib/remote/secret_store.dart)、[网页模式与系统能力连接](https://github.com/ccch1mneyyy/dsh-go/blob/0579295f1b74f12607d435e4b6c1f677da9c1c41/app/lib/ui/web/web_home.dart)。
- Orca `c624d85cbcae02b603a1c0001fc6b8e78ccf7e95`：[Expo/RN 依赖](https://github.com/stablyai/orca/blob/c624d85cbcae02b603a1c0001fc6b8e78ccf7e95/mobile/package.json)、[扫码](https://github.com/stablyai/orca/blob/c624d85cbcae02b603a1c0001fc6b8e78ccf7e95/mobile/app/pair-scan.tsx)、[配对确认](https://github.com/stablyai/orca/blob/c624d85cbcae02b603a1c0001fc6b8e78ccf7e95/mobile/app/pair-confirm.tsx)、[设备凭据的平台分支](https://github.com/stablyai/orca/blob/c624d85cbcae02b603a1c0001fc6b8e78ccf7e95/mobile/src/transport/host-device-token-store.ts)、[推送网关](https://github.com/stablyai/orca/blob/c624d85cbcae02b603a1c0001fc6b8e78ccf7e95/cloud/README.md#mobile-push-gateway)。
- Paseo `3ed57e9dd72df4927b08f16859eaf8d4d2d70ac2`：[Expo/RN/Web 依赖](https://github.com/getpaseo/paseo/blob/3ed57e9dd72df4927b08f16859eaf8d4d2d70ac2/packages/app/package.json)、[主机与线路模型](https://github.com/getpaseo/paseo/blob/3ed57e9dd72df4927b08f16859eaf8d4d2d70ac2/packages/app/src/types/host-connection.ts)、[连接与前后台恢复](https://github.com/getpaseo/paseo/blob/3ed57e9dd72df4927b08f16859eaf8d4d2d70ac2/packages/app/src/runtime/host-runtime.ts)、[发送确认](https://github.com/getpaseo/paseo/blob/3ed57e9dd72df4927b08f16859eaf8d4d2d70ac2/packages/app/src/composer/actions.ts)、[审批卡片](https://github.com/getpaseo/paseo/blob/3ed57e9dd72df4927b08f16859eaf8d4d2d70ac2/packages/app/src/agent-stream/view.tsx)、[Web 推送边界](https://github.com/getpaseo/paseo/blob/3ed57e9dd72df4927b08f16859eaf8d4d2d70ac2/packages/app/src/push-notifications/index.web.ts)。

## Android APK

`packages/mobile` 是 Capacitor Android 壳，复用 `packages/web/src/mobile` 的 React UI 和受限远程协议。手机不运行 DSH、Agent、daemon 或 PTY。当前没有 iOS 工程。

- 安装后点击「扫码连接」，首次使用相机时授予权限。扫描器使用本地 ZXing，不依赖 Google 服务。取消、拒绝权限、扫描非配对码或过期码时保留当前节点。
- 二维码名称用于显示，认证结果中的节点信息用于保存。名称可以稍后修改。配对后可在「已保存的电脑」中重连，不需要再次输入地址。
- App 内置匹配的 Tailcat JS 与解压后的 WASM，构建时校验固定 SHA-256。WebView 使用本地 HTTPS origin，未配置远程 `server.url`，任意远程网页不能进入带原生权限的主 WebView。
- `packages/web/src/remote` 中的 `NodeConnection` 与 `NodePlatform` 共享配对、能力协商、凭据、偏好、设备名称、扫码、前后台活动与 `read/write/close` 通道；原有 Mobile 名称保留兼容导出。Android Keystore 操作异步返回，凭据读写失败会向客户端报告；普通偏好和草稿使用本机缓存与持久存储。
- Android 返回前台沿用客户端恢复流程，补读任务和聊天；不自动重放结果未知的写操作。锁屏和后台期间不保证保持在线，Agent 在电脑上继续运行。
- 最低 Android 8（API 26），需要支持当前 UI/WASM 的 Android System WebView（123 或以上）。不满足时显示本地升级提示。系统相机自动唤起 App 的 App Links、本地通知、推送、附件和完整桌面功能尚未接入。

当前 APK 继续使用 Tailcat 浏览器/WASM 数据面，业务流量经过公共 DERP，不会因打包而自动获得 UDP 直连。Cloudflare 只用于可选浏览器网页，和 App 数据通道独立。

构建调试安装包：

```sh
pnpm install --frozen-lockfile
# 本机需有 Java 21 和 Android SDK；按 Android 常规方式配置 SDK 路径。
pnpm --filter @conclave/mobile android:debug
```

产物：`packages/mobile/android/app/build/outputs/apk/debug/app-debug.apk`。这是本地调试签名的实验安装包，不是应用商店发布版本；构建不会发布或上传 APK。

## 独立浏览器连接端

`pnpm build` 或 `pnpm build:remote` 会生成 `packages/web/remote-dist/`。其中 `index.html`、编译资产、Tailcat WASM 和匹配 JS 可部署到固定 HTTPS 站点的根路径；构建不发布、不包含主机凭据。固定 origin 能保留该浏览器的节点列表，避免临时域名每次变化导致重新配对。当前客户端不是离线 PWA。

本机可打开 `/conclave?node=connect`，也能从设置的「连接其他节点」进入。在另一台电脑上打开公开浏览器网址会显示原版 Conclave，手机浏览器会自动进入 agents-go。粘贴一次性配对链接即可添加节点，无需填写主机地址或端口。所有业务仍通过 Tailcat 通道，网页服务器只提供静态文件。二维码中的 `agents-go.invalid` 是配对载荷，适用于 App 扫码或连接端粘贴，不是应当访问的网站。

## 电脑端的原版工作区与节点切换

标题区的节点入口显示当前节点及连接状态，可回到本机、选择已配对节点、粘贴配对链接、断开或移除本地记录。公开静态站点只提供远程节点入口，不读取访问电脑的本地 core 凭据；远程连接失败也不会回落到本机节点。移除本地记录不等于撤销主机授权。

切换节点会重新加载工作区，清除旧连接、订阅和内存缓存。桌面布局偏好、输入草稿、待保存编辑和待确认首条消息按节点分别存储，本机原有存储键保持兼容。多个浏览器临时 origin 的记录仍然隔离；要长期保存同一节点列表应部署固定 HTTPS 入口。

远程桌面复用原版会话、任务与项目布局，并接收实时消息和变更。操作仍限于已开放的会话、任务、移交与委派；文件内容、Git 内容、终端输出及写入，以及主机管理设置未开放。界面显示远程限制，未开放操作会明确拒绝且不切断节点连接。远程路径属于目标节点，不会交给当前电脑的文件选择器或编辑器打开。

桌面 RPC 是鉴权后 Tailcat 通道的一种新会话，采用协议定义的方法白名单、真实 core 订阅和断开清理，不公开 core HTTP/WebSocket 或本机 token。输入仍限 64 KiB，结果仍限 4 MiB，写请求继续使用设备级持久防重记录。客户端限速排队；已提交但超时的写操作标记结果未知，不自动重放。旧节点不支持桌面工作区时会提示更新节点或使用手机版。

## 开发与验证

```sh
pnpm install --frozen-lockfile
pnpm build
CONCLAVE_HOME=~/.conclave-demo pnpm dev
```

使用独立测试 home，避免混入日常任务。设置页由 `remote-access-experiment` 能力标记控制，连接旧 core 时不显示。新的 RPC 是增量扩展，不改变协议版本。

默认运行文件位于 `<CONCLAVE_HOME>/remote/`，网络组件固定哈希、仅允许 HTTPS 下载，校验通过才执行。开发时可用 `CONCLAVE_REMOTE_ASSETS` 指向已有缓存；缓存同样需要校验。日志和临时密钥所在目录仅当前用户可访问，不能作为静态站点发布。源代码运行需要先执行 `pnpm build`，生成 `remote.html`、`mobile.html` 和对应资产。

2026-11-06 原版电脑工作区与节点切换更新：类型检查与最终构建通过，374 个测试文件通过，3060 项通过、4 项跳过。真实公共 DERP 的 15 项浏览器验收通过，覆盖电脑原版 UI、手机自动进入 agents-go、双节点同 ID 草稿隔离、实时会话更新、新建会话 create→continue→send、同会话移交、选择已有项目与 Agent 创建并启动任务，以及未开放控件不会断开连接。验收使用构建后的原版 App、共享连接与真实远程网关；业务后端为协议校验的确定性 fixture，未调用模型或 daemon，不等于真机或长期公网稳定性验收。实验节点更新保留原有 1 个会话和 2 台已配对设备。

2026-11-06 会话与多端布局更新：实验 worktree 已快进到 main `4737e11`，原有实验改动完整恢复且保留同步前备份。全仓类型检查、网页构建和 Android 调试构建通过；364 个测试文件通过，2990 项通过、4 项跳过。最后的移交停止条件与远程设置回归 59 项通过；共享 UI、连接与原生适配组合 109 项通过。APK 签名验证通过。

新增真实公共 DERP 验收 24 项通过，含无项目首条消息的 create→continue→send、同会话移交、只读委派与取消、原任务继续、项目筛选、重连和撤销错误。320/390/768/1440px 的明暗主题均无页面横向溢出，弹层中的 Agent/权限菜单可实际选择，共保留 17 张截图。使用真实共享 UI、WASM、连接层与网关，业务处理为协议校验的确定性 fixture，不调用真实模型或 daemon，也不代表 Android/iOS 硬件验收。

实验节点已在原端口更新，保留 1 台原配对手机；浏览器发布恢复 ready，公网 HTML、JS、WASM 返回 200，core 鉴权路径返回 404。新版 APK 覆盖安装首次被锁屏中的 Vivo 系统拒绝；随后通过新 ADB 端口于 2026-11-06 15:29 完成覆盖安装，保留原有节点记录。V2220A 真机已打开新版独立会话页，显示已连接的 Dell 节点与主机 Agent/模型选项；相机、锁屏恢复等完整硬件矩阵仍未全部验证。

验证覆盖一次性配对、过期、撤销多个连接、并发操作、写请求去重、启动取消、异常退出清理、静态路径隔离，以及手机网页实际通过公网 DERP 连接的流程。完整浏览器验收用真实 core/daemon 和独立临时项目，测试 CLI 模拟 Agent 回复，不产生模型调用费用。

2026-11-06 APK 集成验证：全仓类型检查、构建通过；363 个测试文件通过，2940 项通过、4 项跳过。随后补充的旧设备迁移与本地 WASM 路径检查分别通过客户端 44 项、原生适配 7 项目标测试。扫码默认名称、过期/非配对码、相机取消、重复点击、设备凭据读写失败、主机重启恢复及独立网页失败均有回归覆盖。Android 调试 APK 构建、签名校验、2 项 Java 导航测试和 Lint 均通过；Android 原生硬件验证仍待进行。

真实公网 DERP 补充验收 17 项通过：使用共享 MobileApp 与包内 WASM，扫码后自动识别节点、读取任务与会话；关闭并重建主机服务实例后，从磁盘恢复同一节点、通道与设备授权；撤销后重连被拒绝，未触发任何业务 RPC。全程无 Cloudflare 或二维码网页导航。扫码适配器和任务后端使用确定性测试替身，浏览器为桌面 Chrome 手机尺寸，未运行模型；这项检查不能替代 Android 相机、Keystore、锁屏恢复或长期公网稳定性验证。

2026-11-06 agents-go 界面重构验证：全仓 361 个测试文件通过，2906 项通过、4 项跳过，类型检查与构建通过。聊天使用安全 GFM Markdown，图片转换为链接；相邻已完成过程可折叠。新增覆盖发送期间重选任务、抽屉与设置返回保留草稿，以及异步提问仍可直接发送消息。

此前公网 HTTPS 入口已完成配对、创建、发消息和重连，但重复验收出现临时域名 DNS 解析失败和 WASM 下载超时。将静态页面改由本机提供、保持真实 Tailcat 公网 DERP 通道后，新版 15 项浏览器验收全部通过，包括票据拒绝、设备撤销、任务搜索与草稿、320/390 像素布局、320 像素大字设置，以及弹层关闭与焦点；无直接 core 访问和未捕获浏览器错误。这不等同于 iOS/Android 真机或长期公网可用性验收。

Android 真机还需核对：相机权限与扫码、Keystore 凭据保存、切换电脑不串任务或草稿、锁屏后的前台恢复不重复发消息、审批响应丢失时重新读取状态、凭据写入失败的提示、系统返回键、软键盘和安全区，以及实际设备上的 WASM 启动。可选网页域名变化不应影响 App 保存的配对；浏览器跨域访问则需重新配对。这些仍需真机验收；本机编译和共享客户端测试不能替代 Android 硬件验证。

## 边界

这是集成实验，尚非长期远程基础设施。临时 HTTPS 和公共 DERP 没有服务可用性保证。已保存设备与节点身份仍依赖本机持久数据和所用 DERP 可达。后续可增加固定网页与其他传输适配，不需要因此开放 core 端口。

远程网关仅接受协议白名单内的操作；桌面保留原有会话/任务内容与工作区元数据，不开放文件、Git 内容、终端输出、管理或凭据 RPC。任务列表只返回分页摘要；单条传入消息最多 64 KiB，单条结果最多 4 MiB，超出时拒绝并提示。写操作携带独立 requestId，同一设备同一请求不会因连接重试重复执行；每台设备授权最多保存 4096 条写入记录（跨主机重启保留），达到上限需重新配对。不要把此入口改成任意 core HTTP/WebSocket 反向代理。

agents-go 与远程桌面均未开放文件/终端与 Git 内容、附件上传、完整主机设置、团队/讨论/例程管理和定时消息。项目入口用于读取与筛选已有项目。主机已有功能不会因此被改成远程任意 RPC；后续按协议逐项扩展。
