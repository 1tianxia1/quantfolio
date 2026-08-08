// ============================================================
// 技术指标纯函数（可单测）
// SMA/EMA/MACD/RSI/KDJ + volume_streak/high_60d_distance_pct/percentile
// ============================================================

/** 简单移动平均（返回与输入等长数组，前 n-1 个为 null） */
export function sma(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    sum += v === null || v === undefined ? 0 : v;
    if (i >= period) {
      const drop = values[i - period];
      sum -= drop === null || drop === undefined ? 0 : drop;
    }
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** 指数移动平均（alpha = 2/(period+1)，首值取首个可用值） */
export function ema(values, period) {
  const out = new Array(values.length).fill(null);
  const alpha = 2 / (period + 1);
  let prev = null;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v === null || v === undefined) { out[i] = prev; continue; }
    if (prev === null) {
      prev = v;
    } else {
      prev = alpha * v + (1 - alpha) * prev;
    }
    out[i] = prev;
  }
  return out;
}

/**
 * MACD（12,26,9）：返回 {dif[], dea[], bar[]}
 * bar = (dif - dea) * 2（A股惯例）
 */
export function macd(closes, fast = 12, slow = 26, signal = 9) {
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  const dif = closes.map((_, i) => {
    const f = emaFast[i];
    const s = emaSlow[i];
    return f === null || s === null ? null : f - s;
  });
  const dea = ema(dif, signal);
  const bar = dif.map((d, i) => (d === null || dea[i] === null ? null : (d - dea[i]) * 2));
  return { dif, dea, bar };
}

/** RSI（Wilder 平滑），返回与输入等长数组 */
export function rsi(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length < 2) return out;
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period && i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) avgGain += diff; else avgLoss -= diff;
  }
  avgGain /= period;
  avgLoss /= period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

/** KDJ（9,3,3）：返回 {k[], d[], j[]} */
export function kdj(highs, lows, closes, n = 9, kPeriod = 3, dPeriod = 3) {
  const len = closes.length;
  const k = new Array(len).fill(null);
  const d = new Array(len).fill(null);
  const j = new Array(len).fill(null);
  let prevK = 50;
  let prevD = 50;
  for (let i = 0; i < len; i++) {
    let hh = -Infinity;
    let ll = Infinity;
    for (let m = Math.max(0, i - n + 1); m <= i; m++) {
      if (highs[m] != null && highs[m] > hh) hh = highs[m];
      if (lows[m] != null && lows[m] < ll) ll = lows[m];
    }
    if (!Number.isFinite(hh) || !Number.isFinite(ll) || hh === ll) {
      k[i] = prevK;
      d[i] = prevD;
      j[i] = 3 * prevK - 2 * prevD;
      continue;
    }
    const rsv = ((closes[i] - ll) / (hh - ll)) * 100;
    prevK = (2 / 3) * prevK + (1 / 3) * rsv;
    prevD = (2 / 3) * prevD + (1 / 3) * prevK;
    k[i] = prevK;
    d[i] = prevD;
    j[i] = 3 * prevK - 2 * prevD;
  }
  return { k, d, j };
}

/**
 * 连续放量天数：volume[t] > volume[t-1] 的连续计数（当前日往前数）
 * @param {number[]} volumes 成交量序列
 * @returns {number[]} 每根 K 线的连续放量天数（首根为 0）
 */
export function volumeStreak(volumes) {
  const out = new Array(volumes.length).fill(0);
  for (let i = 1; i < volumes.length; i++) {
    if (volumes[i] > volumes[i - 1]) {
      out[i] = out[i - 1] + 1;
    } else {
      out[i] = 0;
    }
  }
  return out;
}

/**
 * 近 60 日最高价空间（%）：(max(high, 60d) - close) / close * 100
 * 注：SCREENING_RULES 中该指标为「现价距近 60 日最高价的空间」
 * @param {number[]} highs
 * @param {number[]} closes
 * @param {number} window 默认 60
 * @returns {number[]} 百分比（可为负，表示现价已高于 60 日最高）
 */
export function high60dDistancePct(highs, closes, window = 60) {
  const out = new Array(closes.length).fill(null);
  for (let i = 0; i < closes.length; i++) {
    if (closes[i] == null) { out[i] = null; continue; }
    let hh = -Infinity;
    for (let m = Math.max(0, i - window + 1); m <= i; m++) {
      if (highs[m] != null && highs[m] > hh) hh = highs[m];
    }
    if (!Number.isFinite(hh) || hh <= 0) { out[i] = null; continue; }
    out[i] = ((hh - closes[i]) / closes[i]) * 100;
  }
  return out;
}

/**
 * 分位归一化：value 在 poolValues 中的百分位（0-100）
 * pool 必须为「当日全市场可筛标的池」，而非筛选后子集（保证可复现）
 */
export function percentileScore(value, poolValues) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return null;
  if (!poolValues || poolValues.length === 0) return null;
  const sorted = [...poolValues].filter((v) => v !== null && v !== undefined && !Number.isNaN(Number(v))).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  if (value <= sorted[0]) return 0;
  if (value >= sorted[sorted.length - 1]) return 100;
  // 二分查找 value 的位置，线性插值百分位
  let lo = 0;
  let hi = sorted.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] <= value) lo = mid; else hi = mid;
  }
  const rank = lo + 1; // 小于等于 value 的元素个数（近似）
  const pct = (rank / sorted.length) * 100;
  return Math.min(100, Math.max(0, pct));
}

/**
 * 分段线性映射：输入 x 与断点表 [[x1,y1],[x2,y2],...] 线性插值，边界外钳制到首尾 y
 */
export function piecewise(x, breakpoints) {
  if (x === null || x === undefined || Number.isNaN(Number(x))) return null;
  const bp = breakpoints;
  if (!bp || bp.length === 0) return null;
  if (x <= bp[0][0]) return bp[0][1];
  for (let i = 1; i < bp.length; i++) {
    if (x <= bp[i][0]) {
      const [x0, y0] = bp[i - 1];
      const [x1, y1] = bp[i];
      if (x1 === x0) return y1;
      return y0 + ((x - x0) * (y1 - y0)) / (x1 - x0);
    }
  }
  return bp[bp.length - 1][1];
}
