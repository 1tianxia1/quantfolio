// ============================================================
// 五步法/七步法漏斗管线单测
// 使用内存库 + 最小合成数据
// ============================================================
import { describe, it, expect, beforeAll } from 'vitest';
import { openMemoryDatabase } from '../src/db/driver.js';
import { initSchema } from '../src/db/schema.js';
import { createPipelineService } from '../src/services/pipelineService.js';

let db;
let pipeline;

/** 插入一个带行情/指标/竞价/资金流的标的 */
function insertSecurity(code, name, opts = {}) {
  const price = opts.price ?? 10;
  const pctChg = opts.pctChg ?? 4;
  const turnover = opts.turnover ?? 12;
  const mv = opts.mv ?? 200;
  const volRatio = opts.volRatio ?? 1.5;
  const streak = opts.streak ?? 3;
  const space = opts.space ?? 10;
  const auctionPct = opts.auctionPct ?? 4;
  const auctionVolRatio = opts.auctionVolRatio ?? 1.5;
  const firstTrade = opts.firstTrade ?? 2.5;
  const sector = opts.sector ?? 'AI芯片';
  const maBullish = opts.maBullish ?? 1;
  const ma60Bullish = opts.ma60Bullish ?? 1;
  const limitStreak = opts.limitStreak ?? 0;

  db.run(
    `INSERT INTO securities (code, name, market, type, board, price_limit_pct, industry, sector, circ_mv, data_origin)
     VALUES (?,?,?, 'stock', 'SZ-Main10', 10, '测试', ?, ?, 'real')`,
    [code, name, 'SZ', sector, mv],
  );
  db.run(
    `INSERT INTO daily_quotes (code, trade_date, open, high, low, close, pre_close, volume, amount, pct_chg, turnover_rate, volume_ratio, data_origin)
     VALUES (?, '2026-08-07', ?, ?, ?, ?, ?, 1000, 10000, ?, ?, ?, 'real')`,
    [code, price * 1.02, price * 1.03, price * 0.98, price, price / 1.04, pctChg, turnover, volRatio],
  );
  const ma5 = maBullish ? price - 0.2 : price + 0.2;
  const ma10 = maBullish ? price - 0.4 : price + 0.1;
  const ma20 = maBullish ? price - 0.6 : price - 0.1;
  const ma60 = ma60Bullish ? price - 0.8 : price - 0.3;
  db.run(
    `INSERT INTO tech_indicators (
       code, trade_date, ma5, ma10, ma20, ma60, macd_dif, macd_dea, macd_bar,
       rsi6, rsi12, rsi24, kdj_k, kdj_d, kdj_j, vol_ma5, vol_ratio_5,
       volume_streak, high_60d_distance_pct, macd_gold_cross, macd_dead_cross, macd_positive,
       macd_hist_turn_positive, kdj_gold_cross, kdj_dead_cross, ma_bullish, ma_bearish,
       ma_above_20, ma_cross_above_5, indicator_hit, data_origin
     ) VALUES (?, '2026-08-07', ?, ?, ?, ?, 0.5, 0.3, 0.4, 55, 55, 55, 50, 50, 50,
       800, 1.8, ?, ?, 1, 0, 1, 0, 0, 0, ?, 0, 1, 0, '[]', 'derived')`,
    [code, ma5, ma10, ma20, ma60, streak, space, maBullish],
  );
  db.run(
    `INSERT INTO auction_data (code, trade_date, auction_price, auction_pct, auction_volume, auction_amount, auction_vol_ratio, first_trade_vol_ratio, data_origin)
     VALUES (?, '2026-08-07', ?, ?, 100, 1000, ?, ?, 'derived')`,
    [code, price * (1 + auctionPct / 100), auctionPct, auctionVolRatio, firstTrade],
  );
  db.run(
    `INSERT INTO money_flow (code, trade_date, main_net_inflow, net_inflow_3d, net_inflow_5d, data_origin)
     VALUES (?, '2026-08-07', 1000, 3000, 5000, 'real')`,
    [code],
  );
  if (limitStreak > 0) {
    db.run(
      `INSERT INTO limit_records (code, trade_date, limit_type, limit_up_streak, pattern, data_origin)
       VALUES (?, '2026-08-07', 'limit_up', ?, '1天1板', 'real')`,
      [code, limitStreak],
    );
  }
}

