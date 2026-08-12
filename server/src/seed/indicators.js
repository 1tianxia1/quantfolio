// ============================================================
// 批量写 tech_indicators（250 日全量 + indicator_hit 判定）
// 输入：已附加派生字段的 bars（deriveFields 输出）
// ============================================================
import { sma, ema, macd, rsi, kdj } from '../util/indicators.js';
import { round4 } from '../util/money.js';

/**
 * 由 K 线序列计算全部技术指标（含交叉旗标与命中标签）
 * @param {object[]} bars 升序 K 线（含 derived 字段）
 * @returns {object[]} 与 bars 等长的指标行
 */
export function computeIndicators(bars) {
  const closes = bars.map((b) => b.close);
  const highs = bars.map((b) => b.high);
  const lows = bars.map((b) => b.low);
  const volumes = bars.map((b) => b.volume);

  const ma5 = sma(closes, 5);
  const ma10 = sma(closes, 10);
  const ma20 = sma(closes, 20);
  const ma60 = sma(closes, 60);
  const { dif, dea, bar } = macd(closes, 12, 26, 9);
  const rsi6 = rsi(closes, 6);
  const rsi12 = rsi(closes, 12);
  const rsi24 = rsi(closes, 24);
  const { k, d, j } = kdj(highs, lows, closes, 9, 3, 3);
  const volMa5 = sma(volumes, 5);

  return bars.map((b, i) => {
    const prev = i > 0 ? i - 1 : null;
    // 交叉判定（需前值）
    const macdGoldCross = prev !== null && dif[prev] != null && dea[prev] != null && dif[i] != null && dea[i] != null &&
      dif[prev] <= dea[prev] && dif[i] > dea[i] ? 1 : 0;
    const macdDeadCross = prev !== null && dif[prev] != null && dea[prev] != null && dif[i] != null && dea[i] != null &&
      dif[prev] >= dea[prev] && dif[i] < dea[i] ? 1 : 0;
    const macdPositive = dif[i] != null && dif[i] > 0 ? 1 : 0;
    const macdHistTurnPositive = prev !== null && bar[prev] != null && bar[i] != null &&
      bar[prev] <= 0 && bar[i] > 0 ? 1 : 0;
    const kdjGoldCross = prev !== null && k[prev] != null && d[prev] != null && k[i] != null && d[i] != null &&
      k[prev] <= d[prev] && k[i] > d[i] ? 1 : 0;
    const kdjDeadCross = prev !== null && k[prev] != null && d[prev] != null && k[i] != null && d[i] != null &&
      k[prev] >= d[prev] && k[i] < d[i] ? 1 : 0;
    const maBullish = ma5[i] != null && ma10[i] != null && ma20[i] != null && ma5[i] > ma10[i] && ma10[i] > ma20[i] ? 1 : 0;
    const maBearish = ma5[i] != null && ma10[i] != null && ma20[i] != null && ma5[i] < ma10[i] && ma10[i] < ma20[i] ? 1 : 0;
    const maAbove20 = b.close != null && ma20[i] != null && b.close > ma20[i] ? 1 : 0;
    const maCrossAbove5 = prev !== null && closes[prev] != null && ma5[prev] != null && b.close != null && ma5[i] != null &&
      closes[prev] <= ma5[prev] && b.close > ma5[i] ? 1 : 0;

    // 命中标签（计算值）
    const hit = [];
    if (macdGoldCross) hit.push('MACD金叉');
    if (macdDeadCross) hit.push('MACD死叉');
    if (macdPositive) hit.push('DIF>0');
    if (macdHistTurnPositive) hit.push('MACD柱翻红');
    if (kdjGoldCross) hit.push('KDJ金叉');
    if (kdjDeadCross) hit.push('KDJ死叉');
    if (maBullish) hit.push('MA多头');
    if (maBearish) hit.push('MA空头');
    if (maAbove20) hit.push('站上MA20');
    if (maCrossAbove5) hit.push('上穿MA5');
    if (b.volume_streak >= 3) hit.push(`连续放量${b.volume_streak}日`);
    if (b.vol_ratio_5 != null && b.vol_ratio_5 >= 1.5) hit.push(`放量${round4(b.vol_ratio_5)}x`);
    if (b.high_60d_distance_pct != null && b.high_60d_distance_pct >= 8) hit.push('上方空间充足');

    return {
      code: b.code,
      trade_date: b.trade_date,
      ma5: round4(ma5[i]), ma10: round4(ma10[i]), ma20: round4(ma20[i]), ma60: round4(ma60[i]),
      macd_dif: round4(dif[i]), macd_dea: round4(dea[i]), macd_bar: round4(bar[i]),
      rsi6: round4(rsi6[i]), rsi12: round4(rsi12[i]), rsi24: round4(rsi24[i]),
      kdj_k: round4(k[i]), kdj_d: round4(d[i]), kdj_j: round4(j[i]),
      vol_ma5: round4(volMa5[i]), vol_ratio_5: round4(b.vol_ratio_5),
      volume_streak: b.volume_streak ?? 0,
      high_60d_distance_pct: round4(b.high_60d_distance_pct),
      macd_gold_cross: macdGoldCross,
      macd_dead_cross: macdDeadCross,
      macd_positive: macdPositive,
      macd_hist_turn_positive: macdHistTurnPositive,
      kdj_gold_cross: kdjGoldCross,
      kdj_dead_cross: kdjDeadCross,
      ma_bullish: maBullish,
      ma_bearish: maBearish,
      ma_above_20: maAbove20,
      ma_cross_above_5: maCrossAbove5,
      indicator_hit: JSON.stringify(hit),
      data_origin: 'derived',
    };
  });
}

