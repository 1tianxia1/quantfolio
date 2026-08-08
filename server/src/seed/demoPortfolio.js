// ============================================================
// demo 持仓（user_id=NULL）+ demo 目标配置 + 预置策略模板
// ============================================================
import { CLOSING_PIPELINE_STEPS, MORNING_PIPELINE_STEPS } from '../config/screening-defaults.js';

/** demo 持仓（使用种子真实标的代码/名称） */
export const DEMO_HOLDINGS = [
  { code: '000858', name: '五粮液', asset_class: 'stock', quantity: 500, cost_price: 70.0 },
  { code: '000568', name: '泸州老窖', asset_class: 'stock', quantity: 300, cost_price: 95.0 },
  { code: '600276', name: '恒瑞医药', asset_class: 'stock', quantity: 1000, cost_price: 48.0 },
  { code: '603259', name: '药明康德', asset_class: 'stock', quantity: 200, cost_price: 160.0 },
  { code: '002463', name: '沪电股份', asset_class: 'stock', quantity: 300, cost_price: 110.0 },
  { code: '600183', name: '生益科技', asset_class: 'stock', quantity: 200, cost_price: 120.0 },
  { code: '601166', name: '兴业银行', asset_class: 'stock', quantity: 3000, cost_price: 17.0 },
  // ★ cost_price 必须是 4 位小数 5.9662，不能写成券商展示的 5.966：
  //   (6.01 − 5.966 ) × 100 = 4.40 ← 与同花顺差 0.02
  //   (6.01 − 5.9662) × 100 = 4.38 ← 与同花顺一致
  //   seedDemoPortfolio 会 DELETE 整个游客桶再重建，这里漏了就会在每次 seed 后回归。
  { code: '000539', name: '粤电力A', asset_class: 'stock', quantity: 100, cost_price: 5.9662 },
  { code: '516080', name: '创新药ETF易方达', asset_class: 'fund', quantity: 50000, cost_price: 0.7 },
  { code: '159992', name: '创新药ETF银华', asset_class: 'fund', quantity: 30000, cost_price: 0.9 },
  { code: null, name: '现金', asset_class: 'cash', quantity: 80000, cost_price: 1 },
];

/** demo 目标配置（asset_class 维度，Σ=100） */
export const DEMO_TARGETS = [
  { dimension: 'asset_class', target_key: 'stock', target_pct: 60 },
  { dimension: 'asset_class', target_key: 'fund', target_pct: 25 },
  { dimension: 'asset_class', target_key: 'cash', target_pct: 15 },
];

/** 预置策略模板 */
export function buildPresetStrategies() {
  return [
    {
      name: '尾盘五步法（用户核心）',
      type: 'pipeline_closing',
      conditions: { type: 'pipeline_closing', steps: CLOSING_PIPELINE_STEPS, loose_mode: false },
    },
    {
      name: '早盘七步法（用户核心）',
      type: 'pipeline_morning',
      conditions: { type: 'pipeline_morning', steps: MORNING_PIPELINE_STEPS, loose_mode: false },
    },
    {
      name: '打板情绪流',
      type: 'morning',
      conditions: {
        type: 'morning',
        universe: { excludeST: true, excludeNew: true },
        volumeRatio: { min: 2 },
        auction: { pct: [2, 7] },
        limitUp: { minStreak: 1, maxStreak: 0 },
        turnover: [3, 30],
      },
    },
    {
      name: '温和放量+资金流入',
      type: 'morning',
      conditions: {
        type: 'morning',
        universe: { excludeST: true, excludeNew: true },
        volumeRatio: { min: 1.5 },
        turnover: [3, 15],
        netInflow3d: { minWanYuan: 3000 },
      },
    },
    {
      name: '热点板块跟随',
      type: 'morning',
      conditions: {
        type: 'morning',
        universe: { excludeST: true, excludeNew: true },
        auction: { pct: [0, 6] },
        sectors: ['AI芯片', '半导体', '半导体材料', '存储芯片', '创新药', '人形机器人', '光通信'],
      },
    },
    {
      name: 'MACD金叉+多头排列',
      type: 'closing',
      conditions: {
        type: 'closing',
        universe: { excludeST: true, excludeNew: true, types: ['stock'] },
        macd: { status: 'gold_cross' },
        ma: { pattern: 'bullish' },
        volRatio5: { min: 1.5 },
      },
    },
    {
      name: '超跌反弹（RSI<30 + 放量）',
      type: 'closing',
      conditions: {
        type: 'closing',
        universe: { excludeST: true, excludeNew: true, types: ['stock'] },
        rsi: { period: 6, preset: 'oversold' },
        volRatio5: { min: 1.5 },
      },
    },
    {
      name: '低估值放量突破',
      type: 'closing',
      conditions: {
        type: 'closing',
        universe: { excludeST: true, excludeNew: true, types: ['stock'] },
        pe: { range: [5, 30], excludeNegative: true },
        volRatio5: { min: 1.5 },
        ma: { pattern: 'above_20' },
      },
    },
  ];
}

/**
 * 写入 demo 数据（持仓/目标/预置策略）
 * @param {import('../db/driver.js').Database} db
 */
export function seedDemoPortfolio(db) {
  const tx = db.transaction(() => {
    db.exec('DELETE FROM holdings WHERE user_id IS NULL');
    db.exec('DELETE FROM target_allocations WHERE user_id IS NULL');
    db.exec('DELETE FROM strategies WHERE is_preset = 1');

    for (const h of DEMO_HOLDINGS) {
      db.run(
        `INSERT INTO holdings (user_id, code, name, asset_class, quantity, cost_price)
         VALUES (NULL, ?, ?, ?, ?, ?)`,
        [h.code, h.name, h.asset_class, h.quantity, h.cost_price],
      );
    }

    for (const t of DEMO_TARGETS) {
      db.run(
        `INSERT INTO target_allocations (user_id, dimension, target_key, target_pct)
         VALUES (NULL, ?, ?, ?)`,
        [t.dimension, t.target_key, t.target_pct],
      );
    }

    for (const s of buildPresetStrategies()) {
      db.run(
        `INSERT INTO strategies (user_id, name, type, conditions, is_preset)
         VALUES (NULL, ?, ?, ?, 1)`,
        [s.name, s.type, JSON.stringify(s.conditions)],
      );
    }
  });
  tx();
}
