// ============================================================
// 模块 B 策略指标（技术面）主编排（架构 §9 T04）
// 输入 code → indicatorService 快照 + K 线/MACD 序列 + 资金流
//          → signalRules.evaluate（纯函数）→ TechnicalReport
// 铁律：报告中不出现任何「公司好坏 / 基本面」类文字（PRD 要求只看盘面）。
// ============================================================
import { createIndicatorService } from '../indicatorService.js';
import { evaluate as evaluateRules } from './signalRules.js';
import { macd } from '../../util/indicators.js';
import { ApiError } from '../../util/errors.js';

/** 历史窗口：60 根背离 + 30 根趋势 = 90 根足够 */
const KLINE_WINDOW = 90;

/**
 * 模块 B 技术信号服务工厂
 * @param {import('../../db/driver.js').Database} db
 */
export function createTechnicalSignalService(db) {
  const indicators = createIndicatorService(db);

  /**
   * 分析单个标的的技术面信号
   * @param {string} code 6 位裸码
   * @returns {Promise<object>} TechnicalReport
   */
  async function analyze(code) {
    // 1) 最新指标快照（MACD 标志 / 量比 / 资金流 / 价格）
    const snaps = indicators.getLatestSnapshot([code]);
    const snap = snaps[0];
    if (!snap) throw ApiError.securityNotFound(`标的不存在或暂无行情：${code}`);

    // 2) 历史 K 线 + 已计算的 MACD（取最新 90 根，升序）
    const rowsDesc = db.all(
      `SELECT dq.trade_date AS date, dq.open, dq.close, dq.high, dq.low, dq.volume, dq.pct_chg, dq.volume_ratio,
              ti.macd_dif AS dif, ti.macd_dea AS dea, ti.macd_bar AS bar
         FROM daily_quotes dq
         LEFT JOIN tech_indicators ti ON ti.code = dq.code AND ti.trade_date = dq.trade_date
        WHERE dq.code = ?
        ORDER BY dq.trade_date DESC
        LIMIT ${KLINE_WINDOW}`,
      [code],
    );
    const rows = (rowsDesc || []).reverse();

    if (rows.length < 10) {
      throw ApiError.upstreamUnavailable(`技术指标数据不足（${code} 仅有 ${rows.length} 根 K 线）`);
    }

    // 3) 组装 bars（含 OHLC / 量 / MACD）；若表里无 DIF（未计算），用 K 线现算 MACD 兜底
    const bars = rows.map((r) => ({
      date: r.date,
      open: r.open,
      close: r.close,
      high: r.high,
      low: r.low,
      volume: r.volume,
      pct_chg: r.pct_chg,
      volume_ratio: r.volume_ratio,
      dif: r.dif ?? null,
      dea: r.dea ?? null,
      bar: r.bar ?? null,
    }));

    if (bars.every((b) => b.dif == null)) {
      const closes = bars.map((b) => b.close);
      const m = macd(closes, 12, 26, 9);
      bars.forEach((b, i) => {
        b.dif = m.dif[i];
        b.dea = m.dea[i];
        b.bar = m.bar[i];
      });
    }

    // 4) 纯函数评估（同一输入永远同一输出，P2 回测可逐根回放）
    const result = evaluateRules({ code, snap, bars });

    // 5) 组装 TechnicalReport（不含基本面文字）
    return {
      code: snap.code,
      name: snap.name,
      type: snap.type,
      trade_date: snap.trade_date,
      data_origin: snap.data_origin || 'real',
      action: result.action,
      strength: result.strength,
      raw: result.raw,
      reasons: result.reasons,
      rules: result.hits.map((h) => ({
        id: h.id,
        label: h.label,
        direction: h.direction,
        weight: h.weight,
        detail: h.detail || null,
      })),
      indicators: {
        price: snap.price,
        pct_chg: snap.pct_chg,
        volume_ratio: snap.volume_ratio,
        vol_ratio_5: snap.vol_ratio_5,
        turnover_rate: snap.turnover_rate,
        ma5: snap.ma5,
        ma10: snap.ma10,
        ma20: snap.ma20,
        ma60: snap.ma60,
        macd_dif: snap.macd_dif,
        macd_dea: snap.macd_dea,
        macd_bar: snap.macd_bar,
        rsi12: snap.rsi12,
        kdj_k: snap.kdj_k,
        kdj_d: snap.kdj_d,
        kdj_j: snap.kdj_j,
        net_inflow_5d: snap.net_inflow_5d,
        main_net_inflow: snap.main_net_inflow,
      },
      series: bars.map((b) => ({
        date: b.date,
        open: b.open,
        close: b.close,
        high: b.high,
        low: b.low,
        volume: b.volume,
        dif: b.dif,
        dea: b.dea,
        bar: b.bar,
      })),
      meta: {
        degraded: false,
        generated_at: new Date().toISOString(),
      },
    };
  }

  return { analyze };
}

export default createTechnicalSignalService;
