// ============================================================
// 择时服务（架构 §9 T05）—— 策略模式
// P1 落地：signal_follow（跟随技术面信号：买入分批建仓 / 卖出分批离场 / 观望）
// P2 预留：kelly（凯利公式）/ grid（网格）/ martingale（马丁格尔）/ right_stop（右侧止盈）
// 不构成投资建议；示例性建议，仅做盘面信号解读。
// ============================================================
import { createTechnicalSignalService } from './technicalSignalService.js';
import { ApiError } from '../../util/errors.js';

/** 支持的择时策略（P1 仅 signal_follow 完整实现） */
export const TIMING_STRATEGIES = Object.freeze(['signal_follow', 'kelly', 'grid', 'martingale', 'right_stop']);

/**
 * 择时服务工厂
 * @param {import('../../db/driver.js').Database} db
 */
export function createTimingService(db) {
  const technical = createTechnicalSignalService(db);

  /**
   * 对标的执行择时
   * @param {string} code 6 位裸码
   * @param {string} [strategy='signal_follow'] 策略名
   * @returns {Promise<object>} TimingResult
   */
  async function timing(code, strategy = 'signal_follow') {
    if (!TIMING_STRATEGIES.includes(strategy)) {
      throw ApiError.badRequest(`未知择时策略：${strategy}（支持 ${TIMING_STRATEGIES.join(' / ')}）`);
    }
    if (strategy !== 'signal_follow') {
      // P2 模板：本期明确占位，不做空壳结果
      return {
        strategy,
        implemented: false,
        code,
        message: `择时策略「${strategy}」将在 P2 提供（当前仅支持 signal_follow 跟随信号）`,
      };
    }

    // 复用模块 B 技术信号（同一套盘面口径）
    const signal = await technical.analyze(code);

    // 从 K 线序列算关键位（近 20 日低点 / 近 60 日高点）
    const lows = signal.series.slice(-20).map((b) => b.low).filter((v) => v != null && Number.isFinite(v));
    const highs = signal.series.slice(-60).map((b) => b.high).filter((v) => v != null && Number.isFinite(v));
    const price = Number(signal.indicators.price);
    const refStop = lows.length ? Math.min(...lows) : null;
    const refTarget = highs.length ? Math.max(...highs) : null;

    return {
      strategy: 'signal_follow',
      implemented: true,
      code: signal.code,
      name: signal.name,
      trade_date: signal.trade_date,
      action: signal.action,
      strength: signal.strength,
      reasons: signal.reasons,
      entry_advice: buildEntry(signal, refTarget),
      exit_advice: buildExit(signal, refStop),
      key_levels: {
        price: round2(price),
        ref_stop: refStop == null ? null : round2(refStop),
        ref_target: refTarget == null ? null : round2(refTarget),
      },
      risk_notes: [
        '本建议仅基于盘面信号解读，不构成投资建议。',
        '建议分批操作、控制单次仓位；跌破参考止损位严格执行。',
      ],
    };
  }

  return { timing, strategies: TIMING_STRATEGIES };
}

function round2(v) {
  return Math.round((Number(v) + Number.EPSILON) * 100) / 100;
}

/** 买入择时建议（signal_follow） */
function buildEntry(signal, refTarget) {
  const price = signal.indicators.price;
  const ma20 = signal.indicators.ma20;
  const base = `现价 ${price ?? '—'}`;
  if (signal.action === 'buy') {
    const maNote = ma20 != null ? `，回踩 MA20（${round2(ma20)}）附近可加仓` : '';
    const targetNote = refTarget != null ? `；接近 60 日高点 ${round2(refTarget)} 附近不追高` : '';
    return `买入信号（强度 ${signal.strength}）：${base}，建议首笔 1/3 仓位分批建仓${maNote}${targetNote}。`;
  }
  if (signal.action === 'sell') {
    return `卖出信号，暂不建仓：${base}，等待信号转好（金叉/资金回流转正）后再评估。`;
  }
  return `观望：${base}，当前信号未达标（强度 ${signal.strength}），等待明确买卖点。`;
}

/** 卖出择时建议（signal_follow） */
function buildExit(signal, refStop) {
  const stopNote = refStop != null ? `；参考止损位为近 20 日低点 ${round2(refStop)}，跌破则止损离场` : '';
  if (signal.action === 'buy') {
    return `持有为主：未触发离场条件${stopNote}。`;
  }
  if (signal.action === 'sell') {
    return `减仓/离场信号（强度 ${signal.strength}）：建议分批止盈或止损离场${stopNote}。`;
  }
  return `持有者观望：不追涨杀跌${stopNote}。`;
}

export default createTimingService;
