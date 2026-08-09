// ============================================================
// /api/analysis/* 路由（智能分析中心，架构 §9 T02 骨架）
//  - GET  /capabilities          ：检索能力 + AI 配置概览（本期即可用）
//  - POST /quant                 ：模块 A 量化分析（T03 填充 handler）
//  - POST /signal                ：模块 B 策略指标（T04 填充 handler）
//  - POST /pipeline/select       ：流水线 ①选股（T05 填充，含 AI 自主选股）
//  - POST /pipeline/timing       ：流水线 ②择时（T05 填充）
//  - POST /pipeline/backtest     ：流水线 ③回测（P2 填充，本期占位）
//
// 本期（T02）只就位骨架与入参校验；未实现端点返回 ok(not_implemented) 占位，
// 由后续任务逐个替换为真实 handler，前端不会误判为可用功能。
// ============================================================
import { Router } from 'express';
import { z } from 'zod';
import { resolveAiConfig } from '../ai/resolveAiConfig.js';
import { webSearchService } from '../services/webSearch/webSearchService.js';
import { createUserAiConfigModel } from '../models/userAiConfigModel.js';
import { createTechnicalSignalService } from '../services/analysis/technicalSignalService.js';
import { tryNormalizeCode } from '../util/codeUtil.js';
import { optionalAuth } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import { ok } from '../util/response.js';
import { ApiError } from '../util/errors.js';

// ---------- zod 校验 ----------
// code：A 股 / 场内基金统一 6 位裸码（含可能的前缀输入，由 codeUtil 归一化）
const codeSchema = z.object({
  code: z.string().min(1).max(12).trim(),
});

// 流水线步骤入参：选股可只带板块关键词；择时/回测需带标的 code
const pipelineSelectSchema = z.object({
  sector: z.string().min(1).max(50).optional(),
  code: z.string().max(12).optional(),
  style: z.enum(['value', 'trend']).optional(), // 价值投资 / 趋势
});
const pipelineStepSchema = codeSchema.extend({
  strategy: z.string().max(30).optional(), // 凯利 / 网格 / 马丁格尔 / 右侧止盈 …
});

/** 归一化代码；非法时抛 400 */
function normalizeOrThrow(code) {
  const normalized = tryNormalizeCode(code);
  if (!normalized) throw ApiError.badRequest(`无效证券代码：${code}（A 股 / 场内基金为 6 位数字）`);
  return normalized;
}

/** 未实现端点的统一占位响应 */
function notImplemented(feature, message) {
  return ok({ implemented: false, feature, message }, 'not_implemented');
}

export function createAnalysisRoutes(db) {
  const router = Router();
  const userAiConfig = createUserAiConfigModel(db);
  const technical = createTechnicalSignalService(db);

  // ---------- 能力概览（真实可用）：AI 配置 + 检索能力 ----------
  router.get('/capabilities', optionalAuth, (req, res, next) => {
    try {
      const userId = req.user?.id ?? null;
      const resolved = resolveAiConfig(userAiConfig, userId);
      res.json(
        ok(
          {
            ai: {
              notConfigured: Boolean(resolved.notConfigured),
              provider: resolved.aiMeta?.provider ?? null,
              model: resolved.aiConfig?.model ?? null,
              capabilities: resolved.capabilities ?? null,
            },
            search: webSearchService.describe(resolved),
          },
          'ok',
        ),
      );
    } catch (e) {
      next(e);
    }
  });

  // ---------- 模块 A：量化分析（T03 填充） ----------
  router.post('/quant', optionalAuth, validateBody(codeSchema), (req, res, next) => {
    try {
      const code = normalizeOrThrow(req.validated.code);
      res.json(notImplemented('quant', `模块 A 量化分析（${code}）将在后续版本提供`));
    } catch (e) {
      next(e);
    }
  });

  // ---------- 模块 B：策略指标（T04 已实现） ----------
  // 规范端点（架构 §9 T04）：POST /technical
  router.post('/technical', optionalAuth, validateBody(codeSchema), async (req, res, next) => {
    try {
      const code = normalizeOrThrow(req.validated.code);
      const report = await technical.analyze(code);
      res.json(ok(report, 'ok'));
    } catch (e) {
      next(e);
    }
  });

  // 别名端点（PRD 命名，行为与 /technical 一致）
  router.post('/signal', optionalAuth, validateBody(codeSchema), async (req, res, next) => {
    try {
      const code = normalizeOrThrow(req.validated.code);
      const report = await technical.analyze(code);
      res.json(ok(report, 'ok'));
    } catch (e) {
      next(e);
    }
  });

  // ---------- 流水线 ①选股（T05 填充，含 AI 自主选股） ----------
  router.post('/pipeline/select', optionalAuth, validateBody(pipelineSelectSchema), (req, res, next) => {
    try {
      if (req.validated.code) normalizeOrThrow(req.validated.code);
      res.json(notImplemented('pipeline.select', '流水线 ①选股将在后续版本提供'));
    } catch (e) {
      next(e);
    }
  });

  // ---------- 流水线 ②择时（T05 填充） ----------
  router.post('/pipeline/timing', optionalAuth, validateBody(pipelineStepSchema), (req, res, next) => {
    try {
      normalizeOrThrow(req.validated.code);
      res.json(notImplemented('pipeline.timing', '流水线 ②择时将在后续版本提供'));
    } catch (e) {
      next(e);
    }
  });

  // ---------- 流水线 ③回测（P2 填充，本期占位） ----------
  router.post('/pipeline/backtest', optionalAuth, validateBody(pipelineStepSchema), (req, res, next) => {
    try {
      normalizeOrThrow(req.validated.code);
      res.json(notImplemented('pipeline.backtest', '流水线 ③回测（2/5/10 年年化验证）将在后续版本提供'));
    } catch (e) {
      next(e);
    }
  });

  return router;
}

export default createAnalysisRoutes;
