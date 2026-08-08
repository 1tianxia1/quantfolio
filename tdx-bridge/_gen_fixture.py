#!/usr/bin/env python3
# 离线 fixture 生成：用 quote_sync.compute_indicators 计算真实结构，
# 输出 scripts/_tdx_import/quotes_fixture.json，供 import-tdx-quotes.mjs 验证。
import os, sys, json, math
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from quote_sync import compute_indicators

def gen_bars(code, n, start=18.0, drift=0.03, vol=0.6):
    """确定性正弦+漂移行情，便于复现。"""
    bars = []
    price = start
    for i in range(n):
        # 用确定性相位，避免随机
        wave = math.sin(i / 6.0) * vol
        close = round(price * (1 + drift + wave * 0.01), 2)
        op = round(close * (1 - 0.005), 2)
        hi = round(max(close, op) * 1.012, 2)
        lo = round(min(close, op) * 0.988, 2)
        volume = int(1_000_000 + (i % 5) * 200_000 + (1 if i % 3 == 0 else 0) * 500_000)
        amount = int(volume * close)
        # 交易日历：跳过周末，做 70 个交易日的日期
        d = 1 + i
        month = ((d - 1) // 21) % 12 + 1
        day = ((d - 1) % 21) + 1
        date = f"2024-{month:02d}-{day:02d}"
        bars.append({
            "date": date, "open": op, "high": hi, "low": lo, "close": close,
            "volume": volume, "amount": amount,
        })
        price = close
    return bars

codes = ["600519", "000001"]
records = []
for code in codes:
    bars = gen_bars(code, 70)
    indicators = compute_indicators(bars)
    assert len(indicators) == len(bars), f"{code} 指标长度不对齐"
    records.append({"code": code, "bars": bars, "indicators": indicators})

out = os.path.normpath(os.path.join(HERE, "..", "scripts", "_tdx_import", "quotes_fixture.json"))
os.makedirs(os.path.dirname(out), exist_ok=True)
with open(out, "w", encoding="utf-8") as f:
    json.dump(records, f, ensure_ascii=False)

# 打印抽样校验
rec0 = records[0]
print(f"写出 {len(records)} 只证券 -> {out}")
print(f"  600519: {len(rec0['bars'])} 根 K 线, {len(rec0['indicators'])} 条指标")
ind_last = rec0["indicators"][-1]
print(f"  末根指标抽样: ma5={ind_last['ma5']:.3f} ma20={ind_last['ma20']:.3f} "
      f"macd_bar={ind_last['macd_bar']:.4f} rsi6={ind_last['rsi6']} "
      f"kdj_k={ind_last['kdj_k']:.2f} ma_bullish={ind_last['ma_bullish']} "
      f"indicator_hit={ind_last['indicator_hit']}")
