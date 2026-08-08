// ============================================================
// QuoteSyncService —— 把东方财富行情落地到本地 daily_quotes
//
// 职责（架构 §6.1 T01）：
//   1. 拉东财日 K → 幂等 upsert 进既有 daily_quotes 表（复用现有 schema，不新增表）
//   2. 拉东财实时快照 → 覆盖当日那一根，并回填 pe/pb/市值
//   3. daily_quotes 有外键指向 securities，同步前保证证券主记录存在
//
// 幂等性：全部 `ON CONFLICT(code, trade_date) DO UPDATE`，可重复跑、可断点续跑。
//
// 红线（架构 §7）：
//   · close / volume 缺失的 K 线**直接跳过**，不用 0 或前值补 —— 那是编造；
//   · 东财不可达时返回 { ok:false, reason }，由调用方决定重试，绝不静默写脏数据；
//   · 落库一律 data_origin='real'，与派生数据（'derived'）严格区分。
//
// 单位口径：volume=手，amount=元，circ_mv/total_mv=亿元（与 securities 表一致）。
// ============================================================
import { emClient as defaultClient } from '../providers/emClient.js';
import { KLINE_MAX_LIMIT } from '../providers/emEndpoints.js';
import { normalizeCodes, tryNormalizeCode, marketFromCode, guessType } from '../util/codeUtil.js';

/** daily_quotes 落库列（顺序即绑定参数顺序） */
const DQ_COLS = Object.freeze([
  'code', 'trade_date', 'open', 'high', 'low', 'close', 'pre_close', 'volume', 'amount',
  'pct_chg', 'turnover_rate', 'volume_ratio', 'pe_ttm', 'pb', 'total_mv', 'circ_mv', 'data_origin',
]);

/** securities 落库列（仅在证券缺失时插入最小可用记录） */
const SEC_COLS = Object.freeze([
  'code', 'name', 'market', 'type', 'board', 'price_limit_pct', 'is_st', 'is_index_member', 'data_origin',
]);

function placeholders(cols) {
  return cols.map(() => '?').join(',');
}

function updateSet(cols, skip) {
  return cols.filter((c) => !skip.includes(c)).map((c) => `${c}=excluded.${c}`).join(',');
}

function rowToValues(cols, row) {
  return cols.map((c) => (row[c] === undefined ? null : row[c]));
}

/**
 * 板/涨跌幅限制推断
 *
 * ⚠️ 规则与 seed/securities.js#inferBoard 严格对齐（board 取值必须同名，
 *    否则前端按 board 分组统计会出现两套标签）。
 *
 * @param {string} code 6 位裸码
 * @param {string} type 'stock' | 'fund'
 * @param {string|null} name 证券名称（用于识别 ST）
 * @returns {{board: string, priceLimit: number, isST: boolean}}
 */
function inferBoard(code, type, name) {
  const nm = String(name || '');
  const isST = /ST/i.test(nm);
  if (type === 'fund') return { board: 'ETF', priceLimit: 10, isST: false };

  let board = 'SZ-Main10';
  let priceLimit = 10;
  if (/^688/.test(code) || /^689/.test(code)) { board = 'STAR20'; priceLimit = 20; }
  else if (/^300/.test(code) || /^301/.test(code)) { board = 'ChiNext20'; priceLimit = 20; }
  else if (/^8/.test(code) || /^4/.test(code) || /^920/.test(code)) { board = 'BSE30'; priceLimit = 30; }
  else if (/^60/.test(code)) { board = 'SH-Main10'; priceLimit = 10; }
  else if (/^000/.test(code) || /^001/.test(code) || /^002/.test(code) || /^003/.test(code)) { board = 'SZ-Main10'; priceLimit = 10; }
  if (isST) priceLimit = 5;
  return { board, priceLimit, isST };
}

/** 把数组切批 */
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * 创建行情同步服务
 *
 * @param {import('../db/driver.js').Database} db 数据库句柄
 * @param {object} [options] 选项
 * @param {object} [options.client] 注入自定义 EmClient（单测/脚本复用限频状态）
 * @param {boolean} [options.quiet] 静默模式（不打进度日志）
 * @returns {object} QuoteSyncService 实例
 */
