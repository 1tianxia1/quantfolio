// ============================================================
// /api/portfolio/* 路由（持仓、汇总、目标、再平衡）
// 游客模式：读操作落 demo 数据（user_id IS NULL），写操作 401 引导登录
// ============================================================
import { Router } from 'express';
import { z } from 'zod';
import { createPortfolioService } from '../services/portfolioService.js';
import { createRebalanceService } from '../services/rebalanceService.js';
import { createFundNavService } from '../services/fundNavService.js';
import { recognizeHoldingsFromImages } from '../services/holdingImageService.js';
import { resolveAiConfig } from '../ai/resolveAiConfig.js';
import { createUserAiConfigModel } from '../models/userAiConfigModel.js';
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
  // 图片导入时由截图 OCR 回填的现价值与盈亏（可空，手动添加/CSV 无此值）
  current_price: z.number().min(0).max(1e12, '现价超出允许范围').finite('现价必须是有限数值').optional(),
  profit: z.number().max(1e12, '盈亏超出允许范围').finite('盈亏必须是有限数值').optional(),
  profit_rate: z.number().max(1000).finite('盈亏率必须是有限数值').optional(),
  day_profit: z.number().max(1e12).finite('当日盈亏必须是有限数值').optional(),
  day_profit_rate: z.number().max(1000).finite('当日盈亏率必须是有限数值').optional(),
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

const batchUpsertSchema = z.object({
  rows: z.array(holdingSchema).min(1, '至少需要一行持仓'),
});

/** 把同一批传入的 rows 按 code 合并（数量相加、成本价加权平均） */
function mergeIncomingRows(rows) {
  const byCode = new Map();
  const noCodeRows = [];
  for (const r of rows) {
    const code = r.code || null;
    if (!code) {
      noCodeRows.push(r);
      continue;
    }
    const existing = byCode.get(code);
    if (!existing) {
      byCode.set(code, { ...r });
    } else {
      const oldQty = existing.quantity;
      const addQty = r.quantity;
      const totalQty = oldQty + addQty;
      existing.quantity = totalQty;
      if (totalQty > 0) {
        existing.cost_price = (oldQty * existing.cost_price + addQty * r.cost_price) / totalQty;
      }
      // 截现价/盈亏：同码合并时保留最新非空值（图片识别通常同码只出现一次）
      if (r.current_price != null && Number.isFinite(Number(r.current_price))) {
        existing.current_price = r.current_price;
      }
      if (r.profit != null && Number.isFinite(Number(r.profit))) existing.profit = r.profit;
      if (r.profit_rate != null && Number.isFinite(Number(r.profit_rate))) existing.profit_rate = r.profit_rate;
      if (r.day_profit != null && Number.isFinite(Number(r.day_profit))) existing.day_profit = r.day_profit;
      if (r.day_profit_rate != null && Number.isFinite(Number(r.day_profit_rate))) existing.day_profit_rate = r.day_profit_rate;
      // 名称/类别以第一次出现为准（通常来自同一张截图，不会冲突）
    }
  }
  return [...byCode.values(), ...noCodeRows];
}

