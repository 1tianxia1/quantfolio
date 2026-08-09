// ============================================================
// /api/screener/* 路由（morning / closing / pipeline / auction-leaderboard / presets / export.csv）
// ============================================================
import { Router } from 'express';
import { z } from 'zod';
import { createScreenerService } from '../services/screenerService.js';
import { createPipelineService } from '../services/pipelineService.js';
import { createMarketService } from '../services/marketService.js';
import { optionalAuth } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import { ok } from '../util/response.js';
import { createHttpRateLimiter } from '../util/httpRateLimit.js';

// 导出频控（D10）：export.csv 属只读白名单操作（游客可用），但按 IP 限频防滥用
const exportLimiter = createHttpRateLimiter({
  windowMs: 60 * 60 * 1000,
  max: 30,
  keyFn: (req) => `screener-export:${req.ip}`,
  message: '导出过于频繁，请 1 小时后再试',
});

// 通用条件 schema（宽松：未知字段忽略）
const conditionsSchema = z.record(z.any());

const morningSchema = z.object({
  universe: z.record(z.any()).optional(),
  prevPctChg: z.tuple([z.number(), z.number()]).optional(),
  volumeRatio: z.object({ min: z.number() }).optional(),
  turnover: z.tuple([z.number(), z.number()]).optional(),
  auction: z.record(z.any()).optional(),
  limitUp: z.record(z.any()).optional(),
  sectors: z.array(z.string()).optional(),
  netInflow3d: z.object({ minWanYuan: z.number() }).optional(),
  page: z.number().optional(),
  pageSize: z.number().optional(),
  sortBy: z.string().optional(),
  order: z.enum(['asc', 'desc']).optional(),
});

const closingSchema = z.object({
  universe: z.record(z.any()).optional(),
  macd: z.record(z.any()).optional(),
  ma: z.record(z.any()).optional(),
  rsi: z.record(z.any()).optional(),
  kdj: z.record(z.any()).optional(),
  volRatio5: z.record(z.any()).optional(),
  turnover: z.tuple([z.number(), z.number()]).optional(),
  pe: z.record(z.any()).optional(),
  mv: z.record(z.any()).optional(),
  pctChg: z.tuple([z.number(), z.number()]).optional(),
  page: z.number().optional(),
  pageSize: z.number().optional(),
  sortBy: z.string().optional(),
  order: z.enum(['asc', 'desc']).optional(),
});

const pipelineSchema = z.object({
  type: z.enum(['morning', 'closing']),
  steps: z.array(z.object({
    id: z.string(),
    label: z.string().optional(),
    enabled: z.boolean().optional(),
    params: z.record(z.any()).optional(),
  })).optional(),
  loose_mode: z.boolean().optional(),
});

export function createScreenerRoutes(db) {
  const router = Router();
  const screener = createScreenerService(db);
  const pipeline = createPipelineService(db);
  const market = createMarketService(db);

  // 通用早盘筛选（M-01~M-03）
  router.post('/morning', validateBody(morningSchema), (req, res, next) => {
    try {
      const { page, pageSize, sortBy, order, ...conditions } = req.validated;
      res.json(ok(screener.run('morning', conditions, { page, pageSize, sortBy, order }), 'ok'));
    } catch (e) { next(e); }
  });

  // 通用尾盘筛选（C-01~C-11）
  router.post('/closing', validateBody(closingSchema), (req, res, next) => {
    try {
      const { page, pageSize, sortBy, order, ...conditions } = req.validated;
      res.json(ok(screener.run('closing', conditions, { page, pageSize, sortBy, order }), 'ok'));
    } catch (e) { next(e); }
  });

  // 预置策略模板
  router.get('/pipeline/presets', (req, res, next) => {
    try {
      const morning = db.all(`SELECT * FROM strategies WHERE is_preset = 1 AND type IN ('pipeline_morning','morning') ORDER BY id`);
      const closing = db.all(`SELECT * FROM strategies WHERE is_preset = 1 AND type IN ('pipeline_closing','closing') ORDER BY id`);
      res.json(ok({ morning, closing }, 'ok'));
    } catch (e) { next(e); }
  });

  // 五步法/七步法管线执行
  router.post('/pipeline/run', validateBody(pipelineSchema), (req, res, next) => {
    try {
      res.json(ok(pipeline.runPipeline(req.validated), 'ok'));
    } catch (e) { next(e); }
  });

  // 竞价榜 Top60
  router.get('/auction-leaderboard', (req, res, next) => {
    try {
      const top = Math.min(200, Math.max(1, Number(req.query.top || 60)));
      res.json(ok({ items: market.auctionLeaderboard(top) }, 'ok'));
    } catch (e) { next(e); }
  });

  // 条件命中数量实时预估（C-18）
  router.post('/estimate', validateBody(conditionsSchema), (req, res, next) => {
    try {
      const type = req.body.type === 'morning' ? 'morning' : 'closing';
      const { type: _t, ...conditions } = req.body;
      res.json(ok(screener.estimate(type, conditions), 'ok'));
    } catch (e) { next(e); }
  });

  // 导出 CSV（UTF-8 BOM，中文不乱码）；只读白名单操作，游客可用但受 exportLimiter 频控
  router.post('/export.csv', optionalAuth, exportLimiter, validateBody(conditionsSchema), (req, res, next) => {
    try {
      const type = req.body.type === 'morning' ? 'morning' : 'closing';
      const { type: _t, ...conditions } = req.body;
      const result = screener.run(type, conditions, { page: 1, pageSize: 100000 });
      const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const filename = `quantfolio_${type}_${dateStr}.csv`;
      const csv = buildCsv(result.items, type);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send('\uFEFF' + csv); // UTF-8 BOM
    } catch (e) { next(e); }
  });

  return router;
}

/** 手写 CSV（约 30 行，UTF-8 BOM + 引号转义） */
function buildCsv(items, type) {
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const headers = type === 'morning'
    ? ['排名', '代码', '名称', '现价', '涨跌幅', '量比', '换手率', '竞价涨幅', '连板', '板块', '3日主力净流入(万)', '评分', '命中标签']
    : ['排名', '代码', '名称', '现价', '涨跌幅', '换手率', '放量倍数', 'PE', '流通市值(亿)', '评分', '命中标签'];
  const rows = items.map((r) => {
    const m = r.metrics || {};
    if (type === 'morning') {
      return [r.rank, r.code, r.name, r.price, r.pct_chg, m.volume_ratio, m.turnover_rate, m.auction_pct, m.limit_streak, r.sector, m.net_inflow_3d, r.score, (r.hit_tags || []).join(';')];
    }
    return [r.rank, r.code, r.name, r.price, r.pct_chg, m.turnover_rate, m.vol_ratio_5, m.pe_ttm, m.circ_mv, r.score, (r.hit_tags || []).join(';')];
  });
  return [headers.map(esc).join(','), ...rows.map((row) => row.map(esc).join(','))].join('\n');
}
