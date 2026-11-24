#!/usr/bin/env bash
# LTK bridge 静态检查（ruff）
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

"${UV[@]}" run --project ltk-bridge ruff check ltk-bridge/src ltk-bridge/tests ltk-bridge/entrypoint.py
