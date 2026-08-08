#!/usr/bin/env python3
# ============================================================
# quote_sync.py — 定时日行情同步（pytdx 直连 → 计算指标 → 导出 JSON → 灌本地库）
#
# 与 sync.py（证券主数据）同源，本脚本负责"行情"这一层：
#   - 从本地 DB 读取已同步的证券 universe（sync.py 先把代码/名称灌进 securities）。
#   - 用 pytdx.get_security_bars(9, market, code, 0, N) 拉日 K 线（category=9 日线）。
#   - 在本地计算派生字段与技术指标（pct_chg/pre_close/volume_ratio + MA/MACD/RSI/KDJ/各交叉），
#     不依赖服务端重算，保持幂等可重跑。
#   - 导出为 scripts/_tdx_import/quotes.json（数组，每元素含 code / bars / indicators）。
#   - 调用 node import-tdx-quotes.mjs 灌库（ON CONFLICT REPLACE，幂等）。
#   - 内置严格交易日守卫（tradingday.is_trading_day）。
#
# 红线（同 tdx_client.py）：拿不到就跳过该代码，绝不编造 OHLC/数字。
#
# 用法：
#   python quote_sync.py --types stock                # 同步 A 股日线
#   python quote_sync.py --types all                   # 全量（默认）
#   python quote_sync.py --days 250 --limit 200        # 每只 250 根、仅前 200 只（调试）
#   python quote_sync.py --no-import                   # 仅导出不灌库
#   python quote_sync.py --no-check                    # 忽略交易日守卫（测试用）
# ============================================================
import sys
import os
import json
import argparse
import sqlite3
import datetime
import subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from tradingday import is_trading_day

# pytdx 懒导入：仅在实际抓取时才需要，便于无网络环境做语法自检。
try:
    from pytdx.hq import TdxHq_API
    from pytdx.util.best_ip import select_best_ip
    _HAS_PYTDX = True
except Exception:  # pragma: no cover
    _HAS_PYTDX = False

DEFAULT_OUT = os.path.normpath(os.path.join(HERE, "..", "scripts", "_tdx_import", "quotes.json"))
DEFAULT_IMPORT = os.path.normpath(os.path.join(HERE, "..", "scripts", "import-tdx-quotes.mjs"))
DEFAULT_DB = os.path.normpath(os.path.join(HERE, "..", "server", "data", "quantfolio.db"))


# ---------------------------------------------------------------------------
# 指标计算（纯函数，便于离线单测）
# ---------------------------------------------------------------------------
def _ema(values, period):
    if not values:
        return []
    k = 2.0 / (period + 1)
    out = []
    prev = values[0]
    for i, v in enumerate(values):
        prev = v if i == 0 else v * k + prev * (1 - k)
        out.append(prev)
    return out


def _sma(values, period):
    out = []
    for i in range(len(values)):
        if i + 1 < period:
            out.append(None)
        else:
            out.append(sum(values[i + 1 - period : i + 1]) / period)
    return out


