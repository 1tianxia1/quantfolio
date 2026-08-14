// ============================================================
// MarketScheduler —— 全交易日调度器
//
// 定位：在 intradayPoller（15s 持仓轮询）之上，管理全市场级别的
//   数据刷新任务，确保选股/筛选用到的字段（换手率/量比/市值/PE/
//   竞价涨幅/资金流）保持准实时且真实。
//
// 调度表：
//   1) 竞价窗口 9:15–9:25  每 60s 拉全市场竞价快照 → 写 auction_data
//   2) 9:25 定格              采集最终竞价结果 + 触发首次全市场快照
//   3) 盘中 9:30–14:55        每 SNAPSHOT_INTERVAL_MIN 分钟全市场快照（clist）
//   4) 收盘后 15:05           全量日 K 回填 + 派生表重算 + 真实资金流
//
// 红线：
//   · 所有远端请求走 emClient 三道闸，失败返回 null/空数组，不编造；
//   · 竞价量/竞价量比拿不到就置 null（东财/腾讯实时源不提供竞价明细量）；
//   · 资金流走 backfillMoneyFlowLib 的真实 fflow 接口，拿不到留 null。
// ============================================================
import env from '../config/env.js';
import { emClient } from '../providers/emClient.js';
import {
  isAuctionWindow,
  isPostAuction,
  isMarketOpen,
  beijingToday,
  isTradingDay,
} from '../util/tradingTime.js';
import { createMarketSnapshotService } from './marketSnapshotService.js';
import { refreshRealData } from './realDataRefresher.js';
import { createQuoteSyncService } from './quoteSyncService.js';
import { deriveFields } from '../seed/derivedFields.js';
import { seedIndicators } from '../seed/indicators.js';
import { seedLimitRecords } from '../seed/limitRecords.js';
import { seedHotSectors } from '../seed/hotSectors.js';
import { round4 } from '../util/money.js';

/** 盘中全市场快照间隔（分钟），可通过 env 覆盖 */
const SNAPSHOT_INTERVAL_MIN = Number(env.MARKET_SNAPSHOT_INTERVAL_MIN) || 5;
const SNAPSHOT_INTERVAL_MS = SNAPSHOT_INTERVAL_MIN * 60 * 1000;

/** 日志开关 */
const QUIET = String(env.MARKET_SCHEDULER_QUIET || '') === 'true';

function log(...args) {
  if (!QUIET) console.log('[scheduler]', ...args);
}

/**
 * 创建并启动全市场调度器
 * @param {import('../db/driver.js').Database} db 数据库句柄
 * @returns {{ stop: () => void }}
 */
