#!/usr/bin/env bash
# 一键发布：触发 GitHub Actions 的 Publish Release 工作流。
#
# 用法：
#   ./scripts/publish.sh                  # 自动汇总上次发布以来的提交记录作为发布说明
#   ./scripts/publish.sh "发布说明文本"    # 使用自定义发布说明（支持 Markdown）
#
# 前置条件：已安装并登录 gh CLI（gh auth login）。
# 环境变量：SONA_REPO（默认 gyyst/sona）、SONA_REF（默认 main）。

set -euo pipefail

REPO="${SONA_REPO:-gyyst/sona}"
REF="${SONA_REF:-main}"
NOTES="${1:-}"

if ! command -v gh >/dev/null 2>&1; then
  echo "未找到 gh CLI，请先安装：https://cli.github.com/" >&2
  exit 1
fi

echo "触发 ${REPO} 的 Publish Release 工作流（ref: ${REF}）..."
BEFORE_ID=$(gh run list --repo "$REPO" --workflow publish.yml --limit 1 --json databaseId --jq '.[0].databaseId // 0')
gh workflow run publish.yml --repo "$REPO" --ref "$REF" -f "notes=${NOTES}"

# 等待新一次运行出现在列表中，并跟踪结果
RUN_ID=""
for _ in $(seq 1 12); do
  sleep 5
  CANDIDATE=$(gh run list --repo "$REPO" --workflow publish.yml --limit 1 --json databaseId --jq '.[0].databaseId // 0')
  if [ -n "$CANDIDATE" ] && [ "$CANDIDATE" != "0" ] && [ "$CANDIDATE" != "$BEFORE_ID" ]; then
    RUN_ID="$CANDIDATE"
    break
  fi
done

if [ -z "$RUN_ID" ]; then
  echo "未能获取工作流运行 ID，请前往 Actions 页面查看：https://github.com/${REPO}/actions/workflows/publish.yml"
  exit 0
fi

echo "运行 ID：${RUN_ID}"
gh run watch "$RUN_ID" --repo "$REPO" --exit-status
