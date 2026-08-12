// ============================================================
// RealDataRefresher —— 「回填真实行情 + 重算派生表」一体化编排
//
// 定位：
//   业务分析层（screener / pipeline / score / indicator）读的是派生表
//   （tech_indicators / money_flow / auction_data / limit_records / hot_sectors），
//   这些表由 seed 阶段从 daily_quotes 计算而来。因此「接入真实行情」不是
//   把分析层改成远程调用，而是：
//     1) quoteSyncService 把东财真实日 K 回填进 daily_quotes（data_origin='real'）
//     2) 复用 seed 的派生计算函数，基于新的 daily_quotes 重算全部派生表
//   分析层代码一行不改，数据自动变真实。
//
// 幂等性：syncUniverse 全部 ON CONFLICT DO UPDATE；派生函数各自 DELETE + 重建。
//         可重复跑、可断点续跑。
//
// 红线（架构 §7）：
//   · 不编造任何行情数值。quoteSyncService 对缺 close/volume 的 K 线直接跳过；
//   · 派生函数保持其原有语义（缺值即派生并标注 data_origin='derived'，或留空），
//     本模块不为「看起来更全」给任何字段填 0 或估算值；
//   · 无 daily_quotes 的证券**不参与派生**——否则 seedMoneyFlow 会用硬编码兜底
//     交易日为其造出一行资金流，那是凭空捏造（见 buildItems 注释）。
// ============================================================
import { createQuoteSyncService } from './quoteSyncService.js';
import { deriveFields } from '../seed/derivedFields.js';
import { seedIndicators } from '../seed/indicators.js';
import { seedMoneyFlow, seedAuctionData } from '../seed/moneyFlow.js';
import { seedLimitRecords } from '../seed/limitRecords.js';
import { seedHotSectors } from '../seed/hotSectors.js';

/** 从 daily_quotes 读取的列（顺序即 seed 派生函数期望的 bar 字段集） */
const BAR_SELECT_COLS = `SELECT code, trade_date, open, high, low, close, pre_close,
                           volume, amount, pct_chg, turnover_rate, volume_ratio,
                           pe_ttm, pb, total_mv, circ_mv
                    FROM daily_quotes`;
const BAR_ORDER = `ORDER BY code ASC, trade_date ASC`;

/**
 * 把 daily_quotes 按 code 范围读出并分组，逐组附加派生字段
 *
 * 内存友好设计（2GB 小机器可用）：
 *   - 通过流式游标 db.prepare().iterate() 逐行产出，避免把全表物化成数组；
 *   - 当传入 codeSet 时，只扫描「本次同步的标的」的 K 线（WHERE code IN (...) 分块），
 *     而不是 264 万行全量读入。这样内存占用只与同步标的数量成正比，与全市场无关。
 *
 * @param {import('../db/driver.js').Database} db 数据库句柄
 * @param {Set<string>|null} [codeSet] 需要载入的 code 集合；缺省/null = 全量载入
 * @returns {Map<string, object[]>} code -> 已附加派生字段的升序 bars
 */
function buildBarsByCode(db, codeSet) {
  const barsByCode = new Map();
  const CHUNK = 400; // 单条 IN 语句绑定参数上限（远低于 SQLite 999 限制，安全）

  const scanChunk = (codes) => {
    const ph = codes.map(() => '?').join(',');
    const stmt = db.prepare(`${BAR_SELECT_COLS} WHERE code IN (${ph}) ${BAR_ORDER}`);
    for (const r of stmt.iterate(...codes)) {
      let arr = barsByCode.get(r.code);
      if (!arr) {
        arr = [];
        barsByCode.set(r.code, arr);
      }
      arr.push(r);
    }
  };

  if (codeSet && codeSet.size > 0) {
    const codes = [...codeSet];
    for (let i = 0; i < codes.length; i += CHUNK) scanChunk(codes.slice(i, i + CHUNK));
  } else {
    const stmt = db.prepare(`${BAR_SELECT_COLS} ${BAR_ORDER}`);
    for (const r of stmt.iterate()) {
      let arr = barsByCode.get(r.code);
      if (!arr) {
        arr = [];
        barsByCode.set(r.code, arr);
      }
      arr.push(r);
    }
  }

  // 逐只富化（volume_ratio / vol_ratio_5 / volume_streak / high_60d_distance_pct）
  // 原地替换：旧数组随即成为垃圾，避免同时驻留原始与富化两份全量
  for (const [code, bars] of barsByCode) {
    barsByCode.set(code, deriveFields(bars));
  }

  return barsByCode;
}

/**
 * 允许参与 money_flow / auction_data / limit_records 派生的证券类型
 *
 * 与 seed/run.js 的 `items = [...data.stocks, ...data.funds]` 保持一致：
 * 库里另有 index 类型（指数），指数没有竞价与涨停语义，且
 * securityModel.auctionLeaderboard 不按 type 过滤 —— 一旦为指数生成
 * auction_data，竞价榜会混入指数行，属于口径污染。
 */
const DERIVE_TYPES = Object.freeze(['stock', 'fund']);

/**
 * 构建派生函数所需的 item 列表
 *
 * ⚠️ 只纳入 **有 daily_quotes 的证券**：
 *    seedMoneyFlow 对无 bars 的标的会退化用硬编码交易日写入一行派生资金流，
 *    对一只根本没有行情的证券而言，那个交易日与金额都是凭空捏造的。
 *    宁可少一行，不可假一行。
 *
 * @param {import('../db/driver.js').Database} db 数据库句柄
 * @param {Map<string, object[]>} barsByCode code -> bars
 * @returns {object[]} item 数组（含 code / name / type / changePct / mainNetInflow / tags）
 */
