// ============================================================
// P1 缺陷回归测试：同一 target_key 下多行持仓被重复套用完整类别目标
//
// 缺陷现象（修复前）：
//   持仓 = 茅台 100 股(≈140000) + 现金 50000 + 现金备用 30000，总资产 220000
//   目标 asset_class = stock 60% / cash 40%
//   现金类别实际占比 36.36%，偏离 -3.64pt（低于阈值 5，本不该出建议）
//   但旧实现逐行套用 cash 目标 40%：
//     现金备用行：220000×40% − 30000 = 58000  → BUY 58000
//     现金行    ：220000×40% − 50000 = 38000  → BUY 38000
//   合计 96000，而类别真实缺口只有 8000。
//
// 修复后口径：先按 target_key 分组算缺口，再按市值等比分摊到行。
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

/** 插入证券 + 当日行情 */
function insertSecurity(code, name, price, industry = '测试') {
  db.run(
    `INSERT INTO securities (code, name, market, type, board, price_limit_pct, industry, sector, circ_mv, data_origin)
     VALUES (?,?,'SH','stock','SH-Main10',10,?,?,200,'real')`,
    [code, name, industry, industry],
  );
  db.run(
    `INSERT INTO daily_quotes (code, trade_date, open, high, low, close, pre_close, volume, amount, pct_chg, turnover_rate, volume_ratio, data_origin)
     VALUES (?, '2026-08-07', ?, ?, ?, ?, ?, 1000, 10000, 5, 5, 1.5, 'real')`,
    [code, price, price * 1.01, price * 0.99, price, price / 1.05],
  );
}

function addHolding(uid, code, name, assetClass, quantity, costPrice) {
  db.run(
    `INSERT INTO holdings (user_id, code, name, asset_class, quantity, cost_price) VALUES (?,?,?,?,?,?)`,
    [uid, code, name, assetClass, quantity, costPrice],
  );
}

function addTargets(uid, dimension, pairs) {
  for (const [key, pct] of pairs) {
    db.run(
      `INSERT INTO target_allocations (user_id, dimension, target_key, target_pct) VALUES (?,?,?,?)`,
      [uid, dimension, key, pct],
    );
  }
}

beforeAll(async () => {
  db = await openMemoryDatabase();
  initSchema(db);
  portfolio = createPortfolioService(db);
  rebalance = createRebalanceService(db);
  users = createUserModel(db);

  // 茅台价格取 1400 → 100 股 = 140000
  insertSecurity('600519', '贵州茅台', 1400, '白酒');
  insertSecurity('600036', '招商银行', 40, '银行');
  insertSecurity('601398', '工商银行', 5, '银行');
});

