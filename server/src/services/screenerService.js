// ============================================================
// 通用筛选器：条件解析 + AND 过滤 + 命中标签（C-01~C-09, M-01~M-02）
// 与五步法/七步法漏斗管线（pipelineService）并行
// ============================================================
import { createIndicatorService } from './indicatorService.js';
import { createScoreService } from './scoreService.js';
import { createSecurityModel } from '../models/securityModel.js';
import { round2 } from '../util/money.js';

/**
 * 通用筛选服务工厂
 * @param {import('../db/driver.js').Database} db
 */
export function createScreenerService(db) {
  const model = createSecurityModel(db);
  const indicators = createIndicatorService(db);
  const scorer = createScoreService(db);

  return {
  /**
   * 执行通用筛选（早盘 M-01~M-03 / 尾盘 C-01~C-11）
   * @param {'morning'|'closing'} type
   * @param {object} conditions 见 DESIGN.md §5.2
   * @param {object} opts { page, pageSize, sortBy, order }
   */
  run(type, conditions = {}, opts = {}) {
    const universe = conditions.universe || {};
    const types = universe.types || ['stock'];
    const securities = model.list({
      types,
      excludeST: !!universe.excludeST,
      excludeNew: !!universe.excludeNew,
      minMv: universe.mvRange?.[0],
      maxMv: universe.mvRange?.[1],
      minPrice: universe.priceRange?.[0],
      maxPrice: universe.priceRange?.[1],
    });
    const codes = securities.map((s) => s.code);
    const snaps = indicators.getLatestSnapshot(codes, { types });

    // 板块热度上下文（供评分）
    const sectorHeat = buildSectorHeatMap(db);
    // 过滤
    let passed = [];
    const eliminated = [];
    for (const snap of snaps) {
      const check = type === 'morning' ? checkMorning(snap, conditions, securities) : checkClosing(snap, conditions);
      if (check.pass) {
        passed.push({ snap, tags: check.tags });
      } else {
        eliminated.push({ snap, reasons: check.reasons });
      }
    }

    // 评分 + 组装结果
    const results = passed.map(({ snap, tags }, i) => {
      const score = type === 'morning' ? scorer.scoreMorning(snap, { sectorHeat }) : scorer.scoreClosing(snap);
      return {
        rank: i + 1,
        code: snap.code,
        name: snap.name,
        price: snap.price,
        pct_chg: snap.pct_chg,
        score: score.total,
        score_detail: { total: score.total, factors: score.factors },
        hit_tags: Array.from(new Set([...tags, ...snap.hit_tags])),
        hit_step_tags: [],
        metrics: pickMetrics(snap),
        data_origin: snap.data_origin,
      };
    });

    // 排序
    const sortBy = opts.sortBy || 'score';
    const order = opts.order || 'desc';
    results.sort((a, b) => {
      const va = sortBy === 'score' ? a.score : a.metrics[sortBy];
      const vb = sortBy === 'score' ? b.score : b.metrics[sortBy];
      const diff = (va ?? -Infinity) - (vb ?? -Infinity);
      return order === 'asc' ? diff : -diff;
    });

    // 分页
    const page = opts.page || 1;
    const pageSize = opts.pageSize || 20;
    const total = results.length;
    const start = (page - 1) * pageSize;
    const items = results.slice(start, start + pageSize).map((r, i) => ({ ...r, rank: start + i + 1 }));

    // D6：统计因「字段缺失」被淘汰的数量（区别于规则不满足），供前端提示数据完备性问题
    const eliminatedByMissing = eliminated.filter(
      (e) => Array.isArray(e.reasons) && e.reasons.some((r) => typeof r === 'string' && r.includes('缺失')),
    ).length;

    return {
      total,
      items,
      eliminated: eliminated.length,
      eliminated_by_missing: eliminatedByMissing,
      score_weights: type === 'morning' ? scorerWeightMorning() : scorerWeightClosing(),
    };
  },

  /** 条件命中数量实时预估（C-18） */
  estimate(type, conditions) {
    const r = this.run(type, conditions, { page: 1, pageSize: 100000 });
    return { estimated_count: r.total };
  }
  };
}

