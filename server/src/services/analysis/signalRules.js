// ============================================================
// 模块 B 信号规则库（架构 §7.6 / §9 T04）—— 纯函数、无副作用
// evaluate(SignalContext) -> { hits, raw, strength, action, reasons }
// P2 回测将用同一套规则逐根回放，禁止 I/O / Date.now() / 随机数。
// 权重集中在 RULES 一张表，可配置、可单测。
// ============================================================
import { detectDivergence, trendRegime, volumeRegime } from '../../util/indicators.js';

/** 方向常量 */
export const DIRECTION = Object.freeze({
  BULLISH: 'bullish',
  BEARISH: 'bearish',
  NEUTRAL: 'neutral',
});

/**
 * 规则权重表（架构 §7.6，逐字对齐）
 * volume_expand/shrink 的方向是「跟随趋势」：合成时动态判定，表中记为 neutral
 */
export const RULES = Object.freeze([
  { id: 'macd_gold_cross', label: 'MACD 金叉', direction: DIRECTION.BULLISH, weight: 25 },
  { id: 'macd_dead_cross', label: 'MACD 死叉', direction: DIRECTION.BEARISH, weight: 25 },
  { id: 'divergence_bottom', label: '底背离', direction: DIRECTION.BULLISH, weight: 20 },
  { id: 'divergence_top', label: '顶背离', direction: DIRECTION.BEARISH, weight: 20 },
  { id: 'trend_30d_up', label: '30 日上涨趋势', direction: DIRECTION.BULLISH, weight: 15 },
  { id: 'trend_30d_down', label: '30 日下跌趋势', direction: DIRECTION.BEARISH, weight: 15 },
  { id: 'trend_30d_range', label: '30 日横盘震荡', direction: DIRECTION.NEUTRAL, weight: 0 },
  { id: 'volume_expand', label: '放量', direction: DIRECTION.NEUTRAL, weight: 10 },
  { id: 'volume_shrink', label: '缩量', direction: DIRECTION.NEUTRAL, weight: 10 },
  { id: 'main_inflow_5d', label: '5 日主力资金净流入', direction: DIRECTION.BULLISH, weight: 20 },
  { id: 'main_outflow_5d', label: '5 日主力资金净流出', direction: DIRECTION.BEARISH, weight: 20 },
]);

const RULE_MAP = new Map(RULES.map((r) => [r.id, r]));

/** 构造一条命中记录 */
function hit(id, detail = null) {
  const def = RULE_MAP.get(id);
  return {
    id,
    label: def?.label || id,
    direction: def?.direction || DIRECTION.NEUTRAL,
    weight: def?.weight ?? 0,
    detail,
  };
}

/**
 * 合成（架构 §7.6）：
 *   raw = Σ(bullish 命中权重) − Σ(bearish 命中权重)
 *   strength = clamp(raw, −100, 100)
 *   raw ≥ +60 → buy；raw ≤ −60 → sell；其余 hold
 *   reasons = 命中权重 Top3 的 label
 * @param {object[]} hits 命中规则（已带动态方向）
 * @returns {{ raw: number, strength: number, action: 'buy'|'sell'|'hold', reasons: string[] }}
 */
export function synthesize(hits) {
  let raw = 0;
  for (const h of hits) {
    if (h.direction === DIRECTION.BULLISH) raw += h.weight;
    else if (h.direction === DIRECTION.BEARISH) raw -= h.weight;
  }
  const strength = Math.min(100, Math.max(-100, raw));
  const action = strength >= 60 ? 'buy' : strength <= -60 ? 'sell' : 'hold';
  const reasons = [...hits]
    .filter((h) => h.weight > 0)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 3)
    .map((h) => h.label);
  return { raw, strength, action, reasons };
}

