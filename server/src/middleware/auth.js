// ============================================================
// JWT 鉴权中间件：校验 token -> req.user
// 游客模式策略：个人数据接口无 token 时放行（req.user = null），
// 由 service 层决定落 demo 数据或返回 401 引导登录
// ============================================================
import jwt from 'jsonwebtoken';
import env from '../config/env.js';
import { ApiError } from '../util/errors.js';

/**
 * 鉴权中间件工厂
 * @param {object} options
 * @param {boolean} options.required true=必须登录（否则 401）；false=可选（游客放行 req.user=null）
 */
export function authMiddleware(options = {}) {
  const required = options.required ?? false;
  return (req, _res, next) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) {
      if (required) return next(ApiError.unauthorized('请先登录'));
      req.user = null;
      return next();
    }
    try {
      const payload = jwt.verify(token, env.JWT_SECRET);
      req.user = { id: payload.id, username: payload.username };
      return next();
    } catch (e) {
      if (required) return next(ApiError.tokenExpired('登录已过期，请重新登录'));
      req.user = null;
      return next();
    }
  };
}

/** 必须登录（严格模式） */
export const requireAuth = authMiddleware({ required: true });

/** 可选登录（游客放行） */
export const optionalAuth = authMiddleware({ required: false });
