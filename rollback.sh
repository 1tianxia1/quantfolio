#!/usr/bin/env bash
# 回退：一键把所有文件恢复到某个检查点
set -euo pipefail
WS="$(cd "$(dirname "$0")" && pwd)"; cd "$WS"
FORCE=0; ARGS=()
for a in "$@"; do case "$a" in -y|--yes) FORCE=1;; *) ARGS+=("$a");; esac; done
TARGET_ARG="${ARGS[0]:-}"
if [ ! -d .git ]; then echo "[rollback] 还没有检查点，先运行 ./checkpoint.sh。" >&2; exit 1; fi
mapfile -t CPS < <(git rev-list --grep='checkpoint:' HEAD)
if [ ${#CPS[@]} -eq 0 ]; then echo "[rollback] 没有检查点。" >&2; exit 1; fi
if [ "$TARGET_ARG" = "list" ]; then
  git log --pretty=format:'  %h  %ad  %s' --date=format:'%Y-%m-%d %H:%M' --grep='checkpoint:'; echo; exit 0
fi
TARGET=""
if [ -z "$TARGET_ARG" ]; then TARGET="${CPS[0]}"
elif [[ "$TARGET_ARG" =~ ^[0-9]+$ ]]; then
  [ "$TARGET_ARG" -ge ${#CPS[@]} ] && { echo "[rollback] 超出检查点数量(${#CPS[@]})。">&2; exit 1; }
  TARGET="${CPS[$TARGET_ARG]}"
else TARGET="$TARGET_ARG"; fi
if ! git cat-file -e "$TARGET^{commit}" 2>/dev/null; then echo "[rollback] 找不到: $TARGET_ARG">&2; exit 1; fi
SHORT="$(git rev-parse --short "$TARGET")"
echo "[rollback] ⚠️  恢复到检查点 $SHORT: $(git log -1 --pretty=format:'%ad %s' --date=format:'%Y-%m-%d %H:%M' "$TARGET")"
echo "[rollback]   当前未提交/之后的改动都会丢失。"
if [ "$FORCE" -ne 1 ]; then
  read -r -p "[rollback] 确认回退? (y/N) " ans
  [ "${ans:-n}" != "y" ] && [ "${ans:-n}" != "Y" ] && { echo "[rollback] 已取消。"; exit 0; }
fi
git reset --hard "$TARGET" -q
echo "[rollback] ✅ 已恢复，所有文件原样。"
