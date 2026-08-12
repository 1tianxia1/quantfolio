// ============================================================
// T05 质量关卡 A：不穿越未来（no-lookahead）
//
// 用真实库 + 包装 db 拦截所有 all/get 的 (sql, params) 做 SQL 级断言，
// 并对返回的 trades 做行为级 + 次日收益交叉验证。
//
// 设计意图（共享知识规则 #1：AS-OF-T 等值查询）：
//   - 点查快照（AS-OF-T 当日的 daily_quotes/tech_indicators/money_flow/auction_data）
//     必须等值 trade_date = T，绝不能用 trade_date <= T 或 MAX(trade_date)（取最新日）。
//   - 次日收益取 T 在「区间内交易日历」中的真实下一交易日，无 T+1 不计入。
//
// 注意：引擎对 getCalendar（交易日历枚举）与 nextRet 预取使用了
//   `trade_date BETWEEN ? AND ?` 的【范围查询】。这属于正常的区间过滤/预取，
//   并非未来泄漏（数据仍被严格限制在请求区间内，nextDayMap 也只映射到区间内下一交易日），
//   因此本测试对这类 BETWEEN 范围查询豁免 `= ?` 等值要求，但同样禁止 `<=` / `MAX(trade_date)`。
// ============================================================
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { openDatabase } from '../src/db/driver.js';
import { createBacktestService } from '../src/services/backtestService.js';

// 关闭回测落库，避免污染真实库（真实库尚未建 backtests 表，且我们仅做只读验证）
process.env.BACKTEST_PERSIST = 'false';

// 小区间，含全局最后交易日附近；末日无 T+1 必须被排除
const RANGE = ['2026-08-05', '2026-08-10'];

// 参与快照/次日收益的核心表
const CORE_TABLES = ['daily_quotes', 'tech_indicators', 'money_flow', 'auction_data'];

let db;

beforeAll(async () => {
  db = await openDatabase(path.resolve('data/quantfolio.db'));
});

afterAll(() => {
  if (db) db.close();
});

describe('不穿越未来（no-lookahead）', () => {
  let recorded = [];
  let wrapped;
  let result;
  let calendar;

  beforeAll(async () => {
    // 包装真实 db：拦截所有 all/get 调用并记录 (sql, params)
    const rec = [];
    recorded = rec;
    wrapped = new Proxy(db, {
      get(t, prop) {
        if (prop === 'all' || prop === 'get') {
          return (sql, params) => {
            rec.push({ sql, params });
            return t[prop](sql, params);
          };
        }
        return t[prop];
      },
    });

    const svc = createBacktestService(wrapped);
    result = svc.run({ model: 'closing', range: RANGE, topN: 20 });

    // 独立计算区间内升序交易日历（与引擎 buildSnapshots 的 nextDayMap 等价）
    calendar = db
      .all(
        `SELECT DISTINCT trade_date FROM daily_quotes WHERE trade_date BETWEEN ? AND ? ORDER BY trade_date`,
        RANGE,
      )
      .map((r) => r.trade_date);
  }, 30000);

  it('SQL 级：核心表查询无未来泄漏（无 trade_date<= 与 MAX(trade_date)；点查快照为等值）', () => {
    const sqls = recorded
      .map((r) => r.sql)
      .filter((sql) => CORE_TABLES.some((t) => sql.includes(t)));

    // 必须捕获到涉及核心表的查询，否则断言是空跑
    expect(sqls.length).toBeGreaterThan(0);

    for (const sql of sqls) {
      const compact = sql.toLowerCase().replace(/\s+/g, '');
      // 真正的未来泄漏模式
      expect(compact).not.toContain('trade_date<=');
      expect(compact).not.toContain('max(trade_date)');

      // 点查类快照（非 BETWEEN 范围枚举/预取）必须是等值 trade_date = ?
      const isRangeQuery = /\btrade_date\s+between\b/i.test(sql);
      if (!isRangeQuery) {
        expect(/\btrade_date\s*=\s*\?/.test(sql)).toBe(true);
      }
    }
  }, 30000);

  it('行为级：区间内最后交易日无 T+1，trades 中绝不出现 tradeDate === 2026-08-10', () => {
    // 区间内最后交易日即 2026-08-10（与任务设定一致）
    expect(calendar[calendar.length - 1]).toBe('2026-08-10');

    const onLast = result.trades.filter((t) => t.tradeDate === '2026-08-10');
    expect(onLast).toHaveLength(0);

    // 更一般地：任何 trade 的 tradeDate 都不等于区间内最后交易日（不臆造收益）
    const lastInRange = calendar[calendar.length - 1];
    expect(result.trades.every((t) => t.tradeDate !== lastInRange)).toBe(true);
  }, 30000);

  it('次日收益正确性：≥5 笔 trade 的 nextRet == 该 code 在真实下一交易日 pct_chg', () => {
    // 区间内升序日历 → nextTradingDay 映射（与引擎 nextDayMap 一致）
    const nextMap = new Map();
    for (let i = 0; i < calendar.length - 1; i++) {
      nextMap.set(calendar[i], calendar[i + 1]);
    }

    // 随机抽取 ≥5 笔不同 (code, tradeDate) 的 trade
    const pool = [...result.trades];
    const picks = [];
    const seen = new Set();
    while (picks.length < 8 && pool.length) {
      const idx = Math.floor(Math.random() * pool.length);
      const tr = pool.splice(idx, 1)[0];
      const key = `${tr.code}|${tr.tradeDate}`;
      if (seen.has(key)) continue;
      seen.add(key);
      picks.push(tr);
    }
    expect(picks.length).toBeGreaterThanOrEqual(5);

    for (const tr of picks) {
      const nextDay = nextMap.get(tr.tradeDate);
      // 入选的 trade 必有真实 T+1（否则 nextRet==null 已被过滤）
      expect(nextDay).toBeTruthy();

      const rows = db.all(
        'SELECT pct_chg FROM daily_quotes WHERE code=? AND trade_date=?',
        [tr.code, nextDay],
      );
      expect(rows.length).toBe(1);
      // nextRet 必须等于该 code 在真实下一交易日的 pct_chg（证明取的是真实 T+1，而非未来任意日）
      expect(Number(rows[0].pct_chg)).toBeCloseTo(Number(tr.nextRet), 6);
    }
  }, 30000);
});
