# Lillia 1.5 换肤实现静态分析

## 结论摘要

`tmp/Lillia-Setup-1.5.exe` 是一个 NSIS 安装包，真正的换肤程序是包内的 **x64 原生 C++ 程序 `Lillia.exe`**，不是 Electron、Python 或 .NET 应用。

它的核心不是修改账号皮肤数据，而是：

1. 从安装目录的 `LeagueSkins-main/skins` 按英雄、皮肤和炫彩 ID 找 `.fantome` 包；
2. 把包里的 `WAD/*.wad.client` 资源重新发布到工作目录或 overlay；
3. 在游戏进程中挂接资源访问，使游戏读取修改后的 WAD，而不是仅改变客户端中的选中状态。

程序在同一个外层控制流程中按开关选择两条互斥的实现路线，日志分别为 `route=cn` 与 `route=ltk`，不是一条串行全流程：

| 分支 | 资源发布 | 游戏内加载 |
|---|---|---|
| 国服兼容路径（`route=cn`） | `mod-tools.exe import / mkoverlay` 生成 CSLoL overlay | `mod-tools.exe runoverlay` 调用 `cslol-dll.dll`，挂钩 `CreateFileA`，将 WAD 访问重定向 |
| LTK 路径（`route=ltk`） | 可先用 `ltk_compat.exe normalize` 规范化资源，再由 `Lillia-wad.exe` 基于原始游戏 WAD 生成 overlay | `Lillia-ltk-launcher.exe` 启动 Rust LTK host，host 扫描游戏窗口并加载 `ltk_patcher_dll.dll` |

这两类后端的共同点是**替换游戏读取到的资源**。它们是否免检测、是否适用于当前游戏版本，不能由静态分析推出；这类第三方修改可能带来账号处罚与游戏损坏风险。本报告不评价其检测规避能力或封号概率。

## 分析边界和样本

- 样本：`tmp/Lillia-Setup-1.5.exe`
- 大小：`79,129,930` 字节（约 75.5 MiB）
- SHA-256：`f99b9385e184d97e89bd352f078f5096a8b1f7caba3be7a0516826f65deab82a`
- 安装器：`NSIS-3 Unicode`，LZMA 压缩；由 7-Zip 26.06 静态解包。
- 反编译：Ghidra 12.2，官方归档 SHA-256 已校验为 `2c2cd776db3c1f6a097ba418922378ac3649cadd5e844a6f5f088ae628a7be67`。
- 主程序 SHA-256：`11482ea220fb64a131c137b5b99031bdf457d65b3918d0ab9f693080fc47501b`。

**未执行**安装器、主程序、任何提取出的业务组件或游戏；**未登录**账号，**未联系**样本中的业务 API，**未上传**样本。报告只描述该文件内的静态实现，不证明当前线上服务或游戏版本仍按此运行。

安装器的 PE 证书目录为空。这仅表示未发现内嵌 Authenticode 证书表，不是对文件安全性、其他签名形式或信任链的判断。

## 包内结构

```text
Lillia.exe                         主界面、LCU 状态、皮肤选择、任务编排
Uninstall.exe                      NSIS 3.13 卸载器（32 位）
LeagueSkins-main/skins/            内置皮肤资源
LeagueSkins-main/classic/          备用资源目录（81 个英雄目录）
assets/lillia/                     莉莉娅展示图和元数据
$_51_/
├── mod-tools.exe                 CSLoL 资源导入、合并和运行器
├── cslol-dll.dll                 游戏进程内 WAD 打开重定向
├── Lillia-wad.exe                自研 WAD 基线复制、chunk 合并工具
├── Lillia-ltk-launcher.exe       LTK 启动与桌面用户/提权适配
├── ltk-manager.exe              Rust LTK host 的部署名称之一
├── ltk_patcher_host.exe         与上一文件字节完全相同
├── ltk_patcher_dll.dll          LTK 游戏内 patcher
├── ltk_compat.exe               LTK 资源规范化兼容工具
└── vcruntime140.dll             MSVC 运行时
```

`mod-tools.exe` 保留了 CSLoL Manager 的源码路径和命令行说明，可确认其上游角色；`Lillia-wad.exe` 则是额外的定制 WAD 处理层，不能把两者混为一个工具。

主程序导入 D3D11、Direct2D、DirectWrite、WinHTTP、WinSock、CRYPT32/DPAPI 等 Windows API，未见 Electron/.NET/Python 运行时结构。这支持“原生 Windows C++ 应用”的判断，但不能据此还原其完整构建系统。

## 端到端实现

### 1. 资源选择与本地缓存

