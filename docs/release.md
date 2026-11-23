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
- 也可用于补发历史 tag（例如早前自动发布未生成 Release 的 `v1.12.1`）。

## 相关脚本

| 脚本 | 作用 |
| --- | --- |
| `scripts/next-version.mjs` | 计算下一个版本号（当天最大序号 + 1） |
| `scripts/update-version.mjs` | 同步 `package.json` 与 `package-lock.json` 的版本号 |
| `scripts/prepend-changelog.mjs` | 向 `CHANGELOG.md` 顶部插入新版本块 |
| `scripts/publish.sh` | 本地一键触发发布工作流 |
| `scripts/build.sh` | 本地构建插件产物（`--install` 可重新安装依赖） |

## 客户端兼容性

客户端内置的更新检查按版本号的数字段逐段比较（见 `src/lib/update-checker.ts`），四段式版本号可以正确比较。新版本号的首段（年份，如 `2026`）大于历史版本的首段（如 `1`），因此旧客户端能正确识别并提示新版本。
