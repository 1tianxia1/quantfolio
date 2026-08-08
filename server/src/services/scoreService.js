// ============================================================
// 评分服务：M-03 早盘通用评分 + C-11 尾盘通用评分
// + 五步法/七步法漏斗管线评分
// 归一化：piecewise / percentileScore（分位池 = 当日全市场可筛池）
// ============================================================
import {
  MORNING_WEIGHTS, MORNING_BREAKPOINTS, MORNING_LIMIT_UP_RULES, MORNING_SECTOR_HEAT_RULES,
  MORNING_SECTOR_NEGATIVE_SCORE, MISSING_SCORE_MORNING, MISSING_SCORE_CLOSING,
  CLOSING_WEIGHTS, CLOSING_SUB_WEIGHTS, CLOSING_BREAKPOINTS,
  CLOSING_MACD_SCORES, CLOSING_MA_SCORES, CLOSING_KDJ_SCORES,
} from '../config/scoring.js';
import { CLOSING_PIPELINE_SCORING, MORNING_PIPELINE_SCORING } from '../config/screening-defaults.js';
import { piecewise, percentileScore } from '../util/indicators.js';
import { round2 } from '../util/money.js';

/** 因子标签（中文） */
const LABELS = {
  volume_ratio: '量比',
  auction: '竞价表现',
  auction_pct: '竞价涨幅',
  auction_vol_ratio: '竞价量比',
  net_inflow: '资金流(3日)',
  limit_up: '连板/涨停强度',
  turnover: '换手率',
  sector_heat: '板块热度',
  trend: '趋势',
  macd: 'MACD',
  ma: '均线',
  momentum: '动能',
  rsi: 'RSI',
  kdj: 'KDJ',
  volume: '量能',
  vol_ratio_5: '放量倍数',
  valuation: '估值',
  pe: '市盈率',
  mv: '市值',
};

/**
 * 评分服务工厂
 * @param {import('../db/driver.js').Database} db
 */
