// ============================================================
// T4 验收：早盘动态 dataCaveat 双分支
//
// 验证 backtestService.run({model:'morning'}) 的 dataCaveat 随 money_flow
// 覆盖度切换，且「永远非空」：
//
//   分支 A（稀疏 → 兜底静态串）
//     coverage < 0.5  → 'morning aux data sparse, results not faithful'
//   分支 B（高覆盖 → "money_flow real…"）
//     coverage ≥ 0.5  → 'morning aux partial: money_flow real, auction/limit/sector derived'
//
// 设计说明：
//   coverage = actual / (股票数 × 区间交易日数)。真实库 stockCount≈3.7万，
//   要在真实库上把 coverage 顶到 0.5 需注入约半数股票 × 天数（数万行），
//   在 1GB 真实库上不现实且有污染风险。因此：
//     · 分支 A 用【真实库】直接跑（当前真实库稀疏，命中兜底串）—— 验收"真实稀疏态正确"。
//     · 分支 B 用【内存库】精确构造（同一份 computeMorningAuxCoverage 代码路径），
//       以覆盖度阈值 0.5 为界做参数化交叉验证 —— 验收"高覆盖分支确实返回 money_flow real…"。
//   两份测试走的是完全相同的源码逻辑，结论可支撑增量可部署。
// ============================================================
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import path from 'node:path';
import { openDatabase, openMemoryDatabase } from '../src/db/driver.js';
import { initSchema } from '../src/db/schema.js';
import { createBacktestService } from '../src/services/backtestService.js';

// 关闭落库，避免任何意外写库（真实库/内存库都不落）
process.env.BACKTEST_PERSIST = 'false';

const FALLBACK = 'morning aux data sparse, results not faithful';
const REAL_STR = 'morning aux partial: money_flow real, auction/limit/sector derived';

describe("早盘动态 dataCaveat —— 分支A：稀疏→兜底静态串（真实库）", () => {
  let db;
  let svc;

  beforeAll(async () => {
    db = await openDatabase(path.resolve('data/quantfolio.db'));
    svc = createBacktestService(db);
  }, 30000);

  afterAll(() => {
    if (db) db.close();
  });

  it("真实库当前稀疏态：run(morning) 返回恒定兜底串且非空", () => {
    const res = svc.run({ model: 'morning', range: ['2026-08-01', '2026-08-10'], topN: 20 });

    // 1) 永远非空字符串（硬约束）
    expect(typeof res.dataCaveat).toBe('string');
    expect(res.dataCaveat.length).toBeGreaterThan(0);

    // 2) 稀疏态命中兜底静态串
    expect(res.dataCaveat).toBe(FALLBACK);

    // 3) 对照：closing 系 dataCaveat 恒为 null（不变量不被破坏）
    const closing = svc.run({ model: 'closing', range: ['2026-08-01', '2026-08-10'], topN: 20 });
    expect(closing.dataCaveat).toBeNull();
  }, 30000);
});

