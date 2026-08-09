// ============================================================
// 市场服务：行情快照、板块热度、竞价榜 Top60、数据来源元信息
// ============================================================
import { createSecurityModel } from '../models/securityModel.js';
import { createWatchlistModel } from '../models/watchlistModel.js';
import { resolveSecurity } from './securityResolver.js';
import { ApiError } from '../util/errors.js';

/**
 * 市场服务工厂
 * @param {import('../db/driver.js').Database} db
 */
export function createMarketService(db) {
  const model = createSecurityModel(db);
  const watchlist = createWatchlistModel(db);

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

    kline(code, days = 120) {
      const sec = model.findByCode(code);
      if (!sec) return null;
      const bars = model.getKline(code, days).map((b) => ({
        date: b.trade_date,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: b.volume,
        amount: b.amount,
        pct_chg: b.pct_chg,
        turnover_rate: b.turnover_rate,
        volume_ratio: b.volume_ratio,
        data_origin: b.data_origin,
      }));
      return {
        code: sec.code,
        name: sec.name,
        trade_date: bars.length ? bars[bars.length - 1].date : null,
        data_origin: sec.data_origin,
        bars,
      };
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
      };
    },

    auctionLeaderboard(top = 60) {
      return model.auctionLeaderboard(top);
    },

    // ---------- 自选股 ----------
    listWatchlist(userId) {
      if (userId == null) return [];
      return watchlist.list(userId);
    },

    addWatchlist(userId, code) {
      const sec = model.findByCode(code);
      // D3：必须抛 ApiError 让 errorHandler 命中 404 分支；裸 Error 会落入未知错误 500
      if (!sec) throw ApiError.notFound('证券不存在');
      return watchlist.add(userId, code);
    },

    removeWatchlist(userId, id) {
      watchlist.remove(userId, id);
    },
  };
}
