#!/usr/bin/env bash
# 构建 Sona 插件产物（输出到 dist/）。
#
# 用法：
#   ./scripts/build.sh             # 已有 node_modules 时直接构建
#   ./scripts/build.sh --install   # 强制重新安装依赖后再构建

set -euo pipefail

cd "$(dirname "$0")/.."

if [ "${1:-}" = "--install" ] || [ ! -d node_modules ]; then
  echo "安装依赖..."
  npm ci
fi

echo "编译 TypeScript 并构建..."
npm run build
echo "构建完成：dist/"
