#!/usr/bin/env bash
# 类型检查（不产出构建文件）
set -euo pipefail

cd "$(dirname "$0")/../.."

npx tsc --noEmit