def compute_indicators(bars):
    """bars: 升序列表，每元素 {date,open,high,low,close,volume,amount}。
    返回与 bars 对齐的 indicators 列表（含派生字段）。"""
    n = len(bars)
    # 容错：部分品种（如指数）volume/open 等可能为 None；缺失值兜底为 0，避免算数崩溃
    closes = [float(b.get("close") or 0) for b in bars]
    highs = [float(b.get("high") or 0) for b in bars]
    lows = [float(b.get("low") or 0) for b in bars]
    vols = [float(b.get("volume") or 0) for b in bars]

    ma5 = _sma(closes, 5)
    ma10 = _sma(closes, 10)
    ma20 = _sma(closes, 20)
    ma60 = _sma(closes, 60)

    dif = [c - e for c, e in zip(_ema(closes, 12), _ema(closes, 26))]
    dea = _ema(dif, 9)
    macd_bar = [2 * (d - e) for d, e in zip(dif, dea)]

    # RSI
    def rsi(period):
        out = [None] * n
        gains = []; losses = []
        for i in range(1, n):
            ch = closes[i] - closes[i - 1]
            gains.append(max(ch, 0.0)); losses.append(max(-ch, 0.0))
        # Wilder 平滑
        if len(gains) < period:
            return out
        ag = sum(gains[:period]) / period
        al = sum(losses[:period]) / period
        rs = (ag / al) if al > 0 else (float("inf") if ag > 0 else 0.0)
        out[period] = 100 - 100 / (1 + rs) if al > 0 else (100.0 if ag > 0 else 0.0)
        for i in range(period, len(gains)):
            ag = (ag * (period - 1) + gains[i]) / period
            al = (al * (period - 1) + losses[i]) / period
            rs = (ag / al) if al > 0 else (float("inf") if ag > 0 else 0.0)
            out[i + 1] = 100 - 100 / (1 + rs) if al > 0 else (100.0 if ag > 0 else 0.0)
        return out

    rsi6 = rsi(6)
    rsi12 = rsi(12)
    rsi24 = rsi(24)

    # KDJ（9,3,3）
    kdj_k = [None] * n
    kdj_d = [None] * n
    kdj_j = [None] * n
    prev_k = 50.0
    prev_d = 50.0
    for i in range(n):
        window = highs[max(0, i - 8) : i + 1]
        wlow = min(lows[max(0, i - 8) : i + 1])
        whigh = max(window)
        rsv = (closes[i] - wlow) / (whigh - wlow) * 100 if whigh > wlow else 50.0
        k = (2.0 / 3) * prev_k + (1.0 / 3) * rsv
        d = (2.0 / 3) * prev_d + (1.0 / 3) * k
        kdj_k[i] = k
        kdj_d[i] = d
        kdj_j[i] = 3 * k - 2 * d
        prev_k, prev_d = k, d

    vol_ma5 = _sma(vols, 5)

    # 派生行级字段 + 交叉判定
    indicators = []
    for i in range(n):
        close = closes[i]
        # 60 日最高距
        hi60 = max(highs[max(0, i - 59) : i + 1])
        high_60d_distance_pct = (close / hi60 - 1) * 100 if hi60 > 0 else 0.0
        # 量比（近 5 日均量）
        vr5 = (vols[i] / vol_ma5[i]) if (vol_ma5[i] and vol_ma5[i] > 0) else None
        # 连续放量天数（尾随 vol>vol_ma5）
        streak = 0
        j = i
        while j >= 0 and vol_ma5[j] and vols[j] > vol_ma5[j]:
            streak += 1
            j -= 1

        m5 = ma5[i]; m10 = ma10[i]; m20 = ma20[i]; m60 = ma60[i]
        bull = bool(m5 and m10 and m20 and m60 and m5 > m10 > m20 > m60)
        bear = bool(m5 and m10 and m20 and m60 and m5 < m10 < m20 < m60)
        above20 = bool(m20 and close > m20)

        macd_gold = macd_dead = macd_pos = macd_hist_turn_pos = 0
        if i >= 1:
            if dif[i - 1] <= dea[i - 1] and dif[i] > dea[i]:
                macd_gold = 1
            if dif[i - 1] >= dea[i - 1] and dif[i] < dea[i]:
                macd_dead = 1
        if dif[i] > 0:
            macd_pos = 1
        if i >= 1 and macd_bar[i - 1] < 0 and macd_bar[i] >= 0:
            macd_hist_turn_pos = 1

        kdj_gold = kdj_dead = 0
        if i >= 1 and kdj_k[i - 1] is not None:
            if kdj_k[i - 1] <= kdj_d[i - 1] and kdj_k[i] > kdj_d[i]:
                kdj_gold = 1
            if kdj_k[i - 1] >= kdj_d[i - 1] and kdj_k[i] < kdj_d[i]:
                kdj_dead = 1

        ma_cross_above_5 = 0
        if i >= 1 and m5 and m20 and ma5[i - 1] is not None and ma20[i - 1] is not None:
            if ma5[i - 1] <= ma20[i - 1] and m5 > m20:
                ma_cross_above_5 = 1

        # 命中标签（与 seed 的 indicator_hit 同源语义）
        hit = []
        if macd_gold:
            hit.append("MACD金叉")
        if kdj_gold:
            hit.append("KDJ金叉")
        if bull:
            hit.append("多头排列")
        if above20:
            hit.append("站上20日线")
        if streak >= 3:
            hit.append("连续放量")

        indicators.append({
            "ma5": m5, "ma10": m10, "ma20": m20, "ma60": m60,
            "macd_dif": dif[i], "macd_dea": dea[i], "macd_bar": macd_bar[i],
            "rsi6": rsi6[i], "rsi12": rsi12[i], "rsi24": rsi24[i],
            "kdj_k": kdj_k[i], "kdj_d": kdj_d[i], "kdj_j": kdj_j[i],
            "vol_ma5": vol_ma5[i], "vol_ratio_5": vr5,
            "volume_streak": streak,
            "high_60d_distance_pct": high_60d_distance_pct,
            "macd_gold_cross": macd_gold, "macd_dead_cross": macd_dead,
            "macd_positive": macd_pos, "macd_hist_turn_positive": macd_hist_turn_pos,
            "kdj_gold_cross": kdj_gold, "kdj_dead_cross": kdj_dead,
            "ma_bullish": 1 if bull else 0, "ma_bearish": 1 if bear else 0,
            "ma_above_20": 1 if above20 else 0, "ma_cross_above_5": ma_cross_above_5,
            "indicator_hit": json.dumps(hit, ensure_ascii=False),
        })
    return indicators


