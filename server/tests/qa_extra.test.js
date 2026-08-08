// ============================================================
// QA 补充测试（严过关/Yan 独立编写）
// 覆盖：
//   1) 尾盘五步法边界值：涨幅恰好 3%/5%、换手恰好 20%、流通盘恰好 50/500亿、
//      连续放量恰好 3 天（>= 下限 / <= 上限均通过；越界淘汰）
//   2) 早盘七步法宽松模式开关（mv_lt10 严格 <10亿 vs 宽松 <30亿）
//   3) 再平衡 100 股向下取整（精确数值断言）+ 现金不足 balance_ok=false
//   4) 用户数据隔离：用户 A / B / 游客 demo 的 holdings 互不可见
// ============================================================
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { openMemoryDatabase } from '../src/db/driver.js';
import { initSchema } from '../src/db/schema.js';
import { createPipelineService } from '../src/services/pipelineService.js';
import { createPortfolioService } from '../src/services/portfolioService.js';
import { createRebalanceService } from '../src/services/rebalanceService.js';
import { createUserModel } from '../src/models/userModel.js';

let db;
let pipeline;
let portfolio;
let rebalance;
let users;

/** 完整插入一个标的（行情/指标/竞价/资金流），各字段可覆盖 */
function insertSecurity(code, name, opts = {}) {
  const price = opts.price ?? 10;
  const pctChg = opts.pctChg ?? 4;
  const turnover = opts.turnover ?? 12;
  const mv = opts.mv ?? 200;
  const volRatio = opts.volRatio ?? 2;
  const streak = opts.streak ?? 3;
  const space = opts.space ?? 10;
  const auctionPct = opts.auctionPct ?? 4;
  const auctionVolRatio = opts.auctionVolRatio ?? 1.5;
  const firstTrade = opts.firstTrade ?? 2.5;
  const sector = opts.sector ?? 'AI芯片';
  const maBullish = opts.maBullish ?? 1;

  db.run(
    `INSERT INTO securities (code, name, market, type, board, price_limit_pct, industry, sector, circ_mv, data_origin)
     VALUES (?,?,?, 'stock', 'SZ-Main10', 10, '测试', ?, ?, 'real')`,
    [code, name, 'SZ', sector, mv],
  );
  db.run(
    `INSERT INTO daily_quotes (code, trade_date, open, high, low, close, pre_close, volume, amount, pct_chg, turnover_rate, volume_ratio, data_origin)
     VALUES (?, '2026-08-07', ?, ?, ?, ?, ?, 1000, 10000, ?, ?, ?, 'real')`,
    [code, price * 1.02, price * 1.03, price * 0.98, price, price / 1.04, pctChg, turnover, volRatio],
  );
  const ma5 = maBullish ? price - 0.2 : price + 0.2;
  const ma10 = maBullish ? price - 0.4 : price + 0.1;
  const ma20 = maBullish ? price - 0.6 : price - 0.1;
  const ma60 = maBullish ? price - 0.8 : price - 0.3;
  db.run(
    `INSERT INTO tech_indicators (
       code, trade_date, ma5, ma10, ma20, ma60, macd_dif, macd_dea, macd_bar,
       rsi6, rsi12, rsi24, kdj_k, kdj_d, kdj_j, vol_ma5, vol_ratio_5,
       volume_streak, high_60d_distance_pct, macd_gold_cross, macd_dead_cross, macd_positive,
       macd_hist_turn_positive, kdj_gold_cross, kdj_dead_cross, ma_bullish, ma_bearish,
       ma_above_20, ma_cross_above_5, indicator_hit, data_origin
     ) VALUES (?, '2026-08-07', ?, ?, ?, ?, 0.5, 0.3, 0.4, 55, 55, 55, 50, 50, 50,
       800, 1.8, ?, ?, 1, 0, 1, 0, 0, 0, ?, 0, 1, 0, '[]', 'derived')`,
    [code, ma5, ma10, ma20, ma60, streak, space, maBullish],
  );
  db.run(
    `INSERT INTO auction_data (code, trade_date, auction_price, auction_pct, auction_volume, auction_amount, auction_vol_ratio, first_trade_vol_ratio, data_origin)
     VALUES (?, '2026-08-07', ?, ?, 100, 1000, ?, ?, 'derived')`,
    [code, price * (1 + auctionPct / 100), auctionPct, auctionVolRatio, firstTrade],
  );
  db.run(
    `INSERT INTO money_flow (code, trade_date, main_net_inflow, net_inflow_3d, net_inflow_5d, data_origin)
     VALUES (?, '2026-08-07', 1000, 3000, 5000, 'real')`,
    [code],
  );
}

