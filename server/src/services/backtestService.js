// ============================================================
// 回测引擎（模型无关）
//   run(req)            —— 单次回测：AS-OF-T 快照 + 评分 + 次日收益 + 汇总
//   buildSnapshots(req) —— 物化 AS-OF-T 快照（含预取 nextRet），供调参复用
//   getModels()        —— 模型元数据（faithful / dataCaveat / 因子键 / 默认权重）
//
// 最高优先级正确性约束：不穿越未来
//   - 所有快照查询一律 trade_date = T（等值），绝不用 <= T
//   - 早盘分位池用注入的 AS-OF-T 全市场池（getAsOfPool），禁止内部最新日池
//   - 次日收益取 T 在完整交易日历中的「真实下一交易日」，无 T+1 不计入
// ============================================================
import { createScoreService } from './scoreService.js';
import { createBacktestModel } from '../models/backtestModel.js';
import { DEFAULT_WEIGHTS_BY_MODEL } from '../config/scoring.js';
import { isMorningModel } from '../config/tuning.js';
import { round2 } from '../util/money.js';

/** 次日收益字段白名单（防止 SQL 注入） */
const ALLOWED_RETURN_FIELDS = new Set([
  'pct_chg', 'close', 'pre_close', 'open', 'high', 'low', 'volume', 'amount', 'turnover_rate', 'volume_ratio',
]);

/** 收益分布桶（默认 8 桶，与设计 §3.2 一致） */
const DIST_BUCKETS = [
  { bucket: '[-inf,-5)', min: -Infinity, max: -5 },
  { bucket: '[-5,-3)', min: -5, max: -3 },
  { bucket: '[-3,-1)', min: -3, max: -1 },
  { bucket: '[-1,0)', min: -1, max: 0 },
  { bucket: '[0,1)', min: 0, max: 1 },
  { bucket: '[1,3)', min: 1, max: 3 },
  { bucket: '[3,5)', min: 3, max: 5 },
  { bucket: '[5,inf)', min: 5, max: Infinity },
];

/** 早盘数据待补提示（历史辅助数据近乎缺失，结果不忠实） */
const MORNING_DATA_CAVEAT = 'morning aux data sparse, results not faithful';

/** 模型元数据（GET /backtest/models 返回） */
const MODELS = [
  {
    key: 'closing',
    label: '尾盘 C-11',
    faithful: true,
    dataCaveat: null,
    factorKeys: ['trend', 'momentum', 'volume', 'valuation'],
    weightsSource: 'CLOSING_WEIGHTS',
  },
  {
    key: 'closingPipeline',
    label: '尾盘五步法',
    faithful: true,
    dataCaveat: null,
    factorKeys: ['volume_streak', 'pct_chg', 'turnover', 'ma_bullish', 'high_60d'],
    weightsSource: 'point-system',
  },
  {
    key: 'morning',
    label: '早盘 M-03',
    faithful: false,
    dataCaveat: MORNING_DATA_CAVEAT,
    factorKeys: ['volume_ratio', 'auction', 'net_inflow', 'limit_up', 'turnover', 'sector_heat'],
    weightsSource: 'MORNING_WEIGHTS',
  },
  {
    key: 'morningPipeline',
    label: '早盘七步法',
    faithful: false,
    dataCaveat: MORNING_DATA_CAVEAT,
    factorKeys: ['volume_ratio_rank', 'auction_pct', 'auction_vol_ratio', 'limit_up', 'sector_heat', 'first_trade_vol'],
    weightsSource: 'point-system',
  },
];

function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function emptyDistribution() {
  return DIST_BUCKETS.map((b) => ({ bucket: b.bucket, count: 0 }));
}

function bucketize(rets) {
  const counts = emptyDistribution();
  for (const r of rets) {
    for (let i = 0; i < DIST_BUCKETS.length; i++) {
      const b = DIST_BUCKETS[i];
      if (r >= b.min && r < b.max) {
        counts[i].count++;
        break;
      }
    }
  }
  return counts;
}

/**
 * 回测服务工厂
 * @param {import('../db/driver.js').Database} db
 */