function buildItems(db, barsByCode) {
  const secRows = db.all(
    `SELECT code, name, type FROM securities WHERE type IN (${DERIVE_TYPES.map(() => '?').join(',')})`,
    [...DERIVE_TYPES],
  );
  const items = [];

  for (const s of secRows) {
    const bars = barsByCode.get(s.code);
    if (!bars || bars.length === 0) continue;
    const last = bars[bars.length - 1];
    items.push({
      code: s.code,
      name: s.name,
      type: s.type,
      // 真实末根涨跌幅：供 seedLimitRecords 按板涨跌停幅派生真实涨停记录
      changePct: last.pct_chg ?? null,
      // 东财日 K 不含主力资金流，如实留空 → seedMoneyFlow 走 derived 分支并标注来源
      mainNetInflow: null,
      // 真实形态标签由 security_tags 维护，本路径不注入，避免与 seed 双写冲突
      tags: [],
    });
  }

  return items;
}

/**
 * 回填真实行情并重算全部派生表
 *
 * @param {import('../db/driver.js').Database} db 数据库句柄
 * @param {object} [options] 选项
 * @param {number} [options.max=0] 最多同步多少只标的（0 = 全量），用于小步验证
 * @param {number} [options.limit=250] 每只标的拉取的日 K 根数
 * @param {string[]} [options.types=['stock','fund']] 参与同步的证券类型
 * @param {boolean} [options.quiet=false] 静默模式（不打进度日志）
 * @returns {Promise<{syncSummary: object, recompute: string, tradeDate: string|null, stats: object}>}
 */
export async function refreshRealData(db, options = {}) {
  const max = Number(options.max) || 0;
  const limit = Number(options.limit) || 250;
  const types = Array.isArray(options.types) && options.types.length
    ? options.types
    : ['stock', 'fund'];
  const quiet = !!options.quiet;

  /** 统一日志出口（quiet 模式下静默） */
  const log = (...args) => {
    if (!quiet) console.log('[realDataRefresh]', ...args);
  };

  const t0 = Date.now();

  // ---------- 1) 回填真实日 K 到 daily_quotes ----------
  log(`开始回填真实行情（types=${types.join('/')}，max=${max || '全量'}，每只 ${limit} 根）`);
  const sync = createQuoteSyncService(db, { quiet });
  const syncSummary = await sync.syncUniverse({ types, limit, max });
  const tSync = Date.now();
  log(`回填完成：成功 ${syncSummary.succeeded} / 失败 ${syncSummary.failed}，`
    + `写入 ${syncSummary.written} 行，跳过 ${syncSummary.skipped} 行，耗时 ${((tSync - t0) / 1000).toFixed(1)}s`);

  // 本次实际同步到的 code 集合（syncUniverse 已附带）。重算只针对这些标的，
  // 内存占用只与同步数量成正比，与全市场 264 万行解耦——2GB 小机器不再 OOM。
  const syncedCodes = Array.isArray(syncSummary.codes) ? syncSummary.codes : [];
  const codeSet = syncedCodes.length ? new Set(syncedCodes) : null;
  log(`仅对 ${syncedCodes.length} 只同步标的做派生重算（按 code 范围，不全量扫描）`);

  // ---------- 2) 读回「范围内」K 线并附加派生字段 ----------
  const barsByCode = buildBarsByCode(db, codeSet);
  const barCount = [...barsByCode.values()].reduce((s, b) => s + b.length, 0);
  const tBars = Date.now();
  log(`载入 K 线：${barsByCode.size} 只 / ${barCount} 根，耗时 ${((tBars - tSync) / 1000).toFixed(1)}s`);

  // ---------- 3) 构建派生输入 ----------
  const items = buildItems(db, barsByCode);
  const stockItems = items.filter((i) => i.type === 'stock');
  log(`参与派生的标的：${items.length} 只（其中股票 ${stockItems.length} 只）`);

  // ---------- 4) 重算派生表（顺序不可调换：hot_sectors 依赖 money_flow）----------
  seedIndicators(db, barsByCode);
  const tInd = Date.now();
  log(`tech_indicators 重算完成，耗时 ${((tInd - tBars) / 1000).toFixed(1)}s`);

  seedMoneyFlow(db, stockItems, barsByCode);
  seedAuctionData(db, items, barsByCode);
  const limitStat = seedLimitRecords(db, items, barsByCode);
  seedHotSectors(db, barsByCode);
  const tDerive = Date.now();
  log(`money_flow / auction_data / limit_records / hot_sectors 重算完成，`
    + `耗时 ${((tDerive - tInd) / 1000).toFixed(1)}s`
    + `（涨停记录：真实 ${limitStat?.realCount ?? 0} 条 + 派生 ${limitStat?.derivedCount ?? 0} 条）`);

  // ---------- 5) 更新最新交易日 ----------
  const td = db.get('SELECT MAX(trade_date) AS d FROM daily_quotes')?.d ?? null;
  if (td) {
    db.run(
      "INSERT INTO meta_kv(k,v) VALUES('trade_date',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v",
      [td],
    );
  }

  const stats = {
    codesWithBars: barsByCode.size,
    barCount,
    derivedItems: items.length,
    derivedStockItems: stockItems.length,
    limitRecords: { real: limitStat?.realCount ?? 0, derived: limitStat?.derivedCount ?? 0 },
    elapsedMs: Date.now() - t0,
  };
  log(`全部完成，总耗时 ${(stats.elapsedMs / 1000).toFixed(1)}s，最新交易日 ${td ?? '(空)'}`);

  return { syncSummary, recompute: 'ok', tradeDate: td, stats };
}

export default refreshRealData;
