// ============================================================
// zod 请求体校验中间件
// ============================================================
import { ApiError } from '../util/errors.js';

/**
 * 校验 req.body 并挂载为 req.validated
 * @param {import('zod').ZodSchema} schema
 */
export function validateBody(schema) {
  return (req, _res, next) => {
    try {
      req.validated = schema.parse(req.body ?? {});
      next();
    } catch (e) {
      next(e); // errorHandler 处理 ZodError
    }
  };
}

/**
 * 校验 req.query 并挂载为 req.validatedQuery
 * @param {import('zod').ZodSchema} schema
 */
export function validateQuery(schema) {
  return (req, _res, next) => {
    try {
      req.validatedQuery = schema.parse(req.query ?? {});
      next();
    } catch (e) {
      next(e);
    }
  };
}
