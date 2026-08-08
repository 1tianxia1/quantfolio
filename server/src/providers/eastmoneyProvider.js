// ============================================================
// EastmoneyProvider —— 基于东方财富公开接口的 DataProvider 实现
//
// 定位（架构 §6.1 / §7）：
//   本 provider 是「东财实时行情」+「本地 SQLite」的**融合层**，而不是纯远程代理。
//     · 行情数值（价、量、额、涨跌幅、市值、估值）→ 东财，data_origin='real'
//     · 证券静态属性（板块、行业、板、是否 ST、上市日）→ 本地 securities 表
//       （东财列表接口不提供 board/is_st，硬造属于编造，红线禁止）
//     · 东财不可达 / 熔断 / 超时 → 整段降级回 sqliteProvider，绝不白屏
//
// 契约提醒：本 provider 全部方法返回 **Promise**。
//   调用方一律 `await provider.getQuote(code)`；
//   sqliteProvider 是同步返回，`await` 一个非 Promise 值同样成立，两者可无缝互换。
//
// 单位口径（与 securities 表保持一致，避免图表数量级错乱）：
//   circ_mv / total_mv → 亿元（东财返回元，已在 emEndpoints 的 scale 中除 1e8）
//   volume             → 手
//   amount             → 元
// ============================================================
import env from '../config/env.js';
import { createSqliteProvider } from './sqliteProvider.js';
import { createSecurityModel } from '../models/securityModel.js';
import { emClient as defaultClient } from './emClient.js';
import { tryNormalizeCode, normalizeCodes, guessType, marketFromCode } from '../util/codeUtil.js';
import { KLINE_MAX_LIMIT, CLIST_FS } from './emEndpoints.js';

/** 布尔环境变量解析 */
function toBool(v, fallback = false) {
  if (v === undefined || v === null || v === '') return fallback;
  const s = String(v).trim().toLowerCase();
  return s === 'true' || s === '1' || s === 'yes' || s === 'on';
}

/**
 * 创建东方财富数据源
 *
 * @param {import('../db/driver.js').Database} db 数据库句柄（用于静态属性与降级）
 * @param {object} [options] 选项
 * @param {object} [options.client] 注入自定义 EmClient（单测用）
 * @param {number} [options.overlayMax] listSecurities 允许实时覆盖的最大条数
 * @param {boolean} [options.snapshotFull] getLatestSnapshot 是否走全市场实时拉取
 * @returns {object} DataProvider 实现（全部方法为 async）
 */