export function startMarketScheduler(db) {
  let timer = null;
  let lastSnapshotTime = 0;
  let auctionDone = false; // 当日竞价定格是否已完成
  let eodDone = false;     // 当日收盘任务是否已完成
  let currentDate = '';     // 当日日期，跨日重置标记

  const snapshotService = createMarketSnapshotService(db, { quiet: QUIET });

  /**
   * 单次调度 tick（每分钟被 timer 调用）
   */
  async function tick() {
    const now = new Date();
    const today = beijingToday(now);

    // 跨日重置
    if (today !== currentDate) {
      currentDate = today;
      auctionDone = false;
      eodDone = false;
      lastSnapshotTime = 0;
      log(`新交易日 ${today}，调度标记已重置`);
    }

    // 非交易日静默
    if (!isTradingDay(now)) return;

    // ---- 1) 竞价窗口 9:15–9:25 ----
    if (isAuctionWindow(now) && !auctionDone) {
      await tickAuctionSnapshot(db);
    }

    // ---- 2) 9:25 竞价定格 ----
    if (isPostAuction(now) && !auctionDone) {
      await tickAuctionFinal(db);
      auctionDone = true;
      // 定格后立刻拉一次全市场快照，开盘前选股数据就位
      await tickFullSnapshot(db);
      lastSnapshotTime = Date.now();
    }

    // ---- 3) 盘中全市场快照 ----
    if (isMarketOpen(now) && Date.now() - lastSnapshotTime >= SNAPSHOT_INTERVAL_MS) {
      await tickFullSnapshot(db);
      lastSnapshotTime = Date.now();
    }

    // ---- 4) 收盘后 15:05 全量回填 ----
    const t = (() => {
      const info = (() => {
        const offsetMs = 8 * 3600000;
        const beijing = new Date(now.getTime() + offsetMs);
        return { minutes: beijing.getUTCHours() * 60 + beijing.getUTCMinutes() };
      })();
      return info.minutes;
    })();
    if (t >= 15 * 60 + 5 && t < 16 * 60 && !eodDone && currentDate === today) {
      eodDone = true;
      await tickEndOfDay(db);
    }
  }

  // ----------------------------------------------------------
  // 子任务实现
  // ----------------------------------------------------------

  /**
   * 竞价窗口快照：拉全市场 clist，取 open/pre_close 算竞价涨幅
   * 竞价量/量比无法获取（东财/腾讯不提供竞价明细），置 null。
   */
  async function tickAuctionSnapshot(db) {
    try {
      const list = await emClient.fetchList({
        fs: 'b:MK0021,b:MK0022,b:MK0023,b:MK0024,b:MK0401,b:MK0402,b:MK0403,b:MK0404',
        pageSize: 200,
        maxPages: 60,
        fid: 'f3',
        po: 1,
        noCache: true,
      });
      const rows = list?.rows || [];
      if (rows.length === 0) return;

      const today = beijingToday();
      const upsert = db.prepare(
        `INSERT INTO auction_data (code, trade_date, auction_price, auction_pct,
           auction_volume, auction_amount, auction_vol_ratio, first_trade_vol_ratio, data_origin)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'real')
         ON CONFLICT(code, trade_date) DO UPDATE SET
           auction_price   = excluded.auction_price,
           auction_pct     = excluded.auction_pct,
           auction_volume = COALESCE(excluded.auction_volume, auction_data.auction_volume),
           auction_amount = COALESCE(excluded.auction_amount, auction_data.auction_amount),
           auction_vol_ratio = COALESCE(excluded.auction_vol_ratio, auction_data.auction_vol_ratio),
           first_trade_vol_ratio = COALESCE(excluded.first_trade_vol_ratio, auction_data.first_trade_vol_ratio),
           data_origin    = excluded.data_origin`,
      );

      const tx = db.transaction(() => {
        let count = 0;
        for (const r of rows) {
          if (!r.code) continue;
          const open = r.open != null ? Number(r.open) : null;
          const preClose = r.pre_close != null ? Number(r.pre_close) : null;
          if (open == null || preClose == null || preClose === 0) continue;
          const pct = round4(((open / preClose) - 1) * 100);
          upsert.run(r.code, today, open, pct, null, null, null, null);
          count++;
        }
        return count;
      });
      const count = tx();
      if (count > 0) log(`竞价快照：${count} 只（open/pre_close→auction_pct，竞价量暂无数据源）`);
    } catch (e) {
      log(`竞价快照失败（已忽略）：${e.message}`);
    }
  }

  /**
   * 竞价定格：9:25 后开盘价已确定，用 clist 数据做最终竞价写入
   * 同时触发一次全市场快照
   */
  async function tickAuctionFinal(db) {
    log('竞价定格：采集最终竞价结果');
    await tickAuctionSnapshot(db);
  }

  /**
   * 全市场快照：通过 clist 一次性补齐全市场换手率/量比/市值/PE
   * 写入 securities + daily_quotes（双写），约 30-60 次请求，10s 内完成。
   */
  async function tickFullSnapshot(db) {
    try {
      const stats = await snapshotService.syncAShareSnapshot({
        pageSize: 100,
        maxPages: 60,
      });
      if (stats.ok) {
        log(`全市场快照完成：securities ${stats.secWritten} / daily_quotes ${stats.dqWritten}`);
        // 更新交易日标记
        if (stats.tradeDates) {
          const dates = Object.keys(stats.tradeDates);
          if (dates.length > 0) {
            const latestDate = dates.sort().pop();
            const kv = db.prepare(`INSERT INTO meta_kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`);
            kv.run('trade_date', latestDate);
          }
        }
      }
    } catch (e) {
      log(`全市场快照失败（已忽略）：${e.message}`);
    }
  }

  /**
   * 收盘全量回填：日 K → 派生表重算 → 真实资金流
   * 独立开库避免长事务与在线请求冲突。
   */
  async function tickEndOfDay(db) {
    log('收盘任务开始：日 K 回填 + 派生表重算');
    try {
      // 复用现有 refreshRealData（含日 K 回填 + 派生重算）
      // 但跳过 seedAuctionData 的随机模拟（竞价数据已由 tickAuctionFinal 写入真实值）
      await refreshRealDataEodSafe(db);
      log('收盘任务完成');
    } catch (e) {
      log(`收盘任务失败（已忽略）：${e.message}`);
    }
  }

  // 启动定时器（每 60s 检查一次——竞价窗口分钟级精度足够）
  timer = setInterval(tick, 60_000);

  // 启动后立即执行一次
  tick();

  log(`调度器已启动（快照间隔 ${SNAPSHOT_INTERVAL_MIN}min，竞价窗口 60s）`);

  return {
    stop() {
      if (timer) { clearInterval(timer); timer = null; }
      log('调度器已停止');
    },
  };
}

