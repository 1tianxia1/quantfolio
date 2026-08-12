// ============================================================
// 增量2 单测：money_flow 真实历史回填（mock provider 注入，零网络）
//
// 覆盖：
//   1. mapFflowToMoneyFlowRow：元→万元换算，3d/5d 置 null，data_origin='real'
//   2. withRollingSums：升序滚动 3d/5d（含边界）
//   3. upsertMoneyFlowRows：幂等（同 (code,trade_date) 重复写覆盖不新增）
//   4. backfillStock / backfillAll：逐只调用、批提交、--resume 跳过已回填、
//      --dry-run 不写库、失败 code 跳过
// ============================================================
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { openMemoryDatabase } from '../src/db/driver.js';
import { initSchema } from '../src/db/schema.js';
import {
  mapFflowToMoneyFlowRow,
  withRollingSums,
  upsertMoneyFlowRows,
  backfillStock,
  backfillAll,
} from '../scripts/backfillMoneyFlowLib.mjs';

let db;

beforeAll(async () => {
  db = await openMemoryDatabase();
  initSchema(db);
  // money_flow 有外键 → securities(code)；内存库无 seed，预置股票行以通过 FK 约束
  // （真实环境：先 npm run seed 再回填，securities 已就绪）
  const seedCodes = ['600000', '600111', '600222', '600333', '700001', '700002', '700003'];
  for (const code of seedCodes) {
    db.run(
      "INSERT INTO securities (code, name, market, type, board, price_limit_pct) VALUES (?, ?, 'SH', 'stock', '主板', 0.1)",
      [code, code],
    );
  }
});

afterAll(() => {
  if (db) db.close();
});

/** 生成若干 fflow 行（单位：元） */
function fakeRows(code) {
  return [
    { date: '2026-08-01', main_net_inflow: 1000000 },
    { date: '2026-08-02', main_net_inflow: 2000000 },
    { date: '2026-08-03', main_net_inflow: 3000000 },
  ].map((r) => ({ ...r, code }));
}

/** 构造 mock provider（暴露 .client.fetchMoneyFlow） */
function makeProvider(rowsByCode, { failCodes = [] } = {}) {
  return {
    client: {
      fetchMoneyFlow: async (code) => {
        if (failCodes.includes(code)) throw new Error(`mock fail ${code}`);
        return rowsByCode[code] || [];
      },
    },
  };
}

describe('mapFflowToMoneyFlowRow', () => {
  it('元→万元换算，net_inflow_3d/5d 置 null，data_origin=real', () => {
    const row = mapFflowToMoneyFlowRow('600000', {
      date: '2026-08-03',
      main_net_inflow: 123456789, // 元
    });
    expect(row.code).toBe('600000');
    expect(row.trade_date).toBe('2026-08-03');
    expect(row.main_net_inflow).toBeCloseTo(12345.6789); // ÷10000
    expect(row.net_inflow_3d).toBeNull();
    expect(row.net_inflow_5d).toBeNull();
    expect(row.data_origin).toBe('real');
  });

  it('main_net_inflow 缺失时置 null（不抛）', () => {
    const row = mapFflowToMoneyFlowRow('600000', { date: '2026-08-03' });
    expect(row.main_net_inflow).toBeNull();
    expect(row.data_origin).toBe('real');
  });
});

describe('withRollingSums', () => {
  it('升序滚动 3d/5d 正确，边界取可用窗口之和', () => {
    const rows = [
      mapFflowToMoneyFlowRow('600000', { date: '2026-08-01', main_net_inflow: 1000000 }),
      mapFflowToMoneyFlowRow('600000', { date: '2026-08-02', main_net_inflow: 2000000 }),
      mapFflowToMoneyFlowRow('600000', { date: '2026-08-03', main_net_inflow: 3000000 }),
      mapFflowToMoneyFlowRow('600000', { date: '2026-08-04', main_net_inflow: 4000000 }),
      mapFflowToMoneyFlowRow('600000', { date: '2026-08-05', main_net_inflow: 5000000 }),
    ];
    // 万元级：100 / 200 / 300 / 400 / 500
    const out = withRollingSums(rows);

    expect(out[0].net_inflow_3d).toBeCloseTo(100); // 边界：仅 1 日
    expect(out[1].net_inflow_3d).toBeCloseTo(300); // 2 日
    expect(out[2].net_inflow_3d).toBeCloseTo(600); // 3 日
    expect(out[3].net_inflow_3d).toBeCloseTo(900);
    expect(out[4].net_inflow_3d).toBeCloseTo(1200); // 满窗 3 日

    expect(out[0].net_inflow_5d).toBeCloseTo(100); // 边界：仅 1 日
    expect(out[1].net_inflow_5d).toBeCloseTo(300); // 2 日
    expect(out[2].net_inflow_5d).toBeCloseTo(600); // 3 日
    expect(out[3].net_inflow_5d).toBeCloseTo(1000); // 4 日
    expect(out[4].net_inflow_5d).toBeCloseTo(1500); // 满窗 5 日
  });

  it('不修改入参（纯函数）', () => {
    const rows = [mapFflowToMoneyFlowRow('600000', { date: '2026-08-01', main_net_inflow: 1000000 })];
    withRollingSums(rows);
    expect(rows[0].net_inflow_3d).toBeNull();
  });
});