// ------------------------------------------------------------
describe('G-1 多行同类别不再重复套用完整类别目标（主线复现场景）', () => {
  let uid;
  beforeAll(() => {
    uid = users.create({ username: 'g1_user', email: 'g1@example.com', password: 'password123' }).id;
    addHolding(uid, '600519', '贵州茅台', 'stock', 100, 1200); // 市值 140000
    addHolding(uid, null, '现金', 'cash', 50000, 1);
    addHolding(uid, null, '现金备用', 'cash', 30000, 1);
    addTargets(uid, 'asset_class', [['stock', 60], ['cash', 40]]);
  });

  it('分组占比正确：总资产 220000，现金类别 36.36%，偏离 -3.64pt', () => {
    const s = portfolio.buildSummary(uid, 'asset_class');
    expect(s.total_asset).toBeCloseTo(220000, 2);

    const cashAlloc = s.allocation.find((a) => a.key === 'cash');
    expect(cashAlloc.current_pct).toBeCloseTo(36.36, 1);
    expect(cashAlloc.target_pct).toBe(40);
    expect(cashAlloc.deviation_pct).toBeCloseTo(-3.64, 1);

    // 持仓行上的分组字段必须与 allocation 完全一致（同一口径）
    const cashRows = s.holdings.filter((h) => h.asset_class === 'cash');
    expect(cashRows).toHaveLength(2);
    for (const r of cashRows) {
      expect(r.group_current_pct).toBeCloseTo(36.36, 1);
      expect(r.group_deviation_pct).toBeCloseTo(-3.64, 1);
      expect(r.deviation_pct).toBe(r.group_deviation_pct); // deviation_pct 已是分组口径
    }
    // 行级占比仍各自保留（UI 明细表用）
    expect(cashRows.find((r) => r.name === '现金').current_pct).toBeCloseTo(22.73, 1);
    expect(cashRows.find((r) => r.name === '现金备用').current_pct).toBeCloseTo(13.64, 1);
  });

  it('threshold=5 时现金类别偏离 3.64 < 5 → 不产生任何建议（修复前会出 96000）', () => {
    const r = rebalance.suggest(uid, { threshold: 5, dimension: 'asset_class' });
    expect(r.items).toHaveLength(0);
    expect(r.summary.buy_total).toBe(0);
    expect(r.summary.sell_total).toBe(0);
  });

  it('threshold=1 时现金类别合计买入 = 分组缺口 8000，绝不接近 96000', () => {
    const r = rebalance.suggest(uid, { threshold: 1, dimension: 'asset_class' });
    const cashItems = r.items.filter((it) => it.unit === '元');

    // 分组缺口 = 220000×40% − 80000 = 8000
    const groupGap = 220000 * 0.4 - 80000;
    expect(groupGap).toBe(8000);

    const cashSum = cashItems.reduce((s, it) => s + it.suggest_amount, 0);
    expect(cashSum).toBeCloseTo(8000, 1);
    // 硬底线：合计不得超过分组缺口（允许 1 元浮点容差）
    expect(cashSum).toBeLessThanOrEqual(groupGap + 1);
    // 回归哨兵：修复前的 58000 / 38000 / 96000 必须彻底消失
    expect(cashSum).toBeLessThan(96000);
    for (const it of cashItems) {
      expect(it.suggest_amount).not.toBeCloseTo(58000, 0);
      expect(it.suggest_amount).not.toBeCloseTo(38000, 0);
      expect(it.suggest_amount).toBeLessThanOrEqual(groupGap + 1);
    }

    // 按市值等比分摊：现金 50000 → 5000，现金备用 30000 → 3000
    expect(cashItems.find((it) => it.name === '现金').suggest_amount).toBeCloseTo(5000, 1);
    expect(cashItems.find((it) => it.name === '现金备用').suggest_amount).toBeCloseTo(3000, 1);
  });
});

// ------------------------------------------------------------
describe('G-2 分组偏离低于阈值不产生建议', () => {
  it('两行股票同属 stock，分组偏离 0.5pt < threshold 5 → items 为空', () => {
    const uid = users.create({ username: 'g2_user', email: 'g2@example.com', password: 'password123' }).id;
    // 招商 1000 股 ×40 = 40000，工行 2000 股 ×5 = 10000 → stock 合计 50000
    addHolding(uid, '600036', '招商银行', 'stock', 1000, 35);
    addHolding(uid, '601398', '工商银行', 'stock', 2000, 4);
    addHolding(uid, null, '现金', 'cash', 50000, 1);
    // 总资产 100000 → stock 50%，cash 50%；目标 stock 50.5 / cash 49.5 → 偏离 ∓0.5pt
    addTargets(uid, 'asset_class', [['stock', 50.5], ['cash', 49.5]]);

    const s = portfolio.buildSummary(uid, 'asset_class');
    expect(s.total_asset).toBeCloseTo(100000, 2);
    expect(s.allocation.find((a) => a.key === 'stock').deviation_pct).toBeCloseTo(-0.5, 2);

    const r = rebalance.suggest(uid, { threshold: 5, dimension: 'asset_class' });
    expect(r.items).toHaveLength(0);
    expect(r.summary.buy_total).toBe(0);
    expect(r.summary.sell_total).toBe(0);
    expect(r.summary.balance_ok).toBe(true);

    // 逐行口径下招商单行 40% vs 目标 50.5% 会被误判为 -10.5pt 超阈值 —— 修复后不再发生
    const cmb = s.holdings.find((h) => h.code === '600036');
    expect(cmb.current_pct).toBeCloseTo(40, 1);       // 行级占比保留
    expect(cmb.row_deviation_pct).toBeCloseTo(-10.5, 1); // 行级偏离仅作参考
    expect(cmb.deviation_pct).toBeCloseTo(-0.5, 2);   // 判定用的是分组偏离
  });
});