内置库位于安装目录：

```text
LeagueSkins-main/skins/{championId}/{skinId}/{skinId}.fantome
LeagueSkins-main/skins/{championId}/{baseSkinId}/{chromaId}/{chromaId}.fantome
LeagueSkins-main/classic/{championId}/{skinId}/{skinId}.fantome
```

`skins/` 下有 **9,228 个 `.fantome`**（2,063 个皮肤包、7,165 个炫彩包），`classic/` 下另有 1,783 个（81 个英雄目录）；解包后合计约 196 MiB。每个包通常是 ZIP，包含：

```text
META/info.json
WAD/{Champion}.wad.client
```

例如 `skins/28/28068/28068.fantome` 含 `META/info.json` 和 `WAD/Evelynn.wad.client`；元数据为 `Yoousn 28068`，版本 `26.22`。

`Lillia.exe` 的 `FUN_140038cd0` 先试 `<安装目录>\LeagueSkins-main`，再试 `\..\引擎-外服-HID\皮肤包\LeagueSkins-main`；`FUN_1400379b0` 先尝试直接路径，再回退到 `\classic\{championId}\`；`FUN_140034560` 以 `.fantome` 优先、`.lnx` 为备选扩展名。报告没有观察到“每次选择皮肤都下载”的证据。

主程序的 `assets/lillia/manifest.json` 还记录 Data Dragon 图像 URL 和官方数据版本 `16.21.1`。这是**展示图来源**，不能据此声称 WAD 资源也来自 Data Dragon。内置包的确切上游和线上更新策略未由当前静态链路确定。

### 2. 国服兼容路径（`route=cn`）：CSLoL overlay + `CreateFileA` 重定向

国服分支 `FUN_1400367b0` 先调用 `FUN_140041710` 清理旧部署，再按资源 ID 找包，然后调用 `FUN_14003c390`：

1. 建立本地 `apply` 工作区；
2. 以 `mod_{...}` 形式组织 mod/profile 目录；
3. 调用 `mod-tools.exe import <package> <installed-dir> --game:<Game> --noTFT`；
4. 对可复用资源使用 `.ready` 标记，避免每次重新构建；
5. 调用 `mod-tools.exe mkoverlay <mods> <overlay> --game:<Game> --mods:<profile> --noTFT`；
6. 通过 `FUN_140042e40` 执行：

```text
mod-tools.exe runoverlay "<overlay>.config" --game:"<Game>" --opts:none
```

`mod-tools.exe` 的字符串直接说明其实现：`cslol_set_config(profile_path)` 后调用 `cslol_hook(tid, 300000, 100)`。它扫描游戏线程，以 Windows 消息钩子使 `cslol-dll.dll` 进入游戏进程。

进程启动由 `CreateProcessW` 完成，子进程被加入带 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` 的 Job Object，主程序通过管道读取日志，从而降低界面退出后残留后台进程的概率。

#### 游戏内实际替换点

`cslol-dll.dll` 的 `FUN_180002640` 在其 hook 安装路径中安装 MinHook 风格的 `CreateFileA` hook，目标为 `FUN_180002e10`。该 hook 仅对符合以下条件的请求尝试重定向：

- `GENERIC_READ`；
- `FILE_SHARE_READ`；
- `OPEN_EXISTING`；
- `FILE_ATTRIBUTE_NORMAL`；
- 路径包含 `DATA/` 且以 `.wad` 结尾；
- 能在配置的 overlay 前缀下打开对应文件。

满足时，将原始 `CreateFileA(...)` 改为打开 overlay 路径；否则调用原始函数。故其实质是**按原始相对路径重定向到修改后的 WAD**，不是修改账号库存或向 LCU 解锁付费皮肤。

该 DLL 还实现了 `CLST` 容器的处理：读取固定头和数据，经过内部解密/展开步骤后写入 `FILE_FLAG_DELETE_ON_CLOSE` 的临时文件，再把临时句柄交给游戏。代码还会定位并替换游戏内 `CRYPTO_free` 相关指针，说明存在与游戏资源解密兼容有关的定制逻辑。具体算法密钥和版本兼容性不在此报告中展开。

主要证据：`cslol/decompiled.txt` 的 `FUN_180002640`、`FUN_180002e10`，及 REA 导出表证据 `ev_6a1ab5ae506c5366e57117636b7fe6c0743fabbfb272db8b7af8b8cfd24e467c`。

### 3. LTK 路径（`route=ltk`）：WAD 合并 + LTK patcher