/**
 * 收盘安全的 refreshRealData 变体：
 * 不调用 seedMoneyFlow（随机模拟）和 seedAuctionData（随机模拟），
 * 改为只重算技术指标/涨停/板块，资金流走真实 fflow 回填。
 */
async function refreshRealDataEodSafe(db) {
  const { openDatabase } = await import('../db/driver.js');
  const { deriveFields: df } = await import('../seed/derivedFields.js');
  const { seedIndicators: si } = await import('../seed/indicators.js');
  const { seedLimitRecords: slr } = await import('../seed/limitRecords.js');
  const { seedHotSectors: shs } = await import('../seed/hotSectors.js');

  const refreshDb = await openDatabase(env.DB_PATH);
  const limit = Number(env.AUTO_REFRESH_KLINE_LIMIT) || 250;
  const quiet = true;

  // 1) 日 K 回填
  const sync = createQuoteSyncService(refreshDb, { quiet });
  const syncSummary = await sync.syncUniverse({ types: ['stock', 'fund'], limit, max: 0 });
  const syncedCodes = Array.isArray(syncSummary.codes) ? syncSummary.codes : [];
  const codeSet = syncedCodes.length ? new Set(syncedCodes) : null;

  // 2) 读回 K 线并富化
  const BAR_SELECT_COLS = `SELECT code, trade_date, open, high, low, close, pre_close,
                             volume, amount, pct_chg, turnover_rate, volume_ratio,
                             pe_ttm, pb, total_mv, circ_mv
                      FROM daily_quotes`;
  const barsByCode = new Map();
  const CHUNK = 400;
  const scanChunk = (codes) => {
    const ph = codes.map(() => '?').join(',');
    const stmt = refreshDb.prepare(`${BAR_SELECT_COLS} WHERE code IN (${ph}) ORDER BY code ASC, trade_date ASC`);
    for (const r of stmt.iterate(...codes)) {
      let arr = barsByCode.get(r.code);
      if (!arr) { arr = []; barsByCode.set(r.code, arr); }
      arr.push(r);
    }
  };
  if (codeSet && codeSet.size > 0) {
    const codes = [...codeSet];
    for (let i = 0; i < codes.length; i += CHUNK) scanChunk(codes.slice(i, i + CHUNK));
  }
  for (const [code, bars] of barsByCode) barsByCode.set(code, df(bars));

  // 3) 重算技术指标/涨停/板块（不含资金流/竞价——已由调度器实时写入）
  si(refreshDb, barsByCode);
  const items = buildEodItems(refreshDb, barsByCode);
  slr(refreshDb, items, barsByCode);
  shs(refreshDb, barsByCode);

  // 4) 真实资金流回填（走 emClient.fetchMoneyFlow）
  await backfillRealMoneyFlow(refreshDb, items, barsByCode);

  // 5) 更新交易日
  const td = refreshDb.get('SELECT MAX(trade_date) AS d FROM daily_quotes')?.d ?? null;
  if (td) {
    refreshDb.run("INSERT INTO meta_kv(k,v) VALUES('trade_date',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", [td]);
  }

  try { refreshDb.close(); } catch (_) { /* noop */ }
  if (!QUIET) log(`EOD 安全刷新完成：日 K ${syncSummary.succeeded}/${syncSummary.failed}，派生表已重算`);
}