export function createBacktestService(db) {
  const scoreService = createScoreService(db);
  // 早盘分位池缓存：date -> { volumeRatio, netInflow3d }（buildSnapshots 物化一次）
  const poolCache = new Map();

  /** 交易日历（升序） */
  function getCalendar(range) {
    const [start, end] = range;
    return db
      .all(
        `SELECT DISTINCT trade_date FROM daily_quotes WHERE trade_date BETWEEN ? AND ? ORDER BY trade_date`,
        [start, end],
      )
      .map((r) => r.trade_date);
  }

  /** AS-OF-T 基础快照：daily_quotes@T JOIN tech_indicators@T JOIN securities(type='stock') LEFT JOIN aux@T */
  function getBaseSnapshotsAsOf(T) {
    return db.all(
      `SELECT
        dq.code AS code,
        s.name AS name,
        s.sector AS sector,
        dq.close AS price,
        dq.pre_close AS pre_close,
        dq.pct_chg AS pct_chg,
        dq.volume_ratio AS volume_ratio,
        dq.turnover_rate AS turnover_rate,
        COALESCE(dq.pe_ttm, s.pe_ttm) AS pe_ttm,
        COALESCE(dq.circ_mv, s.circ_mv) AS circ_mv,
        ti.ma5 AS ma5, ti.ma10 AS ma10, ti.ma20 AS ma20, ti.ma60 AS ma60,
        ti.macd_gold_cross AS macd_gold_cross,
        ti.macd_dead_cross AS macd_dead_cross,
        ti.macd_positive AS macd_positive,
        ti.macd_hist_turn_positive AS macd_hist_turn_positive,
        ti.rsi6 AS rsi6, ti.rsi12 AS rsi12, ti.rsi24 AS rsi24,
        ti.kdj_k AS kdj_k, ti.kdj_d AS kdj_d, ti.kdj_j AS kdj_j,
        ti.vol_ratio_5 AS vol_ratio_5,
        ti.volume_streak AS volume_streak,
        ti.high_60d_distance_pct AS high_60d_distance_pct,
        ti.ma_bullish AS ma_bullish,
        ti.ma_bearish AS ma_bearish,
        ti.ma_above_20 AS ma_above_20,
        ti.ma_cross_above_5 AS ma_cross_above_5,
        mf.net_inflow_3d AS net_inflow_3d,
        ad.auction_pct AS auction_pct,
        ad.auction_vol_ratio AS auction_vol_ratio,
        ad.first_trade_vol_ratio AS first_trade_vol_ratio
      FROM daily_quotes dq
      JOIN tech_indicators ti ON ti.code = dq.code AND ti.trade_date = dq.trade_date
      JOIN securities s ON s.code = dq.code AND s.type = 'stock'
      LEFT JOIN money_flow mf ON mf.code = dq.code AND mf.trade_date = ?
      LEFT JOIN auction_data ad ON ad.code = dq.code AND ad.trade_date = ?
      WHERE dq.trade_date = ?`,
      [T, T, T],
    );
  }

  /** AS-OF-T 全市场分位池（仅股票，回测专用，杜绝未来泄漏） */
  function computeAsOfPool(T) {
    const volumeRatio = db
      .all(
        `SELECT volume_ratio AS v FROM daily_quotes dq
         JOIN securities s ON s.code = dq.code AND s.type = 'stock'
         WHERE dq.trade_date = ? AND dq.volume_ratio IS NOT NULL`,
        [T],
      )
      .map((r) => r.v);
    const netInflow3d = db
      .all(
        `SELECT net_inflow_3d AS v FROM money_flow
         WHERE trade_date = ? AND net_inflow_3d IS NOT NULL`,
        [T],
      )
      .map((r) => r.v);
    return { volumeRatio, netInflow3d };
  }

  /** 取某日分位池（优先缓存，回测路径由 buildSnapshots 预物化） */
  function getAsOfPool(T) {
    if (poolCache.has(T)) return poolCache.get(T);
    return computeAsOfPool(T);
  }

  /** 路由到对应评分函数（模型无关） */
  function scoreFor(model, snap, weights, pool) {
    switch (model) {
      case 'morning':
        return scoreService.scoreMorning(snap, { weights, pool });
      case 'closing':
        return scoreService.scoreClosing(snap, weights);
      case 'morningPipeline':
        return scoreService.scoreMorningPipeline(snap, { weights, pool });
      case 'closingPipeline':
        return scoreService.scoreClosingPipeline(snap);
      default:
        throw new Error(`未知回测模型: ${model}`);
    }
  }

  /** 汇总逐笔交易 → 指标摘要 */
  function summarize(trades) {
    const picks = trades.length;
    if (picks === 0) {
      return {
        days: 0,
        picks: 0,
        winRate: 0,
        avgNextRet: 0,
        avgWinRet: 0,
        avgLossRet: 0,
        retDistribution: emptyDistribution(),
      };
    }
    const days = new Set(trades.map((t) => t.tradeDate)).size;
    const rets = trades.map((t) => Number(t.nextRet));
    const wins = rets.filter((r) => r > 0);
    const losses = rets.filter((r) => r < 0);
    const winRate = round2(wins.length / picks);
    return {
      days,
      picks,
      winRate,
      avgNextRet: round2(mean(rets)),
      avgWinRet: round2(wins.length ? mean(wins) : 0),
      avgLossRet: round2(losses.length ? mean(losses) : 0),
      retDistribution: bucketize(rets),
    };
  }

  /** 模型 dataCaveat 标记 */
  function getDataCaveat(model) {
    return isMorningModel(model) ? MORNING_DATA_CAVEAT : null;
  }

  /** 从请求中提取落库用 params（不含 userId / 内部字段） */
  function stripParams(req) {
    return {
      model: req.model,
      range: req.range,
      topN: req.topN ?? 20,
      minScore: req.minScore ?? 0,
      weightsOverride: req.weightsOverride ?? null,
      nextDayReturnField: req.nextDayReturnField ?? 'pct_chg',
      sampling: req.sampling ?? null,
      cap: req.cap ?? 2000,
    };
  }

  /** 物化 AS-OF-T 快照（含预取 nextRet），按交易日分块；供 run / tune 复用（权重解耦） */
  function buildSnapshots(req) {
    const { range, sampling, nextDayReturnField = 'pct_chg', model } = req;
    const [start, end] = range;
    const full = getCalendar([start, end]);
    if (full.length === 0) return new Map();

    // 评估日集合：默认全量；采样时按步长抽样，并保留末日（以便取 T+1 次日收益）
    const step = sampling && sampling.step > 1 ? Math.floor(sampling.step) : 0;
    const evalIdx = new Set();
    if (step > 0) {
      for (let i = 0; i < full.length; i += step) evalIdx.add(i);
      evalIdx.add(full.length - 1); // 保留末日
    } else {
      for (let i = 0; i < full.length; i++) evalIdx.add(i);
    }

    // 真实下一交易日映射（完整日历中的 i+1，绝不跨采样间隔）
    const nextDayMap = new Map();
    for (let i = 0; i < full.length - 1; i++) nextDayMap.set(full[i], full[i + 1]);

    // 预取次日收益字段（白名单字段，防注入）
    const field = ALLOWED_RETURN_FIELDS.has(nextDayReturnField) ? nextDayReturnField : 'pct_chg';
    const fieldRows = db.all(
      `SELECT code, trade_date, ${field} AS v FROM daily_quotes WHERE trade_date BETWEEN ? AND ?`,
      [start, end],
    );
    const fieldMap = new Map();
    for (const r of fieldRows) fieldMap.set(`${r.code}|${r.trade_date}`, r.v);

    // 预取区间内涨停记录（limit_type='limit_up'），内存聚合（数据稀疏，成本低）
    const limitRows = db.all(
      `SELECT code, trade_date, first_limit_time, reason, open_times, limit_up_streak, pattern
       FROM limit_records WHERE trade_date BETWEEN ? AND ? AND limit_type = 'limit_up'`,
      [start, end],
    );
    const limitByDate = new Map();
    for (const r of limitRows) {
      if (!limitByDate.has(r.trade_date)) limitByDate.set(r.trade_date, new Map());
      limitByDate.get(r.trade_date).set(r.code, r);
    }

    // 每个评估日：近 20 交易日（含当日）有涨停的 code 集合（窗口内，无未来泄漏）
    const recentLimitByDate = new Map();
    for (const idx of evalIdx) {
      const lo = Math.max(0, idx - 20);
      const set = new Set();
      for (let j = lo; j <= idx; j++) {
        const m = limitByDate.get(full[j]);
        if (m) for (const code of m.keys()) set.add(code);
      }
      recentLimitByDate.set(full[idx], set);
    }

    poolCache.clear();
    const result = new Map();
    const morning = isMorningModel(model);
    for (const idx of evalIdx) {
      const T = full[idx];
      const snaps = getBaseSnapshotsAsOf(T);
      const limitMap = limitByDate.get(T);
      const recentSet = recentLimitByDate.get(T);
      const nextDate = nextDayMap.get(T) || null;
      const dayArr = [];
      for (const snap of snaps) {
        const lim = limitMap ? limitMap.get(snap.code) || null : null;
        snap.limit_today = lim
          ? { first_limit_time: lim.first_limit_time, reason: lim.reason, open_times: lim.open_times }
          : null;
        snap.limit_streak = lim ? lim.limit_up_streak || 1 : 0;
        snap.limit_pattern = lim ? lim.pattern || null : null;
        snap.limit_recent_20d = recentSet ? recentSet.has(snap.code) : false;
        const nextRet = nextDate != null ? (fieldMap.get(`${snap.code}|${nextDate}`) ?? null) : null;
        dayArr.push({ snap, nextRet });
      }
      if (morning) poolCache.set(T, computeAsOfPool(T));
      result.set(T, dayArr);
    }
    return result;
  }

  /** 单次回测 */
  function run(req, userId = null) {
    const model = req.model;
    const topN = req.topN ?? 20;
    const minScore = req.minScore ?? 0;
    const weightsOverride = req.weightsOverride ?? null;

    const base = buildSnapshots(req);
    const morning = isMorningModel(model);
    const trades = [];

    for (const [T, dayArr] of base) {
      const pool = morning ? getAsOfPool(T) : null;
      const scored = dayArr.map((entry) => {
        const { total } = scoreFor(model, entry.snap, weightsOverride, pool);
        return { total, entry };
      });
      const picked = scored
        .filter((s) => s.total >= minScore && s.entry.nextRet != null)
        .sort((a, b) => b.total - a.total)
        .slice(0, topN);
      for (const p of picked) {
        trades.push({
          tradeDate: T,
          code: p.entry.snap.code,
          name: p.entry.snap.name,
          score: p.total,
          nextRet: p.entry.nextRet,
        });
      }
    }

    const summary = summarize(trades);
    const dataCaveat = getDataCaveat(model);

    // 落库（默认开；仅汇总 + 参数，逐笔不入）
    if (process.env.BACKTEST_PERSIST !== 'false') {
      try {
        const backtestModel = createBacktestModel(db);
        backtestModel.save({
          userId,
          kind: 'backtest',
          model,
          params: stripParams(req),
          summary,
          objective: null,
          bestWeights: null,
        });
      } catch (e) {
        console.warn('[backtest] 落库失败（已忽略）:', e.message);
      }
    }

    // trades 截断（仅返回最近 cap 笔，summary 仍全量）
    const cap = req.cap ?? 2000;
    let finalTrades = trades;
    if (trades.length > cap) {
      finalTrades = [...trades]
        .sort((a, b) => b.tradeDate.localeCompare(a.tradeDate))
        .slice(0, cap);
    }

    return {
      model,
      dataCaveat,
      summary,
      trades: finalTrades,
      params: stripParams(req),
    };
  }

  /** 模型元数据列表（含默认权重，供前端滑块初始化） */
  function getModels() {
    return MODELS.map((m) => ({
      ...m,
      defaultWeights: DEFAULT_WEIGHTS_BY_MODEL[m.key] || null,
    }));
  }

  return {
    run,
    buildSnapshots,
    getModels,
    getCalendar,
    getAsOfPool,
    scoreFor,
    summarize,
  };
}
