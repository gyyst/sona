# Sona 自动更新机制

本文档说明 Sona 的自动更新架构、数据契约、发布流程、安全边界以及排障与回滚方式。

适用版本：包含冻结引导器（`src/bootstrap/index.ts`）的版本；v1.12.1 及更早版本没有该引导器。

---

## 1. 为什么需要这套机制

Pengu Loader（含当前稳定版 1.1.6 与最新 1.2 dev 预发布）**没有插件文件写入 API**：

- `context.fs` 只存在于尚未发布的 `feat/app-hub` 分支；
- 即使未来发布，Pengu 也禁止插件改写自己的入口 `index.js`。

因此 Sona 无法像普通桌面应用那样“下载后覆盖安装”。自动更新采用：

> **冻结引导器 + 云端/IndexedDB 应用包 + 本地兜底**

- `index.js`（引导器）由 Pengu 直接加载，安装后不再变化。
- 全部业务逻辑放在可更新的 `app.js` 中。
- 新版本由当前运行的应用下载、校验后写入 IndexedDB，并在 DataStore 记录“待更新指针”。
- 下次启动时引导器优先加载缓存包或远程包，失败则回退本地版本。

首次安装包含引导器的版本仍需手动完成一次；此后才具备自动更新能力。

---

## 2. 插件目录与构建产物

发布 zip（`sona-vX.Y.Z.zip`）结构：

```
sona/
  index.js        # 冻结引导器（构建产物，小于 60 KB）
  app.js          # 应用包（可更新）
  app.css         # 样式（可更新）
  version.json    # 本地版本与构建时间
  update.json     # 更新清单（随包附带，引导器不读取）
  assets/
    README.txt    # 用户自定义资源目录，更新流程永不修改
```

构建由 `vite.config.ts` 的多入口 lib 模式完成，`scripts/build.sh` 额外运行 `scripts/check-build.mjs` 校验以下不变量：

- 产物只允许 `index.js`、`app.js`、`app.css`、`version.json`、`update.json`；
- 不存在额外 JS chunk（引导器与应用包不得共享 chunk）；
- `dist/assets/` 为空——图片等内置资源全部内联为 data URI，更新负载必须是纯文本；
- `app.js` 不含 CSS import（CSS 由引导器注入）；
- `app.css` 不引用外部 `assets/`；
- `version.json` / `update.json` 与 `package.json`、磁盘文件一致。

开发模式（`scripts/dev/dev.sh`）不经过引导器：`penguServe` 仍生成开发用 `index.js`，直接从 Vite dev server 加载源码并支持 HMR。

---

## 3. 数据契约

引导器一旦发布即视为冻结契约，下列字段与键名不可随意修改。

### 3.1 `version.json`（随包发布，本地版本）

```json
{ "version": "2026.11.24.1", "builtAt": 1763942400000 }
```

- `version` 与 `package.json.version` 一致；
- `builtAt` 为构建时间戳，仅用于本地 CSS 缓存击穿；
- 引导器通过 `fetch('<插件目录>/version.json?t=<时间戳>', { cache: 'no-store' })` 读取（Pengu 会剥离 query 再映射文件，query 只用于绕缓存）；
- 读取失败时尝试解析本地 `app.js` 顶部 banner 的 `@version`，仍失败按 `0.0.0` 继续。

### 3.2 `update.json`（发布到 `dist-v<version>` 标签）

```json
{
  "version": "2026.11.24.1",
  "files": {
    "app.js": { "sha256": "<64 位小写十六进制>", "size": 1443326 },
    "app.css": { "sha256": "<64 位小写十六进制>", "size": 110949 }
  }
}
```

- `version` 必须等于发布 tag 去掉 `v` 前缀；
- `files` 只允许 `app.js` 与 `app.css`；
- 单文件上限 8 MB，`sha256` 必须为 64 位小写十六进制。

### 3.3 DataStore 待更新指针

键：`sona:updatePointer`

```ts
interface SonaUpdatePointer {
  version: string        // 目标版本，如 2026.11.24.1
  tag: string            // Release tag，如 v2026.11.24.1
  appUrl: string         // https://cdn.jsdelivr.net/... 或 raw.githubusercontent.com/...
  cssUrl: string
  appSha256: string
  cssSha256: string
  savedAt: number
}
```

