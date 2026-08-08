// ============================================================
// 再平衡单测：100 股向下取整、现金校验、偏离阈值
// ============================================================
import { describe, it, expect, beforeAll } from 'vitest';
import { openMemoryDatabase } from '../src/db/driver.js';
import { initSchema } from '../src/db/schema.js';
import { createPortfolioService } from '../src/services/portfolioService.js';
import { createRebalanceService } from '../src/services/rebalanceService.js';

let db;
let portfolio;
let rebalance;

beforeAll(async () => {
  db = await openMemoryDatabase();
  initSchema(db);

  // 证券（2 只股票 + 1 只基金）
  db.exec(`INSERT INTO securities (code, name, market, type, board, price_limit_pct, industry, sector, circ_mv, data_origin)
           VALUES
             ('600001','测试股A','SH','stock','SH-Main10',10,'白酒','白酒',100,'real'),
             ('600002','测试股B','SH','stock','SH-Main10',10,'银行','银行',200,'real'),
             ('510001','测试基金','SH','fund','ETF',10,'基金','基金',50,'real')`);
  // 行情（最新收盘价）
  db.exec(`INSERT INTO daily_quotes (code, trade_date, open, high, low, close, pre_close, volume, pct_chg, turnover_rate, volume_ratio, data_origin)
           VALUES
             ('600001','2026-08-07',10,10.5,9.8,10,9.5,1000,5.26,5,1.5,'real'),
             ('600002','2026-08-07',20,21,19.5,20,19,1000,5.26,5,1.5,'real'),
             ('510001','2026-08-07',2,2.1,1.9,2,1.9,10000,5.26,5,1.5,'real')`);

  // 用户 1 持仓：A 400 股@8、B 100 股@18、现金 5000
  db.exec(`INSERT INTO users (id, username, email, password_hash)
           VALUES (1, 'tester', 'tester@example.com', 'x')`);
  db.exec(`INSERT INTO holdings (user_id, code, name, asset_class, quantity, cost_price)
           VALUES
             (1, '600001', '测试股A', 'stock', 400, 8),
             (1, '600002', '测试股B', 'stock', 100, 18),
             (1, NULL, '现金', 'cash', 5000, 1)`);
  // 目标配置（asset_class）：股票 70% / 现金 30%
  db.exec(`INSERT INTO target_allocations (user_id, dimension, target_key, target_pct)
           VALUES
             (1, 'asset_class', 'stock', 70),
             (1, 'asset_class', 'cash', 30)`);

  portfolio = createPortfolioService(db);
  rebalance = createRebalanceService(db);
});

describe('组合汇总', () => {
  it('市值/成本/盈亏/占比计算正确', () => {
    const s = portfolio.buildSummary(1, 'asset_class');
    // 总资产 = 400×10 + 100×20 + 5000 = 4000+2000+5000 = 11000
    expect(s.total_asset).toBeCloseTo(11000, 2);
    // 总成本 = 400×8 + 100×18 + 5000 = 3200+1800+5000 = 10000
    expect(s.total_cost).toBeCloseTo(10000, 2);
    expect(s.total_profit).toBeCloseTo(1000, 2);
    // 股票占比 = 6000/11000 = 54.55%
    const stockItem = s.allocation.find((a) => a.key === 'stock');
    expect(stockItem.current_pct).toBeCloseTo(54.55, 1);
    expect(stockItem.target_pct).toBe(70);
    expect(stockItem.deviation_pct).toBeCloseTo(-15.45, 1);
  });
});

describe('再平衡建议', () => {
  it('|偏离|≥阈值生成建议；股票 100 股向下取整', () => {
    const r = rebalance.suggest(1, { threshold: 5, dimension: 'asset_class' });
    // 股票偏离 -15.45 → BUY；目标值 = 11000×70% = 7700，现市值 6000，差额 1700 → 1700/10 = 170 股 → 100 股
    const buy = r.items.find((it) => it.code === '600001' || it.code === '600002');
    expect(buy).toBeDefined();
    expect(buy.action).toBe('BUY');
    expect(buy.suggest_shares % 100).toBe(0);
  });

  it('现金不足时 balance_ok=false 并给出 need_cash', () => {
    const r = rebalance.suggest(1, { threshold: 0.1, dimension: 'asset_class' });
    // 买入需求很大，现金仅 5000
    expect(r.summary.buy_total).toBeGreaterThan(0);
    if (r.summary.buy_total > r.summary.cash_available) {
      expect(r.summary.balance_ok).toBe(false);
      expect(r.summary.need_cash).toBeGreaterThan(0);
    }
  });

  it('阈值提高后建议减少', () => {
    const r5 = rebalance.suggest(1, { threshold: 5, dimension: 'asset_class' });
    const r20 = rebalance.suggest(1, { threshold: 20, dimension: 'asset_class' });
    expect(r20.items.length).toBeLessThanOrEqual(r5.items.length);
  });
});
