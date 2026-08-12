// ============================================================
// intradayPoller 针对性单元测试
// 验证「场外基金交易时段每 ~60s 同步天天基金盘中估值」改动：
//   1. 混合持仓：股票走东财快照、场外基金触发 syncFundNav（codes 含基金代码）
//   2. 仅持有场外基金：poll() 不早退，基金桩仍被调用（验证 early-return 修复）
//   3. 仅持有股票且快照为空：不抛异常、基金桩不被调用（fundCodes 为空，行为与原版一致）
//
// 关键点：
//   - poll / isMarketOpen 均未导出 → 用 vi.useFakeTimers({toFake:['Date']}) 把系统时间
//     钉在「北京时间 10:00（UTC 02:00）周三」交易时段，使 isMarketOpen() 恒真；
//     定时器(setInterval/setTimeout)保持真实，避免 poll 被冻结。
//   - fundNavService / dataProvider 均为「动态 import」→ 用 vi.mock 拦截，绝不触网。
//   - lastFundSync 为模块级共享状态 → 每个用例把 faked 时钟递进 700 天
//     （7 的倍数→仍为周三，且距上次同步远 ≥60s），保证节流同步每次都放行。
// ============================================================
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { start } from '../src/services/intradayPoller.js';

// 用 vi.hoisted 在 hoist 阶段创建可变桩存储，供 vi.mock 工厂与测试共享
const { fundNavCalls, dpConfig } = vi.hoisted(() => ({
  fundNavCalls: [],
  dpConfig: { quotesResponse: [] },
}));

// 拦截动态 import 的 fundNavService：记录调用并返回桩结果（不触网）
vi.mock('../src/services/fundNavService.js', () => ({
  createFundNavService: () => ({
    syncFundNav: async ({ codes }) => {
      fundNavCalls.push(codes);
      return { synced: codes.length, skipped: 0 };
    },
  }),
}));

// 拦截动态 import 的 dataProvider：快照返回值由测试用例控制（不触网）
vi.mock('../src/providers/dataProvider.js', () => ({
  getProvider: () => ({
    getQuotes: async () => dpConfig.quotesResponse,
  }),
}));

// 基点：北京时间 10:00（UTC 02:00）周三，处于交易时段 → isMarketOpen() 返回 true
const BASE_MS = new Date('2026-08-12T02:00:00.000Z').getTime();
let testIndex = 0;

/** 构造内存假 db：all 仅用于持仓查询，prepare 返回带 run 的空桩 */
function makeFakeDb(holdings) {
  return {
    all: () => holdings,
    prepare: () => ({ run: () => {} }),
    run: () => {},
  };
}

/** 等待基金桩被调用（或超时），避免依赖被 faked 的 Date.now() */
async function waitForFundCall(timeoutMs = 1000) {
  const step = 20;
  for (let waited = 0; waited < timeoutMs; waited += step) {
    if (fundNavCalls.length > 0) return;
    await new Promise((r) => setTimeout(r, step));
  }
}

const controllers = [];

beforeEach(() => {
  testIndex += 1;
  fundNavCalls.length = 0;
  dpConfig.quotesResponse = [];
  // 只 fake Date，保留真实 setInterval/setTimeout（否则 poll 的定时器会被冻结）
  vi.useFakeTimers({ toFake: ['Date'] });
  // 每轮递进 700 天（7 的倍数→仍为周三，且距上次同步 >> 60s），保证节流同步放行
  vi.setSystemTime(new Date(BASE_MS + testIndex * 700 * 24 * 3600 * 1000));
  // 屏蔽轮询内部日志噪音
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  controllers.forEach((c) => c && c.stop && c.stop());
  controllers.length = 0;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('intradayPoller 场外基金估值同步', () => {
  it('混合持仓：股票走快照、场外基金触发 syncFundNav 且 codes 含 017141', async () => {
    // 快照返回非空，避免股票块提前 return 而漏掉第 7 步基金同步
    dpConfig.quotesResponse = [{ code: '000878', close: 10, pre_close: 10, pct_chg: 0, volume: 1, amount: 1 }];
    const holdings = [
      { code: '017141', type: 'fund' },
      { code: '000878', type: 'stock' },
    ];
    const controller = start(makeFakeDb(holdings));
    controllers.push(controller);

    await waitForFundCall();
    expect(fundNavCalls.length).toBe(1);
    expect(fundNavCalls[0]).toEqual(['017141']);
    expect(fundNavCalls[0]).toContain('017141');
  });

  it('仅持有场外基金：不早退，基金桩仍被调用（验证 early-return 修复）', async () => {
    const holdings = [{ code: '017141', type: 'fund' }];
    const controller = start(makeFakeDb(holdings));
    controllers.push(controller);

    await waitForFundCall();
    expect(fundNavCalls.length).toBe(1);
    expect(fundNavCalls[0]).toEqual(['017141']);
  });

  it('仅持有股票且快照为空：不抛异常、基金桩不被调用（fundCodes 为空）', async () => {
    dpConfig.quotesResponse = []; // 快照返回空 → 股票块 early return，基金同步段不进入
    const holdings = [{ code: '000878', type: 'stock' }];
    const controller = start(makeFakeDb(holdings));
    controllers.push(controller);

    // 短暂等待，确认 poll 完成且不抛异常
    await new Promise((r) => setTimeout(r, 100));
    expect(fundNavCalls.length).toBe(0);
  });

  it('【回归护栏·潜在源码缺陷】混合持仓且股票快照为空：基金同步仍应执行（不被股票块 early-return 吞掉）', async () => {
    // 股票快照返回空（如东财临时取不到），但仍有场外基金需要估值刷新
    dpConfig.quotesResponse = [];
    const holdings = [
      { code: '017141', type: 'fund' },
      { code: '000878', type: 'stock' },
    ];
    const controller = start(makeFakeDb(holdings));
    controllers.push(controller);

    await waitForFundCall();
    // 期望：即便股票快照为空，第 7 步基金估值同步依然执行
    expect(fundNavCalls.length).toBe(1);
    expect(fundNavCalls[0]).toEqual(['017141']);
  });
});
