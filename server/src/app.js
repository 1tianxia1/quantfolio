// ============================================================
// Express 应用装配：json/cors/路由/错误兜底 + 生产静态托管
// ============================================================
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import { notFoundHandler, errorHandler } from './middleware/error.js';
import { ok } from './util/response.js';
import env from './config/env.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.join(__dirname, '../../client/dist');
const HAS_DIST = fs.existsSync(DIST_DIR);

import { createAuthRoutes } from './routes/authRoutes.js';
import { createPortfolioRoutes } from './routes/portfolioRoutes.js';
import { createScreenerRoutes } from './routes/screenerRoutes.js';
import { createStrategyRoutes } from './routes/strategyRoutes.js';
import { createAiRoutes } from './routes/aiRoutes.js';
import { createMarketRoutes } from './routes/marketRoutes.js';
import { createAnalysisRoutes } from './routes/analysisRoutes.js';

/**
 * 创建 Express 应用
 * @param {import('./db/driver.js').Database} db
 */
export function createApp(db) {
  const app = express();

  // CORS：按环境白名单收敛（D9），非白名单来源不带 CORS 头；
  // 无 origin（同源 / curl / 非浏览器）放行，避免破坏探活与脚本调用。
  const allowedOrigins = env.CLIENT_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean);
  app.use(cors({
    origin(origin, cb) {
      if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
      return cb(null, false);
    },
  }));
  // 图片导入路由需要更大请求体（base64 多图）
  app.use('/api/portfolio/holdings/import-image', express.json({ limit: '20mb' }));
  app.use(express.json({ limit: '5mb' }));
  app.use(express.urlencoded({ extended: true }));

  // 根探活
  app.get('/api/health', (_req, res) => {
    let dbOk = 'ok';
    try { db.exec('SELECT 1'); } catch (_e) { dbOk = 'error'; }
    res.json(ok({ status: 'ok', db: dbOk }, 'ok'));
  });

  // 业务路由
  app.use('/api/auth', createAuthRoutes(db));
  app.use('/api/portfolio', createPortfolioRoutes(db));
  app.use('/api/screener', createScreenerRoutes(db));
  app.use('/api/strategies', createStrategyRoutes(db));
  app.use('/api/ai', createAiRoutes(db));
  app.use('/api/market', createMarketRoutes(db));
  // 智能分析中心（骨架：capabilities 可用，quant/signal/pipeline 待 T03-T05 填充）
  app.use('/api/analysis', createAnalysisRoutes(db));

  // 生产静态文件托管（构建产物 client/dist）
  if (HAS_DIST) {
    app.use(express.static(DIST_DIR, { maxAge: '7d', index: false }));
    // SPA fallback：前端路由（如 /portfolio）非 API 请求一律返回 index.html
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api/')) return next();
      res.sendFile(path.join(DIST_DIR, 'index.html'));
    });
  }

  // 兜底
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
