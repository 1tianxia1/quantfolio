#!/usr/bin/env python3
# ============================================================
# tdx_client.py — 用 pytdx 直连通达信行情服务器解析证券
#
# 用法（由 Node 桥接服务调用）：
#   python tdx_client.py all                 -> 打印完整证券数组 JSON
#   python tdx_client.py resolve <code|name> -> 打印单个证券 JSON 或 {}
#
# 红线：拿不到就返回空 {}，绝不编造代码/名称/数字。
#
# 注意（本机 pytdx 版本实测）：
#   - best_ip 入口是 select_best_ip()，返回 {'ip','port'}
#   - get_security_list(market, start) 按每块 1000 条分页；start=0 通常返回 None，
#     真实数据从 start=900 起，因此循环以 1000 为步长、遇到 None 跳过即可。
#   - 返回字段含 code/name，但不含 market，需由调用方按市场(0=SZ,1=SH)显式传入。
#   - 该列表已涵盖 股票/指数/ETF/债券 等全部证券类别，无需再调 index/etf 专用接口。
# ============================================================
import sys
import os
import json
import warnings

warnings.filterwarnings("ignore")

from pytdx.hq import TdxHq_API
from pytdx.util.best_ip import select_best_ip


def connect():
    import io
    import contextlib

    api = TdxHq_API()
    # 直连模式：设置 TDX_HOST/TDX_PORT 环境变量可绕过 select_best_ip（其会去拉远程列表，
    # 在受限网络下会挂死）。实测沙箱对已知行情服务器 IP:7709 直连可达。
    host = os.environ.get("TDX_HOST")
    port = os.environ.get("TDX_PORT")
    if host:
        try:
            port = int(port) if port else 7709
            api.connect(host, port, time_out=3.0)
            try:
                api.setup()
            except Exception:
                pass
            return api
        except Exception as e:
            print(f"WARN 直连 {host}:{port} 失败: {e}，回退 select_best_ip", file=sys.stderr)
    # select_best_ip() 会把 "GOOD RESPONSE" / "bool object ..." 等探测日志打到 stdout，
    # 会污染脚本最终输出的 JSON，因此临时把 stdout 重定向掉。
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        info = select_best_ip()
    host = info.get("ip") if isinstance(info, dict) else info
    port = int(info.get("port", 7709)) if isinstance(info, dict) else 7709
    api.connect(host, port, time_out=3.0)
    try:
        api.setup()
    except Exception:
        pass
    return api


def fetch_market_list(api, market):
    """分页拉取某市场的全量证券列表（每块 1000 条，start=0 可能为 None 跳过）。"""
    out = []
    total = api.get_security_count(market) or 0
    start = 0
    while start < total:
        try:
            batch = api.get_security_list(market, start)
        except Exception:
            batch = None
        if batch:
            out.extend(batch)
        start += 1000
    return out


def infer_type(code, market):
    # 上证指数系列（000xxx，market=SH）视为指数
    if market == 1 and code.startswith("000"):
        return "index"
    if code.startswith(("399", "39")):
        return "index"
    # 5xxxxx = 沪市基金/ETF；15/16/18xxxx = 深市 ETF
    if code.startswith(("5", "15", "16", "18")):
        return "fund"
    return "stock"


def infer_board(code, type_):
    if type_ == "index":
        return "IDX", 10
    if type_ == "fund":
        return "ETF", 10
    if code.startswith(("688", "689")):
        return "STAR20", 20
    if code.startswith(("300", "301")):
        return "ChiNext20", 20
    if code[0] in "84" or code.startswith("920"):
        return "BSE30", 30
    if code.startswith("60"):
        return "SH-Main10", 10
    if code.startswith(("000", "001", "002", "003")):
        return "SZ-Main10", 10
    return "SZ-Main10", 10


def build_sec(item, market):
    code = item["code"]
    name = item.get("name", "")
    mkt = "SH" if market == 1 else "SZ"
    type_ = infer_type(code, market)
    board, pl = infer_board(code, type_)
    return {
        "code": code,
        "name": name,
        "market": mkt,
        "type": type_,
        "board": board,
        "price_limit_pct": pl,
    }


def load_all():
    api = connect()
    secs = {}
    try:
        for market in (0, 1):  # 0=SZ, 1=SH
            for it in fetch_market_list(api, market):
                s = build_sec(it, market)
                # 代码冲突时优先保留 stock（如 000001：深市平安银行 vs 上证指数）
                if s["code"] not in secs or (
                    secs[s["code"]]["type"] == "index" and s["type"] == "stock"
                ):
                    secs[s["code"]] = s
    finally:
        try:
            api.disconnect()
        except Exception:
            pass
    return list(secs.values())


def resolve(query):
    q = (query or "").strip()
    if not q:
        return None
    all_secs = load_all()
    if q.isdigit() and len(q) == 6:  # 按代码精确匹配
        for s in all_secs:
            if s["code"] == q:
                return s
    for s in all_secs:  # 按名称包含匹配
        if q and s.get("name") and q in s["name"]:
            return s
    return None


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "all"
    if cmd == "all":
        print(json.dumps(load_all(), ensure_ascii=False))
    elif cmd == "resolve":
        q = sys.argv[2] if len(sys.argv) > 2 else ""
        r = resolve(q)
        print(json.dumps(r if r else {}, ensure_ascii=False))
    else:
        print(json.dumps({}, ensure_ascii=False))
