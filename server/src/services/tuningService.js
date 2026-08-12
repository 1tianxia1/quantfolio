// ============================================================
// 调参器（网格搜索）
//   复用 backtestService.buildSnapshots（快照与权重解耦，一次物化、多组合重算评分）
// ============================================================================
import { expandGrid, rankBy } from '../util/gridSearch.js';
import { createBacktestModel } from '../models/backtestModel.js';
import { isMorningModel } from '../config/tuning.js';

/**
 * 调参服务工厂
 * @param {import('../db/driver.js').Database} db
 * @param {import('./backtestService.js').createBacktestService} backtestService
 */
export function createTuningService(db, backtestService) {
  /** 评估单组权重：遍历已物化快照，逐日打分 -> topN -> 累计次日收益 -> 汇总 */
  function evaluateCombo(combo, base, model, req) {
    const topN = req.topN ?? 20;
    const minScore = req.minScore ?? 0;
    const morning = isMorningModel(model);
    const trades = [];
    for (const [T, dayArr] of base) {
      const pool = morning ? backtestService.getAsOfPool(T) : null;
      const scored = dayArr.map((entry) => {
        const { total } = backtestService.scoreFor(model, entry.snap, combo, pool);
        return { total, nextRet: entry.nextRet };
      });
      const picked = scored
        .filter((s) => s.total >= minScore && s.nextRet != null)
        .sort((a, b) => b.total - a.total)
        .slice(0, topN);
      for (const p of picked) trades.push({ nextRet: p.nextRet });
    }
    return backtestService.summarize(trades);
  }

  return {
    /** 网格搜索调参 */
    tune(req, userId = null) {
      const model = req.model;
      const topK = req.topK ?? 10;
      const objective = req.objective ?? 'winRate';

      // 1) 笛卡尔积展开全部权重组合
      const combos = expandGrid(req.tuneTargets || {}, model);

      // 2) 一次物化 AS-OF-T 快照（含预取 nextRet + 早盘分位池缓存）
      const base = backtestService.buildSnapshots(req);

      // 3) 逐组合评估
      const results = combos.map((combo) => ({
        weights: combo,
        metrics: evaluateCombo(combo, base, model, req),
      }));

      // 4) 按 objective 排序取 Top K
      const ranked = rankBy(results, objective);
      const top = ranked
        .slice(0, topK)
        .map((r, i) => ({ rank: i + 1, weights: r.weights, metrics: r.metrics }));

      const dataCaveat = isMorningModel(model) ? 'morning aux data sparse, results not faithful' : null;

      // 5) 落库（kind='tune'：summary=最优组合 metrics，best_weights=Top1）
      if (process.env.BACKTEST_PERSIST !== 'false' && top.length > 0) {
        try {
          const backtestModel = createBacktestModel(db);
          backtestModel.save({
            userId,
            kind: 'tune',
            model,
            params: {
              model,
              range: req.range,
              topN: req.topN ?? 20,
              minScore: req.minScore ?? 0,
              tuneTargets: req.tuneTargets || {},
              objective,
              sampling: req.sampling ?? null,
              topK,
            },
            summary: top[0].metrics,
            objective,
            bestWeights: top[0].weights,
          });
        } catch (e) {
          console.warn('[tuning] 落库失败（已忽略）:', e.message);
        }
      }

      return {
        model,
        objective,
        combinations: combos.length,
        dataCaveat,
        results: top,
      };
    },
  };
}
