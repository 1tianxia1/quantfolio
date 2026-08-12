// ============================================================
// money_flow 真实历史回填 —— 纯函数 + 批处理/断点/重试逻辑
//
// 本文件**零项目内依赖**（不 import 任何 src 模块），仅接收 db / provider，
// 便于单测注入 mock provider 与内存库。CLI 入口见 backfillMoneyFlow.mjs。
//
// ⚠️ 单位红线（不可妥协）：
//   东财 fflow 返回的 main_net_inflow 单位为「元」；
//   money_flow.main_net_inflow 历史口径为「万元」。
//   → 映射时必须 main_net_inflow(元) / 10000 入库（万元）。
//   漏掉 ÷10000 会让净流入放大万倍，早盘分位池 netInflow3d 彻底失真。
// ============================================================

/** 元 → 万元 换算系数（fflow 元 ÷ 10000） */
const YUAN_TO_WAN = 1 / 10000;

/**
 * 单只股票单行映射：fflow 行(元) → money_flow 行(万元)
 * @param {string} code 6 位裸码
 * @param {{date:string, main_net_inflow?:number, small_net_inflow?:number, medium_net_inflow?:number, large_net_inflow?:number, super_net_inflow?:number, close?:number, pct_chg?:number}} rawRow fflow 解析行
 * @returns {{code:string, trade_date:string, main_net_inflow:number|null, net_inflow_3d:null, net_inflow_5d:null, data_origin:'real'}}
 */
export function mapFflowToMoneyFlowRow(code, rawRow) {
  const raw = Number(rawRow?.main_net_inflow);
  const mainNetInflow = Number.isFinite(raw) ? raw * YUAN_TO_WAN : null;
  return {
    code,
    trade_date: String(rawRow?.date),
    main_net_inflow: mainNetInflow, // 元 → 万元
    net_inflow_3d: null, // 本函数置 null，由 withRollingSums 填
    net_inflow_5d: null,
    data_origin: 'real',
  };
}

/**
 * 单只股票有序序列 → 填好滚动 3d/5d（纯函数，可单测）
 * 前置：rows 已按 trade_date 升序。
 * 逻辑：net_inflow_3d[i] = sum(main_net_inflow[i-2..i])；
 *       net_inflow_5d[i] = sum(main_net_inflow[i-4..i])；
 *       边界（不足 N 日）取可用窗口之和。
 * @param {Array<{code:string, trade_date:string, main_net_inflow:number|null, net_inflow_3d:*, net_inflow_5d:*, data_origin:string}>} rows
 * @returns {Array} 同形状新数组（不修改入参）
 */
export function withRollingSums(rows) {
  const n = rows.length;
  const out = rows.map((r) => ({ ...r }));
  for (let i = 0; i < n; i++) {
    let sum3 = 0;
    for (let j = Math.max(0, i - 2); j <= i; j++) sum3 += out[j].main_net_inflow ?? 0;
    let sum5 = 0;
    for (let j = Math.max(0, i - 4); j <= i; j++) sum5 += out[j].main_net_inflow ?? 0;
    out[i].net_inflow_3d = sum3;
    out[i].net_inflow_5d = sum5;
  }
  return out;
}

/**
 * 幂等 upsert（键 code + trade_date）；只动 6 列。
 * 批量走单事务提交，失败整体回滚（驱动支持时）。
 * @param {import('../src/db/driver.js').Database} db
 * @param {Array<{code:string, trade_date:string, main_net_inflow:number|null, net_inflow_3d:number|null, net_inflow_5d:number|null, data_origin:string}>} rows
 */
export function upsertMoneyFlowRows(db, rows) {
  if (!rows || rows.length === 0) return;
  const stmt = db.prepare(
    `INSERT INTO money_flow (code, trade_date, main_net_inflow, net_inflow_3d, net_inflow_5d, data_origin)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(code, trade_date) DO UPDATE SET
       main_net_inflow = excluded.main_net_inflow,
       net_inflow_3d = excluded.net_inflow_3d,
       net_inflow_5d = excluded.net_inflow_5d,
       data_origin = excluded.data_origin`,
  );
  const tx = db.transaction(() => {
    for (const r of rows) {
      // 注意：绑定以独立实参传入（驱动会展开为原生位置参数），
      // 不要传单个数组（better-sqlite3 会误判为具名参数）。
      stmt.run(
        r.code,
        r.trade_date,
        r.main_net_inflow,
        r.net_inflow_3d,
        r.net_inflow_5d,
        r.data_origin,
      );
    }
  });
  tx();
}

/**
 * 取 provider 上的 fetchMoneyFlow（兼容两种挂载形态）：
 *   - 真实 provider：provider.client.fetchMoneyFlow
 *   - 测试注入 mock：provider.client.fetchMoneyFlow
 *   - 兜底：provider.fetchMoneyFlow（极端情况）
 * @param {object} provider
 * @returns {Function|undefined}
 */