`FUN_140034df0` 是外层应用控制器：`DAT_1401ad3dc` 非零时转入 `FUN_1400367b0` 的国服路径并返回；为零时继续 LTK 路径。LTK 分支会调用 `FUN_140050a20`：

1. 检查 LTK host、patcher DLL、兼容工具、WAD 工具等组件；
2. 在 `ltk_work/mods` 和 `overlay` 下准备工作目录；
3. 必要时执行 `ltk_compat.exe normalize`，处理资源的兼容形式；
4. 调用 `Lillia-wad.exe build` 产生 overlay；
5. 在代码判定地区为 `ltk`、游戏路径一致、阶段为 `ChampSelect` 或 `Reconnect` 时，调用 `FUN_140054fa0` 启动 LTK；
6. 阶段不符合时清理 overlay 并取消应用，而不是无条件启动 patcher。

`FUN_140054fa0` 检查 overlay 后调用 `FUN_140056ce0`，后者用 `CreateProcessW` 创建挂起的 `Lillia-ltk-launcher.exe --overlay <path>`，加入 Job Object，并通过 stdin/stdout 管道交换就绪、日志和退出消息。

`Lillia-ltk-launcher.exe` 的入口要求三个参数且第二项为 `--overlay`，检查路径字符和句柄；静态线索显示它涉及 `SeDebugPrivilege`、`explorer.exe` 与 `CreateProcessAsUserW`，可能用于在提权进程与桌面用户游戏进程之间切换启动上下文。未实际提权或启动游戏验证。

随包 host 是 **Rust 编写的 `ltk_patcher_host` 0.2.1**。其内置说明表明：

- 支持正常协议模式和旧 `runoverlay` 兼容模式；
- 使用 stdin/stdout 行协议；
- 扫描 `League of Legends (TM) Client` 窗口；
- 通过 `SetWindowsHookExW` 安装钩子并加载 `ltk_patcher_dll.dll`；
- 游戏退出时移除 hook、结束会话；
- 可用命名管道处理 UAC 提权子进程的标准 I/O 桥接。

包内 `ltk-manager.exe` 和 `ltk_patcher_host.exe` 的 SHA-256 均为 `27de1bfdbf37129e42c12b18cc7b4f75c15d39bcd7afefe65c4c33d0e99fe856`，是同一文件的两种名字，不能视为两个独立产品。

### 4. `Lillia-wad.exe` 怎样生成 overlay

其公开命令行在 `FUN_140013b10` 中解析：

```text
Lillia-wad.exe build \
  --game:<Game> \
  --package:<fantome-or-mod-directory> \
  --out:<overlay> \
  [--audio-source:<original-package>]
```

核心 `FUN_140026880` 和辅助函数完成了比“直接替换原 WAD”更谨慎的流程：

1. 要求游戏目录和 overlay 目录都存在，且目录树不能重叠；
2. 枚举游戏 `DATA/FINAL` 下的 `.wad.client`，解析 WAD v3.4 头与 chunk 表；
3. 从 `.fantome` 的 ZIP 或解压后的 mod 目录读取替换 WAD，检查 chunk 边界、校验和、压缩方式和冲突；
4. 首次构建时，用 `FUN_140028e70` 将原 WAD 完整复制到 overlay；
5. 后续构建先读取 `.lillia-baseline`，若源文件身份仍匹配，则用 `FUN_140018280` 恢复原基线 chunk 表并截断到基线尾部，避免反复追加；
6. `FUN_140015c40` 将皮肤 chunk 追加到 overlay，并改写相应 chunk 的偏移、压缩后大小、校验值等表项；
7. 保存源 WAD 身份到 baseline，用于缓存复用和游戏更新后的失效判断；
8. 通过临时输出和 `MoveFileExW` 发布，删除不再使用的旧 overlay 与 baseline。

因此它是**带基线恢复的可重复 overlay 构建器**，而不是每次都重写游戏原始 WAD。支持的 WAD 版本和压缩类型有明确限制，遇到不支持的分支会失败，不应把它描述为通用 WAD 编辑器。

证据：`wad/decompiled.txt` 的 `FUN_140013b10`、`FUN_140026880`、`FUN_140028e70`、`FUN_140018280`、`FUN_140015c40`。

## 生命周期与恢复

### 已证实的本地机制

