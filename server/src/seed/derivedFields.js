// ============================================================
// 派生字段：volume_ratio / volume_streak / high_60d_distance_pct
// 纯函数（可单测），由 K 线序列计算
// ============================================================
import { volumeStreak, high60dDistancePct, sma } from '../util/indicators.js';
import { round4 } from '../util/money.js';

/**
 * 为 K 线序列附加派生字段
 * @param {object[]} bars 升序 K 线（含 volume/high/low/close）
 * @returns {object[]} 附加 volume_ratio / volume_streak / high_60d_distance_pct / vol_ratio_5
 */
export function deriveFields(bars) {
  const volumes = bars.map((b) => b.volume);
  const highs = bars.map((b) => b.high);
  const closes = bars.map((b) => b.close);
  const streak = volumeStreak(volumes);
  const space = high60dDistancePct(highs, closes, 60);
  const volMa5 = sma(volumes, 5);

  return bars.map((b, i) => {
    // 量比 = 当日量 / 前5日均量（不足 5 日时用可用均值）
    let volumeRatio = null;
    if (i >= 5) {
      const prev5 = volumes.slice(i - 5, i);
      const avg = prev5.reduce((s, v) => s + v, 0) / prev5.length;
      volumeRatio = avg > 0 ? volumes[i] / avg : null;
    } else if (i > 0) {
      const prev = volumes.slice(0, i);
      const avg = prev.reduce((s, v) => s + v, 0) / prev.length;
      volumeRatio = avg > 0 ? volumes[i] / avg : null;
    }
    const volRatio5 = volMa5[i] ? volumes[i] / volMa5[i] : null;
    return {
      ...b,
      volume_ratio: volumeRatio != null ? round4(volumeRatio) : null,
      vol_ratio_5: volRatio5 != null ? round4(volRatio5) : null,
      volume_streak: streak[i],
      high_60d_distance_pct: space[i] != null ? round4(space[i]) : null,
    };
  });
}
