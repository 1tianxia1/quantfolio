// ============================================================
// 市场服务：行情快照、板块热度、竞价榜 Top60、数据来源元信息
// ============================================================
import { createSecurityModel } from '../models/securityModel.js';
import { createWatchlistModel } from '../models/watchlistModel.js';
import { getProvider } from '../providers/dataProvider.js';
import { resolveSecurity } from './securityResolver.js';
import { ApiError } from '../util/errors.js';

/**
 * 市场服务工厂
 * @param {import('../db/driver.js').Database} db
 */
export function createMarketService(db) {
  const model = createSecurityModel(db);
  const watchlist = createWatchlistModel(db);
  // 行情级读取（K 线 / 单股报价）走 provider：DATA_PROVIDER=eastmoney 时为实时数据，
  // 东财不可达时 provider 内部自动降级回 sqlite。
  // overview / search / sectors / auctionLeaderboard / watchlist 仍走本地 model：
  // 它们依赖聚合表与静态属性，v1 不改动。
  // 注意：provider 在 kline/quote 内按请求重新获取（而非此处缓存），
  // 这样设置页切换数据源后最多 10s 内即可生效，无需重启。

  return {
    overview() {
      return model.overview();
    },

    async search(q, limit = 10) {
      if (!q) return [];
      const local = model.search(q, limit);
      if (local.length) return local;
      // 本地未命中：尝试运行时解析（可选 Tongdaxin 桥接兜底 + 写回缓存）
      const resolved = await resolveSecurity(db, q);
      return resolved ? [resolved] : [];
    },

    /** 显式运行时解析：本地优先 → 桥接兜底 → 写回缓存；命中返回证券对象，否则 null */
    resolve(q) {
      return resolveSecurity(db, q);
    },

    /**
     * 日 K 线（走 provider：实时优先，失败自动降级本地）
     *
     * provider.getDailyKline 返回的 bar 字段与旧 model.getKline 映射结果完全一致
     * （date/open/high/low/close/volume/amount/pct_chg/turnover_rate/volume_ratio/data_origin），
     * 直接透传，接口契约不变。
     *
     * @param {string} code 6 位裸码
     * @param {number} [days=120] 需要的最近 N 根
     * @returns {Promise<object|null>} K 线包，无数据时返回 null（路由据此回 404）
     */
    async kline(code, days = 120) {
      const provider = getProvider(db);
      const q = await provider.getQuote(code);
      const bars = await provider.getDailyKline(code, days);
      if (!bars || bars.length === 0) return null;
      const last = bars[bars.length - 1];
      return {
        code,
        name: q?.name ?? null,
        trade_date: last.date,
        data_origin: last.data_origin,
        bars,
      };
    },

    /**
     * 单标的实时报价（走 provider）
     * @param {string} code 6 位裸码
     * @returns {Promise<object|null>} Quote 或 null
     */
    async quote(code) {
      const provider = getProvider(db);
      return provider.getQuote(code);
    },

    sectors(dimension = 'sector', top = 20) {
      return model.getHotSectors(dimension, top);
    },

    meta() {
      const kv = {};
      for (const r of db.all('SELECT k, v FROM meta_kv')) {
        kv[r.k] = r.v;
      }
      let lineage = {};
      try { lineage = JSON.parse(kv.lineage_json || '{}'); } catch (_) { lineage = {}; }
      return {
        trade_date: kv.trade_date || null,
        version: kv.seed_version || null,
        stock_count: Number(kv.stock_count || 0),
        fund_count: Number(kv.fund_count || 0),
        lineage,
        compliance: kv.compliance || null,
      };
    },

    auctionLeaderboard(top = 60) {
      return model.auctionLeaderboard(top);
    },

    // ---------- 自选股 ----------
    listWatchlist(userId, opts = {}) {
      if (userId == null) return [];
      return watchlist.list(userId, opts);
    },

    addWatchlist(userId, code, opts = {}) {
      const sec = model.findByCode(code);
      // D3：必须抛 ApiError 让 errorHandler 命中 404 分支；裸 Error 会落入未知错误 500
      if (!sec) throw ApiError.notFound('证券不存在');
      return watchlist.add(userId, code, opts);
    },

    removeWatchlist(userId, id) {
      watchlist.remove(userId, id);
    },

    // ---------- 自选分组 ----------
    listWatchlistGroups(userId) {
      if (userId == null) return [];
      return watchlist.listGroups(userId);
    },

    createWatchlistGroup(userId, name, category = 'all') {
      if (!name) throw ApiError.badRequest('分组名不能为空');
      return watchlist.createGroup(userId, name, category);
    },

    deleteWatchlistGroup(userId, id) {
      watchlist.deleteGroup(userId, id);
    },

    renameWatchlistGroup(userId, id, name) {
      if (!name) throw ApiError.badRequest('分组名不能为空');
      return watchlist.renameGroup(userId, id, name);
    },

    moveWatchlistItem(userId, id, groupId) {
      watchlist.setGroup(userId, id, groupId);
    },

    updateWatchlistNote(userId, id, note) {
      watchlist.updateNote(userId, id, note);
    },
  };
}