// ------------------------------------------------------------
describe('G-3 SELL 按市值等比分摊', () => {
  it('同类别两行股票超配 → 两条 SELL，比例与市值成正比且各自不超过持仓', () => {
    const uid = users.create({ username: 'g3_user', email: 'g3@example.com', password: 'password123' }).id;
    // 招商 2000 股 ×40 = 80000，工行 4000 股 ×5 = 20000 → stock 100000
    addHolding(uid, '600036', '招商银行', 'stock', 2000, 35);
    addHolding(uid, '601398', '工商银行', 'stock', 4000, 4);
    addHolding(uid, null, '现金', 'cash', 100000, 1);
    // 总资产 200000 → stock 50%；目标 stock 20% / cash 80% → 偏离 +30pt，需卖出
    addTargets(uid, 'asset_class', [['stock', 20], ['cash', 80]]);

    const r = rebalance.suggest(uid, { threshold: 5, dimension: 'asset_class' });
    const sells = r.items.filter((it) => it.action === 'SELL' && it.code);
    expect(sells).toHaveLength(2);

    // 分组缺口 = 200000×20% − 100000 = -60000 → 卖出 60000
    // 分摊：招商 80000/100000×60000 = 48000 → 1200 股；工行 20000/100000×60000 = 12000 → 2400 股
    const cmb = sells.find((it) => it.code === '600036');
    const icbc = sells.find((it) => it.code === '601398');
    expect(cmb.suggest_shares).toBe(1200);
    expect(cmb.suggest_amount).toBeCloseTo(48000, 2);
    expect(icbc.suggest_shares).toBe(2400);
    expect(icbc.suggest_amount).toBeCloseTo(12000, 2);

    // 比例与市值成正比：80000/20000 = 4 → 48000/12000 = 4
    expect(cmb.suggest_amount / icbc.suggest_amount).toBeCloseTo(4, 2);

    // 各自不超过持仓市值
    expect(cmb.suggest_amount).toBeLessThanOrEqual(80000);
    expect(icbc.suggest_amount).toBeLessThanOrEqual(20000);
    expect(cmb.suggest_shares).toBeLessThanOrEqual(2000);
    expect(icbc.suggest_shares).toBeLessThanOrEqual(4000);

    // 合计不超过分组缺口
    const sellSum = sells.reduce((s, it) => s + it.suggest_amount, 0);
    expect(sellSum).toBeLessThanOrEqual(60000 + 1);
  });

  it('清仓场景：分摊额覆盖整行市值时允许破整手，且严格不超过持仓', () => {
    const uid = users.create({ username: 'g3b_user', email: 'g3b@example.com', password: 'password123' }).id;
    // 故意用非整手的 137 股，验证清仓时可以破 100 股整手
    addHolding(uid, '600036', '招商银行', 'stock', 137, 35); // 137×40 = 5480
    addHolding(uid, null, '现金', 'cash', 1000, 1);
    // 总资产 6480，stock 84.57%；目标 stock 0% / cash 100% → 需要整体清仓
    addTargets(uid, 'asset_class', [['stock', 0], ['cash', 100]]);

    const r = rebalance.suggest(uid, { threshold: 5, dimension: 'asset_class' });
    const sell = r.items.find((it) => it.code === '600036');
    expect(sell).toBeDefined();
    expect(sell.action).toBe('SELL');
    // 分组缺口 = 6480×0% − 5480 = −5480，整行被覆盖 → 破整手清仓 137 股
    expect(sell.suggest_shares).toBe(137);
    expect(sell.suggest_amount).toBeCloseTo(5480, 2);
    // 硬底线：不得超过持仓
    expect(sell.suggest_shares).toBeLessThanOrEqual(137);
    expect(sell.suggest_amount).toBeLessThanOrEqual(5480);
  });

  it('非清仓的部分卖出仍按 100 股向下取整（不足 1 手则跳过）', () => {
    const uid = users.create({ username: 'g3c_user', email: 'g3c@example.com', password: 'password123' }).id;
    addHolding(uid, '600036', '招商银行', 'stock', 100, 35); // 4000
    addHolding(uid, null, '现金', 'cash', 1000, 1);
    // 总资产 5000；目标 stock 0.1% / cash 99.9% → 需卖 3995 元 = 99.875 股
    // 未覆盖整行市值（4000）→ 不触发破整手 → 向下取整为 0 手 → 跳过（与修复前一致）
    addTargets(uid, 'asset_class', [['stock', 0.1], ['cash', 99.9]]);

    const r = rebalance.suggest(uid, { threshold: 5, dimension: 'asset_class' });
    expect(r.items.find((it) => it.code === '600036')).toBeUndefined();
    // 但现金侧的类别缺口建议依然给出，且不超过类别缺口
    const cashBuy = r.items.find((it) => it.unit === '元');
    expect(cashBuy).toBeDefined();
    expect(cashBuy.action).toBe('BUY');
    expect(cashBuy.suggest_amount).toBeLessThanOrEqual(5000 * 0.999 - 1000 + 1);
  });
});