// ================= 早盘条件（M-01~M-02） =================
function checkMorning(snap, c, securities) {
  const pass = [];
  const reasons = [];
  const tags = [];
  const uni = c.universe || {};

  // 通用过滤
  if (uni.excludeST && snap.is_st) return { pass: false, reasons: ['ST'], tags };
  if (uni.excludeNew && snap.list_date) {
    const days = (Date.now() - new Date(snap.list_date).getTime()) / 86400000;
    if (days < 60) return { pass: false, reasons: ['次新股'], tags };
  }
  if (uni.mvRange) {
    const [lo, hi] = uni.mvRange;
    if (snap.circ_mv != null && (snap.circ_mv < lo || snap.circ_mv > hi)) return { pass: false, reasons: ['市值区间外'], tags };
  }
  if (uni.priceRange) {
    const [lo, hi] = uni.priceRange;
    if (snap.price != null && (snap.price < lo || snap.price > hi)) return { pass: false, reasons: ['价格区间外'], tags };
  }

  // ① 昨日涨跌幅区间
  if (c.prevPctChg) {
    const [lo, hi] = c.prevPctChg;
    if (snap.prev_pct_chg == null || snap.prev_pct_chg < lo || snap.prev_pct_chg > hi) {
      return { pass: false, reasons: [`昨日涨幅 ${fmt(snap.prev_pct_chg)}% 不在 ${lo}~${hi}`], tags };
    }
    tags.push(`昨涨${round2(snap.prev_pct_chg)}%`);
  }

  // ② 量比 ≥
  if (c.volumeRatio?.min != null) {
    if (snap.volume_ratio == null || snap.volume_ratio < c.volumeRatio.min) {
      return { pass: false, reasons: [`量比 ${fmt(snap.volume_ratio)} < ${c.volumeRatio.min}`], tags };
    }
    tags.push(`量比${round2(snap.volume_ratio)}x`);
  }

  // ③ 换手率区间
  if (c.turnover) {
    const [lo, hi] = c.turnover;
    if (snap.turnover_rate == null || snap.turnover_rate < lo || snap.turnover_rate > hi) {
      return { pass: false, reasons: [`换手 ${fmt(snap.turnover_rate)}% 不在 ${lo}~${hi}`], tags };
    }
    tags.push(`换手${round2(snap.turnover_rate)}%`);
  }

  // ④ 竞价表现
  if (c.auction) {
    if (c.auction.pct) {
      const [lo, hi] = c.auction.pct;
      if (snap.auction_pct == null || snap.auction_pct < lo || snap.auction_pct > hi) {
        return { pass: false, reasons: [`竞价涨幅 ${fmt(snap.auction_pct)}% 不在 ${lo}~${hi}`], tags };
      }
      tags.push(`竞价+${round2(snap.auction_pct)}%`);
    }
    if (c.auction.volRatio?.min != null) {
      if (snap.auction_vol_ratio == null || snap.auction_vol_ratio < c.auction.volRatio.min) {
        return { pass: false, reasons: [`竞价量比 ${fmt(snap.auction_vol_ratio)} < ${c.auction.volRatio.min}`], tags };
      }
      tags.push(`竞价量比${round2(snap.auction_vol_ratio)}`);
    }
  }

  // ⑤ 连板
  if (c.limitUp) {
    const minStreak = c.limitUp.minStreak ?? 0;
    const maxStreak = c.limitUp.maxStreak ?? 99;
    const streak = snap.limit_streak || 0;
    if (streak < minStreak || streak > maxStreak) {
      return { pass: false, reasons: [`连板数 ${streak} 不在 ${minStreak}~${maxStreak}`], tags };
    }
    if (streak > 0) tags.push(`${streak}连板`);
  }

  // ⑥ 热点板块
  if (c.sectors && c.sectors.length) {
    if (!snap.sector || !c.sectors.includes(snap.sector)) {
      return { pass: false, reasons: [`板块 ${snap.sector || '—'} 非热点`], tags };
    }
    tags.push(`热点:${snap.sector}`);
  }

  // ⑦ 3日主力净流入 ≥
  if (c.netInflow3d?.minWanYuan != null) {
    if (snap.net_inflow_3d == null || snap.net_inflow_3d < c.netInflow3d.minWanYuan) {
      return { pass: false, reasons: [`3日净流入 ${fmt(snap.net_inflow_3d)} 万 < ${c.netInflow3d.minWanYuan} 万`], tags };
    }
    tags.push(`3日主力净流入${round2(snap.net_inflow_3d)}万`);
  }

  return { pass: true, reasons, tags };
}