- 显式的 `--cleanup-hid` 命令路径（`FUN_14005d4f0`）会调用 `FUN_140041710` 清理遗留的 `hid.dll` 部署；选肤前 `FUN_1400367b0` 也会先调用同一清理。
- `Game/DATA/FINAL/Lillia` 下的 `.lillia-hid-owner` 作为所有权标记，避免无条件删除外部安装的文件。
- `Game/hid.dll` 和 `Game/hid.dll.lillia-pending` 有备份、移动、待删除和恢复路径；占用无法立即删除时，会使用 `MoveFileExW(..., NULL, MOVEFILE_DELAY_UNTIL_REBOOT)` 延后处理。
- CSLoL/LTK 启动器使用 Job Object，父进程退出可触发子进程树清理。
- 清理界面 `FUN_14006fdb0` 能清理本地皮肤缓存、overlay 和已确认归属的游戏组件，但保留已保存的登录信息。
- WAD 工具会利用 baseline 恢复旧 overlay 的原始表与尾部，避免资源重复叠加。

### 对局结束的处理

`FUN_140062ee0` 将 LCU 阶段映射为：

- `GameStart`、`InProgress`、`Reconnect` → `In game`
- `WaitingForStats`、`PreEndOfGame`、`EndOfGame` → `Post game`
- `Lobby` → `Lobby`

LTK host 自身也监视游戏窗口退出并移除 hook。静态分析尚未证明“每次回到 Lobby 都必然由主程序删除全部 overlay、卸载所有资源”的统一路径，不能照抄 Sona 的对局结束语义。

### 尚未确认的 `hid.dll` 来源

安装包没有直接释放名为 `hid.dll` 的文件。主程序确实包含该文件的部署/恢复代码，但本次追踪没有建立“每次选肤都会从 native-engine 接口下载并安装它”的证据。

`LILLIAHID1` 出现在 `FUN_14004b900` 中，用于读取一个带文件名清单的自定义资源容器，**不是可据此断定 DLL 下载或签名的标志**。`hid.dll` 是否属于旧版或按需下载组件、具体如何被游戏加载，仍需获得对应组件或做合规的动态验证。

## 网络、账号与权限

### 静态观察到的能力

- WinHTTP / WebSocket 网络栈；
- LCU lockfile、游戏目录、进程和阶段的本地读取；
- 登录、注册、刷新会话、许可证验证、设备解绑等账号功能；
- `/api/license/v2/skin-key`、`/api/license/v2/native-engine/chunk` 常量，以及分块响应中的 `sha256`、`offset`、`next_offset` 字段处理；
- `/api/update/v1/latest` 等更新接口；
- 域名常量 `lillia.yoousn.com`、`napi.maobai.cc`；
- 安装说明要求 Yoousn 账号，建议管理员运行；LTK 启动器涉及 `SeDebugPrivilege` 与 UAC 子进程；
- 主程序的诊断文本称，选择记住账号时使用当前 Windows 用户的 DPAPI 保护本地凭据。

这些观察证明程序具备相关代码路径，不证明每次启动都会访问全部接口，也不证明 `native-engine` 当前仍在使用。报告未测试接口可达性、服务响应、账号策略或凭据保护的实际强度。

主程序还含若干游戏、反作弊与安全软件进程名。仅凭这些字符串不能认定它实施反作弊规避；本报告没有把“结束进程”“绕过防护”等未经调用链证实的能力当作结论。

## 与 Sona 当前实现的对照

Sona 基线见 `docs/skin-changer.md`：前端在客户端内接管皮肤选择，已拥有皮肤沿用客户端原生 LCU 逻辑；未拥有皮肤由 Sona 维护选中态，LCU 中的 `selectedSkinId` 保持为基础/已拥有皮肤。选择同步给 `ltk-bridge`，由后者按需下载资源并调用 LTK Manager patcher，在对局结束卸载本后台导入的 mod。

| 维度 | Lillia 1.5 | Sona 当前设计 |
|---|---|---|
| 界面 | 独立原生 Windows 程序 | 客户端内插件 |
| 资源 | 大量 `.fantome` 随安装包内置，另有 plain/sealed 资源识别 | 按需从 `Alban1911/LeagueSkins` 下载 `.fantome`/`.zip` 并 rebase |
| 资源发布 | CSLoL overlay 或自研基线 WAD overlay | rebase 后资源交给 LTK Manager patcher |
| 加载后端 | CSLoL `CreateFileA` hook 与 LTK patcher 两路 | LTK Manager patcher |
| 缓存 | profile、`.ready`、overlay baseline | 本地资源缓存 |
| 生命周期 | Job Object、游戏窗口监视、显式清理（`--cleanup-hid`）与选肤前清理、所有权标记 | LCU phase 驱动，对局结束卸载 |
| 恢复 | WAD baseline、所有权检查、重启删除、清理界面 | 停止 patcher、卸载本后台导入的 mod |

### 值得借鉴的设计