describe('upsertMoneyFlowRows', () => {
  it('幂等：同 (code,trade_date) 重复写覆盖不新增行', () => {
    const rows = [
      { code: '600000', trade_date: '2026-08-01', main_net_inflow: 100, net_inflow_3d: 100, net_inflow_5d: 100, data_origin: 'real' },
      { code: '600000', trade_date: '2026-08-02', main_net_inflow: 200, net_inflow_3d: 300, net_inflow_5d: 300, data_origin: 'real' },
    ];
    upsertMoneyFlowRows(db, rows);
    let n = db.get('SELECT COUNT(*) AS n FROM money_flow WHERE code = ?', ['600000']);
    expect(n.n).toBe(2);

    // 重复写（覆盖 main_net_inflow）
    upsertMoneyFlowRows(db, [
      { code: '600000', trade_date: '2026-08-01', main_net_inflow: 999, net_inflow_3d: 999, net_inflow_5d: 999, data_origin: 'real' },
      { code: '600000', trade_date: '2026-08-02', main_net_inflow: 888, net_inflow_3d: 888, net_inflow_5d: 888, data_origin: 'real' },
    ]);
    n = db.get('SELECT COUNT(*) AS n FROM money_flow WHERE code = ?', ['600000']);
    expect(n.n).toBe(2); // 不重复

    const r1 = db.get('SELECT main_net_inflow FROM money_flow WHERE code = ? AND trade_date = ?', ['600000', '2026-08-01']);
    expect(r1.main_net_inflow).toBe(999); // 覆盖生效
  });

  it('空数组安全（不抛）', () => {
    expect(() => upsertMoneyFlowRows(db, [])).not.toThrow();
  });
});

describe('backfillStock（mock provider）', () => {
  it('逐只调用并写入 money_flow（万元换算 + 3d 滚动）', async () => {
    const provider = makeProvider({ '600000': fakeRows('600000') });
    const r = await backfillStock(db, provider, '600000', {});
    expect(r.status).toBe('ok');
    expect(r.rows).toBe(3);

    const rows = db.all('SELECT * FROM money_flow WHERE code = ? ORDER BY trade_date', ['600000']);
    expect(rows).toHaveLength(3);
    expect(Number(rows[0].main_net_inflow)).toBeCloseTo(100); // 万元
    expect(rows[0].data_origin).toBe('real');
    expect(Number(rows[0].net_inflow_3d)).toBeCloseTo(100); // 边界 3d
    expect(Number(rows[2].net_inflow_5d)).toBeCloseTo(600); // 3 日满窗 5d
  });

  it('fetch 返回 [] → status=empty，不写库', async () => {
    const provider = makeProvider({ '600111': [] });
    const r = await backfillStock(db, provider, '600111', {});
    expect(r.status).toBe('empty');
    const n = db.get('SELECT COUNT(*) AS n FROM money_flow WHERE code = ?', ['600111']);
    expect(n.n).toBe(0);
  });
});

describe('backfillAll（mock provider 主流程）', () => {
  it('失败 code 跳过并继续，汇总 error 计数', async () => {
    const codes = ['600000', '600111', '600222'];
    const provider = makeProvider(
      { '600000': fakeRows('600000'), '600222': fakeRows('600222') },
      { failCodes: ['600111'] },
    );
    const summary = await backfillAll(db, provider, codes, { batchSize: 2 });
    expect(summary.total).toBe(3);
    expect(summary.ok).toBe(2);
    expect(summary.error).toBe(1);
    expect(summary.done).toBe(3);
  });

  it('--resume 跳过已回填（行数≥阈值）的 code，且不调用 fetch', async () => {
    // 预填 600000 为真数据（行数 ≥ 240）
    const pre = [];
    for (let i = 1; i <= 250; i++) {
      pre.push({
        code: '600000',
        trade_date: `2026-01-${String(i).padStart(3, '0')}`,
        main_net_inflow: 100,
        net_inflow_3d: 100,
        net_inflow_5d: 100,
        data_origin: 'real',
      });
    }
    upsertMoneyFlowRows(db, pre);

    let fetched = 0;
    const countingProvider = {
      client: { fetchMoneyFlow: async (code) => { fetched++; return fakeRows(code); } },
    };
    const summary = await backfillAll(db, countingProvider, ['600000'], { resume: true, resumeThreshold: 240 });
    expect(summary.skipped).toBe(1);
    expect(fetched).toBe(0); // 跳过，未调用 fetch
  });

  it('--dry-run 不写库', async () => {
    const before = db.get('SELECT COUNT(*) AS n FROM money_flow WHERE code = ?', ['600333']);
    expect(before.n).toBe(0);

    const provider = makeProvider({ '600333': fakeRows('600333') });
    const summary = await backfillAll(db, provider, ['600333'], { dryRun: true });
    expect(summary.done).toBe(1);

    const after = db.get('SELECT COUNT(*) AS n FROM money_flow WHERE code = ?', ['600333']);
    expect(after.n).toBe(0); // 未写入
  });

  it('批提交：批内数据落库，进度回调触发', async () => {
    const codes = ['700001', '700002', '700003'];
    const provider = makeProvider({
      '700001': fakeRows('700001'),
      '700002': fakeRows('700002'),
      '700003': fakeRows('700003'),
    });
    let progressCalls = 0;
    const summary = await backfillAll(db, provider, codes, {
      batchSize: 2,
      onProgress: () => { progressCalls++; },
    });
    expect(summary.ok).toBe(3);
    expect(progressCalls).toBeGreaterThanOrEqual(1);
    for (const code of codes) {
      const n = db.get('SELECT COUNT(*) AS n FROM money_flow WHERE code = ?', [code]);
      expect(n.n).toBe(3); // 已落库
    }
  });
});