// ================= 尾盘条件（C-01~C-09） =================
function checkClosing(snap, c) {
  const reasons = [];
  const tags = [];
  const uni = c.universe || {};

  if (uni.excludeST && snap.is_st) return { pass: false, reasons: ['ST'], tags };
  if (uni.excludeNew && snap.list_date) {
    const days = (Date.now() - new Date(snap.list_date).getTime()) / 86400000;
    if (days < 60) return { pass: false, reasons: ['次新股'], tags };
  }
  if (uni.types && uni.types.length && !uni.types.includes(snap.type)) {
    return { pass: false, reasons: [`类型 ${snap.type}`], tags };
  }

  // C-01 MACD
  if (c.macd?.status) {
    const status = c.macd.status;
    const ok =
      (status === 'gold_cross' && snap.macd_gold_cross === 1) ||
      (status === 'dead_cross' && snap.macd_dead_cross === 1) ||
      (status === 'dif_positive' && snap.macd_positive === 1) ||
      (status === 'hist_turn_positive' && snap.macd_hist_turn_positive === 1);
    if (!ok) return { pass: false, reasons: [`MACD 非${status}`], tags };
    tags.push('MACD金叉');
  }

  // C-02 RSI
  if (c.rsi) {
    const period = c.rsi.period || 12;
    const v = snap[`rsi${period}`];
    if (c.rsi.range) {
      const [lo, hi] = c.rsi.range;
      if (v == null || v < lo || v > hi) return { pass: false, reasons: [`RSI${period} ${fmt(v)} 不在 ${lo}~${hi}`], tags };
    }
    if (c.rsi.preset === 'oversold' && (v == null || v >= 30)) return { pass: false, reasons: [`RSI${period} 非超卖`], tags };
    if (c.rsi.preset === 'overbought' && (v == null || v <= 70)) return { pass: false, reasons: [`RSI${period} 非超买`], tags };
    if (c.rsi.preset === 'normal' && (v == null || v < 30 || v > 70)) return { pass: false, reasons: [`RSI${period} 非正常区间`], tags };
    if (v != null) tags.push(`RSI:${round2(v)}`);
  }

  // C-03 KDJ
  if (c.kdj) {
    const status = c.kdj.status;
    let ok = true;
    if (status === 'gold_cross') ok = snap.kdj_gold_cross === 1;
    if (status === 'dead_cross') ok = snap.kdj_dead_cross === 1;
    if (status === 'j_oversold') ok = snap.kdj_j != null && snap.kdj_j < 0;
    if (status === 'j_overbought') ok = snap.kdj_j != null && snap.kdj_j > 100;
    if (!ok) return { pass: false, reasons: [`KDJ 非${status}`], tags };
    if (status === 'gold_cross' || status === 'dead_cross') tags.push('KDJ金叉');
    if (c.kdj.range) {
      const r = c.kdj.range;
      if (r.k && (snap.kdj_k == null || snap.kdj_k < r.k[0] || snap.kdj_k > r.k[1])) return { pass: false, reasons: ['K 区间外'], tags };
      if (r.d && (snap.kdj_d == null || snap.kdj_d < r.d[0] || snap.kdj_d > r.d[1])) return { pass: false, reasons: ['D 区间外'], tags };
      if (r.j && (snap.kdj_j == null || snap.kdj_j < r.j[0] || snap.kdj_j > r.j[1])) return { pass: false, reasons: ['J 区间外'], tags };
    }
  }

  // C-04 均线
  if (c.ma?.pattern) {
    const p = c.ma.pattern;
    const ok =
      (p === 'bullish' && snap.ma_bullish === 1) ||
      (p === 'bearish' && snap.ma_bearish === 1) ||
      (p === 'above_20' && snap.ma_above_20 === 1) ||
      (p === 'cross_above_5' && snap.ma_cross_above_5 === 1);
    if (!ok) return { pass: false, reasons: [`均线非${p}`], tags };
    tags.push('MA多头');
  }

  // C-05 放量倍数
  if (c.volRatio5) {
    const v = snap.vol_ratio_5;
    if (c.volRatio5.min != null && (v == null || v < c.volRatio5.min)) return { pass: false, reasons: [`放量 ${fmt(v)}x < ${c.volRatio5.min}`], tags };
    if (c.volRatio5.max != null && (v == null || v > c.volRatio5.max)) return { pass: false, reasons: [`放量 ${fmt(v)}x > ${c.volRatio5.max}`], tags };
    if (v != null) tags.push(`放量${round2(v)}x`);
  }

  // C-06 换手率
  if (c.turnover) {
    const [lo, hi] = c.turnover;
    if (snap.turnover_rate == null || snap.turnover_rate < lo || snap.turnover_rate > hi) {
      return { pass: false, reasons: [`换手 ${fmt(snap.turnover_rate)}% 不在 ${lo}~${hi}`], tags };
    }
    tags.push(`换手${round2(snap.turnover_rate)}%`);
  }

  // C-07 PE
  if (c.pe) {
    if (c.pe.excludeNegative && snap.pe_ttm != null && snap.pe_ttm < 0) return { pass: false, reasons: ['负PE'], tags };
    if (c.pe.range) {
      const [lo, hi] = c.pe.range;
      if (snap.pe_ttm == null || snap.pe_ttm < lo || snap.pe_ttm > hi) return { pass: false, reasons: [`PE ${fmt(snap.pe_ttm)} 不在 ${lo}~${hi}`], tags };
    }
    if (snap.pe_ttm != null) tags.push(`PE:${round2(snap.pe_ttm)}`);
  }

  // C-08 市值（流通市值亿元）
  if (c.mv?.range) {
    const [lo, hi] = c.mv.range;
    if (snap.circ_mv == null || snap.circ_mv < lo || snap.circ_mv > hi) return { pass: false, reasons: [`市值 ${fmt(snap.circ_mv)}亿 不在 ${lo}~${hi}`], tags };
    tags.push(`市值${round2(snap.circ_mv)}亿`);
  }

  // C-09 涨跌幅
  if (c.pctChg) {
    const [lo, hi] = c.pctChg;
    if (snap.pct_chg == null || snap.pct_chg < lo || snap.pct_chg > hi) return { pass: false, reasons: [`涨幅 ${fmt(snap.pct_chg)}% 不在 ${lo}~${hi}`], tags };
  }

  return { pass: true, reasons, tags };
}

