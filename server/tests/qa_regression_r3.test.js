// ============================================================
// QA 第 3 轮回归测试（严过关 / Yan）—— P1「分组目标当单行目标用」修复的独立验证
//
// 覆盖工程师自测未触及的角度：
//   R3-1  dimension='industry' 多行聚合（targetKeyOf 的另一条分支，工程师主测 asset_class）
//   R3-2  三行及以上同类别的等比分摊精度与残差对账
//   R3-3  某 target_key 有目标但完全无持仓行（bond）→ group_level 建议且不崩
//   R3-4  矛盾场景：类别整体需 SELL，但组内小市值行按「行级口径」会被判成 BUY
//         → 断言同一 target_key 下 action 唯一，绝不自相矛盾
//   R3-5  target_pct 合计非 100 的报错行为 + 绕过校验后的健壮性
//   R3-6  跨维度目标污染（QA R3 新发现，见 QA_REPORT §六·C）
//
// 设计原则：断言写「PRD/DESIGN 认为正确的行为」，不迁就实现。
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

/** 插入证券 + 当日行情（close = price，保证估值可预测） */
function insertSecurity(code, name, price, industry) {
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

/** 绕过 service 层 Σ=100 校验，直接落库目标（用于健壮性测试） */
function addTargets(uid, dimension, pairs) {
  for (const [key, pct] of pairs) {
    db.run(
      `INSERT INTO target_allocations (user_id, dimension, target_key, target_pct) VALUES (?,?,?,?)`,
      [uid, dimension, key, pct],
    );
  }
}

function newUser(tag) {
  return users.create({ username: `r3_${tag}`, email: `r3_${tag}@example.com`, password: 'password123' }).id;
}

/** 按 target_key 归拢 items，返回 key → {actions:Set, amount, diffSum} */
function groupItems(items) {
  const m = new Map();
  for (const it of items) {
    const g = m.get(it.target_key) || { actions: new Set(), amount: 0, diffSum: 0, rows: [] };
    g.actions.add(it.action);
    g.amount += it.suggest_amount;
    g.diffSum += it.diff_value;
    g.rows.push(it);
    m.set(it.target_key, g);
  }
  return m;
}

beforeAll(async () => {
  db = await openMemoryDatabase();
  initSchema(db);
  portfolio = createPortfolioService(db);
  rebalance = createRebalanceService(db);
  users = createUserModel(db);

  insertSecurity('600036', '招商银行', 40, '银行');
  insertSecurity('601398', '工商银行', 5, '银行');
  insertSecurity('600519', '贵州茅台', 1400, '白酒');
  insertSecurity('600888', '无行业股', 25, null); // industry 为 NULL → 应归入「其他」
});

// ------------------------------------------------------------
// R3-1 industry 维度多行聚合
// 工程师主要验证了 asset_class；industry 走 targetKeyOf 的另一条分支
// （h.industry || (cash ? '现金' : '其他')），必须单独回归。
// ------------------------------------------------------------
describe('R3-1 dimension=industry 多行聚合（targetKeyOf 的另一条分支）', () => {
  let uid;
  let summary;

  beforeAll(() => {
    uid = newUser('industry');
    addHolding(uid, '600036', '招商银行', 'stock', 1000, 35); // 银行 40000
    addHolding(uid, '601398', '工商银行', 'stock', 4000, 4);  // 银行 20000
    addHolding(uid, '600519', '贵州茅台', 'stock', 20, 1200); // 白酒 28000
    addHolding(uid, null, '现金', 'cash', 12000, 1);          // 现金 12000
    // 总资产 100000 → 银行 60% / 白酒 28% / 现金 12%
    addTargets(uid, 'industry', [['银行', 50], ['白酒', 30], ['现金', 20]]);
    summary = portfolio.buildSummary(uid, 'industry');
  });

  it('industry 分组占比按类别聚合，不是逐行占比', () => {
    expect(summary.total_asset).toBeCloseTo(100000, 2);
    expect(summary.active_dimension).toBe('industry');

    const bank = summary.allocation.find((a) => a.key === '银行');
    const baijiu = summary.allocation.find((a) => a.key === '白酒');
    const cash = summary.allocation.find((a) => a.key === '现金');

    expect(bank.current_pct).toBeCloseTo(60, 2);   // 40000 + 20000
    expect(bank.market_value).toBeCloseTo(60000, 2);
    expect(bank.deviation_pct).toBeCloseTo(10, 2);
    expect(baijiu.current_pct).toBeCloseTo(28, 2);
    expect(baijiu.deviation_pct).toBeCloseTo(-2, 2);
    // 现金行没有 industry 字段 → targetKeyOf 兜底成 '现金'
    expect(cash.current_pct).toBeCloseTo(12, 2);
    expect(cash.deviation_pct).toBeCloseTo(-8, 2);
  });

  it('★ 回归哨兵：银行两行的行级偏离与分组偏离方向相反，判定必须用分组口径', () => {
    const cmb = summary.holdings.find((h) => h.code === '600036');
    const icbc = summary.holdings.find((h) => h.code === '601398');

    // 行级：招商 40% vs 类别目标 50% → -10pt（旧口径会误判成「买入」）
    expect(cmb.current_pct).toBeCloseTo(40, 2);
    expect(cmb.row_deviation_pct).toBeCloseTo(-10, 2);
    // 分组：银行类别 60% vs 50% → +10pt（正确口径是「卖出」）—— 符号相反
    expect(cmb.group_current_pct).toBeCloseTo(60, 2);
    expect(cmb.group_deviation_pct).toBeCloseTo(10, 2);
    expect(cmb.deviation_pct).toBe(cmb.group_deviation_pct);
    expect(Math.sign(cmb.row_deviation_pct)).not.toBe(Math.sign(cmb.deviation_pct));

    // 工行同组，两行的分组字段必须完全相同
    expect(icbc.group_current_pct).toBe(cmb.group_current_pct);
    expect(icbc.group_deviation_pct).toBe(cmb.group_deviation_pct);
    expect(icbc.target_key).toBe('银行');
    expect(cmb.target_key).toBe('银行');
  });

  it('industry 维度再平衡：银行类别缺口 10000 按市值等比分摊，白酒未超阈值不出建议', () => {
    const r = rebalance.suggest(uid, { threshold: 5, dimension: 'industry' });

    // 白酒偏离 -2pt < 5 → 无任何建议（旧口径下茅台单行 28% vs 30% 也会被单独判定）
    expect(r.items.some((it) => it.target_key === '白酒')).toBe(false);

    const bankItems = r.items.filter((it) => it.target_key === '银行');
    expect(bankItems).toHaveLength(2);
    for (const it of bankItems) expect(it.action).toBe('SELL');

    // 类别缺口 = 100000×50% − 60000 = −10000
    // 招商 40000/60000×10000 = 6666.67 → 166.67 股 → 100 股 = 4000
    // 工行 20000/60000×10000 = 3333.33 → 666.67 股 → 600 股 = 3000
    const cmb = bankItems.find((it) => it.code === '600036');
    const icbc = bankItems.find((it) => it.code === '601398');
    expect(cmb.group_diff_value).toBeCloseTo(-10000, 2);
    expect(cmb.suggest_shares).toBe(100);
    expect(cmb.suggest_amount).toBeCloseTo(4000, 2);
    expect(icbc.suggest_shares).toBe(600);
    expect(icbc.suggest_amount).toBeCloseTo(3000, 2);
    // 分摊前缺口之和 = 分组缺口（不丢钱不造钱）
    expect(cmb.diff_value + icbc.diff_value).toBeCloseTo(-10000, 1);

    // 现金类别 -8pt → BUY 8000（单行，全额）
    const cashItem = r.items.find((it) => it.target_key === '现金');
    expect(cashItem.action).toBe('BUY');
    expect(cashItem.suggest_amount).toBeCloseTo(8000, 2);
    expect(cashItem.unit).toBe('元');

    // 任意一条建议都不得超过其所属类别的缺口
    for (const it of r.items) {
      expect(Math.abs(it.suggest_amount)).toBeLessThanOrEqual(Math.abs(it.group_diff_value) + 1);
    }
  });

  it('industry 为 NULL 的股票归入「其他」分组，不会污染已有类别', () => {
    const uid2 = newUser('industry_null');
    addHolding(uid2, '600888', '无行业股', 'stock', 400, 20); // 25×400 = 10000
    addHolding(uid2, '600036', '招商银行', 'stock', 250, 35); // 银行 10000
    addTargets(uid2, 'industry', [['银行', 50], ['其他', 50]]);

    const s = portfolio.buildSummary(uid2, 'industry');
    const other = s.allocation.find((a) => a.key === '其他');
    expect(other).toBeDefined();
    expect(other.market_value).toBeCloseTo(10000, 2);
    expect(s.holdings.find((h) => h.code === '600888').target_key).toBe('其他');
    expect(s.allocation.find((a) => a.key === '银行').market_value).toBeCloseTo(10000, 2);
  });
});

// ------------------------------------------------------------
// R3-2 三行及以上同类别的分摊精度
// ------------------------------------------------------------
describe('R3-2 三行以上同类别等比分摊精度与残差对账', () => {
  let uid;
  let r;
  // 招商 834×40 = 33360；现金 33333 + 22222 + 11113 = 66668；总资产 100028
  const CASH_TOTAL = 66668;
  const TOTAL = 100028;
  const CASH_GAP = CASH_TOTAL - TOTAL * 0.4; // 26656.8

  beforeAll(() => {
    uid = newUser('split3');
    addHolding(uid, '600036', '招商银行', 'stock', 834, 35);
    addHolding(uid, null, '现金A', 'cash', 33333, 1);
    addHolding(uid, null, '现金B', 'cash', 22222, 1);
    addHolding(uid, null, '现金C', 'cash', 11113, 1);
    addTargets(uid, 'asset_class', [['stock', 60], ['cash', 40]]);
    r = rebalance.suggest(uid, { threshold: 1, dimension: 'asset_class' });
  });

  it('三行现金各自按市值权重分摊，合计等于类别缺口（残差 ≤ 0.05 元）', () => {
    const cashItems = r.items.filter((it) => it.target_key === 'cash');
    expect(cashItems).toHaveLength(3);
    for (const it of cashItems) expect(it.action).toBe('SELL');

    const sum = cashItems.reduce((s, it) => s + it.suggest_amount, 0);
    expect(CASH_GAP).toBeCloseTo(26656.8, 4);
    // 现金不做整手取整 → 分摊残差只应来自 round2，三行合计误差 ≤ 0.05
    expect(sum).toBeCloseTo(CASH_GAP, 1);
    expect(Math.abs(sum - CASH_GAP)).toBeLessThanOrEqual(0.05);

    // 每行金额 / 市值 的比值必须一致（等比分摊的定义）
    const ratios = cashItems.map((it) => {
      const mv = { 现金A: 33333, 现金B: 22222, 现金C: 11113 }[it.name];
      return it.suggest_amount / mv;
    });
    for (const ratio of ratios) expect(ratio).toBeCloseTo(CASH_GAP / CASH_TOTAL, 5);

    // SELL 封顶：任一行不得卖超自己的市值
    for (const it of cashItems) {
      const mv = { 现金A: 33333, 现金B: 22222, 现金C: 11113 }[it.name];
      expect(it.suggest_amount).toBeLessThanOrEqual(mv);
    }
  });

  it('整手取整残差非负且小于一手金额，summary 对账自洽', () => {
    const s = r.summary;
    // 卖出侧全是现金 → 几乎无残差
    expect(Math.abs(s.rounding_residual_sell)).toBeLessThanOrEqual(0.05);
    expect(s.planned_sell_total).toBeCloseTo(CASH_GAP, 1);

    // 买入侧是股票：26656.8 → 666.42 股 → 向下取整 600 股 = 24000，残差 2656.8
    expect(s.planned_buy_total).toBeCloseTo(26656.8, 1);
    expect(s.buy_total).toBeCloseTo(24000, 2);
    expect(s.rounding_residual_buy).toBeGreaterThanOrEqual(0);
    expect(s.rounding_residual_buy).toBeLessThan(100 * 40); // < 一手金额
    expect(s.rounding_residual_buy).toBeCloseTo(s.planned_buy_total - s.buy_total, 2);
    expect(s.rounding_residual_sell).toBeCloseTo(s.planned_sell_total - s.sell_total, 2);
  });
});

// ------------------------------------------------------------
// R3-3 目标里有 bond 但一股没买
// ------------------------------------------------------------
describe('R3-3 target_key 有目标但完全无持仓行 → group_level 建议', () => {
  let uid;
  let summary;
  let r;

  beforeAll(() => {
    uid = newUser('bond');
    addHolding(uid, '600036', '招商银行', 'stock', 2000, 35); // 80000
    addHolding(uid, null, '现金', 'cash', 20000, 1);          // 20000
    addTargets(uid, 'asset_class', [['stock', 60], ['cash', 20], ['bond', 20]]);
    summary = portfolio.buildSummary(uid, 'asset_class');
    r = rebalance.suggest(uid, { threshold: 5, dimension: 'asset_class' });
  });

  it('allocation 为零持仓的 bond 建出空分组（占比 0、偏离 -20），且不凭空造持仓行', () => {
    const bond = summary.allocation.find((a) => a.key === 'bond');
    expect(bond).toBeDefined();
    expect(bond.current_pct).toBe(0);
    expect(bond.market_value).toBe(0);
    expect(bond.target_pct).toBe(20);
    expect(bond.deviation_pct).toBeCloseTo(-20, 2);
    // holdings 里绝不能多出一条 bond 行
    expect(summary.holdings).toHaveLength(2);
    expect(summary.holdings.some((h) => h.asset_class === 'bond')).toBe(false);
  });

  it('输出 is_group_level=true 的类别整体建议，不崩溃、无 NaN', () => {
    const bondItem = r.items.find((it) => it.target_key === 'bond');
    expect(bondItem).toBeDefined();
    expect(bondItem.is_group_level).toBe(true);
    expect(bondItem.action).toBe('BUY');
    expect(bondItem.code).toBeNull();
    expect(bondItem.name).toContain('bond');
    expect(bondItem.suggest_shares).toBe(0);
    expect(bondItem.unit).toBe('元');
    expect(bondItem.suggest_amount).toBeCloseTo(20000, 2); // 100000×20% − 0
    expect(Number.isFinite(bondItem.suggest_amount)).toBe(true);
    expect(bondItem.group_current_pct).toBe(0);

    // 有持仓的分组仍走行级分摊
    const stockItem = r.items.find((it) => it.target_key === 'stock');
    expect(stockItem.is_group_level).toBe(false);
    expect(stockItem.action).toBe('SELL');
    expect(stockItem.suggest_shares).toBe(500);
    expect(stockItem.suggest_amount).toBeCloseTo(20000, 2);

    // cash 偏离 0 → 不出建议
    expect(r.items.some((it) => it.target_key === 'cash')).toBe(false);

    for (const it of r.items) {
      expect(Number.isNaN(it.suggest_amount)).toBe(false);
      expect(Number.isNaN(it.diff_value)).toBe(false);
    }
  });
});

// ------------------------------------------------------------
// R3-4 矛盾场景：类别整体需 SELL，组内小市值行按行级口径会被判成 BUY
// ------------------------------------------------------------
describe('R3-4 同类别内不得出现自相矛盾的 BUY/SELL', () => {
  let uid;
  let summary;
  let r;

  beforeAll(() => {
    uid = newUser('conflict');
    addHolding(uid, '600036', '招商银行', 'stock', 3500, 35); // 140000
    addHolding(uid, '601398', '工商银行', 'stock', 200, 4);   // 1000
    addHolding(uid, null, '现金', 'cash', 59000, 1);          // 59000
    // 总资产 200000 → stock 70.5% / cash 29.5%；目标 50/50
    addTargets(uid, 'asset_class', [['stock', 50], ['cash', 50]]);
    summary = portfolio.buildSummary(uid, 'asset_class');
    r = rebalance.suggest(uid, { threshold: 5, dimension: 'asset_class' });
  });

  it('小市值行的行级偏离与分组偏离符号相反（旧口径会给出 BUY）', () => {
    const icbc = summary.holdings.find((h) => h.code === '601398');
    expect(icbc.current_pct).toBeCloseTo(0.5, 2);
    expect(icbc.row_deviation_pct).toBeCloseTo(-49.5, 1); // 旧口径 → BUY 99000
    expect(icbc.group_deviation_pct).toBeCloseTo(20.5, 1); // 正确口径 → 类别应 SELL
    expect(Math.sign(icbc.row_deviation_pct)).not.toBe(Math.sign(icbc.group_deviation_pct));
  });

  it('同一 target_key 下所有建议方向一致，工行绝不出现 BUY', () => {
    const grouped = groupItems(r.items);
    for (const [key, g] of grouped) {
      expect(g.actions.size, `target_key=${key} 出现了自相矛盾的多种 action`).toBe(1);
    }
    // 工行要么没建议（不足一手被跳过），要么只能是 SELL
    const icbcItem = r.items.find((it) => it.code === '601398');
    if (icbcItem) expect(icbcItem.action).toBe('SELL');
    expect(r.items.some((it) => it.code === '601398' && it.action === 'BUY')).toBe(false);

    // 招商：140000/141000 × 41000 = 40709.22 → 1017 股 → 向下取整 1000 股 = 40000
    const cmb = r.items.find((it) => it.code === '600036');
    expect(cmb.action).toBe('SELL');
    expect(cmb.suggest_shares).toBe(1000);
    expect(cmb.suggest_amount).toBeCloseTo(40000, 2);

    // 现金类别整体需买入 41000
    const cash = r.items.find((it) => it.target_key === 'cash');
    expect(cash.action).toBe('BUY');
    expect(cash.suggest_amount).toBeCloseTo(41000, 2);

    // stock 侧卖出合计不得超过类别缺口 41000
    const stockSell = r.items
      .filter((it) => it.target_key === 'stock')
      .reduce((s, it) => s + it.suggest_amount, 0);
    expect(stockSell).toBeLessThanOrEqual(41000 + 1);
    expect(r.summary.balance_ok).toBe(true);
  });
});

// ------------------------------------------------------------
// R3-5 target_pct 合计校验与健壮性
// ------------------------------------------------------------
describe('R3-5 target_pct 合计非 100 的报错与健壮性', () => {
  it('saveTargets Σ≠100 抛 400；Σ 在 ±0.01 容差内放行', () => {
    const uid = newUser('sum');
    expect(() => portfolio.saveTargets(uid, 'asset_class', [
      { target_key: 'stock', target_pct: 60 }, { target_key: 'cash', target_pct: 30 },
    ])).toThrow(/100/);
    expect(() => portfolio.saveTargets(uid, 'asset_class', [
      { target_key: 'stock', target_pct: 60.005 }, { target_key: 'cash', target_pct: 40 },
    ])).not.toThrow();
    expect(() => portfolio.saveTargets(uid, 'asset_class', [
      { target_key: 'stock', target_pct: 60 }, { target_key: 'cash', target_pct: 40 },
    ])).not.toThrow();
  });

  it('历史脏数据（Σ=80，绕过校验直接落库）不崩，且各组分摊仍不超各组缺口', () => {
    const uid = newUser('dirty');
    addHolding(uid, '600036', '招商银行', 'stock', 1000, 35); // 40000
    addHolding(uid, null, '现金', 'cash', 60000, 1);          // 60000
    addTargets(uid, 'asset_class', [['stock', 50], ['cash', 30]]); // Σ=80

    let r;
    expect(() => { r = rebalance.suggest(uid, { threshold: 1, dimension: 'asset_class' }); }).not.toThrow();
    for (const it of r.items) {
      expect(Number.isFinite(it.suggest_amount)).toBe(true);
      expect(Math.abs(it.suggest_amount)).toBeLessThanOrEqual(Math.abs(it.group_diff_value) + 1);
    }
    // stock 目标 50000 现 40000 → BUY 10000；cash 目标 30000 现 60000 → SELL 30000
    expect(r.items.find((it) => it.target_key === 'cash').action).toBe('SELL');
    expect(r.items.find((it) => it.target_key === 'stock').action).toBe('BUY');
  });
});

// ------------------------------------------------------------
// R3-6 跨维度目标污染（QA R3 新发现的 P2）
//
// buildSummary(userId) 不传 dimension 时，portfolioService 先用
// listTargets(userId, undefined) 取了「所有维度」的目标，再用 settings 里的
// active_dimension 分组。新增的「零持仓目标 key 也建空分组」逻辑会把其它维度
// 的 target_key 物化成幻影 allocation 项。
// 期望：allocation 只包含当前 active_dimension 下的 key。
// 修复：buildSummary 先解析 activeDimension，再 listTargets(userId, activeDimension)。
// ------------------------------------------------------------
describe('R3-6 不传 dimension 时 allocation 不得混入其它维度的目标 key', () => {
  it('用户同时配置 asset_class 与 code 维度目标时，无参 summary 不出现幻影分组', () => {
    const uid = newUser('crossdim');
    addHolding(uid, '600036', '招商银行', 'stock', 1000, 35); // 40000
    addHolding(uid, null, '现金', 'cash', 60000, 1);          // 60000
    addTargets(uid, 'asset_class', [['stock', 40], ['cash', 60]]);
    addTargets(uid, 'code', [['600036', 70], ['601398', 30]]);

    const s = portfolio.buildSummary(uid); // 不传维度 → 落到 active_dimension='asset_class'
    expect(s.active_dimension).toBe('asset_class');

    const keys = s.allocation.map((a) => a.key).sort();
    expect(keys).toEqual(['cash', 'stock']);
    // 幻影项特征：dimension 标成 asset_class，key 却是股票代码
    expect(s.allocation.some((a) => a.key === '600036')).toBe(false);
    expect(s.allocation.some((a) => a.key === '601398')).toBe(false);
  });
});

// ------------------------------------------------------------
// R3-7 dimension='code' + cash 目标 → 幻影分组造钱（QA R3 新发现的 P1）
//
// targetKeyOf(h,'code') 直接 return h.code，现金行 code 为 NULL → 被踢出分组；
// 而 'industry' 分支是有兜底的（h.asset_class==='cash' ? '现金' : '其他'）。
// 叠加新增的「零持仓目标 key 也建空分组」后果：
//   · allocation 里 cash 组 market_value=0，用户真实持有的 2 万现金凭空消失
//     （allocation 市值合计 80000 ≠ 总资产 100000）
//   · rebalance 输出 BUY「cash 类别整体」¥50000，而真实缺口只有 ¥30000
//   · need_cash=30000 / balance_ok=false —— 误导用户「还缺 3 万外部资金」
//
// 这与本轮修复的 P1 属同一族（分组口径把不存在的持仓当成 0），且是本次重写
// 新引入的：修复前 cash 目标只是被静默忽略，不会造钱。
//
// 两种修复皆可，本用例断言的是二者都满足的不变量：
//   (a) targetKeyOf 的 code 分支补 cash 兜底 → cash 组市值 20000，缺口 30000；
//   (b) 明确不支持 code 维度配 cash → 不得输出任何 cash 幻影建议。
//
// 旧用例为何没抓到：G-4 与 QA-3 的 code 维度 cash 目标分别只配了 1% / 0.05%，
// 偏离绝对值低于 threshold 被提前 continue 掉，恰好掩盖了这条路径。
// ------------------------------------------------------------
describe('R3-7 dimension=code 下 cash 目标不得凭空造钱', () => {
  let uid;
  let summary;
  let r;

  beforeAll(() => {
    uid = newUser('codecash');
    addHolding(uid, '600036', '招商银行', 'stock', 2000, 35); // 80000
    addHolding(uid, null, '现金', 'cash', 20000, 1);          // 20000
    addTargets(uid, 'code', [['600036', 50], ['cash', 50]]);  // 总资产 100000
    summary = portfolio.buildSummary(uid, 'code');
    r = rebalance.suggest(uid, { threshold: 5, dimension: 'code' });
  });

  it('allocation 不得丢失用户真实持有的现金', () => {
    const cash = summary.allocation.find((a) => a.key === 'cash');
    if (cash) {
      // 若建了 cash 组，其市值必须是真实现金，不能是 0
      expect(cash.market_value).toBeCloseTo(20000, 2);
      expect(cash.current_pct).toBeCloseTo(20, 2);
      expect(cash.deviation_pct).toBeCloseTo(-30, 2);
    }
    // 分组市值合计不得凭空缩水（现金要么入组、要么该组根本不出现）
    const allocSum = summary.allocation.reduce((s, a) => s + a.market_value, 0);
    expect(allocSum).toBeCloseTo(summary.total_asset, 2);
  });

  it('cash 建议金额必须等于真实缺口 30000，绝不能是整个目标值 50000', () => {
    const cashItem = r.items.find((it) => it.target_key === 'cash');
    if (cashItem) {
      expect(cashItem.suggest_amount).not.toBeCloseTo(50000, 0);
      expect(cashItem.suggest_amount).toBeCloseTo(30000, 0);
    }
    // 买入总额不得超过组合总资产口径下的真实再平衡规模
    expect(r.summary.buy_total).toBeLessThanOrEqual(30000 + 1);
    // 用户手里有 20000 现金、只需在内部腾挪，不该被告知"外部还缺 3 万"
    expect(r.summary.need_cash).toBeLessThanOrEqual(0 + 1);
  });
});
