// ============================================================
// 统一错误处理中间件：ApiError -> 信封；未知错误 -> 500
// ============================================================
import { ApiError, httpStatusToCode } from '../util/errors.js';
import { fail } from '../util/response.js';

/** 404 兜底 */
export function notFoundHandler(_req, res) {
  res.status(404).json(fail('接口不存在', 40400));
}

/** 统一错误处理（4 参签名必须是 Express 错误中间件） */
export function errorHandler(err, _req, res, _next) {
  if (err instanceof ApiError) {
    return res.status(err.httpStatus).json(fail(err.message, err.code, err.data ?? null));
  }
  // zod 校验错误：取第一条 message
  if (err && err.name === 'ZodError' && Array.isArray(err.issues)) {
    const first = err.issues[0];
    const msg = first ? `${first.path?.join('.') || '参数'}: ${first.message}` : '校验失败';
    return res.status(400).json(fail(msg, 40001));
  }
  // SQLite 唯一性约束
  if (err && /UNIQUE constraint failed/i.test(String(err.message || ''))) {
    return res.status(409).json(fail('数据已存在（唯一性冲突）', 40900));
  }
  console.error('[error]', err);
  const code = httpStatusToCode(err.status || 500);
  return res.status(500).json(fail(err.message || '服务器内部错误', code));
}
