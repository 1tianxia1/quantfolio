// ============================================================
// SqliteProvider —— 默认 DataProvider 实现
// 读本地 SQLite 库（models/securityModel）
// ============================================================
import { createSecurityModel } from '../models/securityModel.js';

/**
 * 创建 SQLite 数据源实现
 * @param {import('../db/driver.js').Database} db
 */
export function createSqliteProvider(db) {
  const model = createSecurityModel(db);

  return {
    name: 'sqlite',

    /** 单标的快照：最新价 + 基础信息 */
    getQuote(code) {
      const sec = model.findByCode(code);
      if (!sec) return null;
      const quote = model.getLatestQuote(code);
      return {
        code: sec.code,
        name: sec.name,
        type: sec.type,
        market: sec.market,
        sector: sec.sector,
        industry: sec.industry,
        close: quote?.close ?? null,
        pre_close: quote?.pre_close ?? null,
        open: quote?.open ?? null,
        high: quote?.high ?? null,
        low: quote?.low ?? null,
        pct_chg: quote?.pct_chg ?? null,
        turnover_rate: quote?.turnover_rate ?? null,
        volume_ratio: quote?.volume_ratio ?? null,
        amount: quote?.amount ?? null,
        volume: quote?.volume ?? null,
        circ_mv: sec.circ_mv,
        total_mv: sec.total_mv,
        pe_ttm: quote?.pe_ttm ?? sec.pe_ttm,
        pb: quote?.pb ?? sec.pb,
        trade_date: quote?.trade_date ?? null,
        data_origin: quote?.data_origin ?? sec.data_origin,
      };
    },

    /** 批量快照 */
    getQuotes(codes) {
      return codes.map((c) => this.getQuote(c)).filter(Boolean);
    },

    /** 日 K 线（含来源标注） */
    getDailyKline(code, n = 120) {
      return model.getKline(code, n).map((b) => ({
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
    },

    /** 证券列表（带最新价） */
    listSecurities(filter = {}) {
      return model.list(filter);
    },

    /** 板块信息 */
    getSectorInfo(code) {
      const sec = model.findByCode(code);
      if (!sec) return null;
      const heat = sec.sector ? model.getSectorHeat(sec.sector) : null;
      return {
        sector: sec.sector,
        industry: sec.industry,
        heat: heat || null,
      };
    },

    /** 全市场最新快照（分位评分池） */
    getLatestSnapshot() {
      return model.getLatestSnapshot(['stock', 'fund']);
    },
  };
}