def market_of(code):
    """pytdx market: 0=SZ, 1=SH。BJ 归到 SZ 通道（best-effort）。"""
    s = str(code)
    if s[0] in "69" or s.startswith("900") or s.startswith("601") or s.startswith("603") or s.startswith("600") or s.startswith("604") or s.startswith("605"):
        return 1
    return 0


# ---------------------------------------------------------------------------
# 抓取
# ---------------------------------------------------------------------------
def fetch_bars(api, code, days, sec_type=None):
    """返回升序 bars 列表；拿不到返回 []。

    注意两个易踩的坑：
    1) 指数必须用 get_index_bars，用 get_security_bars 读会解析出乱码
       （负价 + 形如 "296956-72-" 的日期），曾污染 7 万余行。
    2) pytdx 返回的成交量字段名是 `vol` 而非 `volume`，取错会全为 0，
       导致量比/量能类指标整体失效。
    """
    is_index = str(sec_type).lower() == "index"
    try:
        if is_index:
            raw = api.get_index_bars(9, market_of(code), str(code), 0, days)
        else:
            raw = api.get_security_bars(9, market_of(code), str(code), 0, days)
    except Exception:
        return []
    if not raw:
        return []

    bars = []
    prev_close = None
    for r in raw:
        dt = str(r.get("datetime", ""))[:10]
        # 校验日期形态，挡掉乱码解析结果
        if not _valid_date(dt):
            continue
        close = r.get("close")
        # 价格必须为正，负价/零价是乱码特征
        if close is None or close <= 0:
            continue
        op = r.get("open"); hi = r.get("high"); lo = r.get("low")
        # pytdx 字段名为 vol；兼容少数返回 volume 的情况。NOT NULL 列兜底为 0
        vol = r.get("vol")
        if vol is None:
            vol = r.get("volume")
        vol = vol or 0
        amt = r.get("amount") or 0
        pct = ((close - prev_close) / prev_close * 100) if prev_close else None
        bars.append({
            "date": dt, "open": op, "high": hi, "low": lo, "close": close,
            "volume": vol, "amount": amt, "pct_chg": pct, "pre_close": prev_close,
        })
        prev_close = close

    _fill_volume_ratio(bars)
    return bars


def _valid_date(s):
    """严格校验 YYYY-MM-DD 且年份合理，用于挡掉 pytdx 乱码解析结果。"""
    if not s or len(s) != 10 or s[4] != "-" or s[7] != "-":
        return False
    try:
        y, m, d = int(s[0:4]), int(s[5:7]), int(s[8:10])
    except ValueError:
        return False
    if not (1990 <= y <= 2100 and 1 <= m <= 12 and 1 <= d <= 31):
        return False
    return True


def _fill_volume_ratio(bars):
    """就地写入量比 volume_ratio = 当日量 / 前 5 日均量（不足 5 日或均量为 0 则留空）。"""
    for i, b in enumerate(bars):
        if i < 5:
            b["volume_ratio"] = None
            continue
        prev5 = [bars[j]["volume"] for j in range(i - 5, i)]
        avg = sum(prev5) / 5.0
        b["volume_ratio"] = round(b["volume"] / avg, 4) if avg > 0 else None


def load_universe(db_path, types):
    if not os.path.exists(db_path):
        print(f"WARN 本地库不存在: {db_path}（请先运行 sync.py 同步证券主数据）", file=sys.stderr)
        return []
    con = sqlite3.connect(db_path)
    try:
        cur = con.execute("SELECT code, type FROM securities")
        rows = cur.fetchall()
    finally:
        con.close()
    want = set(types)
    return [(c, t) for c, t in rows if (not want or t in want)]


