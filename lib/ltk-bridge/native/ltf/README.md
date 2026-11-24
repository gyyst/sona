# LTF bridge（LeagueToolFlop）

本目录来自 [Rose](https://github.com/Alban1911/Rose) 的 `native/ltf/`，用于让本地后台驱动 LTK Manager：

- `LeagueToolFlop.dll`：注入 LTK Manager，提供 `127.0.0.1:46321-46340` 上的 newline-delimited JSON API。
- `ltk_launcher.exe`：启动 LTK Manager、注入 DLL、等待 bridge 就绪。
- `build.ps1`：Windows + Visual Studio 2022 构建脚本。

## 构建

### 方式一：GitHub Actions（推荐）

推送到 GitHub 后，Actions 会自动运行 **LTK Bridge** 工作流：

- 在 Actions → **LTK Bridge** → **Run workflow** 手动触发；
- 构建完成后下载 artifact **sona-ltf-bridge**；
- 发布 `v*` tag 时，**Release** 工作流会把 `sona-ltf-bridge-<tag>.zip` 一起附到 Release。

### 方式二：本地构建

前置条件：

- Windows 10/11 x64
- Visual Studio 2022，安装「使用 C++ 的桌面开发」工作负载

在 PowerShell 中执行：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\lib\ltk-bridge\native\ltf\build.ps1
```

产物位于 `lib/ltk-bridge/native/ltf/bin/`。后台默认从该目录寻找 launcher。

## 来源与许可

Rose 使用 MIT 许可证；LTF 原始来源为 LeagueToolFlop 项目。此处保留 Rose 中经过验证的修改版源码与其来源说明。使用前请阅读 Rose 的 `LICENSE` 和上游 LTF 项目的许可。

## 安全说明

这是进程注入组件，只应在自己的电脑上、按照本仓库文档使用。杀毒软件可能拦截，请勿关闭安全软件来强行运行未知二进制。
