// ============================================================
// HttpProvider —— 预留 HTTP 数据源适配位
// 读 .env 的 MARKET_API_BASE；未配置/未实现时返回「未实现」提示
// ============================================================
import env from '../config/env.js';

/**
 * 创建 HTTP 数据源实现（预留）
 * @param {import('../db/driver.js').Database} _db 占位（保持工厂签名一致）
 */
export function createHttpProvider(_db) {
  const base = env.MARKET_API_BASE || '';

  function notImplemented(method) {
    const msg = base
      ? `HttpProvider.${method} 尚未实现（MARKET_API_BASE=${base}）`
      : `HttpProvider.${method} 尚未实现，请先配置 MARKET_API_BASE 或改用 DATA_PROVIDER=sqlite`;
    throw new Error(msg);
  }

  return {
    name: 'http',
    getQuote(code) { notImplemented(`getQuote(${code})`); },
    getQuotes(codes) { notImplemented(`getQuotes(${codes.length})`); },
    getDailyKline(code, n) { notImplemented(`getDailyKline(${code},${n})`); },
    listSecurities(filter) { notImplemented(`listSecurities`); },
    getSectorInfo(code) { notImplemented(`getSectorInfo(${code})`); },
    getLatestSnapshot() { notImplemented('getLatestSnapshot'); },
  };
}