- 由应用在下载、校验、写入 IndexedDB 成功后写入；
- 引导器只信任通过 HTTPS + 主机白名单 + SHA-256 格式校验的指针；
- 指针损坏或版本非法时忽略并清除，同时删除 IndexedDB 缓存。

### 3.4 IndexedDB 缓存

```
数据库:   sona-updates
版本:     1
对象仓库: bundles（keyPath: "id"）
记录:     {
  id: "pending",
  version: string,
  appSource: string,   // app.js 全文
  cssSource: string,   // app.css 全文
  savedAt: number
}
```

- 应用写入前必须完成大小与 SHA-256 校验；
- 引导器只使用 `version` 与指针版本一致的记录；
- 清理指针时同步删除该记录；
- IndexedDB 不可用或写入失败时仍写入指针，重启后由远程 URL 兜底，更新页会提示“未缓存到本地”。

### 3.5 引导器运行时信息

引导器在调用应用 `init` 前写入：

```ts
window.__SONA_BOOTSTRAP__ = {
  source: 'local' | 'cache' | 'remote',
  runningVersion: string,
  localVersion: string,
  attemptedVersion?: string,
  error?: string,
}

window.__SONA_PLUGIN_BASE_URL__ = '<插件目录 URL，以 / 结尾>'
```

- 更新页据此展示运行来源、运行版本与本地版本；
- `__SONA_PLUGIN_BASE_URL__` 确保在缓存/远程运行时仍能解析 `//plugins/<目录>/assets/...`。

---

## 4. 引导器选择顺序

```
init(context):
  1. 读取本地 version.json（失败则读 app.js banner，再失败按 0.0.0）
  2. 读取 DataStore 待更新指针（非法则清理）
  3. 若指针版本 > 本地版本：
       a. IndexedDB 缓存包（与指针版本一致，1.5 秒超时）
       b. 远程 ESM import（5 秒超时，仅白名单 URL）
  4. 仍未成功：加载本地 app.js
  5. 本地也失败：若指针未尝试过，再试一次远程；仍失败才向 Pengu 抛错
  6. 若本次运行的是本地版本且本地版本 ≥ 指针版本：清理指针与 IndexedDB 缓存（手动升级/回退后的陈旧数据）
  7. 写入 __SONA_BOOTSTRAP__ / __SONA_PLUGIN_BASE_URL__，注入 CSS，调用 app.init(context)

load():
  等待 init 的 Promise 后调用 app.load?.()
```

CSS 注入方式：

| 运行来源 | 注入方式 |
|---|---|
| 本地 | `<link href="<插件目录>app.css?v=<version>-<builtAt>">`（必须带构建指纹，绕开 immutable 缓存） |
| IndexedDB | `<style>` 内联 `cssSource`（离线可用） |
| 远程 | `<link href="<指针 cssUrl>">` |

约束：引导器不发起 GitHub API 请求，不读取 `update.json`，`init` 不会无限等待网络。

---

## 5. 更新状态机

```
idle / checking → latest | available | error
available       → downloading | latest（跳过） | error
downloading     → ready | error
ready           → latest（跳过 / 恢复本地） | available（发现更高版本）
error           → checking（重试） | idle
```

- `ready` 表示 IndexedDB 与指针已就绪，等待重启；
- 自动检查受 Sona 设置与 `Pengu.autoUpdateCheck` 共同门控；
- 手动“检查更新”不受开关限制；
- 启动时若引导器回退到本地且指针版本更高，初始状态为 `error`（可操作错误），本次会话不会自动重复下载同一版本，避免循环；
- 每个版本只通知一次（可用与就绪各一次）。

### 5.1 自动更新策略

设置项 `autoUpdateMode`：

| 值 | 行为 |
|---|---|
| `auto`（默认） | 启动后自动检查并下载，下载完成提示重启 |
| `notify` | 只检查并提示，用户点击“立即更新”后才下载 |
| `off` | 不自动检查（手动检查仍可用） |

此外，当 `Pengu.autoUpdateCheck === false` 时，Sona 不发起任何自动网络请求。

### 5.2 下载与校验

- 产物标签：`dist-v<version>`（例如 `dist-v2026.11.24.1`）；
- 下载源顺序：jsDelivr → raw.githubusercontent.com；
- 同名文件按源顺序回退；清单与文件都走 HTTPS；
- 清单校验版本、文件名、大小与 SHA-256 格式；
- 下载后重新计算大小与 SHA-256，与清单一致才写入；
- 下载内容**不会**被 `eval` / `new Function` 执行，只在下次启动由引导器以 ESM 模块加载；
- 版本化产物 URL 不可变，允许浏览器复用 HTTP 缓存；GitHub API 请求则禁用缓存。

