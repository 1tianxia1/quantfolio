// ============================================================
// MarketSnapshotService —— 全市场快照同步（东财 clist 列表接口）
//
// 存在意义（修复 D1「筛选器无数据」）：
//   quoteSyncService 走的是**日 K 接口**，而东财日 K **不返回**
//   流通市值 / 换手率 / 量比 / PE / 行业。于是 securities.circ_mv 长期只有
//   seed 阶段手工种下的 77 只有值，screener/pipeline 读 circ_mv 时
//   36697 只里只有 77 只可用，漏斗必然「静默 0 命中」。
//
//   东财 clist（沪深京 A 股列表）一次请求即可返回上述全部字段，
//   5900 只 A 股只需约 30 次请求，是补齐这些字段的正确数据源。
//
// 写入两处（读取端口径不同，必须都写）：
//   1) securities   —— screener 的 circ_mv / sector / industry 由此读取
//                      （securityModel.getQuotes 是 JOIN securities 取的市值）
//   2) daily_quotes —— 当日那根 K 线的 turnover_rate / volume_ratio / 估值
//
// 红线：
//   · 上游返回 '-'（停牌无价）一律解析为 null，不补 0、不沿用前值；
//   · close/volume 缺失的标的**只更新 securities，不写 daily_quotes**
//     （daily_quotes.close/volume 为 NOT NULL，补零即等于编造行情）；
//   · sector 采取「仅在为空时填充」策略，避免覆盖 seed 阶段人工标注的
//     概念板块（如 'AI芯片'）—— 上游 f100 是申万行业口径，两者语义不同。
// ============================================================
import { emClient as defaultClient } from '../providers/emClient.js';
import { CLIST_FS } from '../providers/emEndpoints.js';
import { tryNormalizeCode, marketFromCode } from '../util/codeUtil.js';

/** daily_quotes 落库列（顺序即绑定参数顺序） */
const DQ_COLS = Object.freeze([
  'code', 'trade_date', 'open', 'high', 'low', 'close', 'pre_close', 'volume', 'amount',
  'pct_chg', 'turnover_rate', 'volume_ratio', 'pe_ttm', 'pb', 'total_mv', 'circ_mv', 'data_origin',
]);

/**
 * 板/涨跌幅限制推断（与 quoteSyncService#inferBoard、seed/securities#inferBoard 同规则）
 * @param {string} code 6 位裸码
 * @param {string|null} name 证券名称（识别 ST）
 * @returns {{board: string, priceLimit: number, isST: boolean}}
 */
function inferBoard(code, name) {
  const nm = String(name || '');
  const isST = /ST/i.test(nm);
  let board = 'SZ-Main10';
  let priceLimit = 10;
  if (/^688/.test(code) || /^689/.test(code)) { board = 'STAR20'; priceLimit = 20; }
  else if (/^300/.test(code) || /^301/.test(code)) { board = 'ChiNext20'; priceLimit = 20; }
  else if (/^8/.test(code) || /^4/.test(code) || /^920/.test(code)) { board = 'BSE30'; priceLimit = 30; }
  else if (/^60/.test(code)) { board = 'SH-Main10'; priceLimit = 10; }
  if (isST) priceLimit = 5;
  return { board, priceLimit, isST };
}

/**
 * 上游 ts（unix 秒）→ 北京时区交易日 YYYY-MM-DD
 *
 * 用 +8 偏移显式换算而非 toISOString()：后者按 UTC 取日期，
 * 北京时间 00:00~08:00 之间会回退成前一天。
 *
 * @param {number|null} ts unix 时间戳（秒）
 * @returns {string|null} YYYY-MM-DD
 */
function tsToTradeDate(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date((n + 8 * 3600) * 1000).toISOString().slice(0, 10);
}

/**
 * 上游 list_date '20211018' → '2021-10-18'
 * @param {string|null} raw 8 位日期串
 * @returns {string|null}
 */
function normalizeListDate(raw) {
  const s = String(raw ?? '').trim();
  return /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : null;
}

/** 有限数才返回，'-'/null/NaN 一律 null（绝不补 0） */
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * 创建全市场快照同步服务
 * @param {import('../db/driver.js').Database} db 数据库句柄
 * @param {object} [options] 选项
 * @param {object} [options.client] 注入自定义 EmClient
 * @param {boolean} [options.quiet] 静默模式
 * @returns {object} MarketSnapshotService 实例
 */
