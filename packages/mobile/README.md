# agents-go Android

Conclave 手机界面的 Capacitor Android 壳。任务和 Agent 仍在电脑运行；APK 内置 React 页面、Tailcat JavaScript 与 WASM，不加载临时公网网页，也不在手机运行 DSH。

## 构建

需要 Node.js 22.13+、仓库指定的 pnpm、Java 21、Android SDK Platform 35 和 Build Tools 35.0.0，设置 `ANDROID_HOME` 为 SDK 路径。

```sh
pnpm install --frozen-lockfile
pnpm build:android
```

输出：`packages/mobile/android/app/build/outputs/apk/debug/app-debug.apk`。这是本地调试签名，命令不会安装到手机，也不会发布。

固定 Capacitor 7.6.10、Android Gradle Plugin 8.10.0、Gradle 8.11.1 和 ZXing Embedded 4.3.0。Gradle Wrapper 首次构建会下载对应工具；依赖使用 npm、Google Maven、Maven Central 官方来源。

Tailcat 浏览器资源在构建时下载并核对 SHA-256，版本与 `packages/core/src/remote-assets.ts` 一致，缓存于本包 `.cache/tailcat`。`CONCLAVE_MOBILE_ASSET_DIR` 可指定已有的、通过相同校验的资源目录；构建不依赖固定临时路径。官方 Pages 内容若发生变化，构建拒绝打包，需核实并同时更新两端固定版本。WASM 构建时解压为 `main.wasm`，原生适配使用此本地 URL；浏览器入口仍沿用 `main.wasm.gz`。

## 使用与边界

Android 8.0+，Android System WebView 123+。旧 WebView 显示内置升级提示。打开应用后点“扫码连接”，允许相机访问并扫描电脑显示的连接码。扫码解码在本机执行，不需要 Google Play 服务或远程识别模型。取消扫码保持原连接；格式验证、短票据及连接流程由共享移动端处理。

共享连接层位于 `packages/web/src/remote`，Android 与浏览器复用 `NodeConnection` 的配对、能力协商和恢复逻辑。`mobile-native.ts` 实现兼容 `NodePlatform` 的 `MobilePlatform`：

- 设备名来自 Android 型号，扫码返回未经转换的原始文本；不打开扫描地址。
- 凭据通过 Android Keystore AES-256-GCM 加密，记录名参与认证；原生提交完成才报告成功。卸载应用会移除本机凭据，应用备份与设备迁移均禁用。
- 设置与草稿在独立 SharedPreferences 中；启动异步读入缓存，UI 同步读取、按序提交偏好写入。系统存储写入失败时，本次会话仍保留内存值，后续写入返回失败。
- 前后台事件来自原生 Activity；后台不保证网络持续存活，返回前台由共享连接逻辑恢复。
- WebView 仅允许 `https://localhost/` 与 `/index.html`，扫描地址不会导航，用户主动点击的外部 HTTPS 聊天链接交系统浏览器打开，不进入带原生桥的页面。未注册外部深链接入口；后续增加时必须交给 `importInvitation` 验证，不能导航。
- 日志不输出原生桥调用参数，WebView 调试关闭，禁止明文 HTTP；APK 内容限制策略允许 Tailcat 使用 HTTPS/WSS。

本包复用手机/电脑网页的会话、任务、项目、模型配置、移交和委派，不额外暴露桌面 RPC。布局按屏幕尺寸切换，原生层只提供设备能力。未来 iOS 壳实现同一平台接口，不能复用 Android Keystore 或 Java 扫码类。

浏览器刷新或 App 进程被回收后，客户端未确认写请求的标识尚未恢复。此前操作若结果未知，应先核对主机状态；同进程前后台重连的防重不等同于跨进程保证。

## 检查

```sh
pnpm --filter @conclave/web typecheck
pnpm exec vitest run packages/web/src/mobile
cd packages/mobile/android
./gradlew --no-daemon :app:testDebugUnitTest :app:lintDebug
```

Java 导航规则测试覆盖外部 URL、脚本/文件协议和本地非入口页面。摄像头扫码、Keystore、系统返回与前后台恢复仍需要在授权的模拟器或真机验证；仅 APK 编译成功不代表这些设备行为已验证。
