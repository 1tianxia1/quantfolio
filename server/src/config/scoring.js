// ============================================================
// 通用评分权重（M-03 早盘通用 / C-11 尾盘通用）与归一化断点
// 权重固定（不开放用户调整），与 DESIGN.md §7.2 / §7.3 一致
// ============================================================

/** M-03 早盘通用评分权重（Σ=1.00） */
export const MORNING_WEIGHTS = {
  volume_ratio: 0.20,   // 量比
  auction: 0.20,        // 竞价表现
  net_inflow: 0.20,     // 资金流（近3日主力净流入，分位法）
  limit_up: 0.15,       // 连板/涨停强度
  turnover: 0.15,       // 换手率
  sector_heat: 0.10,    // 板块热度
};

/** M-03 各因子归一化断点（piecewise） */
export const MORNING_BREAKPOINTS = {
  volume_ratio: [[0.3, 0], [0.8, 20], [1.0, 40], [1.5, 60], [3, 85], [5, 100], [10, 100]],
  auction_pct: [[-3, 0], [0, 50], [3, 80], [4, 95], [5, 100], [7, 80], [9, 50], [12, 20]],
  auction_vol_ratio: [[0, 20], [0.5, 60], [1, 90], [2, 100]],
  turnover: [[0, 0], [2, 55], [5, 80], [8, 95], [12, 100], [20, 80], [35, 55], [50, 30], [100, 10]],
};

/** M-03 连板/涨停强度得分规则 */
export const MORNING_LIMIT_UP_RULES = {
  noLimit: 0,          // 无涨停
  within20d: 30,       // 近20日有涨停
  streak1: 60,         // 当日涨停 1 板
  streak2: 75,         // 2 板
  streak3: 88,         // 3 板
  streak4Plus: 100,    // 4 板及以上
  oneWordBonus: 5,     // 一字板加分（封顶 100）
  breakBoardPenalty: -10, // 炸板减分
};

/** M-03 板块热度得分（按 hot_rank） */
export const MORNING_SECTOR_HEAT_RULES = [
  { maxRank: 3, score: 100 },
  { maxRank: 10, score: 85 },
  { maxRank: 20, score: 70 },
  { maxRank: 40, score: 50 },
  { maxRank: Infinity, score: 30 },
];

/** M-03 板块涨幅为负时给 10 分 */
export const MORNING_SECTOR_NEGATIVE_SCORE = 10;

/** 通用评分缺失值：早盘 40（中性），尾盘 50（中性） */
export const MISSING_SCORE_MORNING = 40;
export const MISSING_SCORE_CLOSING = 50;

/** C-11 尾盘通用评分权重（Σ=1.00） */
export const CLOSING_WEIGHTS = {
  trend: 0.35,     // 趋势类（0.5×MACD + 0.5×MA）
  momentum: 0.25,  // 动能类（0.5×RSI + 0.5×KDJ）
  volume: 0.25,    // 量能类（0.5×vol_ratio_5 + 0.5×换手）
  valuation: 0.15, // 估值类（0.6×PE + 0.4×市值）
};

/** C-11 子因子权重 */
export const CLOSING_SUB_WEIGHTS = {
  macd: 0.5, ma: 0.5,
  rsi: 0.5, kdj: 0.5,
  volRatio: 0.5, turnover: 0.5,
  pe: 0.6, mv: 0.4,
};

/** C-11 断点表 */
export const CLOSING_BREAKPOINTS = {
  rsi: [[0, 10], [20, 60], [30, 75], [40, 85], [50, 95], [60, 90], [70, 75], [80, 55], [90, 30], [100, 10]],
  vol_ratio_5: [[0.5, 30], [1, 55], [1.5, 80], [2, 95], [3, 100], [5, 85], [8, 60], [10, 40]],
  turnover: [[0, 0], [2, 55], [5, 80], [8, 95], [12, 100], [20, 80], [35, 55], [50, 30], [100, 10]],
  pe: [[0, 100], [10, 95], [15, 85], [20, 70], [30, 55], [50, 40], [100, 20]],
  mv: [[10, 55], [50, 75], [100, 90], [300, 100], [500, 90], [1000, 70], [5000, 40]],
};

/** C-11 MACD 状态得分 */
export const CLOSING_MACD_SCORES = {
  goldCrossDifPositive: 95, // 金叉且 DIF>0
  goldCross: 85,            // 金叉
  histTurnPositive: 70,     // 柱由负转正
  difPositive: 60,          // DIF>0
  difNegative: 30,          // DIF<0
  deadCross: 15,            // 死叉
};

/** C-11 MA 形态得分 */
export const CLOSING_MA_SCORES = {
  bullish: 100,   // 多头排列 MA5>MA10>MA20
  above20: 65,    // close>MA20
  above5: 50,     // 站上 MA5
  bearish: 15,    // 空头排列
  neutral: 40,    // 其余
};

/** C-11 KDJ 状态得分 */
export const CLOSING_KDJ_SCORES = {
  lowGoldCross: 95, // 低位金叉（K<30）
  goldCross: 85,    // 金叉
  deadCross: 20,    // 死叉
  jOversold: 30,    // J<0
  jOverbought: 10,  // J>100
  neutral: 50,      // 其余
};