export function createScoreService(db) {
  // 预载：当日全市场快照池（供分位归一化，保证可复现）
  let poolCache = null;

  function getPool() {
    if (poolCache) return poolCache;
    // 分位池 = 当日全市场可筛标的池（股票），而非筛选后子集 —— 保证可复现
    poolCache = {
      netInflow3d: db.all(
        `SELECT mf.net_inflow_3d AS v FROM money_flow mf
         JOIN securities s ON s.code = mf.code
         WHERE s.type = 'stock'
           AND mf.trade_date = (SELECT MAX(trade_date) FROM money_flow)
           AND mf.net_inflow_3d IS NOT NULL`
      ).map((r) => r.v),
      volumeRatio: db.all(
        `SELECT dq.volume_ratio AS v FROM daily_quotes dq
         JOIN securities s ON s.code = dq.code
         WHERE s.type = 'stock'
           AND dq.trade_date = (SELECT MAX(trade_date) FROM daily_quotes)
           AND dq.volume_ratio IS NOT NULL`
      ).map((r) => r.v),
    };
    return poolCache;
  }

  function scoreFactor(key, label, score, weight, note = '') {
    return {
      key,
      label,
      score: round2(score ?? 0),
      weight,
      contribution: round2((score ?? 0) * weight),
      note,
    };
  }

  /** 组合总分 */
  function totalFrom(factors) {
    const t = factors.reduce((s, f) => s + (f.contribution || 0), 0);
    return Math.min(100, Math.max(0, Math.round(t)));
  }

  /** 漏斗管线总分：直接求和因子得分（各因子分值即点数，Σ=100） */
  function totalFromPoints(factors) {
    const t = factors.reduce((s, f) => s + (f.score || 0), 0);
    return Math.min(100, Math.max(0, Math.round(t)));
  }

  /** 管线因子：weight=1（点数制，非权重制），contribution=score */
  function pointFactor(key, label, score, note = '') {
    return scoreFactor(key, label, score, 1, note);
  }

  return {
    // ================= M-03 早盘通用评分 =================
    /**
     * @param {object} snap 指标快照（indicatorService.getLatestSnapshot 单条）
     * @param {object} ctx { sectorHeat: {sectorName -> {rank, pct_chg}} }
     */
    scoreMorning(snap, ctx = {}) {
      const pool = getPool();
      const factors = [];

      // 1) 量比 20%
      let volScore = MISSING_SCORE_MORNING;
      let volNote = '数据缺失';
      if (snap.volume_ratio != null) {
        volScore = piecewise(snap.volume_ratio, MORNING_BREAKPOINTS.volume_ratio);
        volNote = `量比 ${round2(snap.volume_ratio)}`;
      }
      factors.push(scoreFactor('volume_ratio', LABELS.volume_ratio, volScore, MORNING_WEIGHTS.volume_ratio, volNote));

      // 2) 竞价表现 20%（0.6×pct + 0.4×vol_ratio）
      let auctionScore = MISSING_SCORE_MORNING;
      let auctionNote = '数据缺失';
      if (snap.auction_pct != null || snap.auction_vol_ratio != null) {
        const pctScore = snap.auction_pct != null ? piecewise(snap.auction_pct, MORNING_BREAKPOINTS.auction_pct) : MISSING_SCORE_MORNING;
        const vrScore = snap.auction_vol_ratio != null ? piecewise(snap.auction_vol_ratio, MORNING_BREAKPOINTS.auction_vol_ratio) : MISSING_SCORE_MORNING;
        auctionScore = 0.6 * pctScore + 0.4 * vrScore;
        auctionNote = `竞价 ${snap.auction_pct != null ? round2(snap.auction_pct) + '%' : '—'}`;
      }
      factors.push(scoreFactor('auction', LABELS.auction, auctionScore, MORNING_WEIGHTS.auction, auctionNote));

      // 3) 资金流 20%（分位法）
      let inflowScore = MISSING_SCORE_MORNING;
      let inflowNote = '数据缺失';
      if (snap.net_inflow_3d != null) {
        inflowScore = percentileScore(snap.net_inflow_3d, pool.netInflow3d);
        if (inflowScore == null) inflowScore = MISSING_SCORE_MORNING;
        inflowNote = `3日净流入 ${round2(snap.net_inflow_3d)} 万`;
      }
      factors.push(scoreFactor('net_inflow', LABELS.net_inflow, inflowScore, MORNING_WEIGHTS.net_inflow, inflowNote));

      // 4) 连板/涨停强度 15%
      factors.push(scoreFactor('limit_up', LABELS.limit_up, limitUpScore(snap), MORNING_WEIGHTS.limit_up, limitUpNote(snap)));

      // 5) 换手率 15%（倒U）
      let turnScore = MISSING_SCORE_MORNING;
      let turnNote = '数据缺失';
      if (snap.turnover_rate != null) {
        turnScore = piecewise(snap.turnover_rate, MORNING_BREAKPOINTS.turnover);
        turnNote = `换手 ${round2(snap.turnover_rate)}%`;
      }
      factors.push(scoreFactor('turnover', LABELS.turnover, turnScore, MORNING_WEIGHTS.turnover, turnNote));

      // 6) 板块热度 10%
      let sectorScore = MISSING_SCORE_MORNING;
      let sectorNote = '数据缺失';
      const heat = ctx.sectorHeat?.[snap.sector];
      if (snap.sector && heat) {
        if (heat.pct_chg != null && heat.pct_chg < 0) {
          sectorScore = MORNING_SECTOR_NEGATIVE_SCORE;
          sectorNote = `板块 ${snap.sector} 涨幅为负`;
        } else {
          for (const rule of MORNING_SECTOR_HEAT_RULES) {
            if (heat.rank <= rule.maxRank) { sectorScore = rule.score; break; }
          }
          sectorNote = `板块 ${snap.sector} 热度第 ${heat.rank}`;
        }
      }
      factors.push(scoreFactor('sector_heat', LABELS.sector_heat, sectorScore, MORNING_WEIGHTS.sector_heat, sectorNote));

      return { total: totalFrom(factors), factors };
    },

    // ================= C-11 尾盘通用评分 =================
    scoreClosing(snap) {
      const factors = [];

      // 趋势类 35%（0.5×MACD + 0.5×MA）
      const macdScore = macdSubScore(snap);
      const maScore = maSubScore(snap);
      const trendScore = 0.5 * macdScore + 0.5 * maScore;
      factors.push(scoreFactor('trend', LABELS.trend, trendScore, CLOSING_WEIGHTS.trend, `${LABELS.macd} ${macdNote(snap)}; ${LABELS.ma} ${maNote(snap)}`));

      // 动能类 25%（0.5×RSI + 0.5×KDJ）
      const rsiScore = rsiSubScore(snap);
      const kdjScore = kdjSubScore(snap);
      const momentumScore = 0.5 * rsiScore + 0.5 * kdjScore;
      factors.push(scoreFactor('momentum', LABELS.momentum, momentumScore, CLOSING_WEIGHTS.momentum, `${LABELS.rsi} ${rsiNote(snap)}; ${LABELS.kdj} ${kdjNote(snap)}`));

      // 量能类 25%（0.5×vol_ratio_5 + 0.5×换手）
      let volRatioScore = MISSING_SCORE_CLOSING;
      let volRatioNote = '数据缺失';
      if (snap.vol_ratio_5 != null) {
        volRatioScore = piecewise(snap.vol_ratio_5, CLOSING_BREAKPOINTS.vol_ratio_5);
        volRatioNote = `放量 ${round2(snap.vol_ratio_5)}x`;
      }
      let turnScore = MISSING_SCORE_CLOSING;
      let turnNote = '数据缺失';
      if (snap.turnover_rate != null) {
        turnScore = piecewise(snap.turnover_rate, CLOSING_BREAKPOINTS.turnover);
        turnNote = `换手 ${round2(snap.turnover_rate)}%`;
      }
      const volumeScore = 0.5 * volRatioScore + 0.5 * turnScore;
      factors.push(scoreFactor('volume', LABELS.volume, volumeScore, CLOSING_WEIGHTS.volume, `${volRatioNote}; ${turnNote}`));

      // 估值类 15%（0.6×PE + 0.4×市值）
      let peScore = MISSING_SCORE_CLOSING;
      let peNote = '数据缺失';
      if (snap.pe_ttm != null) {
        peScore = snap.pe_ttm < 0 ? 30 : piecewise(snap.pe_ttm, CLOSING_BREAKPOINTS.pe);
        peNote = `PE ${round2(snap.pe_ttm)}`;
      }
      let mvScore = MISSING_SCORE_CLOSING;
      let mvNote = '数据缺失';
      if (snap.circ_mv != null) {
        mvScore = piecewise(snap.circ_mv, CLOSING_BREAKPOINTS.mv);
        mvNote = `市值 ${round2(snap.circ_mv)}亿`;
      }
      const valuationScore = 0.6 * peScore + 0.4 * mvScore;
      factors.push(scoreFactor('valuation', LABELS.valuation, valuationScore, CLOSING_WEIGHTS.valuation, `${peNote}; ${mvNote}`));

      return { total: totalFrom(factors), factors };
    },

    // ================= 五步法漏斗评分 =================
    scoreClosingPipeline(snap) {
      const cfg = CLOSING_PIPELINE_SCORING;
      const factors = [];

      // 1) 放量台阶数 30（3日=30，每多1日+10，封顶50）
      let streakScore = 0;
      let streakNote = '数据缺失';
      if (snap.volume_streak != null) {
        const streak = snap.volume_streak;
        if (streak >= 3) {
          streakScore = Math.min(cfg.volume_streak.cap, cfg.volume_streak.max + (streak - 3) * cfg.volume_streak.perExtraDay);
        }
        streakNote = `连续放量 ${streak} 日`;
      }
      factors.push(pointFactor('volume_streak', '放量台阶数', streakScore, streakNote));

      // 2) 涨幅贴近 4% 中枢 20
      let pctScore = 0;
      let pctNote = '数据缺失';
      if (snap.pct_chg != null) {
        const c = cfg.pct_chg;
        pctScore = c.max * Math.max(0, 1 - Math.abs(snap.pct_chg - c.center) / c.tolerance);
        pctNote = `涨幅 ${round2(snap.pct_chg)}%`;
      }
      factors.push(pointFactor('pct_chg', '涨幅贴近4%中枢', pctScore, pctNote));

      // 3) 换手贴近 12.5% 中枢 15
      let turnScore = 0;
      let turnNote = '数据缺失';
      if (snap.turnover_rate != null) {
        const c = cfg.turnover;
        turnScore = c.max * Math.max(0, 1 - Math.abs(snap.turnover_rate - c.center) / c.tolerance);
        turnNote = `换手 ${round2(snap.turnover_rate)}%`;
      }
      factors.push(pointFactor('turnover', '换手贴近12.5%中枢', turnScore, turnNote));

      // 4) 多头排列完整度 20（站上 MA5/MA10/MA20 各计分，缺 1 条 -7）
      let maScore = 0;
      let maNote = '数据缺失';
      if (snap.ma5 != null && snap.ma10 != null && snap.ma20 != null) {
        const above = [snap.price > snap.ma5, snap.price > snap.ma10, snap.price > snap.ma20].filter(Boolean).length;
        maScore = Math.max(0, cfg.ma_bullish.max - (3 - above) * cfg.ma_bullish.perMissing);
        maNote = `站上 MA5/MA10/MA20: ${above}/3`;
      }
      factors.push(pointFactor('ma_bullish', '多头排列完整度', maScore, maNote));

      // 5) 上方空间 15
      let spaceScore = 0;
      let spaceNote = '数据缺失';
      if (snap.high_60d_distance_pct != null) {
        spaceScore = Math.min(cfg.high_60d.max, snap.high_60d_distance_pct * cfg.high_60d.factor);
        spaceNote = `上方空间 ${round2(snap.high_60d_distance_pct)}%`;
      }
      factors.push(pointFactor('high_60d', '上方空间', spaceScore, spaceNote));

      return { total: totalFromPoints(factors), factors };
    },

    // ================= 七步法漏斗评分 =================
    scoreMorningPipeline(snap, ctx = {}) {
      const cfg = MORNING_PIPELINE_SCORING;
      const pool = getPool();
      const factors = [];

      // 1) 量比排名分位 25（Top1%=25，每降 1% 分位 -0.25）
      let vrScore = 0;
      let vrNote = '数据缺失';
      let pct = null;
      if (snap.volume_ratio != null && pool.volumeRatio.length > 0) {
        pct = percentileScore(snap.volume_ratio, pool.volumeRatio);
        if (pct != null) {
          vrScore = Math.max(0, 25 - (100 - pct) * 0.25);
        }
        vrNote = `量比分位 ${round2(pct)}%`;
      }
      factors.push(pointFactor('volume_ratio_rank', '量比排名分位', vrScore, vrNote));

      // 2) 竞价涨幅贴近 4% 20
      let apScore = 0;
      let apNote = '数据缺失';
      if (snap.auction_pct != null) {
        const c = cfg.auction_pct;
        apScore = c.max * Math.max(0, 1 - Math.abs(snap.auction_pct - c.center) / c.tolerance);
        apNote = `竞价涨幅 ${round2(snap.auction_pct)}%`;
      }
      factors.push(pointFactor('auction_pct', '竞价涨幅贴近4%', apScore, apNote));

      // 3) 竞价量比 15（piecewise (0.5,0)(1,60)(2,90)(3,100)，钳制到 15 分上限）
      let avScore = 0;
      let avNote = '数据缺失';
      if (snap.auction_vol_ratio != null) {
        avScore = Math.min(cfg.auction_vol_ratio.max, piecewise(snap.auction_vol_ratio, [[0.5, 0], [1, 60], [2, 90], [3, 100]]));
        avNote = `竞价量比 ${round2(snap.auction_vol_ratio)}`;
      }
      factors.push(pointFactor('auction_vol_ratio', '竞价量比', avScore, avNote));

      // 4) 连板/涨停强度 20（有涨停+5，连板数每 1 板 +5，封顶 20）
      let luScore = 0;
      let luNote = '无涨停';
      if (snap.limit_today) {
        luScore = Math.min(cfg.limit_up.max, cfg.limit_up.hasLimit + (snap.limit_streak || 1) * cfg.limit_up.perStreak);
        luNote = `连板 ${snap.limit_streak || 1} 板`;
      } else if (snap.limit_recent_20d) {
        luScore = cfg.limit_up.hasLimit;
        luNote = '近20日有涨停';
      }
      factors.push(pointFactor('limit_up', '连板/涨停强度', luScore, luNote));

      // 5) 板块热度 15（主线第一档 15 / 第二档 10 / 第三档 5）
      let shScore = 0;
      let shNote = '非主线';
      if (ctx.mainlineTier && ctx.mainlineTier[snap.sector] !== undefined) {
        const tier = ctx.mainlineTier[snap.sector];
        shScore = tier === 1 ? cfg.sector_heat.tier1 : tier === 2 ? cfg.sector_heat.tier2 : cfg.sector_heat.tier3;
        shNote = `主线第 ${tier} 档`;
      }
      factors.push(pointFactor('sector_heat', '板块热度', shScore, shNote));

      // 6) 首笔量比 5（≥2 →5，每 +1 加 1，封顶 5）
      let ftScore = 0;
      let ftNote = '数据缺失';
      if (snap.first_trade_vol_ratio != null) {
        const v = snap.first_trade_vol_ratio;
        ftScore = v >= cfg.first_trade_vol.base ? cfg.first_trade_vol.max : Math.max(0, v - cfg.first_trade_vol.base + 1);
        ftNote = `首笔量比 ${round2(v)}`;
      }
      factors.push(pointFactor('first_trade_vol', '首笔量比', ftScore, ftNote));

      return { total: totalFromPoints(factors), factors };
    },
  };
}