// ------------------------------------------------------------
describe('G-4 dimension=code 行为不回归（一 key 一行，分组退化为单行）', () => {
  it('code 维度下每行独立成组，结果与修复前一致', () => {
    const uid = users.create({ username: 'g4_user', email: 'g4@example.com', password: 'password123' }).id;
    addHolding(uid, '600036', '招商银行', 'stock', 100, 35); // 4000
    addHolding(uid, '601398', '工商银行', 'stock', 1000, 4); // 5000
    addHolding(uid, null, '现金', 'cash', 1000, 1);
    // 总资产 10000；code 维度目标：招商 60% / 工行 39% / cash 1%
    addTargets(uid, 'code', [['600036', 60], ['601398', 39], ['cash', 1]]);

    const s = portfolio.buildSummary(uid, 'code');
    // code 维度下一行一组 → 分组占比 === 行级占比
    for (const h of s.holdings) {
      if (h.target_key == null) continue;
      expect(h.group_current_pct).toBeCloseTo(h.current_pct, 2);
      expect(h.deviation_pct).toBeCloseTo(h.row_deviation_pct, 2);
    }

    const r = rebalance.suggest(uid, { threshold: 5, dimension: 'code' });
    // 招商：当前 40%，目标 60% → 偏离 -20pt → BUY (10000×60% − 4000) = 2000 → 2000/40 = 50 股 → 向下取整 0 手 → 跳过
    // 工行：当前 50%，目标 39% → 偏离 +11pt → SELL (10000×39% − 5000) = -1100 → 1100/5 = 220 股 → 200 股 = 1000
    const icbc = r.items.find((it) => it.code === '601398');
    expect(icbc).toBeDefined();
    expect(icbc.action).toBe('SELL');
    expect(icbc.suggest_shares).toBe(200);
    expect(icbc.suggest_amount).toBeCloseTo(1000, 2);

    // 招商不足 1 手被跳过（与修复前一致）
    expect(r.items.find((it) => it.code === '600036')).toBeUndefined();

    // ★ R3-#1 修复后行为变更（本断言原先固化了缺陷行为，已按守恒律更新）：
    // 旧：targetKeyOf 的 code 分支直接返回 h.code，现金行 code 为 NULL → target_key=null
    //     → 现金被踢出所有分组（分组市值合计 9000 ≠ 总资产 10000，钱凭空消失），
    //       用户配的 cash 1% 目标被静默忽略。
    // 新：code 维度与 industry 分支一致，现金兜底成 'cash' 键 → 正常参与分组与再平衡。
    //     现金 1000/10000 = 10% vs 目标 1% → 偏离 +9pt ≥ 5 → SELL (10000×1% − 1000) = −900
    const cashItem = r.items.find((it) => it.unit === '元');
    expect(cashItem).toBeDefined();
    expect(cashItem.target_key).toBe('cash');
    expect(cashItem.action).toBe('SELL');
    expect(cashItem.suggest_amount).toBeCloseTo(900, 2);

    // 守恒律：allocation 分组市值合计 === 总资产（现金不得再进黑洞）
    const allocSum = s.allocation.reduce((acc, a) => acc + a.market_value, 0);
    expect(allocSum).toBeCloseTo(s.total_asset, 2);
    expect(s.holdings.find((h) => h.asset_class === 'cash').target_key).toBe('cash');
  });

  it('code 维度单行标的：分组缺口 === 行级缺口', () => {
    const uid = users.create({ username: 'g4b_user', email: 'g4b@example.com', password: 'password123' }).id;
    addHolding(uid, '600036', '招商银行', 'stock', 100, 35); // 4000
    addHolding(uid, '601398', '工商银行', 'stock', 200, 4);  // 1000
    addTargets(uid, 'code', [['600036', 20], ['601398', 80]]);

    const r = rebalance.suggest(uid, { threshold: 5, dimension: 'code' });
    for (const it of r.items) {
      // 一行一组 → 行级分摊额必须等于分组缺口
      expect(Math.abs(it.diff_value)).toBeCloseTo(Math.abs(it.group_diff_value), 2);
      expect(it.group_current_pct).toBeCloseTo(it.current_pct, 2);
    }
  });
});