---

## 6. 界面与交互

### 6.1 更新页

- 展示当前运行版本、运行来源（本地 / 本地缓存 / 云端加载）、本地安装版本；
- 展示最新版本、发布日期与更新说明；
- 状态区按状态提供：立即更新、下载中、立即重启客户端、重试更新、重新检查；
- 下载完成显示“已就绪，重启客户端后生效”；
- 远程运行时提供“恢复本地版本”；
- 始终保留 Release / 群文件 / 夸克网盘手动下载入口；
- 错误只按来源展示一种主操作：检查失败 → “重新检查”；下载/启动失败 → “重试更新”。

### 6.2 侧边栏与入口徽标

- 更新流程进行中（可更新 / 下载中 / 已就绪）时显示更新入口；
- 出现可操作错误（下载失败、启动回退）时同样显示入口，文案为“更新失败”；
- 常规检查失败（网络波动、GitHub API 不可达）**不**显示入口，避免长期打扰；
- 设置页“检查更新”卡片会在按钮下方展示当前状态或错误。

### 6.3 通知

- `notify` 模式发现新版本时发送 LCU 通知；
- 下载完成发送“已下载，重启客户端后生效”；
- 失败不弹通知，只在更新页与日志中体现。

---

## 7. 发布流程

正式发布由 `.github/workflows/publish.yml` 一键触发：计算当天版本号（`年.月.日.序号`）→ 更新 `package.json` / `package-lock.json` / `CHANGELOG.md` → 提交 `main` → 打 `v*` tag → 通过 `workflow_call` 调用 `release.yml`。`update-balance.yml` 每周自动同步平衡数据时也走同一发布流程。

`release.yml` 同时支持手动推送 `v*` tag 和 `workflow_dispatch`（补发/重建）。它执行：

1. **版本一致性**：`RELEASE_TAG` 去掉 `v` 必须等于 `package.json.version`，否则失败；
2. **构建**：`npm ci` → 修正 `loaderPath` → `npx tsc && npx vite build` → `node scripts/check-build.mjs`；
3. **准备 Release zip**（工作区 `release/sona`）：
   `index.js`、`app.js`、`app.css`、`version.json`、`update.json`、`assets/README.txt`；
4. **提取 Release notes**：优先使用调用方传入的 notes，否则从 `CHANGELOG.md` 提取；
5. **发布更新产物**：
   - 目标标签 `dist-${RELEASE_TAG}`（例如 `dist-v2026.11.24.1`）；
   - `app.js` / `app.css` / `update.json` 提交到 `dist` 分支（force push）；
   - `dist` 分支只保留最新一次发布的产物，重跑旧版本时不会把产物回退；
   - `dist-v*` 标签不可变：已存在则跳过标签创建，但仍更新 `dist` 分支；补发自动更新之前的旧 tag（没有 `app.js`）时跳过本步骤，只创建/更新 GitHub Release；
6. **创建 GitHub Release**：使用第 3 步工作区中的 zip。

`dist-v*` 不匹配 `v*` 触发器，不会递归触发工作流。发布顺序先更新产物、再创建 Release，确保用户看到新版本时更新包已可下载。

故障恢复：

- 若 `dist-v*` 标签已推送但 Release 创建失败：直接重跑工作流即可跳过已存在的标签并继续创建/更新 Release；不要移动已发布标签；
- 不要移动已发布的标签；修复问题请发布新的补丁版本。

---

## 8. 安全边界

信任根：`gyyst/sona` 仓库 + GitHub CI + HTTPS CDN。

- 清单与文件都要求 HTTPS，且主机必须在白名单内（`cdn.jsdelivr.net`、`raw.githubusercontent.com`）；
- URL 由客户端构造，清单中的 URL 不作为可信输入；
- SHA-256 用于校验传输损坏与缓存串版本；
- 本期**没有代码签名**：无法防御 GitHub 仓库或 CDN 本身被攻破，这是已知边界；
- 本地 `DataStore` / `IndexedDB` 被篡改等价于本地环境已被控制，不在防御范围内；
- 下载内容不在当前进程执行；使用前必须通过清单校验并由引导器以模块方式 import。

---

## 9. 首次迁移

