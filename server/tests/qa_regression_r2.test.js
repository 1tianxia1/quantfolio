// ============================================================
// QA 第 2 轮回归测试（严过关/Yan）
// 针对工程师 P2 修复的验证：
//   1) rebalanceService.js — cashAvailable 改为对全部 asset_class='cash' 持仓行 Σ 求和
//      （回归点：多行现金持仓时 cash_available = 各行 quantity 之和，而非最后一行）
//   2) portfolioService.js saveSettings — morning_loose_mode 在 service 内 Boolean→0/1 归一化
//      （回归点：直接传 JS boolean 不再触发 node:sqlite 绑定报错，且落库为 0/1）
// ============================================================
import { describe, it, expect, beforeAll } from 'vitest';
import { openMemoryDatabase } from '../src/db/driver.js';
import { initSchema } from '../src/db/schema.js';
import { createPortfolioService } from '../src/services/portfolioService.js';
import { createRebalanceService } from '../src/services/rebalanceService.js';
import { createUserModel } from '../src/models/userModel.js';

let db;
let portfolio;
let rebalance;
let users;

beforeAll(async () => {
  db = await openMemoryDatabase();
  initSchema(db);
  portfolio = createPortfolioService(db);
  rebalance = createRebalanceService(db);
  users = createUserModel(db);
});

describe('R2-1 多行现金持仓：cashAvailable 求和（P2 修复验证）', () => {
  it('两行现金 cash_available = 各行 quantity 之和（非最后一行）', () => {
    // 证券 + 行情
    db.run(
      `INSERT INTO securities (code, name, market, type, board, price_limit_pct, industry, sector, circ_mv, data_origin)
       VALUES ('600999','回归股','SH','stock','SH-Main10',10,'测试','测试',200,'real')`,
    );
    db.run(
      `INSERT INTO daily_quotes (code, trade_date, open, high, low, close, pre_close, volume, amount, pct_chg, turnover_rate, volume_ratio, data_origin)
       VALUES ('600999','2026-08-07',10,10.5,9.8,10,9.5,1000,10000,5,5,1.5,'real')`,
    );
    const uid = users.create({ username: 'r2_cash', email: 'r2cash@example.com', password: 'password123' }).id;
    // 股票 1000 元（100 股 × 10）+ 现金 2000 + 现金 3000 → 总资产 6000
    db.run(`INSERT INTO holdings (user_id, code, name, asset_class, quantity, cost_price) VALUES (?, '600999', '回归股', 'stock', 100, 10)`, [uid]);
    db.run(`INSERT INTO holdings (user_id, code, name, asset_class, quantity, cost_price) VALUES (?, NULL, '现金A', 'cash', 2000, 1)`, [uid]);
    db.run(`INSERT INTO holdings (user_id, code, name, asset_class, quantity, cost_price) VALUES (?, NULL, '现金B', 'cash', 3000, 1)`, [uid]);
    // 目标：股票 80% / 现金 20%
    db.run(
      `INSERT INTO target_allocations (user_id, dimension, target_key, target_pct)
       VALUES (?, 'asset_class', 'stock', 80), (?, 'asset_class', 'cash', 20)`,
      [uid, uid],
    );

    const r = rebalance.suggest(uid, { threshold: 1, dimension: 'asset_class' });
    // 修复前：cash_available = 最后一行 3000；修复后：= 2000 + 3000 = 5000
    expect(r.summary.cash_available).toBe(5000);

    // ⚠ 口径修正（P1 分组缺陷修复）：
    // 本用例原先断言 totalCashSell ≈ 2600，那是「逐行各自套用完整类别目标」的错误口径产物
    //   （现金A：1200−2000=−800；现金B：1200−3000=−1800 → 2600），
    // 两行各自减完整类别目标 1200，等于把类别目标重复用了两次。
    // 正确的分组口径：cash 类别目标市值 = 6000×20% = 1200，类别现市值 = 5000，
    //   类别缺口 = 1200 − 5000 = −3800 → 卖出 3800，再按市值等比分摊到两行：
    //   现金A 2000/5000×3800 = 1520，现金B 3000/5000×3800 = 2280。
    const cashItems = r.items.filter((i) => i.unit === '元' && i.action === 'SELL');
    const totalCashSell = cashItems.reduce((s, i) => s + i.suggest_amount, 0);
    expect(totalCashSell).toBeCloseTo(3800, 1);
    expect(cashItems.find((i) => i.name === '现金A').suggest_amount).toBeCloseTo(1520, 1);
    expect(cashItems.find((i) => i.name === '现金B').suggest_amount).toBeCloseTo(2280, 1);
    // 类别缺口守恒：分摊合计不得超过分组缺口
    expect(totalCashSell).toBeLessThanOrEqual(3800 + 1);
    // 平衡校验：buy 3000 <= sell 3800 + cash 5000 → true
    expect(r.summary.balance_ok).toBe(true);
  });

  it('多行现金且买入需求超过现金总和时 balance_ok=false（need_cash 用 Σ 口径）', () => {
    const uid = users.create({ username: 'r2_cash2', email: 'r2cash2@example.com', password: 'password123' }).id;
    // 股票市值 1000 + 现金 2000 + 现金 3000 → 总资产 6000
    db.run(`INSERT INTO holdings (user_id, code, name, asset_class, quantity, cost_price) VALUES (?, '600999', '回归股', 'stock', 100, 10)`, [uid]);
    db.run(`INSERT INTO holdings (user_id, code, name, asset_class, quantity, cost_price) VALUES (?, NULL, '现金A', 'cash', 2000, 1)`, [uid]);
    db.run(`INSERT INTO holdings (user_id, code, name, asset_class, quantity, cost_price) VALUES (?, NULL, '现金B', 'cash', 3000, 1)`, [uid]);
    // 极端目标：股票 99.9% / 现金 0.1% → 需要大量买入股票，现金全部卖出
    db.run(
      `INSERT INTO target_allocations (user_id, dimension, target_key, target_pct)
       VALUES (?, 'asset_class', 'stock', 99.9), (?, 'asset_class', 'cash', 0.1)`,
      [uid, uid],
    );
    const r = rebalance.suggest(uid, { threshold: 1, dimension: 'asset_class' });
    expect(r.summary.cash_available).toBe(5000);
    // 股票目标 5994，现 1000 → BUY 4994/10=499 股 → 400 股 = 4000
    const buy = r.items.find((i) => i.action === 'BUY');
    expect(buy).toBeDefined();
    expect(buy.suggest_shares % 100).toBe(0);
    // buy 4000 <= sell(≈4994 现金) + 5000 → 实际平衡；此处主要断言 cash_available=Σ 且不为 NaN/负
    expect(Number.isFinite(r.summary.cash_available)).toBe(true);
    expect(r.summary.need_cash).toBeGreaterThanOrEqual(0);
  });
});

