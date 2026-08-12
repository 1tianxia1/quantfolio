// ============================================================
// 调参网格搜索纯函数（可单测）
//   expandGrid(targets, model)  —— 笛卡尔积展开为完整 weights 对象数组
//   rankBy(results, objective)  —— 按目标指标降序排序
// ============================================================
import { DEFAULT_WEIGHTS_BY_MODEL } from '../config/scoring.js';

/**
 * 笛卡尔积展开 tuneTargets 为完整 weights 对象数组。
 * - targets: { factorKey: number[] }，仅对加权模型（morning/closing）生效
 * - 未指定的因子用 DEFAULT_WEIGHTS_BY_MODEL[model] 默认补全
 * - 若某因子值为空数组/缺失，则该因子不参与网格（用默认）
 * @param {Record<string, number[]>} targets
 * @param {'morning'|'closing'} [model='closing']
 * @returns {Record<string, number>[]}
 */
export function expandGrid(targets, model = 'closing') {
  const defaults = DEFAULT_WEIGHTS_BY_MODEL[model] || {};
  const keys = Object.keys(targets || {}).filter(
    (k) => Array.isArray(targets[k]) && targets[k].length > 0 && Object.prototype.hasOwnProperty.call(defaults, k),
  );

  if (keys.length === 0) {
    return [{ ...defaults }];
  }

  // 逐因子笛卡尔积
  let combos = [{}];
  for (const key of keys) {
    const values = targets[key];
    const next = [];
    for (const combo of combos) {
      for (const v of values) {
        next.push({ ...combo, [key]: v });
      }
    }
    combos = next;
  }

  // 用默认补全未指定因子
  return combos.map((combo) => ({ ...defaults, ...combo }));
}

/**
 * 按 objective 排序结果（降序）。
 * @param {Array<{weights: object, metrics: object}>} results
 * @param {'winRate'|'avgRet'} [objective='winRate']
 * @returns {Array<{weights: object, metrics: object}>}
 */
export function rankBy(results, objective = 'winRate') {
  const metric = objective === 'avgRet' ? 'avgNextRet' : 'winRate';
  return [...results].sort(
    (a, b) => (b.metrics?.[metric] ?? -Infinity) - (a.metrics?.[metric] ?? -Infinity),
  );
}
