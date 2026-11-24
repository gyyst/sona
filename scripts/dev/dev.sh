#!/usr/bin/env bash
#
# Sona 开发模式：启动 Vite dev server（Pengu 从 dev entry 加载，支持 HMR）
# 用法：bash scripts/dev/dev.sh
# 日志：logs/dev.log

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "${ROOT_DIR}"
mkdir -p logs

LOG_FILE="logs/dev.log"

{
  echo "===== Sona dev server: $(date '+%Y-%m-%d %H:%M:%S') ====="
  npm run dev
} 2>&1 | tee "${LOG_FILE}"
