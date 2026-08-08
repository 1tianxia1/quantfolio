// ============================================================
// 统一响应信封：{ success, data, message, code }
// 成功 code=0；错误码枚举见 shared/constants.js
// ============================================================

/**
 * 成功响应
 * @param {*} data 业务数据
 * @param {string} message 提示信息
 * @param {number} code 业务码（成功为 0）
 */
export function ok(data = null, message = 'ok', code = 0) {
  return { success: true, data, message, code };
}

/**
 * 失败响应
 * @param {string} message 错误信息
 * @param {number} code 错误码（前三位 = HTTP 状态）
 * @param {*} data 附加数据（可选）
 */
export function fail(message = 'error', code = 50000, data = null) {
  return { success: false, data, message, code };
}
