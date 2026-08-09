// ============================================================
// /api/auth/* 路由
// ============================================================
import { Router } from 'express';
import { z } from 'zod';
import { createAuthService } from '../services/authService.js';
import { requireAuth, optionalAuth } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import { ok } from '../util/response.js';
import { createHttpRateLimiter } from '../util/httpRateLimit.js';

const registerSchema = z.object({
  username: z.string().min(2, '用户名至少 2 个字符').max(30),
  email: z.string().email('邮箱格式不正确'),
  password: z.string().min(8, '密码至少 8 位'),
});

const loginSchema = z.object({
  account: z.string().min(1, '请输入账号'),
  password: z.string().min(1, '请输入密码'),
});

const passwordSchema = z.object({
  old_password: z.string().min(1, '请输入旧密码'),
  new_password: z.string().min(8, '新密码至少 8 位'),
});

// 登录防爆破（D2）：按「IP + 账号」15 分钟最多 15 次失败尝试，超出 429
const loginLimiter = createHttpRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 15,
  keyFn: (req) => `login:${req.ip}:${String(req.body?.account || '').toLowerCase()}`,
  message: '登录尝试过于频繁，请 15 分钟后再试',
});

export function createAuthRoutes(db) {
  const router = Router();
  const auth = createAuthService(db);

  router.post('/register', validateBody(registerSchema), (req, res, next) => {
    try {
      res.json(ok(auth.register(req.validated), '注册成功'));
    } catch (e) { next(e); }
  });

  router.post('/login', loginLimiter, validateBody(loginSchema), (req, res, next) => {
    try {
      res.json(ok(auth.login(req.validated), '登录成功'));
    } catch (e) { next(e); }
  });

  router.post('/logout', optionalAuth, (_req, res, next) => {
    try {
      res.json(ok(auth.logout(), '已退出登录'));
    } catch (e) { next(e); }
  });

  router.get('/me', requireAuth, (req, res, next) => {
    try {
      res.json(ok(auth.me(req.user.id), 'ok'));
    } catch (e) { next(e); }
  });

  router.put('/password', requireAuth, validateBody(passwordSchema), (req, res, next) => {
    try {
      auth.changePassword(req.user.id, req.validated);
      res.json(ok(null, '密码修改成功'));
    } catch (e) { next(e); }
  });

  return router;
}
