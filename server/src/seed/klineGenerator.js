// ============================================================
// 250 日派生 K 线生成器
// 以 code 为种子的确定性伪随机序列，末根精确锚定：
//   close[last] = price，pct_chg[last] = changePct，
//   pre_close[last] = price / (1 + changePct/100)（精确反推）
// 同一 code 每次生成结果完全一致（幂等）
//
// 结构：前 249 根派生（index 0..248，close[248]=pre_close 锚定），
//       第 250 根为真实锚定（index 249，close=price）
// ============================================================
import { seededRandom } from '../util/rng.js';
import { generateTradingDates } from '../util/tradingCalendar.js';
import { round4 } from '../util/money.js';

const TRADE_DATE = '2026-08-07';
const N = 250; // 250 根日线
const INTERIOR = N - 1; // 前 249 根派生

/**
 * 生成单只标的的 250 日 K 线
 * @param {object} item 清洗后的标的 { code, name, type, price, changePct, turnoverRate, amount, circMarketCap, tags }
 * @returns {object[]} bars: [{trade_date, open, high, low, close, pre_close, volume, amount, pct_chg, turnover_rate, data_origin}]
 */
export function generateKline(item) {
  const code = item.code;
  const price = item.price;
  const changePct = item.changePct;
  const isFund = item.type === 'fund';
  const rng = seededRandom(code + ':kline');
  const tags = item.tags || [];

  // 1) 交易日序列
  const dates = generateTradingDates(TRADE_DATE, N);

  // 2) 末根前收（精确反推）
  const anchorPrevClose = price / (1 + changePct / 100);

  // 3) 生成 0..247 的随机收益率（±3% 典型波动 + 尾部趋势注入）
  const rets = new Array(INTERIOR - 1).fill(0); // rets[i] = close[i+1]/close[i]-1（i=0..247）
  const tailDrift = tags.some((t) => ['多头排列', 'MACD金叉', 'MACD多头排列', '涨停', '放量上涨'].includes(t))
    ? rng.range(0.0005, 0.004)
    : rng.range(-0.002, 0.002);
  const bearishDrift = tags.some((t) => ['空头排列', 'MACD死叉', '250日均线压制'].includes(t))
    ? rng.range(-0.004, -0.0005)
    : 0;
  for (let i = 0; i < INTERIOR - 1; i++) {
    let r = (rng.next() * 2 - 1) * 0.03;
    if (i >= INTERIOR - 1 - 40) {
      r += tailDrift + bearishDrift;
    }
    rets[i] = r;
  }

  // 4) 构建 close[0..248] 随机游走
  const closes = new Array(INTERIOR).fill(0);
  closes[0] = 100 * (0.8 + rng.next() * 0.6); // 任意起点
  for (let i = 0; i < INTERIOR - 1; i++) {
    closes[i + 1] = closes[i] * (1 + rets[i]);
  }

  // 5) 形态模板注入
  //    a) 可选「近期高点」注入（制造上方空间）——非尾盘候选适用
  //    b) 尾盘五步法候选（涨幅 2.5~6.5%）注入「冲高回落+稳步回升」形态：
  //       峰值 26~34 天前（60 日窗口内，制造 ≥8% 上方空间），
  //       随后回落 6~9 天，最后 20 天稳步回升 → 末根 close > MA5 > MA10 > MA20
  const isClosingCandidate = item.type === 'stock' && item.changePct >= 2.5 && item.changePct <= 6.5;
  const patternInjected = isClosingCandidate && rng.next() < 0.75;
  if (!patternInjected && rng.next() < 0.6) {
    const bump = rng.range(0.06, 0.25);
    const t0 = INTERIOR - 1 - rng.int(55, 70);
    const t1 = Math.min(INTERIOR - 3, t0 + rng.int(4, 8));
    for (let i = Math.max(0, t0); i <= t1; i++) {
      closes[i] *= 1 + bump;
    }
  }

  if (patternInjected) {
    const peak = 1.14 + rng.next() * 0.08; // 峰值相对最终前收
    const peakOffset = rng.int(26, 34);
    const peakIdx = INTERIOR - 1 - peakOffset;
    const declineDays = rng.int(6, 9);
    const declineEnd = Math.min(INTERIOR - 2, peakIdx + declineDays);
    const rampStart = Math.max(0, peakIdx - 12);
    // 阶段1：上涨至峰值（0.80 → peak）
    for (let i = rampStart; i <= peakIdx; i++) {
      const t = (i - rampStart) / Math.max(1, peakIdx - rampStart);
      closes[i] = (0.80 + (peak - 0.80) * t) * closes[INTERIOR - 1];
    }
    // 阶段2：峰值回落（peak → 0.94）
    for (let i = peakIdx + 1; i <= declineEnd; i++) {
      const t = (i - peakIdx) / Math.max(1, declineDays);
      closes[i] = (peak - (peak - 0.94) * t) * closes[INTERIOR - 1];
    }
    // 阶段3：稳步回升（0.94 → 1.0）
    for (let i = declineEnd + 1; i < INTERIOR; i++) {
      const t = (i - declineEnd) / Math.max(1, INTERIOR - 1 - declineEnd);
      closes[i] = (0.94 + (1.0 - 0.94) * t) * closes[INTERIOR - 1];
    }
  }

  // 6) 缩放使 close[248] = anchorPrevClose（保证末根 pre_close 精确）
  const factor = anchorPrevClose / closes[INTERIOR - 1];
  for (let i = 0; i < INTERIOR; i++) {
    closes[i] *= factor;
  }
  closes[INTERIOR - 1] = anchorPrevClose; // 精确锚定

  // 7) 成交量序列（0..248 相对量；末根由 amount 反推）
  const baseVol = item.amount && item.price ? item.amount / item.price : 1e6;
  const volumes = new Array(INTERIOR).fill(0);
  for (let i = 0; i < INTERIOR; i++) {
    let v = baseVol * (0.55 + rng.next() * 0.7);
    // 「放量」标签：尾部 10 日放大（提升 volume_streak 命中率）
    if (i >= INTERIOR - 10 && tags.some((t) => t.includes('放量') || t === '涨停' || t === '换手板')) {
      v *= 1.3 + rng.next() * 0.6;
    }
    volumes[i] = v;
  }

  // 尾段放量形态：约 45%（带放量/涨停标签 70%）构造 3~5 日连续放量，
  // 末根量比提升到 1.5~3.5，使「量比靠前」「连续放量」步骤有真实命中
  const wantStreak = rng.next() < (tags.some((t) => t.includes('放量') || t === '涨停' || t === '换手板') ? 0.7 : 0.45);
  const k = wantStreak ? rng.int(3, 5) : 0;
  const vrBoost = wantStreak ? rng.range(1.5, 3.5) : rng.range(0.6, 2.0);
  let lastVolume = baseVol * vrBoost;
  if (k > 0) {
    // 构造 [N-1-k .. N-2] 逐日递增（0.5 → 0.9 × baseVol），末根 = baseVol × vrBoost
    for (let i = 0; i < k; i++) {
      const idx = INTERIOR - k + i; // N-1-k .. N-2（bar 空间）
      volumes[idx] = baseVol * (0.5 + 0.4 * (i / k));
    }
  }

  // 8) 竞价涨幅（由 rng 派生，用于 open 反推；涨停股倾向高开 3~7%）
  //    小盘股（流通市值 <30亿）倾向竞价高开 3~5%，使早盘七步法第 4 步（宽松模式）有候选
  const smallCap = item.type === 'stock' && item.circMarketCap != null && item.circMarketCap / 1e8 < 30;
  let auctionPct;
  if (smallCap) {
    auctionPct = 3 + rng.next() * 2;
  } else if (tags.includes('涨停') || tags.includes('一字板')) {
    auctionPct = 3 + rng.next() * 4;
  } else {
    auctionPct = rng.next() * 11 - 2.5;
  }
  const openLast = anchorPrevClose * (1 + auctionPct / 100);

  // 9) 组装前 249 根（index 0..248）
  const bars = [];
  for (let i = 0; i < INTERIOR; i++) {
    const close = closes[i];
    const preClose = i === 0 ? closes[0] / (1 + (rng.next() * 2 - 1) * 0.02) : closes[i - 1];
    const open = i === 0 ? closes[0] * (1 + (rng.next() * 2 - 1) * 0.01) : closes[i - 1] * (1 + (rng.next() * 2 - 1) * 0.01);
    const high = Math.max(open, close) * (1 + rng.next() * 0.012);
    const low = Math.min(open, close) * (1 - rng.next() * 0.012);
    const pctChg = preClose ? ((close / preClose) - 1) * 100 : 0;
    const volume = isFund ? volumes[i] * 100 : volumes[i]; // 基金「手×100」转份
    const amount = volume * close * (isFund ? 1 : 0.95 + rng.next() * 0.1);
    const turnoverRate = item.turnoverRate != null ? item.turnoverRate * (volumes[i] / (lastVolume || 1)) : null;
    bars.push({
      code,
      trade_date: dates[i],
      open: round4(open),
      high: round4(high),
      low: round4(low),
      close: round4(close),
      pre_close: round4(preClose),
      volume: round4(volume),
      amount: round4(amount),
      pct_chg: round4(pctChg),
      turnover_rate: turnoverRate != null ? round4(turnoverRate) : null,
      data_origin: 'derived',
    });
  }

  // 10) 末根（index 249，真实锚定）
  const highLast = Math.max(openLast, price) * (1 + rng.next() * 0.012);
  const lowLast = Math.min(openLast, price) * (1 - rng.next() * 0.012);
  const lastAmount = isFund ? lastVolume * 100 * price : lastVolume * price;
  bars.push({
    code,
    trade_date: dates[N - 1],
    open: round4(openLast),
    high: round4(highLast),
    low: round4(lowLast),
    close: round4(price),
    pre_close: round4(anchorPrevClose),
    volume: round4(isFund ? lastVolume * 100 : lastVolume),
    amount: round4(lastAmount),
    pct_chg: changePct,
    turnover_rate: item.turnoverRate != null ? round4(item.turnoverRate) : null,
    data_origin: 'real',
  });

  // 11) 一致性校验（末根锚定）
  const last = bars[N - 1];
  if (Math.abs(last.close - price) > 1e-4) {
    throw new Error(`K线末根 close 未锚定: ${code} close=${last.close} price=${price}`);
  }
  if (Math.abs(last.pct_chg - changePct) > 1e-4) {
    throw new Error(`K线末根 pct_chg 未锚定: ${code} pct=${last.pct_chg} changePct=${changePct}`);
  }
  // 反推关系：pre_close × (1 + changePct/100) ≈ price（容忍 round4 精度损失）
  if (Math.abs(last.pre_close * (1 + changePct / 100) - price) > 1e-3) {
    throw new Error(`K线末根 pre_close 未锚定: ${code} pre_close=${last.pre_close} price=${price}`);
  }

  return bars;
}
