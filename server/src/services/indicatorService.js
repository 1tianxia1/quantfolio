// ============================================================
// 指标服务：读取/计算最新交易日指标快照
// 依赖 tech_indicators 表（seed 阶段已计算全量），提供最新日聚合视图
// ============================================================
import { createSecurityModel } from '../models/securityModel.js';

/**
 * 指标服务工厂
 * @param {import('../db/driver.js').Database} db
 */
export function createIndicatorService(db) {
  const model = createSecurityModel(db);

  return {
  /**
   * 获取一批标的最新交易日指标快照（合并行情/资金/竞价/涨停/板块）
   * @param {string[]} codes
   * @param {object} options { types: ['stock'] }
   */
  getLatestSnapshot(codes, options = {}) {
    if (!codes || codes.length === 0) return [];
    const quotes = model.getQuotes(codes);
    const indicators = model.getLatestIndicators(codes);
    const flows = model.getMoneyFlow(codes);
    const auctions = model.getAuctionData(codes);
    const limits = model.getLatestLimitUp(codes);
    const tags = model.listTags(codes);

    const indMap = new Map(indicators.map((r) => [r.code, r]));
    const flowMap = new Map(flows.map((r) => [r.code, r]));
    const auctionMap = new Map(auctions.map((r) => [r.code, r]));
    const limitMap = new Map();
    for (const l of limits) {
      if (!limitMap.has(l.code)) limitMap.set(l.code, []);
      limitMap.get(l.code).push(l);
    }

    return quotes.map((q) => {
      const ind = indMap.get(q.code) || {};
      const flow = flowMap.get(q.code) || {};
      const auction = auctionMap.get(q.code) || {};
      const limitList = limitMap.get(q.code) || [];
      const limitToday = limitList.find((l) => l.trade_date === q.trade_date && l.limit_type === 'limit_up') || null;
      const limitRecent20 = limitList.filter((l) => l.limit_type === 'limit_up').length > 0;

      // 指标命中标签 = 计算值命中 + 真实 tags（双通道）
      let indicatorHit = [];
      try { indicatorHit = JSON.parse(ind.indicator_hit || '[]'); } catch (_) { indicatorHit = []; }
      const seedTags = tags[q.code] || [];
      const hitTags = Array.from(new Set([...indicatorHit, ...seedTags]));

      return {
        code: q.code,
        name: q.name,
        type: q.type,
        market: q.market,
        sector: q.sector,
        industry: q.industry,
        board: q.board,
        is_st: q.is_st,
        list_date: q.list_date,
        price: q.close,
        pre_close: q.pre_close,
        open: q.open,
        high: q.high,
        low: q.low,
        pct_chg: q.pct_chg,
        turnover_rate: q.turnover_rate,
        volume: q.volume,
        amount: q.amount,
        volume_ratio: q.volume_ratio,
        circ_mv: q.circ_mv,
        total_mv: q.total_mv,
        pe_ttm: q.pe_ttm ?? q.sec_pe,
        pb: q.pb,
        trade_date: q.trade_date,
        data_origin: q.data_origin,
        // 指标
        ma5: ind.ma5, ma10: ind.ma10, ma20: ind.ma20, ma60: ind.ma60,
        macd_dif: ind.macd_dif, macd_dea: ind.macd_dea, macd_bar: ind.macd_bar,
        rsi6: ind.rsi6, rsi12: ind.rsi12, rsi24: ind.rsi24,
        kdj_k: ind.kdj_k, kdj_d: ind.kdj_d, kdj_j: ind.kdj_j,
        vol_ma5: ind.vol_ma5, vol_ratio_5: ind.vol_ratio_5,
        volume_streak: ind.volume_streak ?? 0,
        high_60d_distance_pct: ind.high_60d_distance_pct,
        macd_gold_cross: ind.macd_gold_cross ?? 0,
        macd_dead_cross: ind.macd_dead_cross ?? 0,
        macd_positive: ind.macd_positive ?? 0,
        macd_hist_turn_positive: ind.macd_hist_turn_positive ?? 0,
        kdj_gold_cross: ind.kdj_gold_cross ?? 0,
        kdj_dead_cross: ind.kdj_dead_cross ?? 0,
        ma_bullish: ind.ma_bullish ?? 0,
        ma_bearish: ind.ma_bearish ?? 0,
        ma_above_20: ind.ma_above_20 ?? 0,
        ma_cross_above_5: ind.ma_cross_above_5 ?? 0,
        indicator_hit: indicatorHit,
        seed_tags: seedTags,
        hit_tags: hitTags,
        // 资金流（万元）
        main_net_inflow: flow.main_net_inflow,
        net_inflow_3d: flow.net_inflow_3d,
        net_inflow_5d: flow.net_inflow_5d,
        // 竞价
        auction_price: auction.auction_price,
        auction_pct: auction.auction_pct,
        auction_volume: auction.auction_volume,
        auction_amount: auction.auction_amount,
        auction_vol_ratio: auction.auction_vol_ratio,
        first_trade_vol_ratio: auction.first_trade_vol_ratio,
        // 涨停
        limit_today: limitToday,
        limit_streak: limitToday?.limit_up_streak || 0,
        limit_pattern: limitToday?.pattern || null,
        limit_reason: limitToday?.reason || null,
        limit_recent_20d: limitRecent20,
      };
    });
  }
  };
}