function resolveFetch(provider) {
  return provider?.client?.fetchMoneyFlow ?? provider?.fetchMoneyFlow;
}

/**
 * 单只股票回填：取 fflow → 映射(元→万元) → 滚动求和 → 幂等 upsert。
 * 便于测试注入 mock provider。
 * @param {import('../src/db/driver.js').Database} db
 * @param {object} provider 暴露 .client.fetchMoneyFlow 或 .fetchMoneyFlow
 * @param {string} code 6 位裸码
 * @param {object} [opts] 预留（当前未用，保持签名一致）
 * @returns {Promise<{code:string, rows:number, status:'ok'|'empty'|'error', error?:string}>}
 */
export async function backfillStock(db, provider, code, opts = {}) {
  const fetch = resolveFetch(provider);
  if (typeof fetch !== 'function') {
    throw new Error('provider 未暴露 fetchMoneyFlow');
  }
  const rows = await fetch(code, { limit: 0 });
  if (!Array.isArray(rows) || rows.length === 0) {
    return { code, rows: 0, status: 'empty' };
  }
  const mapped = rows.map((r) => mapFflowToMoneyFlowRow(code, r));
  const summed = withRollingSums(mapped);
  upsertMoneyFlowRows(db, summed);
  return { code, rows: summed.length, status: 'ok' };
}

/**
 * 批量回填主流程（CLI 与测试共用）。
 * @param {import('../src/db/driver.js').Database} db
 * @param {object} provider 暴露 .client.fetchMoneyFlow 或 .fetchMoneyFlow
 * @param {string[]} codes 待回填 code 列表
 * @param {object} [opts]
 *   - batchSize: 每批只数（默认 50）
 *   - delayMs: 批间 sleep（默认 0；CLI 默认 200）
 *   - resume: 跳过已回填（money_flow 行数 ≥ resumeThreshold）的 code
 *   - resumeThreshold: 判定已回填阈值（默认 240）
 *   - dryRun: 只统计不写库
 *   - sleepFn: 可注入的 sleep（测试用，默认真实 setTimeout）
 *   - onProgress: (info) => void 进度回调
 * @returns {Promise<{total:number, done:number, ok:number, empty:number, error:number, skipped:number, rows:number}>}
 */
export async function backfillAll(db, provider, codes, opts = {}) {
  const batchSize = Number(opts.batchSize) || 50;
  const delayMs = Number(opts.delayMs) || 0;
  const resume = !!opts.resume;
  const resumeThreshold = Number(opts.resumeThreshold) || 240;
  const dryRun = !!opts.dryRun;
  const sleepFn = typeof opts.sleepFn === 'function'
    ? opts.sleepFn
    : (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const total = codes.length;
  const summary = { total, done: 0, ok: 0, empty: 0, error: 0, skipped: 0, rows: 0 };
  const t0 = Date.now();
  const sleep = (ms) => (ms > 0 ? sleepFn(ms) : Promise.resolve());

  for (let start = 0; start < total; start += batchSize) {
    const batch = codes.slice(start, start + batchSize);
    const batchStart = Date.now();
    const batchResult = [];

    for (const code of batch) {
      // 断点续跑：跳过已回填（money_flow 行数 ≥ 阈值）的 code
      if (resume) {
        const existing = db.get(
          'SELECT COUNT(*) AS n FROM money_flow WHERE code = ? AND main_net_inflow IS NOT NULL',
          [code],
        );
        if (existing && existing.n >= resumeThreshold) {
          summary.skipped++;
          summary.done++;
          batchResult.push({ code, status: 'skipped' });
          continue;
        }
      }

      // 干跑：只统计，不写库
      if (dryRun) {
        summary.done++;
        batchResult.push({ code, status: 'dry-run' });
        continue;
      }

      try {
        const r = await backfillStock(db, provider, code, opts);
        summary.done++;
        if (r.status === 'ok') {
          summary.ok++;
          summary.rows += r.rows;
        } else if (r.status === 'empty') {
          summary.empty++;
        }
        batchResult.push(r);
      } catch (e) {
        // 失败 code 记日志、跳过、继续全量，不中断
        summary.done++;
        summary.error++;
        batchResult.push({ code, status: 'error', error: e?.message || String(e) });
      }
    }

    const batchCost = Date.now() - batchStart;
    const accCost = Date.now() - t0;
    if (typeof opts.onProgress === 'function') {
      opts.onProgress({
        done: summary.done,
        total,
        percent: total ? ((summary.done / total) * 100).toFixed(1) : '0.0',
        batchCostMs: batchCost,
        accCostMs: accCost,
        batch: batchResult,
      });
    }

    // 批间礼貌限速（仅真实运行，且非最后一批）
    if (!dryRun && delayMs > 0 && start + batchSize < total) {
      await sleep(delayMs);
    }
  }

  return summary;
}
