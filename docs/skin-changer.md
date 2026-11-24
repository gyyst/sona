# 选人换肤

Sona 的选人换肤功能参考了 [Rose](https://github.com/Alban1911/Rose) 的客户端插件与注入链路，在英雄选择界面提供皮肤、炫彩与特殊形态的浏览和选择能力，并可通过本地后台把选择交给 LTK Manager，在游戏内替换模型。

## 能力边界

| 能力 | 是否支持 | 说明 |
|------|:--------:|------|
| 解锁未拥有皮肤的预览 | ✅ | 去灰、去锁标、恢复悬停与点击 |
| 选择皮肤 / 炫彩 | ✅ | 通过 LCU 写入 `selectedSkinId`，客户端内显示选中 |
| 按英雄记忆上次选择 | ✅ | 存储于 Sona 配置 |
| 随机皮肤 | ✅ | 可限定「全部皮肤」或「仅已拥有」 |
| 游戏内模型替换 | ✅（可选） | 需要安装 LTK Manager（可在面板内一键下载安装）、运行 `ltk-bridge`；Release 包已含 LTF bridge 与后台 |
| 特殊形态选择 | ⚠️ | 伪形态 ID 仅记录选择；游戏内生效暂未接入 |
| 派对模式 | ❌ | 不同步给好友，仅本机可见 |

> Rose 的完整链路是「Pengu 插件 → Python 托盘后端 → LTF bridge DLL → LTK Manager patcher」。
> Sona 实现了同构的客户端层和最小后台；原生 bridge 使用 Rose 的源码，需在 Windows 上构建。

## 客户端使用

1. 打开 Sona 面板 → 工具 → 换肤，开启「选人换肤」。
2. 进入英雄选择，右下角出现「换肤」按钮。
3. 点击按钮打开面板，点击皮肤卡片或炫彩即可写入选择。

可选开关：

- **解锁皮肤预览**：解除未拥有皮肤的灰色遮罩与锁标。
- **记住上次皮肤**：按英雄记住手动选择，下次选人自动应用。
- **随机皮肤**：英雄确定后随机选择一款；可选「仅已拥有」。

## 实现结构

```
src/lib/features/skin-changer/
├── index.ts         生命周期：phase/session 监听、预览解锁、状态推送
├── launcher.ts      入口按钮注入（右下角按钮区 / 轮播容器）
├── auto-apply.ts    记忆与随机的自动应用
├── skin-apply.ts    LCU 皮肤选择 + 桥接事件发送
├── skin-data.ts     皮肤/炫彩/特殊形态数据加载（game-data + inventory）
├── skin-unlock.ts   原生轮播解锁与状态类改写
├── state.ts         类型、瞬时状态与皮肤记忆
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

## 游戏内注入（LTK Manager）

### 组成

```
Sona 插件 ──WebSocket──> ltk-bridge（Python）
                             │
                             ├─ 皮肤资源下载 / 缓存
                             ├─ LCU phase 监控
                             └─ LTF bridge ──> LTK Manager patcher ──> 游戏
```

`ltk-bridge` 位于项目根目录，使用 uv 管理依赖，日志写入 `logs/`。

### 一次性准备

**方式一：在 Sona 面板内一键安装（推荐）**

1. 启动 `sona-ltk` 后台（双击 `sona/ltk/install-autostart.bat`，或每次运行 `start-sona-ltk.bat`）；
2. 打开 Sona → 工具 → 换肤，开启「LTK Manager 桥接」；
3. 在「LTK Manager 安装」区域点击「下载并安装 LTK Manager」；
4. 后台把官方安装包下载到 `sona/ltk/downloads/`，并校验大小与 SHA-256；
5. Windows 弹出 UAC 时选择「是」；
6. 官方安装器会把 LTK Manager 安装到 `C:\Program Files\LTK Manager`。这是 LTK Manager 的强制安全策略（ADR-0055）：它的注入组件会在提权后运行，放在用户可写目录会形成本地提权风险，因此**不能安装到插件目录**；
7. 状态变为「已安装」后即可正常使用，后续无需重复安装。

安装包默认固定为 LTK Manager v1.33.0；版本、下载地址、校验值与文件大小可在 `config.json` 中覆盖（见下方配置项）。LTK Manager 自身的后续升级由官方 updater 负责。

**方式二：手动安装**

1. 安装 [LTK Manager](https://github.com/LeagueToolkit/ltk-manager/releases)。
2. 构建 LTF bridge（Windows + Visual Studio 2022）：

   ```powershell
   Set-ExecutionPolicy -Scope Process Bypass
   .\ltk-bridge\native\ltf\build.ps1
   ```

3. 安装后台依赖：

   ```bash
   ./scripts/ltk/install.sh
   ```

4. 复制并编辑配置：

   ```powershell
   Copy-Item ltk-bridge/config.example.json ltk-bridge/config.json
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

1. 客户端选择皮肤/炫彩后，通过 WebSocket 发送 `skin-selection`。
2. 后台检查 LCU 阶段，只在 `ChampSelect` / `GameStart` / `InProgress` / `Reconnect` 处理。
3. 已拥有的皮肤直接跳过（客户端自身即可生效）。
4. 未拥有的皮肤：
   - 按 `championId` / `skinId` / `chromaId` 下载资源包；
   - 通过 LCU 把客户端切回基础皮肤（rebase 资源运行在基础皮肤路径）；
   - 导入 LTK Manager、启用 mod、启动 patcher。
5. 对局结束（Lobby / EndGame / PostGame）时停止 patcher、卸载本后台导入的 mod。
6. 状态通过 WebSocket 回传，面板顶部显示「已连接 / 正在注入 / 游戏内已应用 / 错误」。

### 资源路径

默认从 `darkseal-org/lol-skins` 下载，路径规则与 Rose 一致：

```text
skins/{championId}/{skinId}/{skinId}.zip
skins/{championId}/{skinId}/{chromaId}/{chromaId}.zip
```

资源包已 rebase 到基础皮肤路径，运行时不需要重写 WAD。

### 配置项

见 `ltk-bridge/config.example.json`：

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
| `skinRepositoryBaseUrl` | 远程资源库地址 |

> 自定义 `ltkManagerVersion` 时，应同时提供对应的 `ltkManagerDownloadUrl`、`ltkManagerSha256` 与 `ltkManagerSize`，否则校验会失败或版本显示不一致。

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
  "message": "游戏内换肤已应用：Elementalist Lux",
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
- `config.json` 与默认 `authToken` 也位于用户可写位置；默认 token 仅用于本机开发。需要更高隔离时，请把 `config.json` 与 Sona 设置中的端口/token 改为随机值并限制文件权限。
