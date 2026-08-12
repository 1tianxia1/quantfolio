// ============================================================
// /api/backtest/* 路由（run / tune / models）
//   POST /run    —— 单次回测
//   POST /tune   —— 网格搜索调参
//   GET  /models —— 模型元数据（faithful / dataCaveat / 因子键 / 默认权重）
// ============================================================
import { Router } from 'express';
import { z } from 'zod';
import { createBacktestService } from '../services/backtestService.js';
import { createTuningService } from '../services/tuningService.js';
import { validateBody } from '../middleware/validate.js';
import { optionalAuth } from '../middleware/auth.js';
import { ok } from '../util/response.js';

const modelEnum = z.enum(['morning', 'closing', 'closingPipeline', 'morningPipeline']);

const rangeSchema = z.tuple([z.string().min(1), z.string().min(1)]);

const runSchema = z.object({
  model: modelEnum,
  range: rangeSchema,
  topN: z.number().int().positive().optional().default(20),
  minScore: z.number().optional().default(0),
  weightsOverride: z.record(z.number()).nullable().optional().default(null),
  nextDayReturnField: z.string().optional().default('pct_chg'),
  sampling: z.object({ step: z.number().int().positive() }).nullable().optional().default(null),
  cap: z.number().int().positive().max(10000).optional().default(2000),
});

const tuneSchema = z.object({
  model: modelEnum,
  range: rangeSchema,
  topN: z.number().int().positive().optional().default(20),
  minScore: z.number().optional().default(0),
  tuneTargets: z.record(z.array(z.number())).optional().default({}),
  objective: z.enum(['winRate', 'avgRet']).optional().default('winRate'),
  sampling: z.object({ step: z.number().int().positive() }).optional().default({ step: 5 }),
  topK: z.number().int().positive().optional().default(10),
});

export function createBacktestRoutes(db) {
  const router = Router();
  const backtestService = createBacktestService(db);
  const tuningService = createTuningService(db, backtestService);

  // 单次回测
  router.post('/run', optionalAuth, validateBody(runSchema), (req, res, next) => {
    try {
      const result = backtestService.run(req.validated, req.user?.id ?? null);
      res.json(ok(result, 'ok'));
    } catch (e) {
      next(e);
    }
  });

  // 网格搜索调参
  router.post('/tune', optionalAuth, validateBody(tuneSchema), (req, res, next) => {
    try {
      const result = tuningService.tune(req.validated, req.user?.id ?? null);
      res.json(ok(result, 'ok'));
    } catch (e) {
      next(e);
    }
  });

  // 模型元数据
  router.get('/models', (req, res, next) => {
    try {
      res.json(ok({ models: backtestService.getModels() }, 'ok'));
    } catch (e) {
      next(e);
    }
  });

  return router;
}
