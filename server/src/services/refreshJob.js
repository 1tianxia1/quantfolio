// ============================================================
// 刷新任务管理器（单例）
// 把"回填真实行情 + 重算派生表"放到后台异步跑，避免 HTTP 请求被长事务阻塞。
// 状态（running/done/failed + 时间戳 + 结果）保存到内存并持久化 meta_kv，
// 这样前端可轮询进度，且服务重启后仍能看到上次结果。
// ============================================================
import { refreshRealData } from './realDataRefresher.js';
import { openDatabase } from '../db/driver.js';
import env from '../config/env.js';

const META_KEY = 'market_refresh_status';

const state = {
  status: 'idle', // idle | running | done | failed
  startedAt: null,
  finishedAt: null,
  lastError: null,
  lastResult: null, // { tradeDate, stats, finishedAt }
  running: false,
};

function loadPersisted(db) {
  try {
    const row = db.get('SELECT v FROM meta_kv WHERE k=?', [META_KEY]);
    if (row?.v) {
      const s = JSON.parse(row.v);
      // 只恢复非运行态：上次若中断在 running，应视为已结束而非卡死
      if (s && s.status !== 'running') Object.assign(state, s);
    }
  } catch (_e) {
    /* 忽略损坏的缓存 */
  }
}

function persist(db) {
  try {
    db.run(
      `INSERT INTO meta_kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`,
      [META_KEY, JSON.stringify({
        status: state.status,
        startedAt: state.startedAt,
        finishedAt: state.finishedAt,
        lastError: state.lastError,
        lastResult: state.lastResult,
      })],
    );
  } catch (_e) {
    /* 持久化失败不影响内存状态 */
  }
}

/** 读取当前刷新状态（前端轮询用） */
export function getRefreshState() {
  return { ...state };
}

/**
 * 触发一次后台刷新（若已有任务在跑则跳过）。
 * 注意：本函数自行打开/关闭数据库，调用方无需传入 db，也无需管理 db 生命周期，
 * 避免"调用方提前关闭 db 导致后台任务报 database connection is not open"的问题。
 * @param {object} [options] 透传给 refreshRealData（limit / max / types）
 * @returns {Promise<{started: boolean, alreadyRunning?: boolean, error?: string}>}
 */
export async function startRefresh(options = {}) {
  let db = null;
  try {
    db = await openDatabase(env.DB_PATH);
  } catch (e) {
    return { started: false, error: e?.message || String(e) };
  }

  loadPersisted(db);
  if (state.running) {
    try { db.close(); } catch (_) { /* 忽略 */ }
    return { started: false, alreadyRunning: true };
  }

  state.running = true;
  state.status = 'running';
  state.startedAt = new Date().toISOString();
  state.lastError = null;
  persist(db);

  // 后台执行，不阻塞调用方；用独立微任务跑长事务，db 生命周期由本函数独占
  (async () => {
    try {
      const result = await refreshRealData(db, { quiet: true, ...options });
      state.lastResult = {
        tradeDate: result.tradeDate,
        stats: result.stats,
        finishedAt: new Date().toISOString(),
      };
      state.status = 'done';
      // 将最新交易日和合规文案写入 meta_kv，供前端全局展示
      try {
        const kv = db.prepare(`INSERT INTO meta_kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`);
        kv.run('trade_date', result.tradeDate || '');
        kv.run('compliance', `行情截至 ${result.tradeDate || ''} 收盘，数据来自东方财富（实时行情）`);
      } catch (_e) { /* 静默忽略，不影响主流程 */ }
    } catch (e) {
      state.lastError = e?.message || String(e);
      state.status = 'failed';
    } finally {
      state.running = false;
      state.finishedAt = new Date().toISOString();
      persist(db);
      try { db.close(); } catch (_) { /* 忽略 */ }
    }
  })();

  return { started: true };
}
