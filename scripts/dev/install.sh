#!/usr/bin/env bash
#
# Sona 依赖安装：按 package-lock.json 安装，日志写入 logs/install.log
# 用法：bash scripts/dev/install.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "${ROOT_DIR}"
mkdir -p logs

LOG_FILE="logs/install.log"

{
  echo "===== Sona npm ci: $(date '+%Y-%m-%d %H:%M:%S') ====="
  npm ci
} 2>&1 | tee "${LOG_FILE}"

echo ""
echo "✅ 依赖安装完成，日志：${ROOT_DIR}/${LOG_FILE}"