// ================= 工具 =================
function fmt(v) {
  return v === null || v === undefined ? '—' : round2(v);
}

function pickMetrics(snap) {
  return {
    pct_chg: snap.pct_chg,
    turnover_rate: snap.turnover_rate,
    volume: snap.volume,
    volume_ratio: snap.volume_ratio,
    vol_ratio_5: snap.vol_ratio_5,
    pe_ttm: snap.pe_ttm,
    circ_mv: snap.circ_mv,
    total_mv: snap.total_mv,
    amount: snap.amount,
    main_net_inflow: snap.main_net_inflow,
    net_inflow_3d: snap.net_inflow_3d,
    auction_pct: snap.auction_pct,
    auction_vol_ratio: snap.auction_vol_ratio,
    limit_streak: snap.limit_streak,
    high_60d_distance_pct: snap.high_60d_distance_pct,
    volume_streak: snap.volume_streak,
    rsi12: snap.rsi12,
    kdj_j: snap.kdj_j,
  };
}

function buildSectorHeatMap(db) {
  // 使用传入的 db 构建 sector -> {rank, pct_chg} 映射（供评分上下文使用）
  const model = createSecurityModel(db);
  const rows = model.getHotSectors('sector', 200);
  const map = {};
  for (const r of rows) {
    map[r.sector_name] = { rank: r.hot_rank, pct_chg: r.sector_pct_chg };
  }
  return map;
}

function scorerWeightMorning() {
  return { volume_ratio: 0.2, auction: 0.2, net_inflow: 0.2, limit_up: 0.15, turnover: 0.15, sector_heat: 0.1 };
}
function scorerWeightClosing() {
  return { trend: 0.35, momentum: 0.25, volume: 0.25, valuation: 0.15 };
}
