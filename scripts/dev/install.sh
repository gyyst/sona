#!/usr/bin/env bash
# 安装项目依赖（首次运行或依赖变更后使用）
set -euo pipefail

cd "$(dirname "$0")/../.."

if [ -f package-lock.json ]; then
  npm ci
else
  npm install
fi
