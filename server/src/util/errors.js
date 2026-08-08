// ============================================================
// 业务错误类型 + 错误码（与 shared/constants.js 的 ERROR_CODE 对齐）
// ============================================================
import { ERROR_CODE } from '../../../shared/constants.js';

/**
 * 业务异常：携带 HTTP 状态码 + 业务错误码
 */
export class ApiError extends Error {
  /**
   * @param {string} message 用户可读信息
   * @param {number} httpStatus HTTP 状态码
   * @param {number} code 业务错误码（默认取 ERROR_CODE 中对应项）
   * @param {*} data 附加数据
   */
  constructor(message, httpStatus = 400, code = ERROR_CODE.BAD_REQUEST, data = null) {
    super(message);
    this.name = 'ApiError';
    this.httpStatus = httpStatus;
    this.code = code;
    this.data = data;
  }

  static badRequest(msg = '参数错误', data = null) {
    return new ApiError(msg, 400, ERROR_CODE.BAD_REQUEST, data);
  }

  static validation(msg = '校验失败', data = null) {
    return new ApiError(msg, 400, ERROR_CODE.VALIDATION, data);
  }

  static unauthorized(msg = '未登录', data = null) {
    return new ApiError(msg, 401, ERROR_CODE.UNAUTHORIZED, data);
  }

  static loginFailed(msg = '账号或密码错误', data = null) {
    return new ApiError(msg, 401, ERROR_CODE.LOGIN_FAILED, data);
  }

  static tokenExpired(msg = '登录已过期，请重新登录', data = null) {
    return new ApiError(msg, 401, ERROR_CODE.TOKEN_EXPIRED, data);
  }

  static forbidden(msg = '无权限', data = null) {
    return new ApiError(msg, 403, ERROR_CODE.FORBIDDEN, data);
  }

  static notFound(msg = '资源不存在', data = null) {
    return new ApiError(msg, 404, ERROR_CODE.NOT_FOUND, data);
  }

  /** 40401：标的不存在（东财与本地库均未命中） */
  static securityNotFound(msg = '标的不存在', data = null) {
    return new ApiError(msg, 404, ERROR_CODE.SECURITY_NOT_FOUND, data);
  }

  /**
   * 42401：情报时效不达标（零结果 / 全部超期）。
   * 架构 §7.5 最高红线：命中此错误时**绝不调用 LLM**，宁可不出结论也不基于旧闻编造。
   */
  static staleIntel(msg = '未获取到时效达标的实时情报，已拒绝生成结论', data = null) {
    return new ApiError(msg, 424, ERROR_CODE.STALE_INTEL, data);
  }

  /** 42402：登录用户尚未配置 AI Key（引导跳「模型设置」） */
  static aiNotConfigured(msg = '尚未配置 AI 模型，请先前往「模型设置」填写 API Key', data = null) {
    return new ApiError(msg, 424, ERROR_CODE.AI_NOT_CONFIGURED, data);
  }

  /** 50301：上游数据源不可用且降级也失败 */
  static upstreamUnavailable(msg = '上游数据源暂不可用，请稍后重试', data = null) {
    return new ApiError(msg, 503, ERROR_CODE.UPSTREAM_UNAVAILABLE, data);
  }

  static conflict(msg = '唯一性冲突', data = null) {
    return new ApiError(msg, 409, ERROR_CODE.CONFLICT, data);
  }

  static internal(msg = '服务器内部错误', data = null) {
    return new ApiError(msg, 500, ERROR_CODE.INTERNAL, data);
  }

  static aiTimeout(msg = 'AI 服务响应超时，已返回本地兜底结果', data = null) {
    return new ApiError(msg, 504, ERROR_CODE.AI_TIMEOUT, data);
  }
}

/** HTTP 状态码 -> 业务错误码的快捷映射（供中间件使用） */
export function httpStatusToCode(httpStatus) {
  const map = {
    400: ERROR_CODE.BAD_REQUEST,
    401: ERROR_CODE.UNAUTHORIZED,
    403: ERROR_CODE.FORBIDDEN,
    404: ERROR_CODE.NOT_FOUND,
    409: ERROR_CODE.CONFLICT,
    424: ERROR_CODE.STALE_INTEL,
    500: ERROR_CODE.INTERNAL,
    503: ERROR_CODE.UPSTREAM_UNAVAILABLE,
    504: ERROR_CODE.AI_TIMEOUT,
  };
  return map[httpStatus] ?? ERROR_CODE.INTERNAL;
}
