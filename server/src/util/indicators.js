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

// ============================================================
// 以下为「智能分析中心」模块 B（架构 §7.6）新增纯函数
// 铁律：本段与 signalRules.js 一样禁止 I/O / Date.now() / 随机数，
//       P2 回测将逐根回放这些函数，必须完全确定。
// ============================================================

/**
 * 摆动点检测：左右各 k 根确认的局部高/低点（架构 §7.6 divergence 用）
 * @param {number[]} values 序列（升序，末位最新）
 * @param {number} k 左右确认根数（默认 3）
 * @returns {{ highs: number[], lows: number[] }} 索引数组（升序）
 */
export function findPivots(values, k = 3) {
  const highs = [];
  const lows = [];
  const n = values.length;
  for (let i = k; i < n - k; i++) {
    const v = values[i];
    if (v === null || v === undefined || !Number.isFinite(v)) continue;
    let isHigh = true;
    let isLow = true;
    for (let j = i - k; j <= i + k; j++) {
      if (j === i) continue;
      const u = values[j];
      if (u === null || u === undefined || !Number.isFinite(u)) continue;
      if (u >= v) isHigh = false;
      if (u <= v) isLow = false;
    }
    if (isHigh) highs.push(i);
    if (isLow) lows.push(i);
  }
  return { highs, lows };
}

/**
 * 顶/底背离检测（架构 §7.6，纯函数）
 * 近 window 根内，取左右各 k 根确认的摆动点：
 *   底背离：最近两个摆动低点 价格 P2 < P1 而 DIF2 > DIF1（价格新低、动能抬高）→ bullish
 *   顶背离：对称（价格新高、动能走低）→ bearish
 * @param {number[]} closes 收盘价序列（升序，末位最新）
 * @param {Array<number|null>} dif MACD DIF 序列（与 closes 等长）
 * @param {number} [window=60] 检测窗口
 * @param {number} [k=3] 摆动点确认根数
 * @returns {{ top: boolean, bottom: boolean, topIndex: number|null, bottomIndex: number|null }}
 */
export function detectDivergence(closes, dif, window = 60, k = 3) {
  const len = closes.length;
  const start = Math.max(0, len - window);
  const sliceC = closes.slice(start);
  const sliceD = dif.slice(start);
  const { highs, lows } = findPivots(sliceC, k);

  let bottom = false;
  let bottomIndex = null;
  if (lows.length >= 2) {
    const p1 = lows[lows.length - 2];
    const p2 = lows[lows.length - 1];
    const d1 = sliceD[p1];
    const d2 = sliceD[p2];
    if (p2 > p1 && sliceC[p2] < sliceC[p1] && d1 != null && d2 != null && Number.isFinite(d1) && Number.isFinite(d2) && d2 > d1) {
      bottom = true;
      bottomIndex = start + p2;
    }
  }

  let top = false;
  let topIndex = null;
  if (highs.length >= 2) {
    const h1 = highs[highs.length - 2];
    const h2 = highs[highs.length - 1];
    const d1 = sliceD[h1];
    const d2 = sliceD[h2];
    if (h2 > h1 && sliceC[h2] > sliceC[h1] && d1 != null && d2 != null && Number.isFinite(d1) && Number.isFinite(d2) && d2 < d1) {
      top = true;
      topIndex = start + h2;
    }
  }

  return { top, bottom, topIndex, bottomIndex };
}

/**
 * 趋势状态（架构 §7.6 trend_30d_*）：
 *   up   ：斜率 > 0 且区间涨幅 ≥ +5%
 *   down ：斜率 < 0 且区间跌幅 ≤ −5%
 *   range：区间涨跌幅绝对值 < 5% 且 (max−min)/mean < 12%（仅打标）
 * 斜率用最小二乘（对索引）。
 * @param {number[]} closes 收盘价序列（升序）
 * @param {number} [window=30] 窗口
 * @returns {{ slope: number, rangePct: number, amplitudePct: number|null, regime: 'up'|'down'|'range'|'insufficient' }}
 */
export function trendRegime(closes, window = 30) {
  const len = closes.length;
  const start = Math.max(0, len - window);
  const seg = closes.slice(start).filter((v) => v !== null && v !== undefined && Number.isFinite(v));
  if (seg.length < 10) return { slope: 0, rangePct: 0, amplitudePct: null, regime: 'insufficient' };
  const n = seg.length;
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += seg[i];
    sumXY += i * seg[i];
    sumXX += i * i;
  }
  const denom = n * sumXX - sumX * sumX;
  const slope = denom === 0 ? 0 : (n * sumXY - sumX * sumY) / denom;
  const first = seg[0];
  const last = seg[n - 1];
  const rangePct = first === 0 ? 0 : ((last - first) / first) * 100;
  const mean = seg.reduce((s, v) => s + v, 0) / n;
  const max = Math.max(...seg);
  const min = Math.min(...seg);
  const amplitudePct = mean === 0 ? 0 : ((max - min) / mean) * 100;

  let regime = 'range';
  if (slope > 0 && rangePct >= 5) regime = 'up';
  else if (slope < 0 && rangePct <= -5) regime = 'down';
  return { slope, rangePct, amplitudePct, regime };
}

/**
 * 量能状态（架构 §7.6 volume_expand / volume_shrink）
 * @param {number|null|undefined} volRatio5 5 日量比
 * @returns {{ expand: boolean, shrink: boolean }}
 */
export function volumeRegime(volRatio5) {
  const v = Number(volRatio5);
  if (!Number.isFinite(v)) return { expand: false, shrink: false };
  return { expand: v >= 1.5, shrink: v <= 0.7 };
}