export function createEastmoneyProvider(db, options = {}) {
  const client = options.client || defaultClient;
  const fallback = createSqliteProvider(db);
  const model = createSecurityModel(db);

  /** 单次 listSecurities 最多向东财批量询价多少只（超出直接用本地值，避免翻页风暴） */
  const overlayMax = Number(options.overlayMax ?? env.EM_LIST_OVERLAY_MAX) || 300;
  /** 是否允许 getLatestSnapshot 拉全市场（默认关闭：一次 ~57 页，只在离线刷库时开） */
  const snapshotFull = options.snapshotFull ?? toBool(env.EM_SNAPSHOT_FULL, false);
  /** 全市场翻页上限（保护性，防止东财 total 异常导致无限翻） */
  const snapshotMaxPages = Number(env.EM_SNAPSHOT_MAX_PAGES) || 60;

  /**
   * 安全读取本地静态行（表不存在或查询异常时不阻断东财主路径）
   * @param {string} code 6 位裸码
   * @returns {object|null} securities 行或 null
   */
  function localSecurity(code) {
    try {
      return model.findByCode(code) || null;
    } catch (e) {
      console.warn(`[eastmoney] 本地 securities 查询失败（${code}）：${e.message}`);
      return null;
    }
  }

  /**
   * 把东财快照 + 本地静态属性合成 DataProvider 的 Quote 结构
   * 字段与 sqliteProvider.getQuote 完全一致，额外补 static_origin / source 便于溯源
   *
   * @param {string} code 6 位裸码
   * @param {object} em emClient 归一化快照
   * @param {object|null} local securities 行
   * @returns {object} Quote
   */
  function composeQuote(code, em, local) {
    return {
      code,
      name: em.name || local?.name || null,
      type: local?.type || guessType(code),
      market: local?.market || marketFromCode(code, local?.type),
      sector: local?.sector ?? null,
      industry: local?.industry ?? em.industry ?? null,
      close: em.close,
      pre_close: em.pre_close,
      open: em.open,
      high: em.high,
      low: em.low,
      pct_chg: em.pct_chg,
      turnover_rate: em.turnover_rate,
      volume_ratio: em.volume_ratio,
      amount: em.amount,
      volume: em.volume,
      circ_mv: em.circ_mv ?? local?.circ_mv ?? null,
      total_mv: em.total_mv ?? local?.total_mv ?? null,
      pe_ttm: em.pe_ttm ?? local?.pe_ttm ?? null,
      pb: em.pb ?? local?.pb ?? null,
      trade_date: em.trade_date,
      // 行情数值来自东财实时接口
      data_origin: 'real',
      // 静态属性（板块/行业/板）的来源，便于前端区分「价格真实但行业是本地缓存」
      static_origin: local?.data_origin ?? null,
      source: 'eastmoney',
    };
  }

  return {
    name: 'eastmoney',

    /**
     * 单标的快照：东财实时优先，失败降级本地
     * @param {string} code 6 位裸码
     * @returns {Promise<object|null>} Quote 或 null
     */
    async getQuote(code) {
      const c = tryNormalizeCode(code);
      if (!c) return null;
      const local = localSecurity(c);
      if (client.isCircuitOpen()) return fallback.getQuote(c);

      const em = await client.fetchQuote(c, { market: local?.market, type: local?.type });
      if (!em) return fallback.getQuote(c);
      return composeQuote(c, em, local);
    },

    /**
     * 批量快照：一次 ulist.np 批量询价，缺失项逐个降级本地
     * @param {string[]} codes 6 位裸码数组
     * @returns {Promise<object[]>} Quote 数组（顺序与输入一致，无效项剔除）
     */
    async getQuotes(codes) {
      const list = normalizeCodes(codes);
      if (list.length === 0) return [];
      if (client.isCircuitOpen()) return fallback.getQuotes(list);

      const emList = await client.fetchQuotes(list);
      const emMap = new Map(emList.map((q) => [q.code, q]));

      const out = [];
      for (const c of list) {
        const em = emMap.get(c);
        if (em) {
          out.push(composeQuote(c, em, localSecurity(c)));
        } else {
          const local = fallback.getQuote(c);
          if (local) out.push(local);
        }
      }
      return out;
    },

    /**
     * 日 K 线：东财历史接口优先（最多 2500 根，供 P2 回测），失败降级本地
     * @param {string} code 6 位裸码
     * @param {number} [n=120] 需要的最近 N 根
     * @returns {Promise<object[]>} Bar 数组（升序），字段与 sqliteProvider 一致
     */
    async getDailyKline(code, n = 120) {
      const c = tryNormalizeCode(code);
      if (!c) return [];
      // 上限透传 2500：P2 回测需要约 10 年日线，这里只放开能力，不主动拉满
      const want = Math.min(KLINE_MAX_LIMIT, Math.max(1, Number(n) || 120));
      if (client.isCircuitOpen()) return fallback.getDailyKline(c, want);

      const local = localSecurity(c);
      const k = await client.fetchKline(c, {
        limit: want,
        market: local?.market,
        type: local?.type,
      });
      if (!k || !Array.isArray(k.bars) || k.bars.length === 0) {
        return fallback.getDailyKline(c, want);
      }

      const bars = k.bars.slice(-want).map((b) => ({
        date: b.date,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: b.volume,
        amount: b.amount,
        pct_chg: b.pct_chg,
        turnover_rate: b.turnover_rate,
        // 东财日 K 接口不提供量比，如实置 null（红线：不拿 0 或估算值顶替）
        volume_ratio: null,
        data_origin: 'real',
      }));
      return bars;
    },

    /**
     * 证券列表：以本地 securities 表为 universe（静态属性权威），
     * 结果集较小时用东财实时价覆盖 *_latest 字段。
     *
     * 为什么不直接用东财 clist 当 universe：
     *   clist 不返回 board / is_st / list_date / fund_track 等本项目筛选强依赖的字段，
     *   缺这些字段会让 screener 静默失真 —— 宁可价格慢一拍，也不能属性错。
     *
     * @param {object} [filter] 过滤条件，同 securityModel.list
     * @returns {Promise<object[]>} 证券行数组
     */
    async listSecurities(filter = {}) {
      const rows = fallback.listSecurities(filter);
      if (!Array.isArray(rows) || rows.length === 0) return rows || [];
      if (rows.length > overlayMax || client.isCircuitOpen()) return rows;

      const codes = rows.map((r) => r.code).filter(Boolean);
      const emList = await client.fetchQuotes(codes);
      if (emList.length === 0) return rows;
      const emMap = new Map(emList.map((q) => [q.code, q]));

      return rows.map((r) => {
        const em = emMap.get(r.code);
        if (!em) return r;
        return {
          ...r,
          price_latest: em.close ?? r.price_latest,
          pre_close_latest: em.pre_close ?? r.pre_close_latest,
          pct_chg_latest: em.pct_chg ?? r.pct_chg_latest,
          turnover_latest: em.turnover_rate ?? r.turnover_latest,
          volume_ratio_latest: em.volume_ratio ?? r.volume_ratio_latest,
          amount_latest: em.amount ?? r.amount_latest,
          quote_date: em.trade_date ?? r.quote_date,
          circ_mv: em.circ_mv ?? r.circ_mv,
          total_mv: em.total_mv ?? r.total_mv,
          pe_ttm: em.pe_ttm ?? r.pe_ttm,
          pb: em.pb ?? r.pb,
          // 覆盖成功的行，其行情部分为实时真实数据
          quote_origin: 'real',
        };
      });
    },

    /**
     * 板块信息：行业/板块归属取本地静态，热度取东财行业板块实时排行
     * @param {string} code 6 位裸码
     * @returns {Promise<{sector: string|null, industry: string|null, heat: object|null}|null>}
     */
    async getSectorInfo(code) {
      const c = tryNormalizeCode(code);
      if (!c) return null;
      const local = localSecurity(c);
      if (!local) return null;

      const base = {
        sector: local.sector ?? null,
        industry: local.industry ?? null,
        heat: null,
      };

      if (client.isCircuitOpen()) return fallback.getSectorInfo(c);

      const sectors = await client.fetchSectors({ dimension: 'industry', limit: 200 });
      if (sectors.length > 0) {
        const wanted = [local.industry, local.sector].filter(Boolean).map((s) => String(s));
        const hit = sectors.find((s) => s.sector_name && wanted.some((w) => (
          s.sector_name === w || s.sector_name.includes(w) || w.includes(s.sector_name)
        )));
        if (hit) {
          base.heat = {
            dimension: 'industry',
            sector_name: hit.sector_name,
            sector_code: hit.sector_code,
            trade_date: null,
            sector_pct_chg: hit.pct_chg,
            hot_rank: hit.hot_rank,
            leading_stock: hit.leading_stock,
            stock_count: (hit.up_count ?? 0) + (hit.down_count ?? 0) || null,
            total_amount: hit.amount,
            total_main_inflow: hit.main_net_inflow,
            data_origin: 'real',
          };
          return base;
        }
      }

      // 东财没命中（板块名不同源）→ 用本地热度，如实标注其自身 data_origin
      const localInfo = fallback.getSectorInfo(c);
      return localInfo || base;
    },

    /**
     * 全市场最新快照（分位评分池）
     *
     * 默认走本地：一次全市场实时拉取 ≈ 57 页请求，5QPS 下约 12s，
     * 放在在线请求链路上会拖垮体验。需要真实全市场快照时：
     *   EM_SNAPSHOT_FULL=true（建议只在离线刷库脚本里开）
     *
     * @returns {Promise<object[]>} 快照数组，字段同 securityModel.getLatestSnapshot
     */
    async getLatestSnapshot() {
      if (!snapshotFull || client.isCircuitOpen()) return fallback.getLatestSnapshot();

      const pageSize = Number(env.EM_CLIST_PAGE_SIZE) || 100;
      const groups = [
        { fs: CLIST_FS.A_SHARE, type: 'stock' },
        { fs: CLIST_FS.FUND_ETF, type: 'fund' },
      ];

      const out = [];
      for (const g of groups) {
        // eslint-disable-next-line no-await-in-loop
        const { rows } = await client.fetchList({
          fs: g.fs,
          pageSize,
          maxPages: snapshotMaxPages,
        });
        for (const r of rows) {
          const c = tryNormalizeCode(r.code);
          if (!c) continue;
          const local = localSecurity(c);
          out.push({
            code: c,
            close: r.close,
            pct_chg: r.pct_chg,
            turnover_rate: r.turnover_rate,
            volume_ratio: r.volume_ratio,
            amount: r.amount,
            circ_mv: r.circ_mv ?? local?.circ_mv ?? null,
            sector: local?.sector ?? null,
            industry: local?.industry ?? r.industry ?? null,
            type: local?.type || g.type,
            data_origin: 'real',
          });
        }
      }

      // 全市场一条都没拿到 → 明确降级，不返回半截空表
      if (out.length === 0) return fallback.getLatestSnapshot();
      return out;
    },

    /**
     * 数据源健康度（供 /health 与运维排查，非 PROVIDER_METHODS 契约方法）
     * @returns {Promise<object>} 连通性 + 限频/缓存/熔断统计
     */
    async health() {
      const ping = await client.ping();
      return {
        provider: 'eastmoney',
        reachable: ping.ok,
        pingMs: ping.ms,
        detail: ping.detail,
        overlayMax,
        snapshotFull,
        stats: client.getStats(),
      };
    },

    /** 暴露底层客户端（脚本/探针复用同一套限频状态） */
    client,
    /** 暴露降级源（便于上层显式对照真实值与本地值） */
    fallback,
  };
}

export default createEastmoneyProvider;
