#!/usr/bin/env bash
# 安装 LTK bridge 的 Python 依赖（uv）
set -euo pipefail

cd "$(dirname "$0")/../.."

if command -v uv >/dev/null 2>&1 && uv --version >/dev/null 2>&1; then
  UV=(uv)
elif command -v mise >/dev/null 2>&1; then
  UV=(mise x uv@0.13.9 -- uv)
else
  echo "未找到 uv。请先安装 uv，或运行：mise use -g uv@0.13.9" >&2
  exit 1
fi

"${UV[@]}" sync --project ltk-bridge
