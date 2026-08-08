#!/usr/bin/env python3
# ============================================================
# tradingday.py — 严格交易日判断（A 股）
#
# 规则：交易日 = 周一~周五 且 不在法定休市区间内。
# 周末(Sat/Sun)直接由 weekday 判定；此处仅列"非周末"的法定休市区间。
#
# 数据来源：沪深北交易所 2025-12-22 公布的《2026 年部分节假日休市安排》。
# ⚠️ 每年需更新：2027 年起请把新的休市区间补进 HOLIDAY_RANGES 列表。
# ============================================================
import datetime

# 2026 年 A 股非周末休市区间（含起止，ISO 格式）
HOLIDAY_RANGES_2026 = [
    ("2026-01-01", "2026-01-03"),   # 元旦
    ("2026-02-15", "2026-02-23"),   # 春节
    ("2026-04-04", "2026-04-06"),   # 清明
    ("2026-05-01", "2026-05-05"),   # 劳动节
    ("2026-06-19", "2026-06-21"),   # 端午
    ("2026-09-25", "2026-09-27"),   # 中秋
    ("2026-10-01", "2026-10-07"),   # 国庆
]

# 后续年份在此追加，例如：
# HOLIDAY_RANGES_2027 = [ ("2027-01-01","2027-01-03"), ... ]
ALL_RANGES = HOLIDAY_RANGES_2026


def _parse(s):
    return datetime.date.fromisoformat(s)


def is_trading_day(d=None):
    """返回指定日期(默认今天)是否为 A 股交易日。"""
    d = d or datetime.date.today()
    if d.weekday() >= 5:  # 5=Sat, 6=Sun
        return False
    for start, end in ALL_RANGES:
        if _parse(start) <= d <= _parse(end):
            return False
    return True


if __name__ == "__main__":
    print("today", datetime.date.today().isoformat(), "trading_day =", is_trading_day())
