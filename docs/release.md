# 发布流程

本文说明 Sona 的版本号规则与发布方式。

## 版本号规则

- 格式：`v年.月.日.序号`，例如 `v2026.11.24.1`、`v2026.11.24.2`。
- 日期按**北京时间**（Asia/Shanghai）取当天。
- 序号为**同一天内的递增序号**，从 1 开始；跨天后重新从 1 开始。
- Git tag 带 `v` 前缀（`v2026.11.24.1`），`package.json` 的 `version` 字段不带 `v`（`2026.11.24.1`）。
- 发布工作流会自动计算版本号，无需手动指定。

## 一键发布

### 方式一：GitHub 网页

1. 打开仓库的 **Actions → Publish Release**。
2. 点击 **Run workflow**，选择 `main` 分支。
3. 可选填写「发布说明」；留空则自动汇总上次发布以来的提交记录。
4. 点击运行。工作流会自动完成版本计算、提交、打 tag、构建和发布。

### 方式二：命令行

```bash
./scripts/publish.sh "### ✨ 改进

- 本次发布的主要内容"
```

不带参数时自动汇总提交记录：

```bash
./scripts/publish.sh
```

脚本会触发 GitHub Actions 并跟踪运行结果。前置条件是已安装并登录 `gh` CLI。

## 工作流之间的关系

```
publish.yml（手动一键发布）──────┐
                                 ├──> release.yml（构建 + 创建 GitHub Release）
update-balance.yml（每周自动）───┘
```

- **publish.yml**：手动触发。计算版本号 → 更新 `package.json` / `package-lock.json` → 写入 `CHANGELOG.md` → 提交 `main` → 打 tag → 调用 `release.yml`。
- **update-balance.yml**：每周三/四/五自动检查英雄平衡数据，有变化时以同样方式发布新版本。
- **release.yml**：被上述两个工作流调用，或响应手动推送的 `v*` tag；负责构建、打包并创建 GitHub Release。

## 手动兜底发布

如需绕过一键发布（例如修复历史版本），可手动打 tag：

```bash
git tag v2026.11.24.3
git push origin v2026.11.24.3
```

`release.yml` 会响应 tag 推送并发布。**注意**：tag 对应的提交中，`package.json` 的 `version` 必须与 tag 一致，否则工作流会失败。

另外，GitHub 规定 `GITHUB_TOKEN` 推送 tag 不会触发新的工作流（`workflow_dispatch` 与 `workflow_call` 除外），因此自动化流程必须通过 `workflow_call` 调用 `release.yml`，不能依赖推送 tag 间接触发。

### 重新发布或补发

构建失败或漏发时，可在 **Actions → Release → Run workflow** 中填写要发布或重新发布的 tag：

- 构建失败后可原样重试；已存在的 Release 会被更新，不会产生重复。
- 已存在的 `dist-v*` 更新产物标签会在重跑时被跳过（标签不可变），不会阻塞 Release 创建/更新。
- 也可用于补发历史 tag（例如早前自动发布未生成 Release 的 `v1.12.1`）。补发自动更新之前的旧 tag 时，工作流会跳过 `dist-v*` 更新产物发布，只创建/更新 GitHub Release。

## 自动更新产物

`release.yml` 在创建 GitHub Release 的同时，会把 `app.js`、`app.css`、`update.json` 发布到 `dist-v<version>` 标签（例如 `dist-v2026.11.24.1`）。客户端自动更新只读取这个标签，不读取 Release 附件。

- `dist-v*` 标签不可变，不要删除或移动；发布事故请用新版本修复。
- 若 `dist-v*` 标签已推送但 Release 创建失败，直接重跑工作流即可：已存在的标签会被跳过，Release 会被创建/更新。
- `dist` 分支只保留最新一次产物，用于调试；历史版本仍在各自的 `dist-v*` 标签中。

## 发布产物

每次发布生成两个 Release 附件：

| 附件 | 内容 |
| --- | --- |
| `sona-<tag>.zip` | 插件本体 + `ltk/` 运行时（LTF 桥接、`sona-ltk.exe`、自维护的 LTK Manager 安装包） |
| `sona-ltk-runtime-<tag>.zip` | 仅 `ltk/` 运行时，供手动部署 |

### 自维护的 LTK Manager

`release.yml` 的 `build-ltk-manager` job 从 `lib/ltk-manager` 子模块构建 LTK Manager 的 NSIS 安装包，
放进插件 zip 的 `ltk/manager/`，并写入 `ltk/manager/manifest.json`（版本、文件名、SHA-256、大小）。

- 后台 `sona-ltk` 优先使用随包安装包，缺失或校验失败时才回退到内置下载地址。
- 安装包版本取自 `lib/ltk-manager/package.json`，由子模块提交锁定，与 Sona 的日期版本互不影响。
  该版本必须是稳定版（不含 `-rc` 之类后缀），否则构建失败。
- 构建会移除 `tauri.conf.json` 的 `signCommand`：fork 没有自己的证书，而 `LTK-PATCHER-LICENSE.md`
  要求再分发时必须移除 League Toolkit 的签名。
- 跨仓库调用可复用工作流时必须写在 **job 级**（`jobs.<id>.uses`），不能写成 `steps[].uses`。
  写错时整个 workflow 会被判为无效：push 触发的运行 0 秒失败、`total_count` 为 0 个 job。
- 可复用工作流默认检出**调用方**仓库，因此 fork 的构建工作流必须显式
  `repository: gyyst/ltk-manager` 加 `ref`，否则会在 sona 仓库里跑 `pnpm install` 并失败。
- 传给 fork 的 `ref` 必须读子模块 gitlink（`git ls-tree HEAD lib/ltk-manager`），
  不能用 `git -C lib/ltk-manager rev-parse HEAD`：子模块未初始化时它返回父仓库 HEAD，
  那个提交在 fork 上不存在，checkout 会报 `not our ref`。
- 自动更新默认关闭，避免用户被更新回未打补丁的上游版本。需要启用时，在仓库 Variables 里设置
  `SONA_LTK_UPDATER_ENDPOINT`（指向自有 releases 的 `latest.json`）与 `SONA_LTK_UPDATER_PUBKEY`，
  并另行为该端点发布 `latest.json`。

## 相关脚本

| 脚本 | 作用 |
| --- | --- |
| `scripts/next-version.mjs` | 计算下一个版本号（当天最大序号 + 1） |
| `scripts/update-version.mjs` | 同步 `package.json` 与 `package-lock.json` 的版本号 |
| `scripts/prepend-changelog.mjs` | 向 `CHANGELOG.md` 顶部插入新版本块 |
| `scripts/publish.sh` | 本地一键触发发布工作流 |
| `scripts/build.sh` | 本地构建插件产物并校验自动更新契约（`--install` 可重新安装依赖） |
| `scripts/dev/dev.sh` | 本地开发模式（Vite dev server + HMR） |
| `scripts/dev/check.sh` | 类型检查 + 构建不变量校验 |
| `scripts/dev/install.sh` | 依赖安装 |

## 客户端兼容性

客户端内置的更新检查按版本号的数字段逐段比较（见 `src/lib/update/update-checker.ts`），四段式版本号可以正确比较。新版本号的首段（年份，如 `2026`）大于历史版本的首段（如 `1`），因此旧客户端能正确识别并提示新版本。