/**
 * 批量写入 tech_indicators
 * @param {import('../db/driver.js').Database} db
 * @param {Map<string, object[]>} barsByCode code -> enriched bars
 */
export function seedIndicators(db, barsByCode) {
  const tx = db.transaction(() => {
    // 仅删除「本次输入范围内」的 code，避免误删未同步标的的已有派生数据（内存友好 + 增量重算）
    const codes = [...barsByCode.keys()];
    if (codes.length) db.deleteByCodes('tech_indicators', codes);
    else db.exec('DELETE FROM tech_indicators');
    for (const [code, bars] of barsByCode) {
      const rows = computeIndicators(bars);
      for (const r of rows) {
        db.run(
          `INSERT INTO tech_indicators (
             code, trade_date, ma5, ma10, ma20, ma60,
             macd_dif, macd_dea, macd_bar,
             rsi6, rsi12, rsi24, kdj_k, kdj_d, kdj_j,
             vol_ma5, vol_ratio_5, volume_streak, high_60d_distance_pct,
             macd_gold_cross, macd_dead_cross, macd_positive, macd_hist_turn_positive,
             kdj_gold_cross, kdj_dead_cross, ma_bullish, ma_bearish,
             ma_above_20, ma_cross_above_5, indicator_hit, data_origin
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            r.code, r.trade_date, r.ma5, r.ma10, r.ma20, r.ma60,
            r.macd_dif, r.macd_dea, r.macd_bar,
            r.rsi6, r.rsi12, r.rsi24, r.kdj_k, r.kdj_d, r.kdj_j,
            r.vol_ma5, r.vol_ratio_5, r.volume_streak, r.high_60d_distance_pct,
            r.macd_gold_cross, r.macd_dead_cross, r.macd_positive, r.macd_hist_turn_positive,
            r.kdj_gold_cross, r.kdj_dead_cross, r.ma_bullish, r.ma_bearish,
            r.ma_above_20, r.ma_cross_above_5, r.indicator_hit, r.data_origin,
          ],
        );
      }
    }
  });
  tx();
}