/** 清空行情类表（按 FK 依赖顺序），保证各边界用例池独立 */
function clearMarketTables() {
  db.exec('DELETE FROM limit_records');
  db.exec('DELETE FROM auction_data');
  db.exec('DELETE FROM money_flow');
  db.exec('DELETE FROM tech_indicators');
  db.exec('DELETE FROM daily_quotes');
  db.exec('DELETE FROM security_tags');
  db.exec('DELETE FROM securities');
}

const CLOSING_DEFAULT_STEPS = [
  { id: 'pct3_5', enabled: true, params: { min: 3, max: 5 } },
  { id: 'turnover5_20', enabled: true, params: { min: 5, max: 20 } },
  { id: 'mv50_500', enabled: true, params: { min: 50, max: 500 } },
  { id: 'vol_streak', enabled: true, params: { minStreak: 3, maxStreak: 5 } },
  { id: 'ma_bullish', enabled: true, params: { minSpace: 8 } },
];

/** 只启用指定步骤（其余禁用），用单一标的验证某一步的边界 */
function runClosingStepOnly(stepId) {
  const steps = CLOSING_DEFAULT_STEPS.map((s) => ({ ...s, enabled: s.id === stepId }));
  const r = pipeline.runPipeline({ type: 'closing', steps });
  // 禁用步骤也在 funnel 中（survivors 不变），按 step_id 取目标步骤
  return { r, step: r.funnel.find((f) => f.step_id === stepId) };
}

beforeAll(async () => {
  db = await openMemoryDatabase();
  initSchema(db);
  pipeline = createPipelineService(db);
  portfolio = createPortfolioService(db);
  rebalance = createRebalanceService(db);
  users = createUserModel(db);
});

