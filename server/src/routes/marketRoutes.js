// ============================================================
// /api/market/* 路由（overview / search / kline / sectors / meta / lineage / watchlist / health）
// ============================================================
import { Router } from 'express';
import { createMarketService } from '../services/marketService.js';
import { optionalAuth, requireAuth } from '../middleware/auth.js';
import { ok } from '../util/response.js';
import { ApiError } from '../util/errors.js';
import { getEffectiveProviderName, setEffectiveProviderName } from '../config/providerConfig.js';
import { startRefresh, getRefreshState } from '../services/refreshJob.js';

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

  router.get('/kline', async (req, res, next) => {
    try {
      const code = String(req.query.code || '');
      // days 钳制到 [10, 500]：min 10 根是设计取舍（避免空 K 线图），契约未声明最小值；前端默认 120 不受影响
      const days = Math.min(500, Math.max(10, Number(req.query.days || 120)));
      const data = await market.kline(code, days);
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

  // ---------- 实时行情状态（公开，供顶栏/设置页展示） ----------
  router.get('/status', (_req, res, next) => {
    try {
      const provider = getEffectiveProviderName(db);
      const meta = market.meta();
      res.json(ok({
        realtimeEnabled: provider === 'eastmoney',
        provider,
        tradeDate: meta.trade_date,
        refresh: getRefreshState(),
      }, 'ok'));
    } catch (e) { next(e); }
  });

  // ---------- 手动刷新真实行情（需登录；后台异步跑，立即返回） ----------
  router.post('/refresh', requireAuth, async (req, res, next) => {
    try {
      const limit = Math.min(500, Math.max(5, Number(req.body?.limit || 120)));
      const max = Math.max(0, Number(req.body?.max || 0));
      const r = await startRefresh({ limit, max });
      res.json(ok(r, r.started ? '已启动后台刷新，可在顶栏查看进度' : '已有刷新任务在运行'));
    } catch (e) { next(e); }
  });

  router.get('/refresh/status', (_req, res, next) => {
    try { res.json(ok(getRefreshState(), 'ok')); } catch (e) { next(e); }
  });

  // ---------- 数据源设置（需登录；全局服务器配置，非按用户） ----------
  router.post('/settings', requireAuth, async (req, res, next) => {
    try {
      const realtime = !!req.body?.realtime;
      const name = setEffectiveProviderName(db, realtime ? 'eastmoney' : 'sqlite');
      // 开启实时后，后台轻量刷新最近几天，让"最新交易日"尽快变真实
      if (realtime) {
        await startRefresh({ limit: 5, max: 0 });
      }
      res.json(ok({ realtimeEnabled: name === 'eastmoney', provider: name }, '已保存'));
    } catch (e) { next(e); }
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
      const { category, groupId, note } = req.body;
      res.json(ok(market.addWatchlist(req.user.id, code, { category, groupId, note }), '已加入自选'));
    } catch (e) { next(e); }
  });

  router.delete('/watchlist/:id', optionalAuth, (req, res, next) => {
    try {
      if (!req.user) return next(ApiError.unauthorized('请先登录后再删除自选'));
      market.removeWatchlist(req.user.id, Number(req.params.id));
      res.json(ok(null, '已移除自选'));
    } catch (e) { next(e); }
  });

  // 自选项：移动分组 / 更新备注
  router.patch('/watchlist/:id/group', requireAuth, (req, res, next) => {
    try {
      const gid = req.body.groupId == null ? null : Number(req.body.groupId);
      market.moveWatchlistItem(req.user.id, Number(req.params.id), gid);
      res.json(ok(null, '已移动'));
    } catch (e) { next(e); }
  });

  router.patch('/watchlist/:id/note', requireAuth, (req, res, next) => {
    try {
      market.updateWatchlistNote(req.user.id, Number(req.params.id), String(req.body.note || ''));
      res.json(ok(null, '已保存备注'));
    } catch (e) { next(e); }
  });

  // ---------- 自选分组（用户私有，需登录） ----------
  router.get('/watchlist-groups', requireAuth, (req, res, next) => {
    try { res.json(ok(market.listWatchlistGroups(req.user.id), 'ok')); } catch (e) { next(e); }
  });

  router.post('/watchlist-groups', requireAuth, (req, res, next) => {
    try {
      const name = String(req.body.name || '').trim();
      if (!name) return next(ApiError.badRequest('分组名不能为空'));
      const category = req.body.category === 'fund' ? 'fund' : (req.body.category === 'a_share' ? 'a_share' : 'all');
      res.json(ok(market.createWatchlistGroup(req.user.id, name, category), '已创建分组'));
    } catch (e) { next(e); }
  });

  router.delete('/watchlist-groups/:id', requireAuth, (req, res, next) => {
    try {
      market.deleteWatchlistGroup(req.user.id, Number(req.params.id));
      res.json(ok(null, '已删除分组'));
    } catch (e) { next(e); }
  });

  router.patch('/watchlist-groups/:id', requireAuth, (req, res, next) => {
    try {
      const name = String(req.body.name || '').trim();
      if (!name) return next(ApiError.badRequest('分组名不能为空'));
      res.json(ok(market.renameWatchlistGroup(req.user.id, Number(req.params.id), name), '已重命名'));
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