export function createMarketSnapshotService(db, options = {}) {
  const client = options.client || defaultClient;
  const quiet = !!options.quiet;
  const log = (...a) => { if (!quiet) console.log('[marketSnapshot]', ...a); };

  const dqSql = `INSERT INTO daily_quotes (${DQ_COLS.join(',')}) VALUES (${DQ_COLS.map(() => '?').join(',')}) `
    + `ON CONFLICT(code,trade_date) DO UPDATE SET ${DQ_COLS.filter((c) => c !== 'code' && c !== 'trade_date').map((c) => `${c}=excluded.${c}`).join(',')}`;

  // securities：已存在则更新「行情派生」字段，不动 sector（除非原来为空）
  const secInsertSql = `
    INSERT INTO securities (
      code, name, market, type, board, price_limit_pct, industry, sector, list_date,
      is_st, is_index_member, circ_mv, total_mv, pe_ttm, pb, data_origin
    ) VALUES (?,?,?,?,?,?,?,?,?,?,0,?,?,?,?,'real')
    ON CONFLICT(code) DO UPDATE SET
      name            = excluded.name,
      board           = excluded.board,
      price_limit_pct = excluded.price_limit_pct,
      industry        = COALESCE(excluded.industry, securities.industry),
      sector          = COALESCE(securities.sector, excluded.sector),
      list_date       = COALESCE(excluded.list_date, securities.list_date),
      is_st           = excluded.is_st,
      circ_mv         = COALESCE(excluded.circ_mv, securities.circ_mv),
      total_mv        = COALESCE(excluded.total_mv, securities.total_mv),
      pe_ttm          = COALESCE(excluded.pe_ttm, securities.pe_ttm),
      pb              = COALESCE(excluded.pb, securities.pb)
  `;

  return {
    name: 'marketSnapshotService',
    client,

    /**
     * 拉取沪深京 A 股全市场快照并回填 securities + daily_quotes
     *
     * @param {object} [opts] 选项
     * @param {string} [opts.fs] 东财 fs 选择器，默认沪深京 A 股
     * @param {number} [opts.pageSize=200] 每页条数（上限 500）
     * @param {number} [opts.maxPages=60] 最多翻页数（5900 只 / 200 ≈ 30 页）
     * @returns {Promise<object>} 同步统计
     */
    async syncAShareSnapshot(opts = {}) {
      const fs = opts.fs || CLIST_FS.A_SHARE;
      const pageSize = Math.min(500, Math.max(20, Number(opts.pageSize) || 200));
      const maxPages = Math.max(1, Number(opts.maxPages) || 60);

      log(`拉取全市场 A 股快照（每页 ${pageSize}，最多 ${maxPages} 页）…`);
      const list = await client.fetchList({ fs, pageSize, maxPages, fid: 'f3', po: 1, noCache: true });
      const rows = list?.rows || [];
      if (rows.length === 0) {
        return { ok: false, reason: '东财 clist 无数据或不可达（已降级，不写库）', total: 0 };
      }
      log(`上游返回 ${rows.length} 条（total=${list.total}）`);

      const stats = {
        ok: true,
        fetched: rows.length,
        upstreamTotal: list.total,
        secWritten: 0,
        dqWritten: 0,
        dqSkippedNoPrice: 0,
        invalidCode: 0,
        duplicated: 0,
        tradeDates: {},
      };

      const secStmt = db.prepare(secInsertSql);
      const dqStmt = db.prepare(dqSql);
      const seen = new Set(); // 跨页并列值会导致同一标的中途重复返回，去重避免重复写库

      const tx = db.transaction(() => {
        for (const r of rows) {
          const code = tryNormalizeCode(r.code);
          if (!code) { stats.invalidCode += 1; continue; }
          if (seen.has(code)) { stats.duplicated += 1; continue; }
          seen.add(code);

          const name = r.name || code;
          const { board, priceLimit, isST } = inferBoard(code, name);
          const industry = r.industry || null;

          secStmt.run(
            code, name, marketFromCode(code, 'stock'), 'stock', board, priceLimit,
            industry, industry, normalizeListDate(r.list_date),
            isST ? 1 : 0,
            num(r.circ_mv), num(r.total_mv), num(r.pe_ttm), num(r.pb),
          );
          stats.secWritten += 1;

          // ---- daily_quotes：无价/无量不写（NOT NULL 列，补零即编造）----
          const tradeDate = tsToTradeDate(r.ts);
          const close = num(r.close);
          const volume = num(r.volume);
          if (!tradeDate || close === null || volume === null) {
            stats.dqSkippedNoPrice += 1;
            continue;
          }

          dqStmt.run(
            code, tradeDate,
            num(r.open), num(r.high), num(r.low), close, num(r.pre_close),
            volume, num(r.amount), num(r.pct_chg), num(r.turnover_rate), num(r.volume_ratio),
            num(r.pe_ttm), num(r.pb), num(r.total_mv), num(r.circ_mv), 'real',
          );
          stats.dqWritten += 1;
          stats.tradeDates[tradeDate] = (stats.tradeDates[tradeDate] || 0) + 1;
        }
      });
      tx();

      log(`securities 更新 ${stats.secWritten} 条，daily_quotes 写入 ${stats.dqWritten} 行`
        + `（无价跳过 ${stats.dqSkippedNoPrice}）`);
      return stats;
    },
  };
}

export default createMarketSnapshotService;