// ================= 子函数 =================

/** 连板/涨停强度得分（M-03） */
function limitUpScore(snap) {
  if (!snap.limit_today && !snap.limit_recent_20d) return MORNING_LIMIT_UP_RULES.noLimit;
  if (!snap.limit_today) return MORNING_LIMIT_UP_RULES.within20d;
  const streak = snap.limit_streak || 1;
  let s = streak >= 4 ? MORNING_LIMIT_UP_RULES.streak4Plus
    : streak === 3 ? MORNING_LIMIT_UP_RULES.streak3
    : streak === 2 ? MORNING_LIMIT_UP_RULES.streak2
    : MORNING_LIMIT_UP_RULES.streak1;
  // 一字板加分
  const pattern = snap.limit_pattern || '';
  const isOneWord = snap.limit_today.first_limit_time === '09:25:00'
    || /一字/.test(pattern)
    || /一字/.test(snap.limit_today.reason || '');
  if (isOneWord) {
    s += MORNING_LIMIT_UP_RULES.oneWordBonus;
  }
  // 炸板减分（open_times > 0 视为曾打开）
  if ((snap.limit_today.open_times || 0) > 0) {
    s += MORNING_LIMIT_UP_RULES.breakBoardPenalty;
  }
  return Math.min(100, Math.max(0, s));
}

