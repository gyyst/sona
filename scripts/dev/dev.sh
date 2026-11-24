#!/usr/bin/env bash
# 开发模式：启动 Vite 开发服务器并生成 Pengu 开发入口
set -euo pipefail

cd "$(dirname "$0")/../.."

npm run dev
