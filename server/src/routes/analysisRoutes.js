// ============================================================
// /api/analysis/* 路由（智能分析中心）
//  - GET  /capabilities              ：检索能力 + AI 配置概览
//  - POST /quant                     ：模块 A 量化分析（T03）
//  - POST /technical | /signal       ：模块 B 策略指标（T04）
//  - POST /pipeline/runs             ：新建流水线（T05）
//  - GET  /pipeline/runs[/:id]       ：列表 / 详情（含步骤）
//  - POST /pipeline/runs/:id/select  ：①选股（手动 code / AI 自主选股）
//  - POST /pipeline/runs/:id/timing  ：②择时（signal_follow；P2 补模板）
//  - POST /pipeline/runs/:id/backtest：③回测（P2 占位）
// ============================================================
import { Router } from 'express';
import { z } from 'zod';
import { resolveAiConfig } from '../ai/resolveAiConfig.js';
import { webSearchService } from '../services/webSearch/webSearchService.js';
import { createUserAiConfigModel } from '../models/userAiConfigModel.js';
import { createTechnicalSignalService } from '../services/analysis/technicalSignalService.js';
import { createFundamentalAnalysisService } from '../services/analysis/fundamentalAnalysisService.js';
import { createPipelineRunService } from '../services/analysis/pipelineRunService.js';
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

export function createAnalysisRoutes(db) {
  const router = Router();
  const userAiConfig = createUserAiConfigModel(db);
  const technical = createTechnicalSignalService(db);
  const fundamental = createFundamentalAnalysisService(db);
  const pipeline = createPipelineRunService(db);

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

  // ---------- 模块 A：量化分析（T03 已实现） ----------
  router.post('/quant', optionalAuth, validateBody(codeSchema), async (req, res, next) => {
    try {
      const code = normalizeOrThrow(req.validated.code);
      const report = await fundamental.analyze(code, req.user?.id ?? null);
      res.json(ok(report, 'ok'));
    } catch (e) {
      next(e);
    }
  });

  // ---------- 模块 A：量化分析（流式 SSE，带进度与 180s 超时保护） ----------
  router.post('/quant/stream', optionalAuth, validateBody(codeSchema), async (req, res, next) => {
    let code;
    try {
      code = normalizeOrThrow(req.validated.code);
    } catch (e) {
      return next(e);
    }

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const send = (obj) => {
      try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch (_) { /* client gone */ }
    };
    // 每 15s 发一次心跳，保活并让前端确认连接在线
    const heartbeat = setInterval(() => send({ type: 'ping' }), 15000);
    const onClose = () => clearInterval(heartbeat);
    req.on('close', onClose);

    try {
      const report = await fundamental.analyze(code, req.user?.id ?? null, { onProgress: send });
      send({ type: 'done', report });
    } catch (e) {
      send({ type: 'error', code: e?.code ?? 50000, message: e?.message || '分析失败，请稍后重试' });
    } finally {
      clearInterval(heartbeat);
      req.removeListener('close', onClose);
      if (!res.writableEnded) res.end();
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

  // ---------- 流水线（T05：run 化端点，①选股 → ②择时 → ③回测占位） ----------

  /** 从 :id 解析正整数 runId */
  function parseRunId(raw) {
    const id = Number(raw);
    if (!Number.isInteger(id) || id <= 0) throw ApiError.badRequest('无效流水线 id');
    return id;
  }

  // 新建流水线
  router.post('/pipeline/runs', optionalAuth, validateBody(z.object({ name: z.string().max(50).optional() })), (req, res, next) => {
    try {
      const run = pipeline.createRun(req.user?.id ?? null, req.validated.name || '');
      res.json(ok(run, '流水线已创建'));
    } catch (e) {
      next(e);
    }
  });

  // 流水线列表
  router.get('/pipeline/runs', optionalAuth, (req, res, next) => {
    try {
      res.json(ok(pipeline.listRuns(req.user?.id ?? null), 'ok'));
    } catch (e) {
      next(e);
    }
  });

  // 读取流水线（含步骤）
  router.get('/pipeline/runs/:id', optionalAuth, (req, res, next) => {
    try {
      const run = pipeline.getRun(parseRunId(req.params.id), req.user?.id ?? null);
      res.json(ok(run, 'ok'));
    } catch (e) {
      next(e);
    }
  });

  // ① 选股（手动 code / AI 自主选股 sector）
  router.post('/pipeline/runs/:id/select', optionalAuth, validateBody(pipelineSelectSchema), async (req, res, next) => {
    try {
      const run = await pipeline.select(parseRunId(req.params.id), req.user?.id ?? null, req.validated);
      res.json(ok(run, '选股完成'));
    } catch (e) {
      next(e);
    }
  });

  // ② 择时（signal_follow；P2 补 kelly/grid/martingale/right_stop）
  router.post('/pipeline/runs/:id/timing', optionalAuth, validateBody(pipelineStepSchema), async (req, res, next) => {
    try {
      const run = await pipeline.timing(parseRunId(req.params.id), req.user?.id ?? null, req.validated);
      res.json(ok(run, '择时完成'));
    } catch (e) {
      next(e);
    }
  });

  // ③ 回测（P2 占位：明确提示，不做空壳结果）
  router.post('/pipeline/runs/:id/backtest', optionalAuth, validateBody(pipelineStepSchema), async (req, res, next) => {
    try {
      const run = await pipeline.backtest(parseRunId(req.params.id), req.user?.id ?? null, req.validated);
      res.json(ok(run, '回测（P2）'));
    } catch (e) {
      next(e);
    }
  });

  return router;
}

export default createAnalysisRoutes;
