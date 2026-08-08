// ============================================================
// /api/strategies/* 路由
// 游客：只读预置模板；写操作 401 引导登录
// ============================================================
import { Router } from 'express';
import { z } from 'zod';
import { createStrategyModel } from '../models/strategyModel.js';
import { optionalAuth } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import { ok } from '../util/response.js';
import { ApiError } from '../util/errors.js';
import { STRATEGY_TYPE } from '../../../shared/constants.js';

const createSchema = z.object({
  name: z.string().min(1, '策略名不能为空').max(50),
  type: z.enum(Object.values(STRATEGY_TYPE), '策略类型不合法'),
  conditions: z.any(),
});

const updateSchema = z.object({
  name: z.string().min(1).max(50).optional(),
  conditions: z.any().optional(),
});

export function createStrategyRoutes(db) {
  const router = Router();
  const strategies = createStrategyModel(db);

  router.get('/', optionalAuth, (req, res, next) => {
    try {
      const userId = req.user?.id ?? null;
      const type = req.query.type || undefined;
      res.json(ok(strategies.list(userId, type), 'ok'));
    } catch (e) { next(e); }
  });

  router.post('/', optionalAuth, (req, res, next) => {
    try {
      if (!req.user) return next(ApiError.unauthorized('请先登录后再保存策略'));
      const parsed = createSchema.parse(req.body);
      res.json(ok(strategies.create(req.user.id, parsed), '策略已保存'));
    } catch (e) { next(e); }
  });

  router.put('/:id', optionalAuth, (req, res, next) => {
    try {
      if (!req.user) return next(ApiError.unauthorized('请先登录后再修改策略'));
      const parsed = updateSchema.parse(req.body);
      const updated = strategies.update(req.user.id, Number(req.params.id), parsed);
      if (!updated) return next(ApiError.forbidden('预置策略不可修改或策略不存在'));
      res.json(ok(updated, '策略已更新'));
    } catch (e) { next(e); }
  });

  router.delete('/:id', optionalAuth, (req, res, next) => {
    try {
      if (!req.user) return next(ApiError.unauthorized('请先登录后再删除策略'));
      const deleted = strategies.delete(req.user.id, Number(req.params.id));
      if (!deleted) return next(ApiError.forbidden('预置策略不可删除或策略不存在'));
      res.json(ok(null, '策略已删除'));
    } catch (e) { next(e); }
  });

  return router;
}