/**
 * 评估一组信号上下文（纯函数）
 * @param {object} ctx SignalContext
 * @param {string} [ctx.code] 标的代码
 * @param {object} [ctx.snap] 最新指标快照（indicatorService.getLatestSnapshot 单条）
 * @param {object[]} [ctx.bars] 升序 K 线数组（每根含 close，可选 dif；最新在末位）
 * @param {number} [ctx.cursor] 回放游标：指定则只用前 cursor+1 根（不得穿越未来数据）；默认全部
 * @returns {{ hits: object[], raw: number, strength: number, action: string, reasons: string[] }}
 */
export function evaluate(ctx) {
  const { snap = {} } = ctx || {};
  let bars = Array.isArray(ctx?.bars) ? ctx.bars : [];
  if (ctx?.cursor != null && Number.isFinite(ctx.cursor)) {
    bars = bars.slice(0, ctx.cursor + 1);
  }

  const closes = bars.map((b) => b.close).filter((v) => v !== null && v !== undefined && Number.isFinite(v));
  const difs = bars.map((b) => b.dif);

  const trend = trendRegime(closes, 30);
  const div = detectDivergence(closes, difs, 60, 3);
  const vol = volumeRegime(snap.vol_ratio_5);

  const hits = [];

  // 1-2) MACD 金叉 / 死叉（快照标志）
  const macdGold = snap.macd_gold_cross === 1 || snap.macd_gold_cross === true;
  const macdDead = snap.macd_dead_cross === 1 || snap.macd_dead_cross === true;
  if (macdGold) hits.push(hit('macd_gold_cross'));
  if (macdDead) hits.push(hit('macd_dead_cross'));

  // 3-4) 顶 / 底背离（近 60 根，左右各 3 根确认）
  if (div.bottom) hits.push(hit('divergence_bottom', '价格新低而 DIF 抬高（近 60 根）'));
  if (div.top) hits.push(hit('divergence_top', '价格新高而 DIF 走低（近 60 根）'));

  // 5-7) 30 日趋势
  if (trend.regime === 'up') hits.push(hit('trend_30d_up', `区间涨幅 ${trend.rangePct.toFixed(2)}%`));
  if (trend.regime === 'down') hits.push(hit('trend_30d_down', `区间跌幅 ${trend.rangePct.toFixed(2)}%`));
  if (trend.regime === 'range') hits.push(hit('trend_30d_range', `振幅 ${trend.amplitudePct == null ? '—' : trend.amplitudePct.toFixed(2)}%`));

  // 8-9) 量能：方向跟随趋势（expand 同向、shrink 反向）；横盘时不参与合成
  if (vol.expand) {
    const h = hit('volume_expand', `5日量比 ${snap.vol_ratio_5}`);
    h.direction = trend.regime === 'up' ? DIRECTION.BULLISH : trend.regime === 'down' ? DIRECTION.BEARISH : DIRECTION.NEUTRAL;
    hits.push(h);
  }
  if (vol.shrink) {
    const h = hit('volume_shrink', `5日量比 ${snap.vol_ratio_5}`);
    h.direction = trend.regime === 'up' ? DIRECTION.BEARISH : trend.regime === 'down' ? DIRECTION.BULLISH : DIRECTION.NEUTRAL;
    hits.push(h);
  }

  // 10-11) 5 日主力资金（双确认）
  const inflow5 = Number(snap.net_inflow_5d);
  const mainInflow = Number(snap.main_net_inflow);
  const inflowOk = Number.isFinite(inflow5) && Number.isFinite(mainInflow);
  if (inflowOk && inflow5 > 0 && mainInflow > 0) hits.push(hit('main_inflow_5d', `5日净流入 ${inflow5.toFixed(0)} 万`));
  if (inflowOk && inflow5 < 0 && mainInflow < 0) hits.push(hit('main_outflow_5d', `5日净流出 ${inflow5.toFixed(0)} 万`));

  return { hits, ...synthesize(hits) };
}

export default { RULES, DIRECTION, evaluate, synthesize };