1. **缓存身份和可重复构建**：不仅缓存下载包，还记录原始 WAD 身份、构建输入和完成标记。游戏更新或资源变化后应使缓存失效，而不是仅按皮肤 ID 复用。
2. **明确所有权**：给本程序部署的文件写所有者标记，清理时区分自有文件与外部安装，避免误删。
3. **进程树托管**：用 Job Object 管理 patcher 和 launcher，降低界面异常退出留下的后台进程。
4. **启动时自恢复**：在启动或首次应用前检查上次异常退出的 pending 文件、残留 overlay 和旧部署，再允许新一次应用；Lillia 的 `--cleanup-hid` 与选肤前清理提供了部分同类能力。
5. **格式适配层独立**：把 `.fantome` 解包、规范化、WAD overlay 构建与进程注入分开，便于按游戏版本替换单一后端。

这些仅是架构建议，不建议为了对齐 Lillia 而直接新增第二套注入后端。

### 不应直接照搬的部分

- 不应照搬 `CreateFileA` hook、游戏内解密相关 patch 或 `hid.dll` 部署。它们提高版本耦合和实现风险，而 Sona 已有 LTK 方案。
- 不应把安装包内完整的皮肤库直接复制进 Sona。应保留按需下载、哈希验证和缓存清理。
- 不应以管理员权限作为普通功能的默认前提。提权边界和桌面用户切换必须单独审查。
- 不能把“hook 已安装”当作换肤成功。需要同时验证资源构建、目标路径、游戏进程和最终加载状态。

## 证据索引

| 主题 | 证据位置（任务目录下） | 关键函数/事实 |
|---|---|---|
| 安装包身份 | `research/evidence.md` | NSIS、样本哈希、证书目录与资源表 |
| 主控与资源选择 | `evidence/main/decompiled.txt`、`evidence/main/calls.txt` | `FUN_140034df0`、`FUN_1400379b0`、`FUN_140034560`、`FUN_140038cd0`；`FUN_1400367b0` 的函数体见 `calls.txt` 的 caller 导出 |
| CSLoL 构建和运行 | `evidence/main/decompiled.txt` | `FUN_14003c390`、`FUN_140042e40` |
| LTK 构建和运行 | `evidence/main/decompiled.txt` | `FUN_140050a20`、`FUN_140054fa0`、`FUN_140056ce0` |
| WAD overlay 算法 | `evidence/wad/decompiled.txt` | `FUN_140013b10`、`FUN_140026880`、`FUN_140028e70`、`FUN_140015c40`、`FUN_140018280` |
| 游戏内重定向 | `evidence/cslol/decompiled.txt` | `FUN_180002640`、`FUN_180002e10` |
| LTK 启动器 | `evidence/launcher/decompiled.txt`、`evidence/launcher/strings.tsv` | `FUN_140002660`、`FUN_140005490`；Rust host 0.2.1 与 stdin/stdout 说明来自包内 `ltk-manager.exe` 的静态字符串（未单独导出） |
| 生命周期 | `evidence/main/calls.txt`、`evidence/main/decompiled.txt` | `FUN_14005d4f0`、`FUN_1400367b0`、`FUN_140041710`（calls.txt/decompiled.txt）；`FUN_140062ee0`、`FUN_14006fdb0`（decompiled.txt）；`--cleanup-hid` 分派见静态反汇编 `0x14000ed25` |
| hid 容器读取 | `evidence/engine/constants.txt` | `FUN_14004b900` 的 `LILLIAHID1` 检查 |

任务目录为 `.trellis/tasks/11-24-lillia-skin-analysis/`。这些是分析工作证据，不是第三方源码恢复版；函数名来自 Ghidra 自动命名，地址以主程序默认映像基址为参照。

## 静态分析未覆盖项

- 当前线上服务的真实请求、响应、更新内容与账号策略；
- `hid.dll` 的实际文件、加载方式及其是否属于当前默认链路；
- NSIS 卸载器 `Uninstall.exe` 的实际清理范围（是否覆盖 `Lillia\apply`、`ltk_work`、overlay 与游戏目录自有组件）；
- `DAT_1401ad3dc` 的赋值来源及其他地区判定条件（本次只确认 `route=cn|ltk` 日志与分支调用点）；
- LTK patcher DLL 内部每个资源重定向细节；
- 不同 Windows 权限、游戏渠道与版本下的实际兼容性；
- 使用第三方换肤的封号概率、安全性和反作弊评价；
- 退出、崩溃、断电、游戏更新等所有场景下的完整恢复证明。

本报告没有修改 Sona 产品代码。
