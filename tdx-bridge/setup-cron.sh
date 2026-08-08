#!/usr/bin/env bash
# ============================================================
# setup-cron.sh — 在 Linux 云服务器部署 QuantFolio 证券定时同步
#
# 用途：把"每日交易日 9:14 同步 A 股 / 13:00 同步基金+指数"挂到系统 cron。
#       脚本自包含：自动建 venv、装 pytdx、解析 node 绝对路径、写 crontab。
#       所有路径都用"仓库相对路径"推导，克隆到任意目录都能跑（无需改任何路径）。
#
# 前置：服务器需有 python3、node（已在 PATH 或常见位置），且能连通达信行情服务器
#       （国内服务器如阿里云 ECS 一般 OK；海外服务器 pytdx 可能连不上，详见末尾说明）。
#
# 用法：
#   bash tdx-bridge/setup-cron.sh          # 部署 / 更新 crontab
#   bash tdx-bridge/setup-cron.sh --remove # 仅移除 QuantFolio 相关 cron 条目
# ============================================================
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/.." && pwd)"
VENV="$REPO_ROOT/tdx-bridge/.venv"
OUT="$REPO_ROOT/scripts/_tdx_import"
DB="$REPO_ROOT/server/data/quantfolio.db"
CRON_LOG="$REPO_ROOT/tdx-bridge/sync-cron.log"
SYNC="$HERE/sync.py"

# ---------- 可选移除 ----------
if [ "${1:-}" = "--remove" ]; then
  ( crontab -l 2>/dev/null | grep -v "QuantFolio-sync" ) | crontab - || true
  echo "已移除 QuantFolio 相关 cron 条目。"
  exit 0
fi

# ---------- 1) venv + pytdx ----------
if [ ! -x "$VENV/bin/python" ]; then
  echo "创建 venv: $VENV"
  python3 -m venv "$VENV"
fi
"$VENV/bin/python" -m pip install --quiet --upgrade pip
"$VENV/bin/python" -m pip install --quiet pytdx

# ---------- 2) node 绝对路径（cron 环境 PATH 极简，必须绝对路径）----------
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  # 常见位置兜底
  for p in /usr/local/bin/node /usr/bin/node /opt/node/bin/node; do
    [ -x "$p" ] && NODE_BIN="$p" && break
  done
fi
if [ -z "$NODE_BIN" ]; then
  echo "错误: 未找到 node，请先在云服务器安装 Node.js（建议 18+）。" >&2
  exit 1
fi
echo "使用 node: $NODE_BIN"

# ---------- 3) 写 crontab（幂等：先删旧的 QuantFolio 条目）----------
TMP="$(mktemp)"
crontab -l 2>/dev/null | grep -v "QuantFolio-sync" > "$TMP" || true

cat >> "$TMP" <<EOF
# QuantFolio-sync-ag: 每个工作日 09:14 同步 A 股（脚本内置交易日守卫，节假日自动 SKIP）
14 9 * * 1-5 $VENV/bin/python $SYNC --types stock --out $OUT --db-path $DB --node "$NODE_BIN" >> $CRON_LOG 2>&1
# QuantFolio-sync-funds-indices: 每个工作日 13:00 同步基金/指数
0 13 * * 1-5 $VENV/bin/python $SYNC --types fund,index --out $OUT --db-path $DB --node "$NODE_BIN" >> $CRON_LOG 2>&1
EOF

crontab "$TMP"
rm -f "$TMP"

echo "=============================================="
echo "crontab 部署完成（已生效）："
crontab -l | grep "QuantFolio-sync"
echo "----------------------------------------------"
echo "日志文件: $CRON_LOG"
echo "手动验证（立即跑一次，强制忽略交易日）:"
echo "  $VENV/bin/python $SYNC --types fund,index --no-check"
echo "=============================================="
echo
echo "⚠️ 关于通达信连通性：pytdx 直连的是国内通达信行情服务器。"
echo "   若云服务器在海外（如 Oracle ARM 免费机），很可能连不上 -> 同步报错。"
echo "   此时本地库已是全量（股票+基金+指数），日常解析不受影响，只是无法增量更新。"
echo "   建议把项目部署到国内服务器（如你的阿里云 ECS 121.41.228.186）。"