describe('QA-1 尾盘五步法边界值（精确阈值）', () => {
  beforeEach(() => clearMarketTables());

  it('涨幅恰好 3% 通过第 1 步；2.99% 淘汰', () => {
    insertSecurity('B001', '涨幅下界', { pctChg: 3.0, turnover: 12, mv: 200, streak: 3, space: 10 });
    insertSecurity('B002', '涨幅微低', { pctChg: 2.99, turnover: 12, mv: 200, streak: 3, space: 10 });
    const { step } = runClosingStepOnly('pct3_5');
    expect(step.survivors).toBe(1);
    expect(step.top_reasons.some((t) => t.reason.includes('涨幅不足'))).toBe(true);
  });

  it('涨幅恰好 5% 通过；5.01% 淘汰', () => {
    insertSecurity('B003', '涨幅上界', { pctChg: 5.0, turnover: 12, mv: 200, streak: 3, space: 10 });
    insertSecurity('B004', '涨幅微高', { pctChg: 5.01, turnover: 12, mv: 200, streak: 3, space: 10 });
    const { step } = runClosingStepOnly('pct3_5');
    expect(step.survivors).toBe(1);
    expect(step.top_reasons.some((t) => t.reason.includes('涨幅超'))).toBe(true);
  });

  it('换手恰好 20% 通过第 2 步；20.01% 淘汰', () => {
    insertSecurity('B005', '换手上界', { pctChg: 4, turnover: 20.0, mv: 200, streak: 3, space: 10 });
    insertSecurity('B006', '换手微高', { pctChg: 4, turnover: 20.01, mv: 200, streak: 3, space: 10 });
    const { step } = runClosingStepOnly('turnover5_20');
    expect(step.survivors).toBe(1);
    expect(step.top_reasons.some((t) => t.reason.includes('换手超'))).toBe(true);
  });

  it('流通盘恰好 500亿 通过第 3 步；500.01亿 淘汰', () => {
    insertSecurity('B007', '市值上界', { pctChg: 4, turnover: 12, mv: 500, streak: 3, space: 10 });
    insertSecurity('B008', '市值微高', { pctChg: 4, turnover: 12, mv: 500.01, streak: 3, space: 10 });
    const { step } = runClosingStepOnly('mv50_500');
    expect(step.survivors).toBe(1);
    expect(step.top_reasons.some((t) => t.reason.includes('市值超'))).toBe(true);
  });

  it('流通盘恰好 50亿 通过；49.99亿 淘汰', () => {
    insertSecurity('B009', '市值下界', { pctChg: 4, turnover: 12, mv: 50, streak: 3, space: 10 });
    insertSecurity('B010', '市值微低', { pctChg: 4, turnover: 12, mv: 49.99, streak: 3, space: 10 });
    const { step } = runClosingStepOnly('mv50_500');
    expect(step.survivors).toBe(1);
    expect(step.top_reasons.some((t) => t.reason.includes('市值不足'))).toBe(true);
  });

  it('连续放量恰好 3 天通过第 4 步；2 天淘汰；6 天（超上限）淘汰', () => {
    insertSecurity('B011', '放量3日', { pctChg: 4, turnover: 12, mv: 200, streak: 3, space: 10 });
    insertSecurity('B012', '放量2日', { pctChg: 4, turnover: 12, mv: 200, streak: 2, space: 10 });
    insertSecurity('B013', '放量6日', { pctChg: 4, turnover: 12, mv: 200, streak: 6, space: 10 });
    const { step } = runClosingStepOnly('vol_streak');
    expect(step.survivors).toBe(1);
    expect(step.top_reasons.some((t) => t.reason.includes('放量不足'))).toBe(true);
    expect(step.top_reasons.some((t) => t.reason.includes('放量超'))).toBe(true);
  });
});

describe('QA-2 早盘七步法宽松模式开关', () => {
  beforeEach(() => clearMarketTables());

  it('严格模式 mv_lt10 用 <10亿；宽松模式用 <30亿（looseMax）', () => {
    insertSecurity('M001', '中盘15亿', { mv: 15, auctionPct: 4, volRatio: 2, streak: 3, space: 10, sector: 'AI芯片' });
    insertSecurity('M002', '大盘40亿', { mv: 40, auctionPct: 4, volRatio: 2, streak: 3, space: 10, sector: 'AI芯片' });

    const steps = [
      { id: 'auction_top60', enabled: true, params: { topN: 60 } },
      { id: 'vol_ratio_top30', enabled: true, params: { topN: 30, min: 1.5 } },
      { id: 'auction3_5', enabled: true, params: { min: 3, max: 5 } },
      { id: 'mv_lt10', enabled: true, params: { max: 10, looseMax: 30 } },
      { id: 'ma_bullish60', enabled: false, params: { minSpace: 8 } },
      { id: 'hot_sector', enabled: false, params: { sectors: ['AI芯片'] } },
      { id: 'first_trade_vol', enabled: false, params: { min: 2 } },
    ];
    const strict = pipeline.runPipeline({ type: 'morning', steps, loose_mode: false });
    const loose = pipeline.runPipeline({ type: 'morning', steps, loose_mode: true });
    expect(strict.funnel[3].survivors).toBe(0); // 15亿、40亿均 >= 10 → 全淘汰
    expect(loose.funnel[3].survivors).toBe(1);  // 15亿 < 30 → 通过；40亿淘汰
  });

  it('用户设置 morning_loose_mode 持久化到 user_settings（按路由契约 0/1）', () => {
    const uid = users.create({ username: 'loose_user', email: 'loose@example.com', password: 'password123' }).id;
    portfolio.saveSettings(uid, { morning_loose_mode: 1 });
    expect(portfolio.getSettings(uid).morning_loose_mode).toBe(1);
    portfolio.saveSettings(uid, { morning_loose_mode: 0 });
    expect(portfolio.getSettings(uid).morning_loose_mode).toBe(0);
  });
});