function limitUpNote(snap) {
  if (!snap.limit_today && !snap.limit_recent_20d) return '无涨停';
  if (!snap.limit_today) return '近20日有涨停';
  return `连板 ${snap.limit_streak || 1} 板${snap.limit_pattern ? '(' + snap.limit_pattern + ')' : ''}`;
}

/** C-11 MACD 子分 */
function macdSubScore(snap) {
  const g = snap.macd_gold_cross === 1 || snap.macd_gold_cross === true;
  const d = snap.macd_dead_cross === 1 || snap.macd_dead_cross === true;
  const difPos = snap.macd_positive === 1 || snap.macd_positive === true;
  const histTurn = snap.macd_hist_turn_positive === 1 || snap.macd_hist_turn_positive === true;
  if (g && difPos) return CLOSING_MACD_SCORES.goldCrossDifPositive;
  if (g) return CLOSING_MACD_SCORES.goldCross;
  if (histTurn) return CLOSING_MACD_SCORES.histTurnPositive;
  if (d) return CLOSING_MACD_SCORES.deadCross;
  if (difPos) return CLOSING_MACD_SCORES.difPositive;
  return CLOSING_MACD_SCORES.difNegative;
}

function macdNote(snap) {
  const g = snap.macd_gold_cross === 1 || snap.macd_gold_cross === true;
  const d = snap.macd_dead_cross === 1 || snap.macd_dead_cross === true;
  const difPos = snap.macd_positive === 1 || snap.macd_positive === true;
  if (g) return '金叉';
  if (d) return '死叉';
  return difPos ? 'DIF>0' : 'DIF<0';
}

