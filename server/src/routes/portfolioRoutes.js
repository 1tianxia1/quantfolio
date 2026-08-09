// ============================================================
// /api/portfolio/* 路由（持仓、汇总、目标、再平衡）
// 游客模式：读操作落 demo 数据（user_id IS NULL），写操作 401 引导登录
// ============================================================
import { Router } from 'express';
import { z } from 'zod';
import { createPortfolioService } from '../services/portfolioService.js';
import { createRebalanceService } from '../services/rebalanceService.js';
import { recognizeHoldingsFromImages } from '../services/holdingImageService.js';
import { optionalAuth, requireAuth } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import { ok } from '../util/response.js';
import { ApiError } from '../util/errors.js';
import { ASSET_CLASS } from '../../../shared/constants.js';

const holdingSchema = z.object({
  code: z.string().nullable().optional(),
  name: z.string().min(1, '名称不能为空'),
  asset_class: z.enum(Object.values(ASSET_CLASS), '资产类别不合法'),
  // D5：数值字段必须为有限数并设上界，防止 1e308 之类溢出污染汇总（total_asset -> null）
  quantity: z.number().min(0, '数量不能为负').max(1e12, '数量超出允许范围').finite('数量必须是有限数值'),
  cost_price: z.number().min(0).max(1e12, '成本价超出允许范围').finite('成本价必须是有限数值').optional().default(0),
});

// D4/D19：CSV 导入的 csv_text 必须是非空字符串；数字/对象/null/空串一律 400
const importSchema = z.object({
  csv_text: z.string().min(1, 'csv_text 不能为空'),
});

const targetSchema = z.object({
  dimension: z.enum(['asset_class', 'industry', 'code'], '维度不合法'),
  items: z.array(z.object({
    target_key: z.string().min(1),
    target_pct: z.number().min(0).max(100),
  })),
});

const settingsSchema = z.object({
  rebalance_threshold: z.number().min(0).max(50).optional(),
  active_dimension: z.enum(['asset_class', 'industry', 'code']).optional(),
  morning_loose_mode: z.boolean().optional(),
});

const rebalanceSchema = z.object({
  threshold: z.number().min(0).max(50).optional(),
  dimension: z.enum(['asset_class', 'industry', 'code']).optional(),
});

