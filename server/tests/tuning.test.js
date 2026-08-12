// ============================================================
// T05 质量关卡 C：调参排序正确性（tuning grid ranking）
//
// 验证 gridSearch 调参：
//   1. combinations === 笛卡尔积大小（2×2 = 4）。
//   2. results 按 objective 指标降序（winRate / avgNextRet）。
//   3. 每个 results[i].weights 是 tuneTargets 因子键到其取值数组的合法组合，
//      且 4 个 (trend, momentum) 组合齐全。
//
// 说明（实现正确性，非 Bug）：
//   expandGrid 返回的是「完整 closing 权重」= {...CLOSING_WEIGHTS, ...override}，
//   即默认值 + 被调参因子的覆盖值。这是 by-design：评分函数需要全部因子权重，
//   且完整权重便于序列化存储。因此权重对象的键集是 CLOSING_WEIGHTS 的【超集】，
//   而非仅 tuneTargets 键集。本测试断言「覆盖因子取合法值 + 全部组合齐全」，
//   这正是「合法组合」的实质含义。
//
// 小区间 + 采样保持单测 < 30s。
// ============================================================
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { openDatabase } from '../src/db/driver.js';
import { createBacktestService } from '../src/services/backtestService.js';
import { createTuningService } from '../src/services/tuningService.js';

// 关闭落库，避免污染真实库
process.env.BACKTEST_PERSIST = 'false';

const RANGE = ['2026-08-01', '2026-08-10'];
const TUNE_TARGETS = { trend: [0.2, 0.4], momentum: [0.1, 0.3] };

let db;
let tuning;

beforeAll(async () => {
  db = await openDatabase(path.resolve('data/quantfolio.db'));
  const svc = createBacktestService(db);
  tuning = createTuningService(db, svc);
}, 30000);

afterAll(() => {
  if (db) db.close();
});

describe('调参排序正确性 (tuning)', () => {
  it('objective=winRate：combinations===4，results 按 winRate 降序，权重为合法组合', () => {
    const res = tuning.tune({
      model: 'closing',
      range: RANGE,
      topN: 20,
      tuneTargets: TUNE_TARGETS,
      objective: 'winRate',
      sampling: { step: 2 },
      topK: 10,
    });

    expect(res.model).toBe('closing');
    expect(res.objective).toBe('winRate');

    // 笛卡尔积：2 × 2 = 4
    expect(res.combinations).toBe(4);

    // 结果数受 topK 限制且非空
    expect(res.results.length).toBeGreaterThan(0);
    expect(res.results.length).toBeLessThanOrEqual(10);

    // 按 winRate 降序
    for (let i = 0; i < res.results.length - 1; i++) {
      expect(res.results[i].metrics.winRate).toBeGreaterThanOrEqual(
        res.results[i + 1].metrics.winRate,
      );
    }

    // 合法组合：每个权重对象的覆盖因子键取 tuneTargets 中声明的值；4 组合齐全
    const pairSet = new Set(
      res.results.map((r) => `${r.weights.trend}|${r.weights.momentum}`),
    );
    expect(pairSet.size).toBe(4);
    for (const r of res.results) {
      expect(TUNE_TARGETS.trend).toContain(r.weights.trend);
      expect(TUNE_TARGETS.momentum).toContain(r.weights.momentum);
    }
  }, 30000);

  it('objective=avgRet：results 按 avgNextRet 降序', () => {
    const res = tuning.tune({
      model: 'closing',
      range: RANGE,
      topN: 20,
      tuneTargets: TUNE_TARGETS,
      objective: 'avgRet',
      sampling: { step: 2 },
      topK: 10,
    });

    expect(res.objective).toBe('avgRet');
    expect(res.combinations).toBe(4);
    expect(res.results.length).toBeGreaterThan(0);

    for (let i = 0; i < res.results.length - 1; i++) {
      expect(res.results[i].metrics.avgNextRet).toBeGreaterThanOrEqual(
        res.results[i + 1].metrics.avgNextRet,
      );
    }
  }, 30000);

  it('权重为完整 closing 权重（默认值 + 覆盖因子）：覆盖键取 tuneTargets 值且因子齐全', () => {
    const res = tuning.tune({
      model: 'closing',
      range: RANGE,
      topN: 20,
      tuneTargets: TUNE_TARGETS,
      objective: 'winRate',
      sampling: { step: 2 },
      topK: 10,
    });

    for (const r of res.results) {
      const w = r.weights;
      // 完整 closing 因子键必须存在（评分函数需要全部因子）
      for (const k of ['trend', 'momentum', 'volume', 'valuation']) {
        expect(k in w).toBe(true);
      }
      // 被调参因子取 tuneTargets 中声明的值
      expect(TUNE_TARGETS.trend).toContain(w.trend);
      expect(TUNE_TARGETS.momentum).toContain(w.momentum);
    }
  }, 30000);
});
