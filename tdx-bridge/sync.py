#!/usr/bin/env python3
# ============================================================
# sync.py — 定时证券主数据同步（pytdx 直连 → 导出 JSON → 灌本地库）
#
# 设计：
#   - 复用 tdx_client.py 的 pytdx 直连引擎（与 tdx-bridge 同源），不依赖 WorkBuddy 侧 MCP。
#   - 按类型（stock/fund/index）导出为 scripts/_tdx_import/<前缀>_pN.json，
#     前缀约定与 import-tdx-securities.mjs 对齐：stock=ag, fund=jj, index=zs。
#   - 导出后自动调用 node import-tdx-securities.mjs 灌库（ON CONFLICT DO NOTHING，幂等）。
#   - 内置严格交易日守卫（tradingday.is_trading_day）：非交易日打印 SKIP 并退出 0，
#     配合自动化每周工作日触发即可实现"严格交易日"语义。
#
# 用法：
#   python sync.py --types stock                  # 9:14 同步 A 股
#   python sync.py --types fund,index             # 13:00 同步基金/指数
#   python sync.py --types all                    # 全量（默认）
#   python sync.py --no-import                    # 仅导出不灌库
#   python sync.py --no-check                     # 强制忽略交易日（测试用）
# ============================================================
import sys
import os
import json
import argparse
import subprocess
import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import tdx_client as tc
from tradingday import is_trading_day

PAGE = 500
PREFIX = {"stock": "ag", "fund": "jj", "index": "zs"}

# 默认路径（相对本脚本）
DEFAULT_OUT = os.path.normpath(os.path.join(HERE, "..", "scripts", "_tdx_import"))
DEFAULT_IMPORT = os.path.normpath(os.path.join(HERE, "..", "scripts", "import-tdx-securities.mjs"))


def _clean_prefix(out_dir, prefix):
    """删除该前缀的旧分页文件，避免残留 stale 页被重复导入。"""
    for fn in os.listdir(out_dir):
        if fn.startswith(prefix + "_p") and fn.endswith(".json"):
            try:
                os.remove(os.path.join(out_dir, fn))
            except OSError:
                pass


def dump(types, out_dir):
    """加载全部证券 → 按类型筛选 → 分页写出 JSON。返回 {文件名: 条数}。"""
    secs = tc.load_all()
    by_type = {t: [] for t in types}
    for s in secs:
        if s.get("type") in by_type:
            by_type[s["type"]].append(s)

    written = {}
    for t in types:
        items = by_type.get(t, [])
        prefix = PREFIX[t]
        _clean_prefix(out_dir, prefix)
        if not items:
            print(f"  [{t}] 0 条（TDX 未返回该类别）")
            continue
        page = 1
        for i in range(0, len(items), PAGE):
            chunk = items[i : i + PAGE]
            fp = os.path.join(out_dir, f"{prefix}_p{page}.json")
            with open(fp, "w", encoding="utf-8") as f:
                json.dump(chunk, f, ensure_ascii=False)
            written[os.path.basename(fp)] = len(chunk)
            page += 1
        print(f"  [{t}] {len(items)} 条 -> {prefix}_p1..p{page-1}.json")
    return written


def main():
    ap = argparse.ArgumentParser(description="QuantFolio 证券主数据定时同步")
    ap.add_argument("--types", default="all", help="stock|fund|index|all，逗号分隔")
    ap.add_argument("--out", default=DEFAULT_OUT, help="导出目录")
    ap.add_argument("--import-script", default=DEFAULT_IMPORT, help="import-tdx-securities.mjs 路径")
    ap.add_argument("--node", default="node", help="node 可执行文件路径")
    ap.add_argument("--db-path", default=None, help="覆盖 DB_PATH 环境变量")
    ap.add_argument("--no-import", action="store_true", help="仅导出，不灌库")
    ap.add_argument("--no-check", action="store_true", help="忽略交易日守卫（测试用）")
    args = ap.parse_args()

    types = ["stock", "fund", "index"] if args.types == "all" else [x.strip() for x in args.types.split(",") if x.strip()]

    today = datetime.date.today()
    if not args.no_check and not is_trading_day(today):
        print(f"SKIP {today.isoformat()} 非交易日，跳过同步")
        sys.exit(0)

    os.makedirs(args.out, exist_ok=True)
    written = dump(types, args.out)
    total = sum(written.values())
    print(f"导出合计 {total} 条 -> {args.out}")

    if args.no_import:
        return

    env = dict(os.environ)
    if args.db_path:
        env["DB_PATH"] = args.db_path
    print(f"开始灌库: {args.node} {args.import_script} {args.out}")
    r = subprocess.run([args.node, args.import_script, args.out], env=env, capture_output=True, text=True)
    sys.stdout.write(r.stdout)
    if r.stderr:
        sys.stderr.write(r.stderr)
    if r.returncode != 0:
        print("灌库失败，退出码", r.returncode, file=sys.stderr)
        sys.exit(r.returncode)
    print("同步完成")


if __name__ == "__main__":
    main()