describe('QA-3 再平衡 100 股向下取整 + 现金校验', () => {
  function insertStockPrice(code, name, price) {
    db.run(
      `INSERT INTO securities (code, name, market, type, board, price_limit_pct, industry, sector, circ_mv, data_origin)
       VALUES (?,?,'SH','stock','SH-Main10',10,'测试','测试',200,'real')`,
      [code, name],
    );
    db.run(
      `INSERT INTO daily_quotes (code, trade_date, open, high, low, close, pre_close, volume, amount, pct_chg, turnover_rate, volume_ratio, data_origin)
       VALUES (?, '2026-08-07', ?, ?, ?, ?, ?, 1000, 10000, 5, 5, 1.5, 'real')`,
      [code, price, price * 1.01, price * 0.99, price, price / 1.05],
    );
  }

  it('建议股数为 100 的整数倍且向下取整（非四舍五入）', () => {
    insertStockPrice('600999', '取整股', 10);
    const uid = users.create({ username: 'rb_user', email: 'rb@example.com', password: 'password123' }).id;
    db.run(`INSERT INTO holdings (user_id, code, name, asset_class, quantity, cost_price) VALUES (?, '600999', '取整股', 'stock', 100, 8)`, [uid]);
    db.run(`INSERT INTO holdings (user_id, code, name, asset_class, quantity, cost_price) VALUES (?, NULL, '现金', 'cash', 5000, 1)`, [uid]);
    db.run(`INSERT INTO target_allocations (user_id, dimension, target_key, target_pct) VALUES (?, 'asset_class', 'stock', 80), (?, 'asset_class', 'cash', 20)`, [uid, uid]);

    const r = rebalance.suggest(uid, { threshold: 1, dimension: 'asset_class' });
    // 总资产 6000；股票目标 4800，现 1000 → BUY 3800/10=380 股 → 向下取整 300 股
    const stock = r.items.find((it) => it.code === '600999');
    expect(stock).toBeDefined();
    expect(stock.action).toBe('BUY');
    expect(stock.suggest_shares).toBe(300);
    expect(stock.suggest_shares % 100).toBe(0);
    // 现金目标 1200，现 5000 → SELL 3800
    const cash = r.items.find((it) => it.unit === '元');
    expect(cash).toBeDefined();
    expect(cash.action).toBe('SELL');
    expect(r.summary.balance_ok).toBe(true);
  });

  it('现金不足时 balance_ok=false 且 need_cash>0', () => {
    insertStockPrice('600001', '重仓A', 10);
    insertStockPrice('600002', '轻仓B', 10);
    const uid = users.create({ username: 'rb2_user', email: 'rb2@example.com', password: 'password123' }).id;
    db.run(`INSERT INTO holdings (user_id, code, name, asset_class, quantity, cost_price) VALUES (?, '600001', '重仓A', 'stock', 100, 10)`, [uid]);
    db.run(`INSERT INTO holdings (user_id, code, name, asset_class, quantity, cost_price) VALUES (?, '600002', '轻仓B', 'stock', 100, 10)`, [uid]);
    db.run(`INSERT INTO holdings (user_id, code, name, asset_class, quantity, cost_price) VALUES (?, NULL, '现金', 'cash', 100, 1)`, [uid]);
    // code 维度目标：A 99.9% / B 0.05% / cash 0.05%（Σ=100）
    db.run(
      `INSERT INTO target_allocations (user_id, dimension, target_key, target_pct) VALUES
         (?, 'code', '600001', 99.9), (?, 'code', '600002', 0.05), (?, 'code', 'cash', 0.05)`,
      [uid, uid, uid],
    );
    const r = rebalance.suggest(uid, { threshold: 1, dimension: 'code' });
    // A 目标 2098 → BUY 1098/10=109 股 → 100 股 = 1000 元；B 卖出 99 股不足 1 手跳过；现金卖出 1.05
    const buy = r.items.find((it) => it.action === 'BUY');
    expect(buy).toBeDefined();
    expect(buy.suggest_shares).toBe(100);
    // buy 1000 > sell(≈1.05) + cash(100) → 不足
    expect(r.summary.buy_total).toBeGreaterThan(0);
    expect(r.summary.balance_ok).toBe(false);
    expect(r.summary.need_cash).toBeGreaterThan(0);
  });
});

