#!/usr/bin/env bash
# ============================================================
#  QuantFolio 一键启动脚本（macOS / Linux）
#  流程：检查 Node -> 安装依赖 -> 初始化 .env -> 导入种子数据 -> 并行启动前后端
# ============================================================
set -e
cd "$(dirname "$0")"

echo "============================================================"
echo "  QuantFolio 启动中 ..."
echo "  后端 API : http://localhost:3001"
echo "  前端页面: http://localhost:5173"
echo "============================================================"

# ---- 1. 检查 Node ----
if ! command -v node >/dev/null 2>&1; then
  echo "[错误] 未检测到 Node.js，请先安装 Node.js 18+（推荐 20/22 LTS）"
  exit 1
fi
echo "[1/4] Node 版本: $(node -v)"

# ---- 2. 安装根依赖 ----
if [ ! -d "node_modules/concurrently" ]; then
  echo "[2/4] 安装根依赖 ..."
  npm install
fi

# ---- 3. 初始化 .env ----
if [ ! -f ".env" ]; then
  echo "[3/4] 生成 .env（从 .env.example 复制）..."
  cp .env.example .env
fi

# ---- 4. 安装前后端依赖 + 导入种子数据 ----
echo "[4/4] 安装前后端依赖 ..."
npm run install-all || echo "[警告] 依赖安装未完全成功，尝试继续 ..."

echo "导入种子数据 ..."
npm run seed || echo "[警告] 种子数据导入失败，请检查 data/seed-market.json 与 server 依赖"

echo ""
echo "启动前后端（Ctrl+C 停止）..."
npm run dev
