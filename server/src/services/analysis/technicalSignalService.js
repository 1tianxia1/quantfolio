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
import { fetchFundNav } from '../../providers/tiantianFundProvider.js';

/** 历史窗口：60 根背离 + 30 根趋势 = 90 根足够 */
const KLINE_WINDOW = 90;

/**
 * 模块 B 技术信号服务工厂
 * @param {import('../../db/driver.js').Database} db
 */
export function createTechnicalSignalService(db) {
  const indicators = createIndicatorService(db);

  /**
   * 判断并组装场外基金的技术面兜底报告。
   * 场外基金无盘中行情（无 OHLC/成交量/MACD），不适合技术面买卖信号，
   * 因此返回一个明确标记为 `is_otc_fund` 的持有态报告，前端据此给出友好提示。
   * @param {string} code
   * @returns {object|null} 若确认是场外基金则返回报告，否则 null
   */
  async function resolveOtcFundSnapshot(code) {
    const sec = db.get('SELECT code, name, type, fund_category FROM securities WHERE code = ?', [code]);
    const isOtc = sec?.fund_category === '场外' || (sec?.type === 'fund' && !db.get('SELECT 1 FROM daily_quotes WHERE code = ? LIMIT 1', [code]));
    if (!isOtc) return null;

    // 优先取本地最新净值，没有则实时拉天天基金并落地
    let navRow = db.get(
      'SELECT nav_date, nav, pre_nav, nav_chg_pct FROM fund_nav WHERE code = ? ORDER BY nav_date DESC LIMIT 1',
      [code],
    );
    if (!navRow || !Number.isFinite(navRow.nav)) {
      try {
        const fetched = await fetchFundNav([code]);
        if (fetched?.[0]?.nav) {
          const n = fetched[0];
          const origin = n.is_estimate ? 'mixed' : 'real';
          db.run(
            `INSERT INTO fund_nav (code, nav_date, nav, pre_nav, nav_chg_pct, is_estimate, data_origin)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(code, nav_date) DO UPDATE SET
               nav = excluded.nav,
               pre_nav = excluded.pre_nav,
               nav_chg_pct = excluded.nav_chg_pct,
               is_estimate = excluded.is_estimate,
               data_origin = excluded.data_origin`,
            [n.code, n.nav_date || new Date().toISOString().slice(0, 10), n.nav, n.pre_nav, n.nav_chg_pct, n.is_estimate ? 1 : 0, origin],
          );
          navRow = { nav_date: n.nav_date, nav: n.nav, pre_nav: n.pre_nav, nav_chg_pct: n.nav_chg_pct };
        }
      } catch (e) {
        // 拉取失败仍继续返回兜底报告
      }
    }

    const tradeDate = navRow?.nav_date || new Date().toISOString().slice(0, 10);
    const nav = Number.isFinite(navRow?.nav) ? navRow.nav : null;
    const pctChg = Number.isFinite(navRow?.nav_chg_pct) ? navRow.nav_chg_pct : null;

    return {
      code,
      name: sec?.name || code,
      type: sec?.type || 'fund',
      trade_date: tradeDate,
      is_otc_fund: true,
      data_origin: 'fund_nav',
      action: 'hold',
      strength: 0,
      raw: 0,
      reasons: ['场外基金无盘中行情，不支持技术面买卖信号'],
      rules: [],
      indicators: {
        price: nav,
        pct_chg: pctChg,
        volume_ratio: null,
        vol_ratio_5: null,
        turnover_rate: null,
        ma5: null,
        ma10: null,
        ma20: null,
        ma60: null,
        macd_dif: null,
        macd_dea: null,
        macd_bar: null,
        rsi12: null,
        kdj_k: null,
        kdj_d: null,
        kdj_j: null,
        net_inflow_5d: null,
        main_net_inflow: null,
      },
      series: nav
        ? [{
            date: tradeDate,
            open: nav,
            close: nav,
            high: nav,
            low: nav,
            volume: null,
            pct_chg: pctChg,
            volume_ratio: null,
            dif: null,
            dea: null,
            bar: null,
          }]
        : [],
      meta: {
        degraded: true,
        generated_at: new Date().toISOString(),
      },
    };
  }

  /**
   * 分析单个标的的技术面信号
   * @param {string} code 6 位裸码
   * @returns {Promise<object>} TechnicalReport
   */
  async function analyze(code) {
    // 1) 最新指标快照（MACD 标志 / 量比 / 资金流 / 价格）
    const snaps = indicators.getLatestSnapshot([code]);
    let snap = snaps[0];

    // 1.1) 场外基金兜底：没有 daily_quotes，但 securities/fund_nav 里有记录
    if (!snap) {
      const otc = await resolveOtcFundSnapshot(code);
      if (otc) return otc;
      throw ApiError.securityNotFound(`标的不存在或暂无行情：${code}`);
    }

    // 1.2) 即便有 snapshot，如果 securities 明确标记为场外基金，也走兜底
    //      （防止某只基金既有 stale daily_quotes 又被识别为场外基金的情况）
    const sec = db.get('SELECT fund_category FROM securities WHERE code = ?', [code]);
    if (sec?.fund_category === '场外') {
      const otc = await resolveOtcFundSnapshot(code);
      if (otc) return otc;
    }

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
        pct_chg: b.pct_chg,
        volume_ratio: b.volume_ratio,
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
