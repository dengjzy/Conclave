# 按需加载的宠物资源包

默认软陶的姿势、步态和公共脸部材质仍随 App 提供。MOSS、ZIP 的完整素材保存在独立仓库 `dengjzy/conclave-pets`，主程序仅包含目录与小预览。目录更新不触发图集下载，用户点击「下载并使用」后才安装。

## 边界

- `protocol/src/pet.ts` 定义 Format 1、图集和头眼参数、目录、安装状态及 RPC 的数据契约。
- `core/src/pet-library.ts` 负责目录缓存、下载、取消、安装记录、更新、移除和本地读取。
- `core/src/pet-package.ts` 校验 ZIP、大小、SHA-256、图片尺寸和包身份；不执行资源包内容。
- renderer 使用 `pet-library.ts` 取得安装状态与资源，通过 `PetResourceCache` 共享当前挂载消费者的图集 Blob URL；最后一个消费者离开时撤销 URL。
- Electron main、daemon 和任务来源插件协议都不增加职责；宠物资源没有独立进程。

新增 `pets` core feature，客户端仅在服务端声明支持后调用。RPC 为 `pets.list/install/cancel/remove/read`，通知为 `pets.changed`。旧 core 仍可显示内置软陶，其余下载入口不可用；这些是新增方法，不改变已有协议字段。

## 分发与本地目录

目录地址固定为 `https://raw.githubusercontent.com/dengjzy/conclave-pets/main/catalog.json`，附件使用同仓库 GitHub Release 的固定版本 URL。每项含名称、描述、136px 小预览、版本、字节数和 SHA-256。离线时沿用最后成功缓存的目录，首次启动有随 App 提供的回退目录。

安装位置为 `CONCLAVE_HOME/pets/`，默认即 `~/.conclave/pets/`：

```text
pets/
  catalog.json
  installed.json
  moss/1.0.0/
    manifest.json
    poses.webp
    walk.webp
    face.webp
```

下载文件先在内存中受限读取，校验后写入暂存目录，最后原子切换安装记录。下载、校验或写入失败时不替换旧安装；重试不会沿用半包。同一宠物的重复请求共用正在进行的安装。

下载只接受目录中 `dengjzy/conclave-pets` 的 HTTPS Release URL。ZIP 最多 4 MiB，且根目录只能有 manifest 和三张规定尺寸的 WebP；不接受 JS、目录、重复文件、符号链接或越界路径。每张图片最多 2 MiB，先核对摘要和 WebP 尺寸再交给 renderer。小预览尺寸也受限。

## 使用与内存

选择已安装版本直接使用本地数据，无需再次下载。有新版本时提供独立的「更新并使用」操作，用户可以继续使用已安装的旧版。移除当前宠物会回退到软陶；内置宠物不可移除。若下载过程中另选了宠物，较晚完成的下载不会覆盖新的选择。

设置中的可选宠物卡片使用小 PNG 预览，不挂载完整 `PetSprite`。只有实际显示的宠物会读取和解码图集。关闭主舞台或打开设置时，主舞台不继续持有可选图集；设置预览按需要持有一份，共享加载避免重复读取。撤销 Blob URL 是释放应用引用，浏览器最终的纹理回收仍由其缓存策略决定。

Format 1 的动作和网格与现有引擎相同。资源包通过 JSON 提供站立和步态锚点、各姿势的眼睛与颈部参数、材质取样位置及眼睛渲染类型，原有头身比例、步频、眨眼、转身、跳跃和探头逻辑共用。

## 资源仓库与开发

资源源目录在 `~/ai-projects/conclave-pets`。`node scripts/build.mjs` 生成 ZIP、各宠物的 manifest 与根目录 catalog；ZIP 文件顺序、时间及摘要可复现，构建不需要 npm 依赖。相同版本发布后不替换内容。

本地联调可显式设置 `CONCLAVE_PET_DIRECTORY` 为该仓库的 `dist/`。此时 core 用本地目录和 ZIP 作为下载源，但仍经过同一套包校验、版本安装和 renderer 加载。普通用户不需要此变量。

独立游乐场默认不连接 core，仅展示内置宠物；提供原有 `?port=&token=` 参数时连接轻量客户端模式，可检查完整的资源包流程。正常桌面开发版继续从 preload 获取 core 地址。

资源仓库的 main 分支提供目录与源素材；正式下载还需要发布 URL 对应的 Release 附件。提交到 main 不会自动创建或发布 ZIP 附件。
