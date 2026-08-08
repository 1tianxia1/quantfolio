// ============================================================
// /api/market/* 路由（overview / search / kline / sectors / meta / lineage / watchlist / health）
// ============================================================
import { Router } from 'express';
import { createMarketService } from '../services/marketService.js';
import { optionalAuth } from '../middleware/auth.js';
import { ok } from '../util/response.js';
import { ApiError } from '../util/errors.js';

export function createMarketRoutes(db) {
  const router = Router();
  const market = createMarketService(db);

  router.get('/overview', (_req, res, next) => {
    try { res.json(ok(market.overview(), 'ok')); } catch (e) { next(e); }
  });

  router.get('/search', async (req, res, next) => {
    try {
      const q = String(req.query.q || '').trim();
      const limit = Math.min(50, Math.max(1, Number(req.query.limit || 10)));
      res.json(ok(await market.search(q, limit), 'ok'));
    } catch (e) { next(e); }
  });

  // 显式实时解析：输入代码/名称，返回对应证券（本地优先→桥接兜底→写回缓存）
  router.get('/resolve', async (req, res, next) => {
    try {
      const q = String(req.query.q || '').trim();
      if (!q) return next(ApiError.badRequest('缺少查询参数 q'));
      const sec = await market.resolve(q);
      if (!sec) return next(ApiError.notFound('未找到对应证券（本地库与桥接均未命中，且未编造数据）'));
      res.json(ok(sec, 'ok'));
    } catch (e) { next(e); }
  });

  router.get('/kline', (req, res, next) => {
    try {
      const code = String(req.query.code || '');
      // days 钳制到 [10, 500]：min 10 根是设计取舍（避免空 K 线图），契约未声明最小值；前端默认 120 不受影响
      const days = Math.min(500, Math.max(10, Number(req.query.days || 120)));
      const data = market.kline(code, days);
      if (!data) return next(ApiError.notFound('证券不存在'));
      res.json(ok(data, 'ok'));
    } catch (e) { next(e); }
  });

  router.get('/sectors', (req, res, next) => {
    try {
      const dimension = req.query.dimension === 'industry' ? 'industry' : 'sector';
      const top = Math.min(100, Math.max(1, Number(req.query.top || 20)));
      res.json(ok(market.sectors(dimension, top), 'ok'));
    } catch (e) { next(e); }
  });

  router.get('/meta', (_req, res, next) => {
    try { res.json(ok(market.meta(), 'ok')); } catch (e) { next(e); }
  });

  // ---------- 自选股 ----------
  router.get('/watchlist', optionalAuth, (req, res, next) => {
    try {
      const userId = req.user?.id ?? null;
      res.json(ok(market.listWatchlist(userId), 'ok'));
    } catch (e) { next(e); }
  });

  router.post('/watchlist', optionalAuth, (req, res, next) => {
    try {
      if (!req.user) return next(ApiError.unauthorized('请先登录后再添加自选'));
      const code = String(req.body.code || '');
      if (!code) return next(ApiError.badRequest('缺少代码'));
      res.json(ok(market.addWatchlist(req.user.id, code), '已加入自选'));
    } catch (e) { next(e); }
  });

  router.delete('/watchlist/:id', optionalAuth, (req, res, next) => {
    try {
      if (!req.user) return next(ApiError.unauthorized('请先登录后再删除自选'));
      market.removeWatchlist(req.user.id, Number(req.params.id));
      res.json(ok(null, '已移除自选'));
    } catch (e) { next(e); }
  });

  // ---------- 健康检查 ----------
  router.get('/health', (_req, res) => {
    let dbOk = 'ok';
    try { db.exec('SELECT 1'); } catch (_e) { dbOk = 'error'; }
    res.json(ok({ status: 'ok', db: dbOk }, 'ok'));
  });

  return router;
}
