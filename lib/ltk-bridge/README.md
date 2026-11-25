# Sona LTK Bridge

Sona 选人换肤的本地搭档进程。它只监听 `127.0.0.1`，负责：

1. 接收 Sona 插件的皮肤 / 炫彩选择；
2. 从 LeagueSkins 资源库按 ID 下载皮肤包（或读取本地皮肤库）；
3. 通过 LTF bridge 导入 LTK Manager、切换 mod、启动 patcher；
4. 对局结束后停止 patcher、清理本后台导入的 mod。

本目录位于仓库 `lib/ltk-bridge/`，下文命令均从仓库根目录执行。LTK Manager 的上游 fork 位于 `lib/ltk-manager/`（git submodule），供后续自建构建使用。

## 能力边界

- 第一版支持**普通皮肤与炫彩**；特殊形态资源暂未接入。
- 需要 LTK Manager；Release 包已包含 LTF bridge 与后台，LTK Manager 可在 Sona 面板一键下载安装，也可手动安装。
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
uv sync --project lib/ltk-bridge
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

需要单独部署时，从 `sona-<tag>.zip` 解压出 `sona/ltk/` 目录即可。

**方式二：GitHub Actions 产物**

在 Actions → **LTK Bridge** → **Run workflow**，完成后下载 artifact `ltk-runtime`。

**方式三：本地构建**

按 `lib/ltk-bridge/native/ltf/README.md` 操作，并用 uv 运行后台。

### 4. 安装 LTK Manager

**方式一：Sona 面板一键安装（推荐）**

1. 启动 `sona-ltk` 后台；
2. 在 Sona 工具页开启「LTK Manager 桥接」，点击「下载并安装 LTK Manager」；
3. 后台把官方安装包下载到 `sona/ltk/downloads/`，校验 SHA-256 后静默运行安装器；
4. 首次安装会弹出 UAC，需要允许；
5. 官方安装器固定安装到 `C:\Program Files\LTK Manager`（LTK Manager 的安全策略，见其 ADR-0055），不能安装到插件目录。

**方式二：手动安装**

从 [LTK Manager Releases](https://github.com/LeagueToolkit/ltk-manager/releases) 下载
`LTK.Manager_<version>_x64-setup.exe`，按向导安装。

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
Copy-Item lib/ltk-bridge/config.example.json lib/ltk-bridge/config.json
```

按需修改：

- `ltkManagerPath`：LTK Manager 的 `ltk-manager.exe` 路径（留空则自动探测）；
- `ltkManagerVersion` / `ltkManagerDownloadUrl` / `ltkManagerSha256` / `ltkManagerSize`：一键安装使用的版本、下载地址、校验值与文件大小（留空使用内置 v1.33.0；自定义版本时四者需同步修改）；
- `ltkManagerDownloadTimeoutS` / `ltkManagerInstallTimeoutS`：下载与安装等待超时（秒）；
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
https://raw.githubusercontent.com/Alban1911/LeagueSkins/main
```

路径规则（数字 ID 目录，与 Rose 一致）：

```text
skins/{championId}/{baseSkinId}/{skinId}.fantome
skins/{championId}/{baseSkinId}/{chromaId}/{chromaId}.fantome
```

也支持 `.zip` 后缀，后台按 `.zip` → `.fantome` 顺序尝试。资源包已由资源库提供方 rebase 到基础皮肤路径，后台不需要在运行时重写 WAD。

> 旧默认源 `darkseal-org/lol-skins` 的布局与本规则不匹配。若 `config.json` 仍保存旧默认地址，启动时会自动迁移到新默认源；自定义镜像不受影响。

## 故障排查

- **`LTKBridge API is not reachable`**：确认 launcher 与 DLL 同时存在，且 LTK Manager 已正常启动。
- **`LTK Manager 已打开但没有 LTF bridge`**：关闭正在运行的 LTK Manager 后重试。
- **`皮肤资源不存在`**：检查网络、资源库地址，或切换为本地皮肤库。
- **patcher 拒绝启动**：确认 League / LTK Manager 都没有设置为「以管理员身份运行」。
- **一键安装提示「已取消 UAC 授权」**：重新点击安装，并在 UAC 窗口选择「是」；标准账户需要输入管理员凭据。
- **一键安装提示 SHA-256 校验失败**：删除 `downloads/` 下的安装包后重试；若自定义了下载地址，确认 `ltkManagerSha256` 与文件一致。
- **安装程序超时**：检查桌面是否有被遮挡的 UAC 弹窗，以及安全软件是否拦截了安装器。