/** C-11 MA 子分 */
function maSubScore(snap) {
  if (snap.ma_bullish === 1 || snap.ma_bullish === true) return CLOSING_MA_SCORES.bullish;
  if (snap.ma_above_20 === 1 || snap.ma_above_20 === true) return CLOSING_MA_SCORES.above20;
  if (snap.ma_cross_above_5 === 1 || snap.ma_cross_above_5 === true) return CLOSING_MA_SCORES.above5;
  if (snap.ma_bearish === 1 || snap.ma_bearish === true) return CLOSING_MA_SCORES.bearish;
  return CLOSING_MA_SCORES.neutral;
}

function maNote(snap) {
  if (snap.ma_bullish === 1 || snap.ma_bullish === true) return '多头排列';
  if (snap.ma_bearish === 1 || snap.ma_bearish === true) return '空头排列';
  if (snap.ma_above_20 === 1 || snap.ma_above_20 === true) return '站上MA20';
  if (snap.ma_cross_above_5 === 1 || snap.ma_cross_above_5 === true) return '上穿MA5';
  return '中性';
}

/** C-11 RSI 子分（默认 RSI12） */
function rsiSubScore(snap) {
  const v = snap.rsi12 ?? snap.rsi6 ?? snap.rsi24;
  if (v == null) return MISSING_SCORE_CLOSING;
  return piecewise(v, CLOSING_BREAKPOINTS.rsi);
}