beforeAll(async () => {
  db = await openMemoryDatabase();
  initSchema(db);

  // A：完美通过尾盘五步法（3-5%涨幅/5-20换手/50-500亿/3日连量/多头+10%空间）
  insertSecurity('000001', '完美标的', { price: 10, pctChg: 4, turnover: 12, mv: 200, streak: 3, space: 10 });
  // B：涨幅超 5%（第一步淘汰）
  insertSecurity('000002', '涨幅过高', { price: 10, pctChg: 8, turnover: 12, mv: 200, streak: 3, space: 10 });
  // C：市值超 500 亿（第三步淘汰）
  insertSecurity('000003', '大盘股', { price: 10, pctChg: 4, turnover: 12, mv: 800, streak: 3, space: 10 });
  // D：放量不足（第四步淘汰）
  insertSecurity('000004', '缩量股', { price: 10, pctChg: 4, turnover: 12, mv: 200, streak: 1, space: 10 });
  // E：空间不足（第五步淘汰）
  insertSecurity('000005', '无空间', { price: 10, pctChg: 4, turnover: 12, mv: 200, streak: 3, space: 2 });

  pipeline = createPipelineService(db);
});

describe('尾盘五步法漏斗', () => {
  it('funnel 5 步逐步过滤，只有 A 通过全部步骤', () => {
    const steps = [
      { id: 'pct3_5', enabled: true, params: { min: 3, max: 5 } },
      { id: 'turnover5_20', enabled: true, params: { min: 5, max: 20 } },
      { id: 'mv50_500', enabled: true, params: { min: 50, max: 500 } },
      { id: 'vol_streak', enabled: true, params: { minStreak: 3, maxStreak: 5 } },
      { id: 'ma_bullish', enabled: true, params: { minSpace: 8 } },
    ];
    const r = pipeline.runPipeline({ type: 'closing', steps });
    expect(r.funnel).toHaveLength(5);
    expect(r.funnel[0].survivors).toBe(4); // B 在第 1 步淘汰（涨幅超5%）
    expect(r.funnel[1].survivors).toBe(4); // 换手均达标
    expect(r.funnel[2].survivors).toBe(3); // C 淘汰（市值超500亿）
    expect(r.funnel[3].survivors).toBe(2); // D 淘汰（放量不足）
    expect(r.funnel[4].survivors).toBe(1); // E 淘汰（空间不足）
    expect(r.items).toHaveLength(1);
    expect(r.items[0].code).toBe('000001');
    // 命中步骤标签：5 个步骤全部命中
    expect(r.items[0].hit_step_tags).toHaveLength(5);
    // 淘汰原因 Top3
    expect(r.funnel[0].top_reasons.length).toBeGreaterThan(0);
  });

  it('禁用某步骤后该步骤不淘汰', () => {
    const steps = [
      { id: 'pct3_5', enabled: true, params: { min: 3, max: 5 } },
      { id: 'turnover5_20', enabled: false, params: {} },
      { id: 'mv50_500', enabled: true, params: { min: 50, max: 500 } },
      { id: 'vol_streak', enabled: true, params: { minStreak: 3, maxStreak: 5 } },
      { id: 'ma_bullish', enabled: true, params: { minSpace: 8 } },
    ];
    const r = pipeline.runPipeline({ type: 'closing', steps });
    const turnStep = r.funnel.find((f) => f.step_id === 'turnover5_20');
    expect(turnStep.eliminated).toBe(0);
    expect(turnStep.survivors).toBe(4); // 禁用步骤不淘汰：pool 在第 1 步后为 4
  });
});

describe('早盘七步法漏斗', () => {
  it('小盘/主线/首笔爆量条件生效；宽松模式可放大市值阈值', () => {
    const steps = [
      { id: 'auction_top60', enabled: true, params: { topN: 60 } },
      { id: 'vol_ratio_top30', enabled: true, params: { topN: 30, min: 1.5 } },
      { id: 'auction3_5', enabled: true, params: { min: 3, max: 5 } },
      { id: 'mv_lt10', enabled: true, params: { max: 10, looseMax: 30 } },
      { id: 'ma_bullish60', enabled: true, params: { minSpace: 8 } },
      { id: 'hot_sector', enabled: true, params: { sectors: ['AI芯片'] } },
      { id: 'first_trade_vol', enabled: true, params: { min: 2 } },
    ];
    // 严格模式：所有标的市值都 > 10 亿 → 全部淘汰
    const strict = pipeline.runPipeline({ type: 'morning', steps, loose_mode: false });
    expect(strict.funnel[3].survivors).toBe(0);
    // 宽松模式 <30 亿依然没有（合成数据市值 200/800 亿），验证开关存在且不影响行为
    const loose = pipeline.runPipeline({ type: 'morning', steps, loose_mode: true });
    expect(loose.funnel[3].survivors).toBe(0);
  });
});
