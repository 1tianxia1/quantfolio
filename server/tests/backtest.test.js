// ============================================================
// T05 质量关卡 B：回测结果契约（backtest result contract）
//
// 验证：
//   1. closing 模型：dataCaveat===null；summary 字段完整；winRate∈[0,1]；
//      picks===trades.length；days===有入选的交易日数。
//   2. morning 模型：dataCaveat 为非空字符串（早盘数据待补标注生效）。
//   3. getModels()：4 个模型，morning 系 faithful=false 且 dataCaveat 非空，
//      closing 系 faithful=true 且 dataCaveat===null。
//
// 小区间 + 采样保持单测 < 30s。
// ============================================================
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { openDatabase } from '../src/db/driver.js';
import { createBacktestService } from '../src/services/backtestService.js';

// 关闭落库，避免污染真实库（且不依赖 backtests 表存在）
process.env.BACKTEST_PERSIST = 'false';

const RANGE = ['2026-08-01', '2026-08-10'];

let db;
let svc;

beforeAll(async () => {
  db = await openDatabase(path.resolve('data/quantfolio.db'));
  svc = createBacktestService(db);
}, 30000);

afterAll(() => {
  if (db) db.close();
});

describe('回测结果契约 (backtest)', () => {
  it('closing 模型：dataCaveat 为 null，summary 字段完整，picks===trades.length，winRate∈[0,1]', () => {
    const res = svc.run({ model: 'closing', range: RANGE, topN: 20 });

    expect(res.model).toBe('closing');
    expect(res.dataCaveat).toBeNull();

    const s = res.summary;
    for (const k of [
      'days', 'picks', 'winRate', 'avgNextRet', 'avgWinRet', 'avgLossRet', 'retDistribution',
    ]) {
      expect(s).toHaveProperty(k);
    }

    // winRate 必须是合法概率
    expect(s.winRate).toBeGreaterThanOrEqual(0);
    expect(s.winRate).toBeLessThanOrEqual(1);

    // picks 与 trades 数量一致（summary 全量、trades 在 cap 内不截断时相等）
    expect(s.picks).toBe(res.trades.length);

    // days 等于有入选的交易日数（末日若无 T+1 则不计入）
    const distinctDays = new Set(res.trades.map((t) => t.tradeDate)).size;
    expect(s.days).toBe(distinctDays);
    expect(s.days).toBeGreaterThan(0);

    // 收益分布为 8 桶
    expect(Array.isArray(s.retDistribution)).toBe(true);
    expect(s.retDistribution).toHaveLength(8);
  }, 30000);

  it('morning 模型：dataCaveat 为非空字符串（早盘数据待补标注生效）', () => {
    const res = svc.run({ model: 'morning', range: RANGE, topN: 20 });

    expect(res.model).toBe('morning');
    expect(typeof res.dataCaveat).toBe('string');
    expect(res.dataCaveat.length).toBeGreaterThan(0);
  }, 30000);

  it('getModels()：4 个模型，morning 系 faithful=false 且 dataCaveat 非空，closing 系 faithful=true 且 dataCaveat=null', () => {
    const models = svc.getModels();

    expect(models).toHaveLength(4);
    const byKey = Object.fromEntries(models.map((m) => [m.key, m]));

    for (const k of ['closing', 'closingPipeline', 'morning', 'morningPipeline']) {
      expect(byKey[k]).toBeDefined();
    }

    for (const k of ['morning', 'morningPipeline']) {
      expect(byKey[k].faithful).toBe(false);
      expect(typeof byKey[k].dataCaveat).toBe('string');
      expect(byKey[k].dataCaveat.length).toBeGreaterThan(0);
    }

    for (const k of ['closing', 'closingPipeline']) {
      expect(byKey[k].faithful).toBe(true);
      expect(byKey[k].dataCaveat).toBeNull();
    }
  });
});