export function createPortfolioRoutes(db) {
  const router = Router();
  const portfolio = createPortfolioService(db);
  const rebalance = createRebalanceService(db);

  /** 写操作前检查登录（游客 401 引导登录） */
  function requireWrite(req, _res, next) {
    if (!req.user) return next(ApiError.unauthorized('请先登录后再进行该操作'));
    next();
  }

  // ---------- 持仓 ----------
  router.get('/holdings', optionalAuth, (req, res, next) => {
    try {
      const userId = req.user?.id ?? null;
      res.json(ok(portfolio.listHoldings(userId), 'ok'));
    } catch (e) { next(e); }
  });

  router.post('/holdings', optionalAuth, requireWrite, validateBody(holdingSchema), (req, res, next) => {
    try {
      const payload = { ...req.validated, code: req.validated.code || null };
      res.json(ok(portfolio.addHolding(req.user.id, payload), '持仓已添加'));
    } catch (e) { next(e); }
  });

  router.put('/holdings/:id', optionalAuth, requireWrite, validateBody(holdingSchema), (req, res, next) => {
    try {
      const payload = { ...req.validated, code: req.validated.code || null };
      res.json(ok(portfolio.updateHolding(req.user.id, Number(req.params.id), payload), '持仓已更新'));
    } catch (e) { next(e); }
  });

  router.delete('/holdings/:id', optionalAuth, requireWrite, (req, res, next) => {
    try {
      portfolio.removeHolding(req.user.id, Number(req.params.id));
      res.json(ok(null, '持仓已删除'));
    } catch (e) { next(e); }
  });

  // ---------- CSV 导入（模板：代码,名称,资产类别,数量,成本价） ----------
  router.post('/holdings/import', optionalAuth, requireWrite, validateBody(importSchema), (req, res, next) => {
    try {
      const csvText = req.validated.csv_text;
      const result = parseHoldingsCsv(csvText);
      let imported = 0;
      const errors = [];
      for (let i = 0; i < result.rows.length; i++) {
        const row = result.rows[i];
        try {
          portfolio.addHolding(req.user.id, {
            code: row.code || null,
            name: row.name,
            asset_class: row.asset_class,
            quantity: row.quantity,
            cost_price: row.asset_class === 'cash' ? 1 : row.cost_price,
          });
          imported += 1;
        } catch (e) {
          errors.push({ row: result.startRow + i + 1, msg: e.message || '导入失败' });
        }
      }
      res.json(ok({ imported, skipped: result.skipped, errors }, '导入完成'));
    } catch (e) { next(e); }
  });

  // ---------- 图片导入（调用视觉模型识别持仓截图） ----------
  router.post('/holdings/import-image', optionalAuth, requireWrite, async (req, res, next) => {
    try {
      const images = req.body?.images;
      if (!Array.isArray(images) || images.length === 0 || images.length > 5) {
        throw ApiError.validation('请上传 1~5 张图片');
      }
      const result = await recognizeHoldingsFromImages(db, images, { hint: req.body?.hint });
      res.json(ok(result, '识别完成'));
    } catch (e) { next(e); }
  });

  // ---------- 汇总 ----------
  router.get('/summary', optionalAuth, (req, res, next) => {
    try {
      const dimension = req.query.dimension || undefined;
      const userId = req.user?.id ?? null;
      res.json(ok(portfolio.buildSummary(userId, dimension), 'ok'));
    } catch (e) { next(e); }
  });

  // ---------- 目标配置 ----------
  router.get('/targets', optionalAuth, (req, res, next) => {
    try {
      const userId = req.user?.id ?? null;
      res.json(ok(portfolio.getTargets(userId, req.query.dimension || undefined), 'ok'));
    } catch (e) { next(e); }
  });

  router.put('/targets', optionalAuth, requireWrite, validateBody(targetSchema), (req, res, next) => {
    try {
      portfolio.saveTargets(req.user.id, req.validated.dimension, req.validated.items);
      res.json(ok(null, '目标配置已保存'));
    } catch (e) { next(e); }
  });

  // ---------- 设置 ----------
  router.get('/settings', optionalAuth, (req, res, next) => {
    try {
      const userId = req.user?.id ?? null;
      res.json(ok(portfolio.getSettings(userId), 'ok'));
    } catch (e) { next(e); }
  });

  router.put('/settings', optionalAuth, requireWrite, validateBody(settingsSchema), (req, res, next) => {
    try {
      const payload = {
        rebalance_threshold: req.validated.rebalance_threshold,
        active_dimension: req.validated.active_dimension,
        morning_loose_mode: req.validated.morning_loose_mode === undefined ? undefined : (req.validated.morning_loose_mode ? 1 : 0),
      };
      res.json(ok(portfolio.saveSettings(req.user.id, payload), '设置已保存'));
    } catch (e) { next(e); }
  });

  // ---------- 再平衡 ----------
  router.post('/rebalance', optionalAuth, validateBody(rebalanceSchema), (req, res, next) => {
    try {
      const userId = req.user?.id ?? null;
      res.json(ok(rebalance.suggest(userId, req.validated), 'ok'));
    } catch (e) { next(e); }
  });

  return router;
}

// ============================================================
// 手写 CSV 解析（约 20 行，UTF-8 BOM + 引号转义）
// 模板：代码,名称,资产类别,数量,成本价；跳过表头与非法行
// ============================================================
const VALID_ASSET_CLASS = ['stock', 'fund', 'cash', 'bond', 'other'];

function parseHoldingsCsv(text) {
  // D4 防御层：即使绕过 zod 直接调用，也拒绝非字符串，避免 text.replace 崩溃
  if (typeof text !== 'string') throw ApiError.badRequest('csv_text 必须是字符串');
  const lines = text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const rows = [];
  let skipped = 0;
  let startRow = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fields = parseCsvLine(line);
    // 跳过表头
    if (i === 0 && /代码|名称|code|name/i.test(fields[0] || '') && /数量|quantity/i.test(fields[3] || '')) {
      startRow = i + 1;
      continue;
    }
    const [code, name, assetClass, quantityStr, costStr] = fields;
    if (!name || !assetClass) { skipped += 1; continue; }
    const quantity = Number(quantityStr);
    const costPrice = costStr === undefined || costStr === '' ? 0 : Number(costStr);
    if (!VALID_ASSET_CLASS.includes(assetClass)) { skipped += 1; continue; }
    if (assetClass !== 'cash' && (!code || !Number.isFinite(quantity) || quantity <= 0)) { skipped += 1; continue; }
    if (assetClass === 'cash' && (!Number.isFinite(quantity) || quantity <= 0)) { skipped += 1; continue; }
    if (!Number.isFinite(costPrice) || costPrice < 0) { skipped += 1; continue; }
    rows.push({
      code: code || null,
      name: assetClass === 'cash' ? '现金' : name,
      asset_class: assetClass,
      quantity,
      cost_price: costPrice,
    });
  }
  return { rows, skipped, startRow };
}

/** 解析单行 CSV（支持引号转义） */
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuote) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i += 1; } else { inQuote = false; }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuote = true;
    } else if (ch === ',') {
      out.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur.trim());
  return out;
}
