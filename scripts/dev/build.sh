#!/usr/bin/env bash
# 生产构建：类型检查 + Vite 打包
set -euo pipefail

cd "$(dirname "$0")/../.."

npm run build