export function createQuoteSyncService(db, options = {}) {
  const client = options.client || defaultClient;
  const quiet = !!options.quiet;

  const dqSql = `INSERT INTO daily_quotes (${DQ_COLS.join(',')}) VALUES (${placeholders(DQ_COLS)}) `
    + `ON CONFLICT(code,trade_date) DO UPDATE SET ${updateSet(DQ_COLS, ['code', 'trade_date'])}`;
  const secSql = `INSERT INTO securities (${SEC_COLS.join(',')}) VALUES (${placeholders(SEC_COLS)}) `
    + 'ON CONFLICT(code) DO NOTHING';

  function log(...args) {
    if (!quiet) console.log('[quoteSync]', ...args);
  }

  /**
   * 保证 securities 中存在该代码（daily_quotes 有外键约束，缺主记录会整批失败）
   * @param {string} code 6 位裸码
   * @param {string|null} name 名称（东财返回值优先）
   * @param {string} [type] 'stock' | 'fund'
   * @returns {boolean} 是否已存在或插入成功
   */
  function ensureSecurity(code, name, type) {
    const c = tryNormalizeCode(code);
    if (!c) return false;
    try {
      const exist = db.get('SELECT code FROM securities WHERE code = ?', [c]);
      if (exist) return true;
      const t = type || guessType(c);
      const { board, priceLimit, isST } = inferBoard(c, t, name);
      db.run(secSql, rowToValues(SEC_COLS, {
        code: c,
        // 名称缺失时用代码占位，属于「已知未知」而非编造出的假名称
        name: name || c,
        market: marketFromCode(c, t),
        type: t,
        board,
        price_limit_pct: priceLimit,
        is_st: isST ? 1 : 0,
        is_index_member: 0,
        data_origin: 'real',
      }));
      return true;
    } catch (e) {
      console.warn(`[quoteSync] ensureSecurity(${c}) 失败：${e.message}`);
      return false;
    }
  }

  /**
   * 把一组 bar 写入 daily_quotes（单事务、幂等）
   * @param {string} code 6 位裸码
   * @param {object[]} bars emClient.fetchKline 返回的 bar 数组
   * @returns {{written: number, skipped: number}} 写入统计
   */
  function writeBars(code, bars) {
    const stmt = db.prepare(dqSql);
    let written = 0;
    let skipped = 0;

    const tx = db.transaction(() => {
      for (const b of bars) {
        const tradeDate = typeof b.date === 'string' ? b.date.slice(0, 10) : null;
        // close / volume 为 NOT NULL 列；缺任一即跳过，绝不补零
        if (!tradeDate || b.close === null || b.close === undefined
          || b.volume === null || b.volume === undefined) {
          skipped += 1;
          continue;
        }
        stmt.run(...rowToValues(DQ_COLS, {
          code,
          trade_date: tradeDate,
          open: b.open ?? null,
          high: b.high ?? null,
          low: b.low ?? null,
          close: b.close,
          pre_close: b.pre_close ?? null,
          volume: b.volume,
          amount: b.amount ?? null,
          pct_chg: b.pct_chg ?? null,
          turnover_rate: b.turnover_rate ?? null,
          // 东财日 K 不含量比 / 估值 / 市值，如实留空，由 T03 指标层另行计算
          volume_ratio: b.volume_ratio ?? null,
          pe_ttm: b.pe_ttm ?? null,
          pb: b.pb ?? null,
          total_mv: b.total_mv ?? null,
          circ_mv: b.circ_mv ?? null,
          data_origin: 'real',
        }));
        written += 1;
      }
    });
    tx();
    return { written, skipped };
  }

  return {
    name: 'quoteSyncService',
    client,
    ensureSecurity,

    /**
     * 同步单只标的的日 K 线
     * @param {string} code 6 位裸码
     * @param {object} [opts] 选项
     * @param {number} [opts.limit=250] 拉取根数，硬上限 2500（P2 回测预留）
     * @param {number} [opts.fqt] 复权方式，缺省用 emClient 默认（前复权）
     * @param {boolean} [opts.noCache=true] 同步任务默认绕过缓存取最新
     * @returns {Promise<{ok: boolean, code: string, written: number, skipped: number, reason?: string}>}
     */
    async syncKline(code, opts = {}) {
      const c = tryNormalizeCode(code);
      if (!c) return { ok: false, code: String(code ?? ''), written: 0, skipped: 0, reason: 'code 非法' };

      const limit = Math.min(KLINE_MAX_LIMIT, Math.max(1, Number(opts.limit) || 250));
      const k = await client.fetchKline(c, {
        limit,
        fqt: opts.fqt,
        noCache: opts.noCache !== false,
      });
      if (!k || !Array.isArray(k.bars) || k.bars.length === 0) {
        return { ok: false, code: c, written: 0, skipped: 0, reason: '东财无数据或不可达（已降级，不写库）' };
      }

      if (!ensureSecurity(c, k.name, undefined)) {
        return { ok: false, code: c, written: 0, skipped: 0, reason: 'securities 主记录缺失且创建失败' };
      }

      try {
        const { written, skipped } = writeBars(c, k.bars);
        return { ok: true, code: c, name: k.name, written, skipped };
      } catch (e) {
        return { ok: false, code: c, written: 0, skipped: 0, reason: `落库失败：${e.message}` };
      }
    },

    /**
     * 批量同步日 K 线（串行，由 emClient 的令牌桶自行限速）
     * @param {string[]} codes 6 位裸码数组
     * @param {object} [opts] 选项，同 syncKline，另加 onProgress
     * @param {(done: number, total: number, last: object) => void} [opts.onProgress] 进度回调
     * @returns {Promise<{total:number, succeeded:number, failed:number, written:number, skipped:number, failures:object[]}>}
     */
    async syncKlines(codes, opts = {}) {
      const list = normalizeCodes(codes);
      const summary = {
        total: list.length, succeeded: 0, failed: 0, written: 0, skipped: 0, failures: [],
      };
      for (let i = 0; i < list.length; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        const r = await this.syncKline(list[i], opts);
        if (r.ok) {
          summary.succeeded += 1;
          summary.written += r.written;
          summary.skipped += r.skipped;
        } else {
          summary.failed += 1;
          summary.failures.push({ code: r.code, reason: r.reason });
        }
        if (typeof opts.onProgress === 'function') opts.onProgress(i + 1, list.length, r);
        if ((i + 1) % 50 === 0) log(`K 线同步进度 ${i + 1}/${list.length}`);
      }
      log(`K 线同步完成：成功 ${summary.succeeded} / 失败 ${summary.failed}，写入 ${summary.written} 行`);
      return summary;
    },

    /**
     * 用实时快照覆盖当日那根 K 线，并回填 pe/pb/市值
     * （盘中调用可让本地库跟上当日行情；收盘后调用等价于补齐当日 K 线）
     *
     * @param {string[]} codes 6 位裸码数组
     * @returns {Promise<{total:number, written:number, skipped:number, missing:string[]}>}
     */
    async syncLatestQuotes(codes) {
      const list = normalizeCodes(codes);
      const result = { total: list.length, written: 0, skipped: 0, missing: [] };
      if (list.length === 0) return result;

      for (const batch of chunk(list, 200)) {
        // eslint-disable-next-line no-await-in-loop
        const quotes = await client.fetchQuotes(batch, { noCache: true });
        const got = new Set(quotes.map((q) => q.code));
        for (const c of batch) if (!got.has(c)) result.missing.push(c);
        if (quotes.length === 0) continue;

        for (const q of quotes) {
          if (!ensureSecurity(q.code, q.name, undefined)) {
            result.skipped += 1;
            continue;
          }
        }

        try {
          for (const q of quotes) {
            if (!q.trade_date || q.close === null || q.volume === null) {
              result.skipped += 1;
              continue;
            }
            const r = writeBars(q.code, [{
              date: q.trade_date,
              open: q.open,
              high: q.high,
              low: q.low,
              close: q.close,
              pre_close: q.pre_close,
              volume: q.volume,
              amount: q.amount,
              pct_chg: q.pct_chg,
              turnover_rate: q.turnover_rate,
              volume_ratio: q.volume_ratio,
              pe_ttm: q.pe_ttm,
              pb: q.pb,
              total_mv: q.total_mv,
              circ_mv: q.circ_mv,
            }]);
            result.written += r.written;
            result.skipped += r.skipped;
          }
        } catch (e) {
          console.warn(`[quoteSync] syncLatestQuotes 落库失败：${e.message}`);
        }
      }

      log(`实时快照同步完成：写入 ${result.written} 行，跳过 ${result.skipped}，未取到 ${result.missing.length}`);
      return result;
    },

    /**
     * 同步本地 securities 表中全部（或指定类型）标的的 K 线
     * @param {object} [opts] 选项
     * @param {string[]} [opts.types=['stock','fund']] 证券类型过滤
     * @param {number} [opts.limit=250] 每只拉取根数
     * @param {number} [opts.max=0] 最多同步多少只（0 = 不限），用于小步验证
     * @returns {Promise<object>} 同 syncKlines 的汇总
     */
    async syncUniverse(opts = {}) {
      const types = Array.isArray(opts.types) && opts.types.length ? opts.types : ['stock', 'fund'];
      const rows = db.all(
        `SELECT code FROM securities WHERE type IN (${types.map(() => '?').join(',')}) ORDER BY code`,
        types,
      );
      let codes = rows.map((r) => r.code);
      if (Number(opts.max) > 0) codes = codes.slice(0, Number(opts.max));
      log(`准备同步 ${codes.length} 只标的的日 K 线（每只 ${opts.limit || 250} 根）`);
      return this.syncKlines(codes, { limit: opts.limit, onProgress: opts.onProgress });
    },
  };
}

export default createQuoteSyncService;