function rsiNote(snap) {
  const v = snap.rsi12 ?? snap.rsi6 ?? snap.rsi24;
  return v == null ? '数据缺失' : `RSI:${round2(v)}`;
}

/** C-11 KDJ 子分 */
function kdjSubScore(snap) {
  const g = snap.kdj_gold_cross === 1 || snap.kdj_gold_cross === true;
  const d = snap.kdj_dead_cross === 1 || snap.kdj_dead_cross === true;
  const j = snap.kdj_j;
  if (g && snap.kdj_k != null && snap.kdj_k < 30) return CLOSING_KDJ_SCORES.lowGoldCross;
  if (g) return CLOSING_KDJ_SCORES.goldCross;
  if (d) return CLOSING_KDJ_SCORES.deadCross;
  if (j != null && j < 0) return CLOSING_KDJ_SCORES.jOversold;
  if (j != null && j > 100) return CLOSING_KDJ_SCORES.jOverbought;
  return CLOSING_KDJ_SCORES.neutral;
}

function kdjNote(snap) {
  const g = snap.kdj_gold_cross === 1 || snap.kdj_gold_cross === true;
  const d = snap.kdj_dead_cross === 1 || snap.kdj_dead_cross === true;
  if (g) return '金叉';
  if (d) return '死叉';
  return snap.kdj_j != null ? `J:${round2(snap.kdj_j)}` : '中性';
}
