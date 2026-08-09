// ============================================================
// HTTP 请求限流中间件（内存滑动窗口）
// 轻量自研：不引入 express-rate-limit 依赖，单进程内存计数足够。
// 语义：每个 key 在 windowMs 内最多 max 次，超出返回 429 + Retry-After。
// 用途：登录失败防爆破（D2）、游客/共享 Key AI 调用防刷单。
// ============================================================
import { fail } from './response.js';

/**
 * 创建 HTTP 限流中间件
 * @param {object} options
 * @param {number} [options.windowMs=60000] 窗口毫秒
 * @param {number} [options.max=60] 窗口内最大次数
 * @param {(req) => string} [options.keyFn] 键提取函数（如按 IP / 账号）
 * @param {string} [options.message] 429 提示文案
 * @param {(req) => boolean} [options.skip] 放行条件（返回 true 直接 next）
 */
export function createHttpRateLimiter({
  windowMs = 60_000,
  max = 60,
  keyFn = (req) => req.ip || 'unknown',
  message = '请求过于频繁，请稍后再试',
  skip,
} = {}) {
  /** @type {Map<string, number[]>} key -> 窗口内请求时间戳数组 */
  const hits = new Map();

  // 定期清理过期记录，防止 key 无限膨胀（unref 不阻塞进程退出）
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, arr] of hits) {
      const alive = arr.filter((t) => now - t < windowMs);
      if (alive.length) hits.set(k, alive);
      else hits.delete(k);
    }
  }, Math.max(10_000, windowMs * 2));
  sweep.unref?.();

  return function rateLimit(req, res, next) {
    if (skip && skip(req)) return next();
    const key = String(keyFn(req) ?? 'unknown');
    const now = Date.now();
    const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (arr.length >= max) {
      const retryAfter = Math.max(1, Math.ceil((windowMs - (now - arr[0])) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(429).json(fail(message, 42900));
    }
    arr.push(now);
    hits.set(key, arr);
    next();
  };
}
