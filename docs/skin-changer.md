# 选人换肤

Sona 的选人换肤功能参考了 [Rose](https://github.com/Alban1911/Rose) 的客户端插件与注入链路，在英雄选择界面提供皮肤、炫彩与特殊形态的浏览和选择能力，并可通过本地后台把选择交给 LTK Manager，在游戏内替换模型。

选择皮肤的主路径是**客户端原生皮肤轮盘**：Sona 接管未拥有皮肤的点击并自行维护选中态；右下角面板保留给特殊形态、随机皮肤、炫彩与完整浏览等高级能力。

## 能力边界

| 能力 | 是否支持 | 说明 |
|------|:--------:|------|
| 解锁未拥有皮肤的预览 | ✅ | 去灰、去锁标、恢复悬停与点击 |
| 选择皮肤 | ✅ | 原生轮盘点击未拥有皮肤即可选择（Sona 接管）；已拥有皮肤走客户端原生逻辑 |
| 选择炫彩 | ✅ | 通过 Sona 面板选择（轮盘没有独立炫彩入口） |
| 按英雄记忆上次选择 | ✅ | 存储于 Sona 配置 |
| 随机皮肤 | ✅ | 可限定「全部皮肤」或「仅已拥有」 |
| 游戏内模型替换 | ✅（可选） | 需要安装 LTK Manager（可在面板内一键下载安装）、运行 `ltk-bridge`（位于 `lib/ltk-bridge`）；Release 包已含 LTF bridge 与后台 |
| 特殊形态选择 | ⚠️ | 伪形态 ID 仅记录选择；游戏内生效暂未接入 |
| 派对模式 | ❌ | 不同步给好友，仅本机可见 |

> Rose 的完整链路是「Pengu 插件 → Python 托盘后端 → LTF bridge DLL → LTK Manager patcher」。
> Sona 实现了同构的客户端层和最小后台；原生 bridge 使用 Rose 的源码，需在 Windows 上构建。

## 客户端使用

1. 打开 Sona 面板 → 工具 → 换肤，开启「选人换肤」。
2. 进入英雄选择后：
   - **日常选择**：直接点击客户端原生皮肤轮盘上的皮肤卡片（含未拥有皮肤）；
   - **高级能力**：点击右下角「换肤」按钮打开面板，选择特殊形态、炫彩、随机皮肤或浏览完整列表。
3. 未拥有皮肤由 Sona 接管点击并写入选择。客户端 16.23 的 LCU 不会回显未拥有皮肤，选中态由 Sona 自行维护；已拥有皮肤仍走客户端原生逻辑。

可选开关：

- **解锁皮肤预览**：解除未拥有皮肤的灰色遮罩与锁标。
- **记住上次皮肤**：按英雄记住手动选择，下次选人自动应用。
- **随机皮肤**：英雄确定后随机选择一款；可选「仅已拥有」。

## 实现结构

```
src/lib/features/skin-changer/
├── index.ts            生命周期、LCU 基线同步、状态推送
├── carousel-select.ts  原生轮盘点击接管、skinId 解析、选中态同步
├── launcher.ts         入口按钮注入（右下角按钮区 / 轮播容器）
├── auto-apply.ts       记忆与随机的自动应用
├── skin-apply.ts       LCU 皮肤选择 + 通知（记忆/广播/bridge）
├── skin-data.ts        皮肤/炫彩/特殊形态数据加载 + 资产键索引
├── skin-unlock.ts      原生轮播解锁与状态类改写
├── state.ts            类型、瞬时状态与皮肤记忆
└── bridge/
    ├── ltk-client.ts    LTK 后台 WebSocket 客户端
    └── ltk-autostart.ts 随 Sona 启动后台的探测与拉起
```

UI 位于 `src/components/ui/skin-changer/`，样式位于 `src/styles/SkinChanger.css`。

## LCU 接口

| 用途 | 接口 |
|------|------|
| 皮肤 / 炫彩数据 | `GET /lol-game-data/assets/v1/champions/{championId}.json` |
| 拥有状态 | `GET /lol-champions/v1/inventories/{summonerId}/champions/{championId}` |
| 未锁定英雄时选皮肤 | `PATCH /lol-champ-select/v1/session/actions/{actionId}` |
| 已锁定英雄时选皮肤 | `PATCH /lol-champ-select/v1/session/my-selection` |

炫彩 ID 可直接作为 `selectedSkinId` 提交（与 Rose 的做法一致）。

> **客户端 16.23 限制**：对未拥有皮肤提交 `selectedSkinId` 会返回 204，但 LCU 不回显，
> 客户端也不会显示选中。因此 Sona 对未拥有皮肤采取「接管轮盘点击 + 自维护选中态」的方式：
> 选择仍会同步给 LTK bridge（bridge 会先强制切回基础皮肤再注入模型），但客户端 LCU 中的
> `selectedSkinId` 保持为基础/已拥有皮肤。已拥有皮肤仍由客户端原生逻辑写入 LCU。

## 游戏内注入（LTK Manager）

### 组成

```
Sona 插件 ──WebSocket──> lib/ltk-bridge（Python）
                             │
                             ├─ 皮肤资源下载 / 缓存
                             ├─ LCU phase 监控
                             └─ LTF bridge ──> LTK Manager patcher ──> 游戏
```

`ltk-bridge` 位于 `lib/ltk-bridge`，使用 uv 管理依赖，日志写入 `logs/`。LTK Manager 的上游 fork 位于 `lib/ltk-manager`（git submodule），供后续自建构建使用。

### 一次性准备

**方式一：在 Sona 面板内一键安装（推荐）**

1. 启动 `sona-ltk` 后台（双击 `sona/ltk/install-autostart.bat`，或每次运行 `start-sona-ltk.bat`）；
2. 打开 Sona → 工具 → 换肤，开启「LTK Manager 桥接」；
3. 在「LTK Manager 安装」区域点击「下载并安装 LTK Manager」；
4. 后台把官方安装包下载到 `sona/ltk/downloads/`，并校验大小与 SHA-256；
5. Windows 弹出 UAC 时选择「是」；
6. 官方安装器会把 LTK Manager 安装到 `C:\Program Files\LTK Manager`。这是 LTK Manager 的强制安全策略（ADR-0055）：它的注入组件会在提权后运行，放在用户可写目录会形成本地提权风险，因此**不能安装到插件目录**；
7. 状态变为「已安装」后即可正常使用。以后要覆盖旧版 Manager，先在工具页完全退出 LTK Manager，再点击「重新安装 / 更新 LTK Manager」。

安装包默认使用随 Sona 打包的 LTK Manager 版本；版本、下载地址、校验值与文件大小可在 `config.json` 中覆盖（见下方配置项）。LTK Manager 自身的后续升级由 Sona 的随包版本与手动「重新安装」负责。

**方式二：手动安装**

1. 安装 [LTK Manager](https://github.com/LeagueToolkit/ltk-manager/releases)。
2. 构建 LTF bridge（Windows + Visual Studio 2022）：

   ```powershell
   Set-ExecutionPolicy -Scope Process Bypass
   .\lib\ltk-bridge\native\ltf\build.ps1
   ```

3. 安装后台依赖：

   ```bash
   ./scripts/ltk/install.sh
   ```

4. 复制并编辑配置：

   ```powershell
   Copy-Item lib/ltk-bridge/config.example.json lib/ltk-bridge/config.json
   ```

5. 启动：

   ```bash
   ./scripts/ltk/run.sh
   ```

### 启动

```bash
./scripts/ltk/run.sh
```

打包版和源码版的日志分别写入 `sona/ltk/logs/` 与项目根 `logs/`。

### 工作流程

1. 客户端通过原生轮盘或 Sona 面板选择皮肤/炫彩后，通过 WebSocket 发送 `skin-selection`。
2. 后台检查 LCU 阶段，只在 `ChampSelect` / `GameStart` / `InProgress` / `Reconnect` 处理。
3. 已拥有的皮肤直接跳过（客户端自身即可生效）。
4. 未拥有的皮肤：
   - 等待本地玩家锁定英雄，期间每 0.25 秒检查一次 LCU 阶段；一旦离开 `ChampSelect` 立即停止，不再等满固定超时；
   - 仅在「`ChampSelect` 且本地玩家已锁定」时通过 LCU 切回基础皮肤（rebase 资源运行在基础皮肤路径）；
   - 按 `championId` / `skinId` / `chromaId` 下载资源包；
   - 导入 LTK Manager、启用 mod、启动 patcher，并等待其进入 `patching` 阶段（期间保持 `applying`）。
5. 对局结束（Lobby / EndGame / PostGame）时停止 patcher、卸载本后台导入的 mod。
6. 状态通过 WebSocket 回传，面板顶部显示「已连接 / 正在准备注入 / 注入已启动 / 错误」。

> `applied` 表示 patcher 已进入 `patching` 阶段（注入进程已启动），不代表 overlay 已确认附着到游戏。
> UAC 等待与 overlay 构建期间保持 `applying`。

> **阶段竞态**：选人结束（`GameStart` / `InProgress` / `Reconnect`）后才到达的选择仍会继续资源与 patcher 流程，
> 但不会再调用 `my-selection`（未锁定或已离开选人时会跳过基础皮肤改写）；
> `Lobby` / `None` / `PostGame` 等阶段会直接返回「对局阶段已结束」错误，不下载资源、不启动 patcher。
> 相同英雄/皮肤/炫彩/形态的重复选择在 2 秒内只处理一次，失败后的重试需在窗口外才会再次进入注入状态机。

### 管理员权限客户端（国服 / WeGame）

WeGame 以管理员权限启动 League 时，注入必须跨越权限边界。当前流程是：

1. 后台先完成客户端切回基础皮肤、资源下载、mod 导入与 overlay 构建；
2. 预检通过后，LTK Manager 才请求 UAC，把它自己的 patcher host（而不是 Manager 本身）提升为管理员；
3. host 从 `Program Files` 安装目录下的暂存副本加载已验证的 DLL，Manager 始终保持普通权限；
4. 后台观察到 patcher 进入 `patching` 后才回传 `applied`。

因此：

- LTK Manager 必须安装在 `C:\Program Files\LTK Manager`。安装到用户可写目录时，暂存目录不满足保护要求，后台会提示重新安装，并拒绝启动 host；
- 每次启动 patcher 都可能弹出一次「暂存 patcher」的 UAC；LTK Manager 启动后的第一次注入还会为 host 提升再弹一次。两次都请选择「是」；
- 上述流程要求 LTK Manager 构建包含 host 提权支持（ADR-0081）。会直接拒绝管理员权限 League 的旧版 Manager 只会返回 `LEAGUE_ELEVATED`，需要升级后再使用；
- overlay 构建失败不会弹 UAC；如果构建或资源准备失败，先修复错误再重试；
- 不要以管理员权限启动 LTK Manager 本身：Manager 自身被提权时会直接拒绝启动；
- 旧版 LTK Manager 不返回 `phase` 字段时，后台无法确认就绪，会记录警告并按原有行为标记 `applied`；升级到支持 `phase` 的版本后自动启用严格等待。

### 资源路径

默认从 `Alban1911/LeagueSkins`（Rose 维护的资源库）下载，使用数字 ID 目录布局：

```text
skins/{championId}/{baseSkinId}/{skinId}.fantome
skins/{championId}/{baseSkinId}/{chromaId}/{chromaId}.fantome
```

后台会依次尝试 `.zip` 与 `.fantome` 两种后缀，因此自定义镜像仍可提供 `.zip` 包。资源包已 rebase 到基础皮肤路径，运行时不需要重写 WAD。

> 旧版本默认的 `darkseal-org/lol-skins` 使用「英雄英文名 / 皮肤名」布局，与后台的目录规则不匹配，会导致下载 404。若 `config.json` 中仍保存该源的默认地址（`master` 或 `main` 分支），加载时会被自动替换为新默认源；自定义镜像地址保持原样。

### GitHub 代理

GitHub 下载默认经过 `https://gh-proxy.org/` 代理，便于国内网络访问；代理只作用于 GitHub 主机（`raw.githubusercontent.com`、`github.com` 等），自定义镜像不会被二次代理。

| 配置项 | 说明 |
|------|------|
| `githubProxy` | 代理前缀，默认 `https://gh-proxy.org/`；空字符串关闭；支持前缀拼接或 `{url}` 模板（如 `https://proxy.example/fetch?url={url}`） |
| `githubProxyFallback` | 代理连接失败/5xx 时是否回退直连，默认 `true`；404 不回退 |

代理覆盖皮肤资源按需下载与 LTK Manager 安装包下载。LTK Manager 安装包仍执行精确大小与 SHA-256 校验，代理主机必须来自上述配置，不能由重定向任意指定。

> 代理是第三方服务，下载内容会经过代理。皮肤资源是公开内容；如不希望经过第三方，把 `githubProxy` 设为空字符串，或换成自建代理。

### 配置项

见 `lib/ltk-bridge/config.example.json`：

| 字段 | 说明 |
|------|------|
| `websocketPort` | 客户端连接端口，默认 `50010` |
| `authToken` | 首条消息认证 token |
| `ltkLauncherPath` | 自定义 `ltk_launcher.exe` 路径 |
| `ltkManagerPath` | `ltk-manager.exe` 路径，留空自动探测 |
| `ltkManagerVersion` | 一键安装使用的 LTK Manager 版本，留空使用内置 `1.33.0` |
| `ltkManagerDownloadUrl` | 安装包下载地址，留空使用官方 Release 地址 |
| `ltkManagerSha256` | 安装包 SHA-256，留空使用内置校验值 |
| `ltkManagerSize` | 安装包字节数，留空或 `0` 使用内置值 |
| `ltkManagerDownloadTimeoutS` | 下载总超时秒数（含重定向与响应头等待），默认 `300` |
| `ltkManagerInstallTimeoutS` | 安装器等待超时秒数，默认 `600` |
| `autoStartLtk` | 未发现 bridge 时是否自动启动 LTK Manager |
| `lcuLockfilePath` | 无法自动发现 LCU lockfile 时手动指定 |
| `skinLibraryMode` | `remote` 在线下载 / `local` 本地皮肤库 |
| `skinLibraryRoot` | 本地皮肤库根目录 |
| `skinRepositoryBaseUrl` | 远程资源库地址，默认 `Alban1911/LeagueSkins`；旧默认地址会自动迁移 |
| `githubProxy` | GitHub 下载代理，默认 `https://gh-proxy.org/`；空字符串关闭；支持 `{url}` 模板 |
| `githubProxyFallback` | 代理失败时是否回退直连，默认 `true` |
| `patcherReadyTimeoutS` | 等待 patcher 进入 `patching` 阶段的超时秒数，默认 `300`，范围 `30`–`900` |

> 自定义 `ltkManagerVersion` 时，应同时提供对应的 `ltkManagerDownloadUrl`、`ltkManagerSha256` 与 `ltkManagerSize`，否则校验会失败或版本显示不一致。

### 排障：CDP 与 Manager 启动

后台通过 LTF bridge 的调试端口（CDP）驱动 LTK Manager 完成导入、开关 mod 与启动 patcher。只有 `ltk_launcher.exe` 启动的 Manager 会保留该端口：launcher 设置 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` 与 `SONA_LTF_BRIDGE=1`，Manager 读取标记后保留调试参数、跳过按调试参数重启与关闭；标记在读取后立即被移除，不会传给 WebView2 或子进程。其他启动方式仍执行 LTK Manager 的 ADR-0080 保护。

- **`CDP unavailable or timed out` / 「LTK Manager 的调试端口不可用」**：关闭 LTK Manager，再由 Sona 重新启动后台与 Manager。手动双击启动的 Manager 没有 launcher 设置的端口，bridge 无法导入。若当前 Manager 是旧版本，先在工具页完全退出它，再点「重新安装 / 更新 LTK Manager」。
- **launcher 提示 `LTK Manager is already open`**：先完全退出正在运行的 LTK Manager，再让 Sona 重新拉起。
- **仍然失败**：查看 `logs/ltk/ltk_launcher.log`（打包版为 `sona/ltk/logs/ltk_launcher.log`）中的 `[cdp] remote debugging on 127.0.0.1:<port>` 与 `[launch]` 行，确认 Manager 是由 launcher 启动的，并确认端口未被占用。
- **安全边界**：`SONA_LTF_BRIDGE` 是普通环境变量，同一 Windows 用户下的任意进程都可以伪造，因此它只表示「由 Sona 的 launcher 启动」，不是强认证。详见 `lib/ltk-manager/docs/adr/0082-sona-ltf-cdp-exception.md`。

## 客户端 ↔ 后台协议

WebSocket：`ws://127.0.0.1:{port}`，首条消息：

```json
{"type":"auth","token":"sona-local-bridge-v1"}
```

皮肤选择：

```json
{
  "type": "skin-selection",
  "championId": 99,
  "skinId": 99007,
  "baseSkinId": 99007,
  "chromaId": null,
  "formId": null,
  "skinName": "Elementalist Lux",
  "owned": false,
  "source": "manual",
  "timestampMs": 1770000000000
}
```

安装 LTK Manager（由后台下载并调用官方安装器）：

```json
{"type":"install-ltk-manager"}
```

后台状态：

```json
{
  "type": "status",
  "phase": "ChampSelect",
  "injectionStatus": "applied",
  "message": "游戏内注入已启动：Elementalist Lux",
  "skinName": "Elementalist Lux",
  "patcherRunning": true,
  "ltkManagerStatus": "installed",
  "ltkManagerProgress": 100,
  "ltkManagerMessage": "LTK Manager 已安装：C:\\Program Files\\LTK Manager\\ltk-manager.exe",
  "capabilities": ["ltk-manager-install"],
  "timestampMs": 1770000000000
}
```

`injectionStatus`：`idle` / `applying` / `applied` / `skipped-owned` / `error`。

- `applying`：资源准备、overlay 构建或等待 UAC / patcher 进入 `patching` 阶段；
- `applied`：patcher 已进入 `patching`，注入进程已启动（不保证 overlay 已附着到游戏）；
- `error`：`message` 给出可操作的中文说明，例如 UAC 取消、暂存目录不受保护、Manager 被提权或等待超时。

`ltkManagerStatus`：`unknown` / `not-installed` / `downloading` / `verifying` / `installing` / `installed` / `error`。
`capabilities` 用于客户端判断后台是否支持一键安装；旧后台不返回该字段时客户端隐藏安装入口。

## 对接其他注入器

每次成功选择皮肤后，插件会在 `window` 上派发 `sona-skin-selection` 事件：

```ts
interface SkinSelectionEventDetail {
  championId: number
  skinId: number
  baseSkinId: number
  chromaId?: number
  formId?: number
  skinName: string
  owned: boolean
  source: 'manual' | 'remembered' | 'random'
  timestamp: number
}
```

外部注入器可以监听该事件，或替换 `ltk-client.ts` 的发送实现。

## 风险提示

- 客户端内选择未拥有皮肤不会修改账号数据。
- 游戏内注入属于第三方修改，存在账号处罚风险，请自行评估。
- 本功能不提供任何竞技优势。
- 一键安装的安装包缓存在插件目录（用户可写目录）。后台在调用安装器前会再次校验 SHA-256，但不会校验 Authenticode 签名；若本机已存在与当前用户同权限的恶意进程，仍存在替换安装包的残余风险。请勿在不可信环境中使用。
- GitHub 下载默认经过 `gh-proxy.org` 第三方代理。代理可看到下载请求与内容；资源均为公开内容，且 LTK Manager 安装包仍有 SHA-256 校验。可在 `config.json` 中把 `githubProxy` 设为空字符串关闭，或替换为自建代理。
- 由 `ltk_launcher.exe` 启动的 LTK Manager 会保留 WebView2 调试端口供 LTF bridge 使用（`lib/ltk-manager` 的 ADR-0082）。同一用户的本机进程可以伪造 `SONA_LTF_BRIDGE` 触发同样的放宽，因此它不是认证；其他启动方式仍按 ADR-0080 拒绝调试端口。
- `config.json` 与默认 `authToken` 也位于用户可写位置；默认 token 仅用于本机开发。需要更高隔离时，请把 `config.json` 与 Sona 设置中的端口/token 改为随机值并限制文件权限。
