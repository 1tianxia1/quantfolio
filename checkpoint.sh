#!/usr/bin/env bash
# 存档：把当前所有文件存为一个检查点
set -euo pipefail
WS="$(cd "$(dirname "$0")" && pwd)"; cd "$WS"
if [ ! -d .git ]; then
  git init -q
  git config user.email "workbuddy@local"
  git config user.name "WorkBuddy Checkpoint"
  git add -A
  git commit -q -m "checkpoint: 基线初始化 @ $(date '+%Y-%m-%d %H:%M:%S')" 2>/dev/null || true
  echo "[checkpoint] 已初始化检查点仓库。"
fi
LABEL="${1:-checkpoint}"
MSG="checkpoint: $LABEL @ $(date '+%Y-%m-%d %H:%M:%S')"
git add -A
if git diff --cached --quiet; then
  echo "[checkpoint] 自上次检查点以来没有变化，跳过。HEAD: $(git rev-parse --short HEAD)"; exit 0
fi
git commit -q -m "$MSG"
echo "[checkpoint] ✅ 已存档: $MSG"; echo "[checkpoint]    ID: $(git rev-parse --short HEAD)"