describe('QA-4 用户数据隔离', () => {
  it('用户 A / B / 游客 demo 的 holdings 互不可见', () => {
    const uidA = users.create({ username: 'user_a', email: 'a@example.com', password: 'password123' }).id;
    const uidB = users.create({ username: 'user_b', email: 'b@example.com', password: 'password123' }).id;
    db.run(
      `INSERT INTO holdings (user_id, code, name, asset_class, quantity, cost_price)
       VALUES (NULL, '600001', '演示股', 'stock', 100, 10)`,
    );
    portfolio.addHolding(uidA, { code: '600002', name: 'A股', asset_class: 'stock', quantity: 100, cost_price: 10 });
    portfolio.addHolding(uidB, { code: '600002', name: 'B股', asset_class: 'stock', quantity: 200, cost_price: 20 });

    const a = portfolio.listHoldings(uidA).holdings;
    const b = portfolio.listHoldings(uidB).holdings;
    const demo = portfolio.listHoldings(null).holdings;

    expect(a.every((h) => h.name === 'A股')).toBe(true);
    expect(b.every((h) => h.name === 'B股')).toBe(true);
    expect(demo.every((h) => h.name === '演示股')).toBe(true);
    expect(a.some((h) => h.name === 'B股')).toBe(false);
    expect(a.some((h) => h.name === '演示股')).toBe(false);
    expect(b.some((h) => h.name === 'A股')).toBe(false);
    expect(b.some((h) => h.name === '演示股')).toBe(false);
    expect(demo.some((h) => h.name === 'A股')).toBe(false);
    expect(demo.some((h) => h.name === 'B股')).toBe(false);
  });

  it('用户 A 修改持仓不影响用户 B；B 无法越权修改 A 的持仓', () => {
    const uidA = users.create({ username: 'user_a2', email: 'a2@example.com', password: 'password123' }).id;
    const uidB = users.create({ username: 'user_b2', email: 'b2@example.com', password: 'password123' }).id;
    const hA = portfolio.addHolding(uidA, { code: '600002', name: 'A股2', asset_class: 'stock', quantity: 100, cost_price: 10 });
    const hB = portfolio.addHolding(uidB, { code: '600002', name: 'B股2', asset_class: 'stock', quantity: 300, cost_price: 30 });
    portfolio.updateHolding(uidA, hA.id, { name: 'A股改', quantity: 500, cost_price: 12, asset_class: 'stock' });
    expect(portfolio.listHoldings(uidA).holdings.find((h) => h.id === hA.id).quantity).toBe(500);
    expect(portfolio.listHoldings(uidB).holdings.find((h) => h.id === hB.id).quantity).toBe(300);
    expect(() => portfolio.updateHolding(uidB, hA.id, { name: '越权', quantity: 1, cost_price: 1, asset_class: 'stock' }))
      .toThrow();
  });
});
