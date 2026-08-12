// ============================================================
// 五步法/七步法默认阈值（用户可覆盖保存）
// 与 SCREENING_RULES.md 精确一致（P0 硬需求）
// ============================================================

/**
 * 尾盘五步法（closing）默认步骤
 * 步骤 id 与 DESIGN.md §5.2 一致
 */
export const CLOSING_PIPELINE_STEPS = [
  {
    id: 'pct3_5',
    label: '当日涨幅 3%~5%',
    enabled: true,
    params: { min: 3, max: 5 },
  },
  {
    id: 'turnover5_20',
    label: '换手率 5%~20%',
    enabled: true,
    params: { min: 5, max: 20 },
  },
  {
    id: 'mv50_500',
    label: '流通市值 50亿~500亿',
    enabled: true,
    params: { min: 50, max: 500 },
  },
  {
    id: 'vol_streak',
    label: '连续 2~8 日温和放量',
    enabled: true,
    params: { minStreak: 2, maxStreak: 8 },
  },
  {
    id: 'ma_bullish',
    label: '多头排列 + 上方空间≥8%',
    enabled: true,
    params: { minSpace: 8 },
  },
];

/**
 * 早盘七步法（morning）默认步骤
 * 步骤 id 与 DESIGN.md §5.2 一致
 */
export const MORNING_PIPELINE_STEPS = [
  {
    id: 'auction_top60',
    label: '竞价涨幅 Top60',
    enabled: true,
    params: { topN: 60 },
  },
  {
    id: 'vol_ratio_top30',
    label: '量比 Top30',
    enabled: true,
    params: { topN: 30, min: 1.5 },
  },
  {
    id: 'auction3_5',
    label: '竞价涨幅 3%~5%',
    enabled: true,
    params: { min: 3, max: 5 },
  },
  {
    id: 'mv_lt10',
    label: '流通市值 <10亿（小盘）',
    enabled: true,
    params: { max: 10, looseMax: 30 },
  },
  {
    id: 'ma_bullish60',
    label: '多头排列(含60日线) + 上方空间≥8%',
    enabled: true,
    params: { minSpace: 8 },
  },
  {
    id: 'hot_sector',
    label: '锚定市场主线板块',
    enabled: true,
    params: { sectors: ['AI芯片', '半导体', '半导体材料', '存储芯片', '创新药', '人形机器人', '商业航天', '光通信'] },
  },
  {
    id: 'first_trade_vol',
    label: '开盘首笔爆量≥2',
    enabled: true,
    params: { min: 2 },
  },
];

/** 步骤默认配置（按 id 索引，供管线执行时合并用户覆盖） */
export const SCREENING_DEFAULTS = {
  closing: Object.fromEntries(CLOSING_PIPELINE_STEPS.map((s) => [s.id, s])),
  morning: Object.fromEntries(MORNING_PIPELINE_STEPS.map((s) => [s.id, s])),
};

/** 步骤默认展示顺序 */
export const SCREENING_STEP_ORDER = {
  closing: CLOSING_PIPELINE_STEPS.map((s) => s.id),
  morning: MORNING_PIPELINE_STEPS.map((s) => s.id),
};

/** 早盘七步法第 4 步宽松模式阈值（<30亿） */
export const MORNING_LOOSE_MV = 30;

/**
 * 尾盘五步法评分（仅对通过全部 5 步者，Σ=100）
 * DESIGN.md §7.4
 */
export const CLOSING_PIPELINE_SCORING = {
  volume_streak: { max: 30, perExtraDay: 10, cap: 50 }, // 3 日=30，每多 1 日 +10，封顶 50
  pct_chg: { max: 20, center: 4, tolerance: 1.5 },      // 20×max(0,1-|pct-4|/1.5)
  turnover: { max: 15, center: 12.5, tolerance: 7.5 },  // 15×max(0,1-|turnover-12.5|/7.5)
  ma_bullish: { max: 20, perMissing: 7 },               // 站上 MA5/MA10/MA20 各计分，缺 1 条 -7
  high_60d: { max: 15, factor: 1.5 },                   // min(15, 空间%×1.5)
};

/**
 * 早盘七步法评分（仅对通过全部 7 步者，Σ=100）
 * DESIGN.md §7.4
 */
export const MORNING_PIPELINE_SCORING = {
  volume_ratio_rank: { max: 25, perTier: 2.5 },         // Top1%=25，每降 1 档 -2.5
  auction_pct: { max: 20, center: 4, tolerance: 1.5 },  // 20×max(0,1-|auction_pct-4|/1.5)
  auction_vol_ratio: { max: 15 },                       // piecewise (0.5,0)(1,60)(2,90)(3,100)
  limit_up: { max: 20, hasLimit: 5, perStreak: 5 },     // 有涨停 +5，连板数每 1 板 +5，封顶 20
  sector_heat: { max: 15, tier1: 15, tier2: 10, tier3: 5 }, // 主线第一档 15 / 第二档 10 / 第三档 5
  first_trade_vol: { max: 5, base: 2 },                 // ≥2 →5，每 +1 加 1，封顶 5
};