function buildEodItems(db, barsByCode) {
  const secRows = db.all(`SELECT code, name, type FROM securities WHERE type IN ('stock','fund')`);
  const items = [];
  for (const s of secRows) {
    const bars = barsByCode.get(s.code);
    if (!bars || bars.length === 0) continue;
    const last = bars[bars.length - 1];
    items.push({ code: s.code, name: s.name, type: s.type, changePct: last.pct_chg ?? null, mainNetInflow: null, tags: [] });
  }
  return items;
}

/**
 * 真实资金流回填：用 emClient.fetchMoneyFlow 逐只拉东财 fflow
 * 受令牌桶约束（5 QPS），对全市场耗时较长，后台异步执行。
 * 拿不到的留 null（不编造）。
 */
async function backfillRealMoneyFlow(db, items, barsByCode) {
  const BATCH_SIZE = 20; // 每批只数
  const BATCH_DELAY_MS = 5000; // 批间延迟（5 QPS → 20 只 ≈ 4s，加 1s 缓冲）
  let done = 0;
  let failed = 0;

  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const batch = items.slice(i, i + BATCH_SIZE);
    // eslint-disable-next-line no-await-in-loop
    if (i > 0) await sleep(BATCH_DELAY_MS);

    const tx = db.transaction(() => {
      for (const item of batch) {
        try {
          // 注意：fetchMoneyFlow 是内部方法，需通过 emClient 对象调用
          // 这里暂时跳过异步调用（事务内不能 await），
          // 改为在循环外逐只调用再事务写入
        } catch (_) {
          failed++;
        }
      }
    });

    // 逐只拉取（事务外 await，写入走批量事务）
    const rows = [];
    for (const item of batch) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const flows = await emClient.fetchMoneyFlow(item.code, { limit: 5, noCache: true });
        if (flows && flows.length > 0) {
          const latest = flows[flows.length - 1];
          const rawMain = Number(latest.main_net_inflow);
          const mainWan = Number.isFinite(rawMain) ? rawMain / 10000 : null; // 元→万元
          // 滚动 3d/5d
          let sum3 = 0, sum5 = 0;
          const n = flows.length;
          for (let j = Math.max(0, n - 3); j < n; j++) {
            const v = Number(flows[j].main_net_inflow);
            sum3 += Number.isFinite(v) ? v / 10000 : 0;
          }
          for (let j = Math.max(0, n - 5); j < n; j++) {
            const v = Number(flows[j].main_net_inflow);
            sum5 += Number.isFinite(v) ? v / 10000 : 0;
          }
          rows.push({
            code: item.code,
            trade_date: latest.date || beijingToday(),
            main_net_inflow: mainWan != null ? round4(mainWan) : null,
            net_inflow_3d: round4(sum3),
            net_inflow_5d: round4(sum5),
            data_origin: 'real',
          });
          done++;
        }
      } catch (_) {
        failed++;
      }
    }

    if (rows.length > 0) {
      const upsert = db.prepare(
        `INSERT INTO money_flow (code, trade_date, main_net_inflow, net_inflow_3d, net_inflow_5d, data_origin)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(code, trade_date) DO UPDATE SET
           main_net_inflow = excluded.main_net_inflow,
           net_inflow_3d = excluded.net_inflow_3d,
           net_inflow_5d = excluded.net_inflow_5d,
           data_origin = excluded.data_origin`,
      );
      const writeTx = db.transaction(() => {
        for (const r of rows) upsert.run(r.code, r.trade_date, r.main_net_inflow, r.net_inflow_3d, r.net_inflow_5d, r.data_origin);
      });
      writeTx();
    }
  }

  if (done > 0 || failed > 0) log(`资金流回填：成功 ${done} / 失败 ${failed}`);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

export default startMarketScheduler;
