// ============================================================
// 评分模型单测（M-03 / C-11 / 漏斗管线评分）
// ============================================================
import { describe, it, expect, beforeAll } from 'vitest';
import { openMemoryDatabase } from '../src/db/driver.js';
import { initSchema } from '../src/db/schema.js';
import { createScoreService } from '../src/services/scoreService.js';
import { roundShares } from '../src/util/money.js';

let db;
let scorer;

beforeAll(async () => {
  db = await openMemoryDatabase();
  initSchema(db);
  // 分位池：写入少量 money_flow + daily_quotes，让分位法可计算
  db.run(
    `INSERT INTO securities (code, name, market, type, board, price_limit_pct, industry, sector, circ_mv, data_origin)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ['000001', '测试股', 'SZ', 'stock', 'SZ-Main10', 10, '测试', '测试板块', 100, 'real'],
  );
  db.run(
    `INSERT INTO daily_quotes (code, trade_date, close, pre_close, volume, pct_chg, turnover_rate, volume_ratio, data_origin)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ['000001', '2026-08-07', 10, 9.8, 1000, 2.04, 5, 1.5, 'real'],
  );
  db.run(
    `INSERT INTO money_flow (code, trade_date, main_net_inflow, net_inflow_3d, net_inflow_5d, data_origin)
     VALUES (?, ?, ?, ?, ?, ?)`,
    ['000001', '2026-08-07', 1000, 3000, 5000, 'real'],
  );
  scorer = createScoreService(db);
});

describe('M-03 早盘通用评分', () => {
  it('量比高/竞价强/资金流入/有涨停/换手适中/板块热 → 高分', () => {
    const snap = {
      code: '000001', volume_ratio: 2.5, auction_pct: 4, auction_vol_ratio: 1.5,
      net_inflow_3d: 3000, turnover_rate: 8, sector: '测试板块',
      limit_today: { limit_up_streak: 2, open_times: 0 }, limit_recent_20d: true, limit_streak: 2,
    };
    const ctx = { sectorHeat: { '测试板块': { rank: 2, pct_chg: 3 } } };
    const r = scorer.scoreMorning(snap, ctx);
    expect(r.total).toBeGreaterThanOrEqual(60);
    expect(r.total).toBeLessThanOrEqual(100);
    expect(r.factors).toHaveLength(6);
    const wsum = r.factors.reduce((s, f) => s + f.weight, 0);
    expect(wsum).toBeCloseTo(1, 5);
    const f = r.factors[0];
    expect(Math.abs(f.contribution - f.score * f.weight)).toBeLessThan(0.01);
  });

  it('无涨停 → 连板因子 0 分', () => {
    const snap = { code: '000001', volume_ratio: 1, auction_pct: 1, auction_vol_ratio: 1, net_inflow_3d: 0, turnover_rate: 5 };
    const r = scorer.scoreMorning(snap, {});
    const lu = r.factors.find((f) => f.key === 'limit_up');
    expect(lu.score).toBe(0);
  });
});

describe('C-11 尾盘通用评分', () => {
  it('金叉/多头/温和量能/低估值 → 趋势与量能因子得分高', () => {
    const snap = {
      macd_gold_cross: 1, macd_positive: 1, ma_bullish: 1,
      rsi12: 55, kdj_k: 55, kdj_d: 50, kdj_j: 65,
      vol_ratio_5: 1.8, turnover_rate: 8, pe_ttm: 12, circ_mv: 200,
    };
    const r = scorer.scoreClosing(snap);
    expect(r.total).toBeGreaterThanOrEqual(50);
    expect(r.total).toBeLessThanOrEqual(100);
    const trend = r.factors.find((f) => f.key === 'trend');
    expect(trend.score).toBeGreaterThan(80);
    const wsum = r.factors.reduce((s, f) => s + f.weight, 0);
    expect(wsum).toBeCloseTo(1, 5);
  });

  it('死叉/空头 → 趋势因子低分', () => {
    const snap = { macd_dead_cross: 1, macd_positive: 0, ma_bearish: 1, rsi12: 30, kdj_j: -10, vol_ratio_5: 0.6, turnover_rate: 1, pe_ttm: 50, circ_mv: 3000 };
    const r = scorer.scoreClosing(snap);
    const trend = r.factors.find((f) => f.key === 'trend');
    expect(trend.score).toBeLessThan(30);
  });
});

describe('漏斗管线评分', () => {
  it('尾盘五步法：3日连量+涨幅4%+换手12.5%+多头+10%空间 → 高分', () => {
    const snap = {
      volume_streak: 3, pct_chg: 4, turnover_rate: 12.5,
      price: 100, ma5: 99, ma10: 98, ma20: 97, high_60d_distance_pct: 10,
    };
    const r = scorer.scoreClosingPipeline(snap);
    expect(r.total).toBeGreaterThanOrEqual(90);
  });

  it('尾盘五步法：数据缺失因子记 0 分并标注', () => {
    const snap = { volume_streak: null, pct_chg: null, turnover_rate: null, high_60d_distance_pct: null };
    const r = scorer.scoreClosingPipeline(snap);
    const f = r.factors.find((x) => x.key === 'volume_streak');
    expect(f.score).toBe(0);
    expect(f.note).toContain('数据缺失');
    expect(r.total).toBeLessThanOrEqual(20);
  });

  it('早盘七步法：量比高分位/竞价4%/爆量/有涨停 → 高分', () => {
    const snap = {
      volume_ratio: 3, auction_pct: 4, auction_vol_ratio: 2.5,
      limit_today: { limit_up_streak: 3 }, limit_streak: 3, first_trade_vol_ratio: 3,
    };
    const ctx = { mainlineTier: { '测试板块': 1 } };
    const r = scorer.scoreMorningPipeline(snap, ctx);
    expect(r.total).toBeGreaterThanOrEqual(70);
  });
});

describe('股数取整', () => {
  it('A股 100 股向下取整', () => {
    expect(roundShares(156, 'stock')).toBe(100);
    expect(roundShares(99, 'stock')).toBe(0);
    expect(roundShares(250, 'stock')).toBe(200);
  });
  it('场内基金按 100 份取整；场外基金保留 2 位', () => {
    expect(roundShares(12345, 'fund', true)).toBe(12300);
    expect(roundShares(123.456, 'fund', false)).toBeCloseTo(123.46, 2);
  });
  it('现金不取整', () => {
    expect(roundShares(12345.678, 'cash')).toBeCloseTo(12345.68, 2);
  });
  it('清仓可破整', () => {
    expect(roundShares(156, 'stock', false, true)).toBe(156);
  });
});