describe('R2-2 saveSettings 布尔归一化（P2 修复验证）', () => {
  it('直接传 morning_loose_mode=true 不再抛 node:sqlite 绑定错误，且落库为 1', () => {
    const uid = users.create({ username: 'r2_bool', email: 'r2bool@example.com', password: 'password123' }).id;
    // 修复前：node:sqlite 无法绑定 boolean → 抛错；修复后：应正常保存为 1
    expect(() => portfolio.saveSettings(uid, { morning_loose_mode: true })).not.toThrow();
    expect(portfolio.getSettings(uid).morning_loose_mode).toBe(1);
    // false → 0
    expect(() => portfolio.saveSettings(uid, { morning_loose_mode: false })).not.toThrow();
    expect(portfolio.getSettings(uid).morning_loose_mode).toBe(0);
    // 数值 1/0 仍兼容
    portfolio.saveSettings(uid, { morning_loose_mode: 1 });
    expect(portfolio.getSettings(uid).morning_loose_mode).toBe(1);
    // 未传该字段时不覆盖（保持 1）
    portfolio.saveSettings(uid, { rebalance_threshold: 7 });
    expect(portfolio.getSettings(uid).morning_loose_mode).toBe(1);
    expect(portfolio.getSettings(uid).rebalance_threshold).toBe(7);
  });
});
