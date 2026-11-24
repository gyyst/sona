# Sona LTK Bridge

Sona 选人换肤的本地搭档进程。它只监听 `127.0.0.1`，负责：

1. 接收 Sona 插件的皮肤 / 炫彩选择；
2. 从 LeagueSkins 资源库按 ID 下载皮肤包（或读取本地皮肤库）；
3. 通过 LTF bridge 导入 LTK Manager、切换 mod、启动 patcher；
4. 对局结束后停止 patcher、清理本后台导入的 mod。

## 能力边界

- 第一版支持**普通皮肤与炫彩**；特殊形态资源暂未接入。
- 需要用户自行安装 LTK Manager，并构建本仓库附带的 LTF bridge。
- 原生 bridge 只能在 Windows 上构建和运行；当前开发环境未进行真机验证。
- 第三方换肤存在账号处罚风险，本项目不提供竞技优势。

## 安装

### 1. 安装 uv

```powershell
winget install astral-sh.uv
```

### 2. 安装 Python 依赖

在项目根目录执行：

```bash
./scripts/ltk/install.sh
```

Windows PowerShell 下可执行：

```powershell
uv sync --project ltk-bridge
```

### 3. 获取 LTF bridge 与后台

**方式一：使用 Sona Release（推荐）**

Sona 的 Release 包中已经包含完整运行环境：

```text
sona/ltk/sona-ltk.exe           # 后台（PyInstaller，无需 Python）
sona/ltk/ltk_launcher.exe
sona/ltk/LeagueToolFlop.dll
sona/ltk/start-sona-ltk.bat
sona/ltk/install-autostart.bat
sona/ltk/uninstall-autostart.bat
sona/ltk/config.example.json
```

也可以单独下载 `sona-ltk-runtime-<tag>.zip`。

**方式二：GitHub Actions 产物**

在 Actions → **LTK Bridge** → **Run workflow**，完成后下载 artifact `ltk-runtime`。

**方式三：本地构建**

按 `ltk-bridge/native/ltf/README.md` 操作，并用 uv 运行后台。

## 运行

**随 Sona 包（推荐）**

- 双击 `sona/ltk/install-autostart.bat`：注册开机自启，之后每次登录 Windows 后台自动运行；
- 或双击 `sona/ltk/start-sona-ltk.bat` 手动启动；
- 在 Sona 工具页开启「LTK Manager 桥接」，并保持「随 Sona 启动后台」开启。

Sona 插件会尝试在启动时拉起 `ltk/sona-ltk.exe`。Pengu 的官方 API 不保证允许插件启动外部进程；若当前环境不支持，插件会静默跳过，使用上面的启动脚本或开机自启即可。

**源码运行**

```bash
./scripts/ltk/run.sh
```

日志输出到：

- `sona/ltk/logs/sona-ltk.log`（打包版）
- `logs/sona-ltk.log`（源码版）
- `logs/ltk/ltk_launcher.log`

## 配置

复制示例配置：

```powershell
Copy-Item ltk-bridge/config.example.json ltk-bridge/config.json
```

按需修改：

- `ltkManagerPath`：LTK Manager 的 `ltk-manager.exe` 路径（留空则自动探测）；
- `ltkLauncherPath`：自定义 launcher 路径（默认使用 `native/ltf/bin/ltk_launcher.exe`）；
- `lcuLockfilePath`：国服等无法自动发现 lockfile 时填写；
- `skinLibraryMode`：`remote` 在线下载，`local` 使用本地皮肤库；
- `skinLibraryRoot`：本地皮肤库根目录（其下应为 `skins/{championId}/...`）。

## 与 Sona 插件对接

在 Sona 面板「工具 → 换肤」中开启 LTK Manager 桥接，端口和 token 需与 `config.json` 一致。

客户端发送：

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

后台返回：

```json
{
  "type": "status",
  "phase": "ChampSelect",
  "injectionStatus": "applied",
  "message": "游戏内换肤已应用：Elementalist Lux",
  "skinName": "Elementalist Lux",
  "patcherRunning": true,
  "timestampMs": 1770000000000
}
```

## 资源路径

远程资源库默认使用：

```text
https://raw.githubusercontent.com/darkseal-org/lol-skins/master
```

路径规则（与 Rose 的 ZipResolver 一致）：

```text
skins/{championId}/{skinId}/{skinId}.zip
skins/{championId}/{skinId}/{chromaId}/{chromaId}.zip
```

也支持 `.fantome` 后缀。资源包已由资源库提供方 rebase 到基础皮肤路径，后台不需要在运行时重写 WAD。

## 故障排查

- **`LTKBridge API is not reachable`**：确认 launcher 与 DLL 同时存在，且 LTK Manager 已正常启动。
- **`LTK Manager 已打开但没有 LTF bridge`**：关闭正在运行的 LTK Manager 后重试。
- **`皮肤资源不存在`**：检查网络、资源库地址，或切换为本地皮肤库。
- **patcher 拒绝启动**：确认 League / LTK Manager 都没有设置为「以管理员身份运行」。
