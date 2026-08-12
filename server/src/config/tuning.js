// ============================================================
// 调参默认配置
//   - 各模型可调因子白名单（仅 morning/closing 加权模型）
//   - objective -> metric 映射
//   - 默认采样步长
// ============================================================

/** 默认采样步长（调参加速：每 N 交易日取 1） */
export const TUNING_DEFAULT_SAMPLING_STEP = 5;

/** 各加权模型可调因子白名单（键名与 MORNING_WEIGHTS / CLOSING_WEIGHTS 一致） */
export const TUNABLE_FACTORS = {
  morning: ['volume_ratio', 'auction', 'net_inflow', 'limit_up', 'turnover', 'sector_heat'],
  closing: ['trend', 'momentum', 'volume', 'valuation'],
};

/** objective -> 排序指标 */
export const OBJECTIVE_METRIC = {
  winRate: 'winRate',
  avgRet: 'avgNextRet',
};

/** 调参默认参数 */
export const DEFAULT_TUNING = {
  samplingStep: TUNING_DEFAULT_SAMPLING_STEP,
  topK: 10,
};

/** 判断模型是否为早盘模型（dataCaveat 标记用） */
export function isMorningModel(model) {
  return model === 'morning' || model === 'morningPipeline';
}