// ------------------------------------------------------------
// G-6 R3-#3：code 维度下「目标已配置但尚未建仓」的标的应给出可执行建仓建议
// 修复前输出 {action:'BUY', code:null, name:'601398 类别整体', suggest_shares:0, unit:'元'}
// —— code 维度的 target_key 本身就是证券代码，退化成「类别整体」会让前端无法跳转、
//    用户也拿不到可下单的股数。
// ------------------------------------------------------------
describe('G-6 code 维度未持有标的的建仓建议（R3-#3）', () => {
  it('回填 code、文案改「建仓」、按现价折算整手股数', () => {
    const uid = users.create({ username: 'g6_user', email: 'g6@example.com', password: 'password123' }).id;
    addHolding(uid, '600036', '招商银行', 'stock', 2000, 35); // 80000
    addHolding(uid, null, '现金', 'cash', 20000, 1);          // 20000 → 总资产 100000
    addTargets(uid, 'code', [['600036', 40], ['601398', 60]]); // 工行一股未持有

    const s = portfolio.buildSummary(uid, 'code');
    // 守恒律：幻影空分组（601398 市值 0）不影响合计，现金已入 'cash' 组
    const allocSum = s.allocation.reduce((acc, a) => acc + a.market_value, 0);
    expect(allocSum).toBeCloseTo(s.total_asset, 2);
    expect(s.allocation.find((a) => a.key === 'cash').market_value).toBeCloseTo(20000, 2);
    expect(s.allocation.find((a) => a.key === '601398').market_value).toBe(0);

    const r = rebalance.suggest(uid, { threshold: 5, dimension: 'code' });
    const icbc = r.items.find((it) => it.target_key === '601398');
    expect(icbc).toBeDefined();
    expect(icbc.action).toBe('BUY');
    // ★ 核心：code 必须回填成 target_key 本身，前端才能跳转详情页
    expect(icbc.code).toBe('601398');
    expect(icbc.name).toContain('建仓');
    expect(icbc.name).not.toContain('类别整体');
    expect(icbc.is_group_level).toBe(true);
    expect(icbc.is_new_position).toBe(true);
    // 缺口 100000×60% − 0 = 60000，现价 5 元 → 12000 股（100 股整手）
    expect(icbc.unit).toBe('股');
    expect(icbc.suggest_shares).toBe(12000);
    expect(icbc.suggest_shares % 100).toBe(0);
    expect(icbc.suggest_amount).toBeCloseTo(60000, 2);
    expect(icbc.suggest_amount).toBeCloseTo(icbc.suggest_shares * 5, 2);

    // 招商超配 40pt → SELL 40000（1000 股），资金校验用证券侧口径
    const cmb = r.items.find((it) => it.code === '600036');
    expect(cmb.action).toBe('SELL');
    expect(cmb.suggest_amount).toBeCloseTo(40000, 2);
    // 买证券 60000，手上现金 20000 + 卖出回款 40000 = 60000 → 刚好平衡
    expect(r.summary.balance_ok).toBe(true);
    expect(r.summary.need_cash).toBeCloseTo(40000, 2); // 卖出未到账前仍需 4 万头寸
  });

  it('缺口不足 1 手时退回金额口径，但仍回填 code 与建仓文案', () => {
    const uid = users.create({ username: 'g6b_user', email: 'g6b@example.com', password: 'password123' }).id;
    addHolding(uid, '600036', '招商银行', 'stock', 250, 35); // 10000 → 总资产 10000
    addTargets(uid, 'code', [['600036', 90], ['600519', 10]]); // 茅台 1400 元/股，一手 140000

    const r = rebalance.suggest(uid, { threshold: 5, dimension: 'code' });
    const mt = r.items.find((it) => it.target_key === '600519');
    expect(mt).toBeDefined();
    // 缺口仅 1000 元 < 一手 140000 → 无法给出整手股数，退回金额口径
    expect(mt.suggest_shares).toBe(0);
    expect(mt.unit).toBe('元');
    expect(mt.suggest_amount).toBeCloseTo(1000, 2);
    // 但 code 与文案仍然回填，前端可跳转、用户知道该建仓哪只
    expect(mt.code).toBe('600519');
    expect(mt.name).toContain('建仓');
    expect(mt.is_group_level).toBe(true);
  });

  it('asset_class 维度的零持仓类别不受影响，仍为 code=null 的「类别整体」', () => {
    const uid = users.create({ username: 'g6c_user', email: 'g6c@example.com', password: 'password123' }).id;
    addHolding(uid, '600036', '招商银行', 'stock', 2000, 35); // 80000
    addHolding(uid, null, '现金', 'cash', 20000, 1);
    addTargets(uid, 'asset_class', [['stock', 60], ['cash', 20], ['bond', 20]]);

    const r = rebalance.suggest(uid, { threshold: 5, dimension: 'asset_class' });
    const bond = r.items.find((it) => it.target_key === 'bond');
    expect(bond.code).toBeNull();
    expect(bond.name).toBe('bond 类别整体');
    expect(bond.is_new_position).toBeUndefined();
    expect(bond.unit).toBe('元');
  });
});