// ---------- 分支B：内存库确定性构造（覆盖度阈值交叉验证） ----------
// 构造一个受控内存库：stocks 只股票、days 个交易日、coveredFraction 比例股票在每天
// 都有 money_flow(main_net_inflow 非空, data_origin='real')。
//   expected = stocks × days
//   actual   = floor(stocks × coveredFraction) × days
//   coverage = actual / expected = coveredFraction
async function buildScenario({ stocks = 100, days = ['2026-03-02', '2026-03-03'], coveredFraction = 0 }) {
  const db = await openMemoryDatabase();
  initSchema(db);
  const codes = [];
  for (let i = 1; i <= stocks; i++) codes.push(String(i).padStart(6, '0')); // '000001' ...

  const insSec = db.prepare(
    `INSERT INTO securities (code, name, market, type, board, price_limit_pct, data_origin)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const insDq = db.prepare(
    `INSERT INTO daily_quotes (code, trade_date, close, pre_close, volume, pct_chg, turnover_rate, volume_ratio, data_origin)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insTi = db.prepare(
    `INSERT INTO tech_indicators (code, trade_date, volume_streak, high_60d_distance_pct, ma_bullish, rsi12, kdj_k, kdj_d, kdj_j)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insMf = db.prepare(
    `INSERT INTO money_flow (code, trade_date, main_net_inflow, net_inflow_3d, net_inflow_5d, data_origin)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );

  for (const c of codes) {
    insSec.run(c, `股${c}`, 'SZ', 'stock', 'SZ-Main10', 10, 'real');
    for (const d of days) {
      insDq.run(c, d, 10, 9.8, 1000, 2, 5, 1.5, 'real');
      insTi.run(c, d, 3, 10, 1, 55, 55, 50, 65);
    }
  }

  const coverCount = Math.floor(stocks * coveredFraction);
  for (let i = 0; i < coverCount; i++) {
    for (const d of days) {
      insMf.run(codes[i], d, 1234.5, 1234.5, 1234.5, 'real');
    }
  }

  const svc = createBacktestService(db);
  return { db, svc, codes, days, coverCount };
}

describe("早盘动态 dataCaveat —— 分支B：高覆盖→'money_flow real…'（内存库，覆盖度阈值交叉验证）", () => {
  // 每个用例独立内存库，afterEach 关闭，避免句柄泄漏
  let ctx;
  afterEach(() => {
    if (ctx && ctx.db) ctx.db.close();
    ctx = null;
  });

  it('覆盖度=0（稀疏）→ 兜底静态串', async () => {
    ctx = await buildScenario({ stocks: 100, coveredFraction: 0 });
    const res = ctx.svc.run({ model: 'morning', range: ctx.days, topN: 20 });
    expect(typeof res.dataCaveat).toBe('string');
    expect(res.dataCaveat.length).toBeGreaterThan(0);
    expect(res.dataCaveat).toBe(FALLBACK);
  }, 20000);

  it('覆盖度=0.3（< 0.5）→ 仍命中兜底静态串', async () => {
    ctx = await buildScenario({ stocks: 100, coveredFraction: 0.3 });
    const res = ctx.svc.run({ model: 'morning', range: ctx.days, topN: 20 });
    expect(res.dataCaveat).toBe(FALLBACK);
  }, 20000);

  it('覆盖度=0.5（边界，≥ 0.5）→ 切换到 "money_flow real…"', async () => {
    ctx = await buildScenario({ stocks: 100, coveredFraction: 0.5 });
    // 用 run() 间接验证覆盖度计算确实落在阈值上
    const cov = ctx.svc; // 仅占位，真实覆盖度由内部 computeMorningAuxCoverage 决定
    void cov;
    const res = ctx.svc.run({ model: 'morning', range: ctx.days, topN: 20 });
    expect(typeof res.dataCaveat).toBe('string');
    expect(res.dataCaveat.length).toBeGreaterThan(0);
    expect(res.dataCaveat).not.toBe(FALLBACK);
    expect(res.dataCaveat).toContain('money_flow real, auction/limit/sector derived');
  }, 20000);

  it('覆盖度=0.6（> 0.5）→ 命中 "money_flow real, auction/limit/sector derived"', async () => {
    ctx = await buildScenario({ stocks: 100, coveredFraction: 0.6 });
    const res = ctx.svc.run({ model: 'morning', range: ctx.days, topN: 20 });
    // 非空 + 非兜底 + 含真实串
    expect(typeof res.dataCaveat).toBe('string');
    expect(res.dataCaveat.length).toBeGreaterThan(0);
    expect(res.dataCaveat).not.toBe(FALLBACK);
    expect(res.dataCaveat).toContain('money_flow real, auction/limit/sector derived');
    // 完整性：早盘模型 faithful=false 不变量
    const models = ctx.svc.getModels();
    const morning = models.find((m) => m.key === 'morning');
    expect(morning.faithful).toBe(false);
  }, 20000);
});
