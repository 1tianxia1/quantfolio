// ============================================================
// Express 应用装配：json/cors/路由/错误兜底
// ============================================================
import express from 'express';
import cors from 'cors';
import { notFoundHandler, errorHandler } from './middleware/error.js';
import { ok } from './util/response.js';

import { createAuthRoutes } from './routes/authRoutes.js';
import { createPortfolioRoutes } from './routes/portfolioRoutes.js';
import { createScreenerRoutes } from './routes/screenerRoutes.js';
import { createStrategyRoutes } from './routes/strategyRoutes.js';
import { createAiRoutes } from './routes/aiRoutes.js';
import { createMarketRoutes } from './routes/marketRoutes.js';

/**
 * 创建 Express 应用
 * @param {import('./db/driver.js').Database} db
 */
export function createApp(db) {
  const app = express();

  app.use(cors());
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

  // 兜底
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
