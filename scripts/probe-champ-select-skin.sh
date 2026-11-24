#!/usr/bin/env bash
# 探测英雄选择界面原生皮肤轮盘对 LCU selectedSkinId 的写入行为（日志写入 logs/）
#
# 用法：
#   ./scripts/probe-champ-select-skin.sh
#   ./scripts/probe-champ-select-skin.sh --seconds=120
set -euo pipefail

cd "$(dirname "$0")/.."
mkdir -p logs

node scripts/probe-champ-select-skin.mjs "$@" 2>&1 | tee logs/probe-champ-select-skin.stdout.log
