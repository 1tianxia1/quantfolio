// ============================================================
// /api/ai/* 路由
//  - POST /diagnose | /morning-comment | /closing-interpret ：生成 AI 报告（游客可用，ref_key='demo'）
//  - GET  /providers ：公开，返回厂商注册表（前端下拉用）
//  - GET  /config   ：登录用户，返回个人 AI 配置（脱敏）
//  - PUT  /config   ：登录用户，保存个人 AI 配置
//  - POST /config/test ：登录用户，连通性测试（仅验证不落库）
// ============================================================
import { Router } from 'express';
import { z } from 'zod';
import { createAiReportService } from '../services/aiReportService.js';
import { createUserAiConfigModel } from '../models/userAiConfigModel.js';
import { listProviders, getProvider } from '../ai/providers.js';
import { testLLM } from '../services/aiService.js';
import { optionalAuth, requireAuth } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import { ok } from '../util/response.js';

const diagnoseSchema = z.object({ force_refresh: z.boolean().optional() });
const commentSchema = z.object({
  items: z.array(z.any()).optional(),
  force_refresh: z.boolean().optional(),
});
const interpretSchema = z.object({
  items: z.array(z.any()).optional(),
  conditions: z.any().optional(),
  strategy_id: z.number().nullable().optional(),
  force_refresh: z.boolean().optional(),
});

// 个人 AI 配置保存/测试
const configSchema = z.object({
  provider: z.string().min(1).optional(),
  apiKey: z.string().optional(), // 空串表示保留原 Key
  baseUrl: z.string().optional(),
  model: z.string().min(1).optional(),
  apiStyle: z.enum(['openai', 'anthropic']).optional(),
});
const testSchema = configSchema.extend({
  // 测试时 apiKey 可空：若请求未带 Key，后端回落到用户已保存配置中的 Key
  apiKey: z.string().optional(),
});

export function createAiRoutes(db) {
  const router = Router();
  const ai = createAiReportService(db);
  const userAiConfig = createUserAiConfigModel(db);

  router.post('/diagnose', optionalAuth, validateBody(diagnoseSchema), async (req, res, next) => {
    try {
      const userId = req.user?.id ?? null;
      const report = await ai.diagnose(userId, req.validated);
      res.json(ok(report, 'ok'));
    } catch (e) { next(e); }
  });

  router.post('/morning-comment', optionalAuth, validateBody(commentSchema), async (req, res, next) => {
    try {
      const userId = req.user?.id ?? null;
      const report = await ai.morningComment(userId, req.validated);
      res.json(ok(report, 'ok'));
    } catch (e) { next(e); }
  });

  router.post('/closing-interpret', optionalAuth, validateBody(interpretSchema), async (req, res, next) => {
    try {
      const userId = req.user?.id ?? null;
      const report = await ai.closingInterpret(userId, req.validated);
      res.json(ok(report, 'ok'));
    } catch (e) { next(e); }
  });

  // 厂商注册表（公开）
  router.get('/providers', (_req, res) => {
    res.json(ok(listProviders(), 'ok'));
  });

  // 当前用户 AI 配置（脱敏，须登录）
  router.get('/config', requireAuth, (req, res, next) => {
    try {
      const cfg = userAiConfig.get(req.user.id);
      res.json(ok(cfg || { hasKey: false, provider: 'custom', model: '', baseUrl: '', apiStyle: 'openai' }, 'ok'));
    } catch (e) { next(e); }
  });

  // 保存当前用户 AI 配置（须登录）
  router.put('/config', requireAuth, validateBody(configSchema), (req, res, next) => {
    try {
      // 自动补全 apiStyle / baseUrl 默认值（基于厂商注册表）
      const p = req.validated.provider ? getProvider(req.validated.provider) : null;
      const payload = {
        provider: req.validated.provider,
        apiKey: req.validated.apiKey,
        baseUrl: req.validated.baseUrl ?? p?.baseUrl ?? '',
        model: req.validated.model,
        apiStyle: req.validated.apiStyle ?? p?.apiStyle ?? 'openai',
      };
      const saved = userAiConfig.upsert(req.user.id, payload);
      res.json(ok(saved, 'AI 配置已保存'));
    } catch (e) { next(e); }
  });

  // 连通性测试（须登录，仅验证不落库）
  router.post('/config/test', requireAuth, validateBody(testSchema), async (req, res, next) => {
    try {
      const p = getProvider(req.validated.provider);
      // 若请求未带 Key，回落到用户已保存配置中的 Key（便于「测试已保存配置」无需重输）
      let apiKey = req.validated.apiKey;
      if (!apiKey) {
        const storedRaw = userAiConfig.getRaw(req.user.id);
        if (storedRaw?.apiKey) apiKey = storedRaw.apiKey;
      }
      const result = await testLLM({
        apiKey,
        baseUrl: req.validated.baseUrl || p?.baseUrl || '',
        model: req.validated.model,
        apiStyle: req.validated.apiStyle || p?.apiStyle || 'openai',
      });
      res.json(ok(result, '连接成功'));
    } catch (e) { next(e); }
  });

  return router;
}