export function createPortfolioRoutes(db) {
  const router = Router();
  const portfolio = createPortfolioService(db);
  const rebalance = createRebalanceService(db);
  const fundNav = createFundNavService(db);

  /** 写操作前检查登录（游客 401 引导登录） */
  function requireWrite(req, _res, next) {
    if (!req.user) return next(ApiError.unauthorized('请先登录后再进行该操作'));
    next();
  }

  /** 持仓保存后：如为场外基金且已有代码，异步同步净值（失败仅告警） */
  async function syncFundNavAfterSave(holding) {
    if (holding.asset_class === ASSET_CLASS.FUND && holding.code) {
      try {
        await fundNav.syncFundNav({ codes: [holding.code] });
      } catch (e) {
        console.warn('[portfolio] 持仓保存后同步基金净值失败:', e.message);
      }
    }
  }

  // ---------- 持仓 ----------
  router.get('/holdings', optionalAuth, (req, res, next) => {
    try {
      const userId = req.user?.id ?? null;
      res.json(ok(portfolio.listHoldings(userId), 'ok'));
    } catch (e) { next(e); }
  });

  router.post('/holdings', optionalAuth, requireWrite, validateBody(holdingSchema), async (req, res, next) => {
    try {
      const payload = { ...req.validated, code: req.validated.code || null };
      const result = portfolio.addHolding(req.user.id, payload);
      await syncFundNavAfterSave(payload);
      res.json(ok(result, '持仓已添加'));
    } catch (e) { next(e); }
  });

  router.put('/holdings/:id', optionalAuth, requireWrite, validateBody(holdingSchema), async (req, res, next) => {
    try {
      const payload = { ...req.validated, code: req.validated.code || null };
      const result = portfolio.updateHolding(req.user.id, Number(req.params.id), payload);
      await syncFundNavAfterSave(payload);
      res.json(ok(result, '持仓已更新'));
    } catch (e) { next(e); }
  });

  router.delete('/holdings/:id', optionalAuth, requireWrite, (req, res, next) => {
    try {
      portfolio.removeHolding(req.user.id, Number(req.params.id));
      res.json(ok(null, '持仓已删除'));
    } catch (e) { next(e); }
  });

  // ---------- CSV 导入（模板：代码,名称,资产类别,数量,成本价） ----------
  router.post('/holdings/import', optionalAuth, requireWrite, validateBody(importSchema), async (req, res, next) => {
    try {
      const csvText = req.validated.csv_text;
      const result = parseHoldingsCsv(csvText);
      let imported = 0;
      const errors = [];
      const fundCodes = [];
      for (let i = 0; i < result.rows.length; i++) {
        const row = result.rows[i];
        try {
          portfolio.upsertHolding(req.user.id, {
            code: row.code || null,
            name: row.name,
            asset_class: row.asset_class,
            quantity: row.quantity,
            cost_price: row.asset_class === 'cash' ? 1 : row.cost_price,
          });
          imported += 1;
          if (row.asset_class === ASSET_CLASS.FUND && row.code) {
            fundCodes.push(row.code);
          }
        } catch (e) {
          errors.push({ row: result.startRow + i + 1, msg: e.message || '导入失败' });
        }
      }
      if (fundCodes.length > 0) {
        try {
          await fundNav.syncFundNav({ codes: [...new Set(fundCodes)] });
        } catch (e) {
          console.warn('[portfolio] CSV 导入后同步基金净值失败:', e.message);
        }
      }
      res.json(ok({ imported, skipped: result.skipped, errors }, '导入完成'));
    } catch (e) { next(e); }
  });

  // ---------- 图片导入批量 upsert（按 code 合并，已存在则更新而非新增） ----------
  router.post('/holdings/batch-upsert', optionalAuth, requireWrite, validateBody(batchUpsertSchema), async (req, res, next) => {
    try {
      const rows = mergeIncomingRows(req.validated.rows);
      let upserted = 0;
      let created = 0;
      let updated = 0;
      const errors = [];
      const fundCodes = [];

      const tx = db.transaction(() => {
        for (let i = 0; i < rows.length; i++) {
          const r = rows[i];
          try {
            const { created: isNew } = portfolio.upsertHolding(req.user.id, {
              code: r.code || null,
              name: r.name,
              asset_class: r.asset_class,
              quantity: r.quantity,
              cost_price: r.asset_class === 'cash' ? 1 : r.cost_price,
              current_price: r.current_price,
              profit: r.profit,
              profit_rate: r.profit_rate,
              day_profit: r.day_profit,
              day_profit_rate: r.day_profit_rate,
            });
            upserted += 1;
            if (isNew) created += 1; else updated += 1;
            if (r.asset_class === ASSET_CLASS.FUND && r.code) {
              fundCodes.push(r.code);
            }
          } catch (e) {
            errors.push({ row: i + 1, msg: e.message || '导入失败' });
          }
        }
      });
      tx();

      if (fundCodes.length > 0) {
        try {
          await fundNav.syncFundNav({ codes: [...new Set(fundCodes)] });
        } catch (e) {
          console.warn('[portfolio] 图片导入 upsert 后同步基金净值失败:', e.message);
        }
      }
      res.json(ok({ upserted, created, updated, errors }, '导入完成'));
    } catch (e) { next(e); }
  });

  // ---------- 图片导入（调用视觉模型识别持仓截图） ----------
  router.post('/holdings/import-image', optionalAuth, requireWrite, async (req, res, next) => {
    try {
      const images = req.body?.images;
      if (!Array.isArray(images) || images.length === 0 || images.length > 5) {
        throw ApiError.validation('请上传 1~5 张图片');
      }
      // BYOK：从「模型设置」读取当前用户的 AI 配置（与 AI 报告/分析中心同一条解析链）
      const userId = req.user?.id ?? null;
      const userAiConfig = createUserAiConfigModel(db);
      const resolved = resolveAiConfig(userAiConfig, userId);
      if (resolved.notConfigured) {
        throw ApiError.badRequest('AI 未配置（请到「模型设置」填写你的 Key，或联系管理员配置服务端 .env）');
      }
      const result = await recognizeHoldingsFromImages(db, images, {
        hint: req.body?.hint,
        // 传用户自定义配置给视觉模型；游客/服务端默认时 aiConfig 为 null，由 aiService 回落 .env
        aiConfig: resolved.aiConfig,
      });
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

  // ---------- 场外基金净值同步（天天基金；公开数据，游客可用） ----------
  router.post('/fund-nav/sync', optionalAuth, async (req, res, next) => {
    try {
      const codes = Array.isArray(req.body?.codes) ? req.body.codes : undefined;
      const result = await fundNav.syncFundNav({ codes });
      res.json(ok(result, '场外基金净值同步完成'));
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
