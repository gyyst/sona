#!/usr/bin/env bash
#
# Sona 检查：TypeScript 类型检查 + 构建产物不变量校验
# 用法：bash scripts/build.sh && bash scripts/dev/check.sh
# 日志：logs/check.log

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "${ROOT_DIR}"
mkdir -p logs

LOG_FILE="logs/check.log"

{
  echo "===== Sona typecheck: $(date '+%Y-%m-%d %H:%M:%S') ====="
  npx tsc --noEmit
  echo "===== Sona build invariants: $(date '+%Y-%m-%d %H:%M:%S') ====="
  node scripts/check-build.mjs
} 2>&1 | tee "${LOG_FILE}"

echo ""
echo "✅ 检查通过，日志：${ROOT_DIR}/${LOG_FILE}"