v1.12.1 及更早版本只有单文件 `index.js`，没有引导器，因此**不能自动更新**：

1. 从 Releases 下载包含引导器的新版 zip；
2. 解压覆盖到 Pengu 插件目录（**不要删除整个 `sona` 文件夹**，否则 `assets/` 中的自定义头像、壁纸会丢失）；
3. 重启客户端，确认版本与运行来源正常；
4. 此后所有版本通过 `app.js` 自动更新，只需重启客户端生效。

设置、玩家备注等数据保存在 DataStore，升级不会丢失。

---

## 10. 设置与关闭方式

设置页提供：

- **自动更新**：`自动检查并下载（推荐）` / `仅提示新版本` / `关闭自动检查`；
- **检查更新**：手动触发，不受自动更新开关限制；
- **恢复本地版本**（远程运行或存在待更新指针时可用）：清除指针与 IndexedDB 缓存，重启后运行本地版本；
- **恢复更新提醒**：清除“已跳过版本”记录。

若 Pengu 自身提供了 `autoUpdateCheck = false`，Sona 不会发起自动检查；此时即使用户手动点击“检查更新”，发现新版本也只展示“立即更新”，不会自动下载。Sona 的 `off` 模式同理，手动检查始终可用。

---

## 11. 排障

| 现象 | 可能原因 | 处理 |
|---|---|---|
| 一直显示“更新失败：检查更新失败” | GitHub API 被网络/代理阻断 | 更新页或设置页手动重试；仍失败时使用 Release / 群文件 / 网盘手动更新 |
| 下载失败、提示超时或 SHA-256 不匹配 | CDN 不可达、缓存不一致或发布资产不完整 | 点击“重试更新”；确认 `dist-v<version>` 标签中的 `update.json` 与文件完整 |
| 提示“更新包加载失败，已回退本地版本” | 客户端禁止 Blob ESM / 远程 ESM，或缓存损坏 | 点击“重试更新”；仍失败则“恢复本地版本”，或等待下次启动 |
| 更新页显示“未缓存到本地” | IndexedDB 写入失败或被清理 | 重启后需要联网从 CDN 加载；可手动下载安装包 |
| 已下载但重启后版本没变 | 引导器加载失败、指针被清理，或客户端未真正重启 | 查看控制台 `[Sona:Bootstrap]` 日志；使用“恢复本地版本”后重试 |
| 手动安装新版后仍提示更新 | 指针未清理（异常场景） | 引导器在本地版本 ≥ 指针版本时会自动清理；也可手动“恢复本地版本” |

引导器日志统一以 `[Sona:Bootstrap]` 为前缀，应用侧更新日志以 `[Update]` 为前缀。

---

## 12. 回滚

1. **应用内回滚**：更新页 / 设置页“恢复本地版本” → 清除指针与缓存 → 重载客户端；
2. **自动回退**：缓存/远程加载失败时引导器自动回退本地版本；
3. **手动回滚**：重新解压安装包含期望版本 `app.js` 的 zip（`assets/` 不受影响）；
4. **发布事故**：`dist-v*` 标签不可变，请发布新补丁版本修复，不要移动旧标签。

---

## 13. 待真机验证项

以下行为依赖 League Client 内嵌 Chromium 的实际限制，失败时均有回退路径：

| 编号 | 验证项 | 失败时的行为 |
|---|---|---|
| V1 | 客户端 CSP 是否允许 `import(blob:...)` | 缓存包加载失败 → 回退远程 URL |
| V2 | IndexedDB 是否在客户端重启后保留 | 每次启动重新从远程加载（不会自动写回缓存），更新页会显示运行来源为“云端加载” |
| V3 | 从 `https://plugins` 模块向 jsDelivr/raw 发起 ESM import 是否被允许 | 回退本地版本，自动更新降级为手动下载 |

建议在真实客户端按以下顺序验收：

1. 手动安装新 zip，确认插件正常启动、版本为本地版本；
2. 发布一个测试补丁版本，重启客户端，确认自动下载 → “已就绪” → 重启后运行新版本；
3. 断网或屏蔽 CDN 后重启，确认回退本地并给出可操作错误；
4. 验证 `auto` / `notify` / `off` 与 `Pengu.autoUpdateCheck = false` 的组合；
5. 验证“跳过此版本”“恢复本地版本”以及手动安装更高版本后的指针清理；
6. 确认更新过程不修改 `assets/`，自定义头像、壁纸与设置均保留。