// ------------------------------------------------------------
describe('G-5 取整后合计对账', () => {
  it('A 股建议股数均为 100 整数倍，且 suggest_amount = shares × price', () => {
    const uid = users.create({ username: 'g5_user', email: 'g5@example.com', password: 'password123' }).id;
    // 招商 40 元、工行 5 元，制造除不尽的分摊额
    addHolding(uid, '600036', '招商银行', 'stock', 337, 35); // 13480
    addHolding(uid, '601398', '工商银行', 'stock', 723, 4);  // 3615
    addHolding(uid, null, '现金', 'cash', 12345, 1);
    addTargets(uid, 'asset_class', [['stock', 85], ['cash', 15]]);

    const r = rebalance.suggest(uid, { threshold: 1, dimension: 'asset_class' });
    const priceMap = { 600036: 40, 601398: 5 };

    for (const it of r.items) {
      if (it.unit === '元') continue; // 现金行不取整
      expect(it.suggest_shares % 100).toBe(0);          // A股 100 股整数倍
      expect(it.suggest_shares).toBeGreaterThan(0);
      // suggest_amount 必须由取整后股数回算
      expect(it.suggest_amount).toBeCloseTo(it.suggest_shares * priceMap[it.code], 2);
    }

    // summary 对账：planned_* 为分摊前分组缺口，residual = planned − 实际
    expect(r.summary.rounding_residual_buy).toBeCloseTo(
      round2p(r.summary.planned_buy_total - r.summary.buy_total), 2,
    );
    expect(r.summary.rounding_residual_sell).toBeCloseTo(
      round2p(r.summary.planned_sell_total - r.summary.sell_total), 2,
    );
    // 取整只会让实际额 ≤ 计划额（向下取整），残差非负
    expect(r.summary.rounding_residual_buy).toBeGreaterThanOrEqual(-0.01);
    expect(r.summary.rounding_residual_sell).toBeGreaterThanOrEqual(-0.01);
  });

  it('分组缺口与各行分摊额之和一致（分摊不丢钱、不造钱）', () => {
    const uid = users.create({ username: 'g5b_user', email: 'g5b@example.com', password: 'password123' }).id;
    addHolding(uid, '600036', '招商银行', 'stock', 500, 35); // 20000
    addHolding(uid, '601398', '工商银行', 'stock', 2000, 4); // 10000
    addHolding(uid, null, '现金A', 'cash', 40000, 1);
    addHolding(uid, null, '现金B', 'cash', 30000, 1);
    addTargets(uid, 'asset_class', [['stock', 60], ['cash', 40]]);

    const r = rebalance.suggest(uid, { threshold: 1, dimension: 'asset_class' });
    // 按 target_key 汇总各行 diff_value，应等于该组 group_diff_value
    const byKey = new Map();
    for (const it of r.items) {
      const cur = byKey.get(it.target_key) || { sum: 0, group: it.group_diff_value };
      cur.sum += it.diff_value;
      byKey.set(it.target_key, cur);
    }
    for (const [, v] of byKey) {
      expect(v.sum).toBeCloseTo(v.group, 1);
    }
  });
});

/** 测试内部用的 2 位舍入（与 util/money.js round2 同规则） */
function round2p(v) {
  return Math.round((Number(v) + Number.EPSILON) * 100) / 100;
}
