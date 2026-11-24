# Sona LTK Runtime

发布包中的 `sona/ltk/` 目录包含：

| 文件 | 作用 |
|------|------|
| `sona-ltk.exe` | ltk-bridge 后台（PyInstaller 打包，无需安装 Python） |
| `ltk_launcher.exe` | 启动 LTK Manager 并注入 LTF bridge |
| `LeagueToolFlop.dll` | LTF bridge DLL |
| `config.example.json` | 配置示例 |
| `start-sona-ltk.bat` | 手动启动后台（首次运行会生成 config.json） |
| `install-autostart.bat` | 注册开机自启（HKCU Run） |
| `uninstall-autostart.bat` | 取消开机自启 |

## 使用

1. 安装 [LTK Manager](https://github.com/LeagueToolkit/ltk-manager/releases)。
2. 双击 `install-autostart.bat`（推荐），或每次双击 `start-sona-ltk.bat`。
3. 在 Sona 工具页开启「LTK Manager 桥接」。
4. 日志写入 `logs/sona-ltk.log`。

`config.json` 首次启动时由 `config.example.json` 复制生成。端口和 token 必须与 Sona 设置页一致（默认 50010 / `sona-local-bridge-v1`）。