def main():
    ap = argparse.ArgumentParser(description="QuantFolio 日行情定时同步")
    ap.add_argument("--types", default="all", help="stock|fund|index|all，逗号分隔")
    ap.add_argument("--days", type=int, default=250, help="每只拉取根数（默认 250）")
    ap.add_argument("--limit", type=int, default=0, help="仅同步前 N 只（调试用，0=全部）")
    ap.add_argument("--out", default=DEFAULT_OUT, help="导出 quotes.json 路径")
    ap.add_argument("--import-script", default=DEFAULT_IMPORT, help="import-tdx-quotes.mjs 路径")
    ap.add_argument("--db-path", default=None, help="覆盖默认 DB 路径")
    ap.add_argument("--node", default="node", help="node 可执行文件路径")
    ap.add_argument("--no-import", action="store_true", help="仅导出，不灌库")
    ap.add_argument("--no-check", action="store_true", help="忽略交易日守卫（测试用）")
    args = ap.parse_args()

    types = ["stock", "fund", "index"] if args.types == "all" else [x.strip() for x in args.types.split(",") if x.strip()]
    db_path = args.db_path or os.environ.get("DB_PATH") or DEFAULT_DB

    today = datetime.date.today()
    if not args.no_check and not is_trading_day(today):
        print(f"SKIP {today.isoformat()} 非交易日，跳过行情同步")
        sys.exit(0)

    if not _HAS_PYTDX:
        print("ERROR 未安装 pytdx，无法抓取行情（pip install pytdx）", file=sys.stderr)
        sys.exit(2)

    universe = load_universe(db_path, types)
    if args.limit:
        universe = universe[: args.limit]
    print(f"universe: {len(universe)} 只（types={types}）")

    api = TdxHq_API()
    host = os.environ.get("TDX_HOST")
    port = os.environ.get("TDX_PORT")
    if host:
        try:
            port = int(port) if port else 7709
            if not api.connect(host, port, time_out=3.0):
                print(f"ERROR 直连 {host}:{port} 失败", file=sys.stderr)
                sys.exit(2)
        except Exception as e:
            print(f"ERROR 直连 {host}:{port} 异常: {e}", file=sys.stderr)
            sys.exit(2)
    else:
        ip = select_best_ip()
        if not api.connect(ip["ip"], int(ip["port"]), time_out=3.0):
            print("ERROR 无法连通达信行情服务器", file=sys.stderr)
            sys.exit(2)

    out_records = []
    flushed = 0
    BATCH = 300

    def _flush(records):
        if not records:
            return 0
        if args.no_import:
            return len(records)
        os.makedirs(os.path.dirname(args.out), exist_ok=True)
        tmp = args.out + ".batch.json"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(records, f, ensure_ascii=False)
        env = dict(os.environ)
        if args.db_path:
            env["DB_PATH"] = args.db_path
        r = subprocess.run([args.node, args.import_script, tmp], env=env, capture_output=True, text=True)
        sys.stdout.write(r.stdout)
        if r.stderr:
            sys.stderr.write(r.stderr)
        try:
            os.remove(tmp)
        except OSError:
            pass
        if r.returncode != 0:
            print("灌库失败，退出码", r.returncode, file=sys.stderr)
            sys.exit(r.returncode)
        return len(records)

    try:
        for idx, (code, sec_type) in enumerate(universe, 1):
            # 周期性重连，避免长时间会话被行情服务器断开导致后续全部跳过
            if idx > 1 and (idx - 1) % 500 == 0:
                try:
                    api.disconnect()
                except Exception:
                    pass
                if host:
                    api.connect(host, int(port) if port else 7709, time_out=3.0)
                else:
                    ip = select_best_ip()
                    api.connect(ip["ip"], int(ip["port"]), time_out=3.0)
            bars = fetch_bars(api, code, args.days, sec_type)
            if not bars:
                continue
            indicators = compute_indicators(bars)
            out_records.append({"code": str(code), "bars": bars, "indicators": indicators})
            if len(out_records) >= BATCH:
                flushed += _flush(out_records)
                print(f"  progress {idx}/{len(universe)} -> 已灌 {flushed} 只")
                out_records = []
    finally:
        api.disconnect()

    if out_records:
        flushed += _flush(out_records)
    print(f"导出+灌库完成: 共 {flushed} 只有行情")


if __name__ == "__main__":
    main()
