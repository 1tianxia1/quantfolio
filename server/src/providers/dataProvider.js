// ============================================================
// DataProvider 适配器模式
// 接口定义 + getProvider 工厂（env.DATA_PROVIDER 切换）
// 业务层只依赖本接口，不依赖具体实现
// ============================================================
import env from '../config/env.js';
import { createSqliteProvider } from './sqliteProvider.js';
import { createHttpProvider } from './httpProvider.js';
import { createEastmoneyProvider } from './eastmoneyProvider.js';

/** DataProvider 接口方法清单（供实现参考与测试） */
export const PROVIDER_METHODS = [
  'getQuote',           // (code) => Quote
  'getQuotes',          // (codes[]) => Quote[]
  'getDailyKline',      // (code, n) => Bar[]
  'listSecurities',     // (filter) => Security[]
  'getSectorInfo',      // (code) => SectorInfo
  'getLatestSnapshot',  // () => Snapshot
];

/** 支持的数据源名称（错误提示与配置校验共用，避免两处硬编码走样） */
export const SUPPORTED_PROVIDERS = ['sqlite', 'http', 'eastmoney'];

/**
 * 数据源工厂
 *
 * ⚠️ 调用约定：**一律 `await` provider 的方法**。
 *   sqliteProvider 同步返回、eastmoneyProvider 返回 Promise，
 *   `await` 非 Promise 值同样成立，因此加了 await 后两者可无缝互换。
 *
 * @param {import('../db/driver.js').Database} db 数据库句柄
 * @param {object} [options] 透传给具体实现的选项（如注入 mock client）
 * @returns {object} DataProvider 实现
 */
export function getProvider(db, options = {}) {
  const name = env.DATA_PROVIDER || 'sqlite';
  switch (name) {
    case 'sqlite':
      return createSqliteProvider(db);
    case 'http':
      return createHttpProvider(db);
    case 'eastmoney':
      // 东财实时行情 + 本地静态属性融合；东财不可达时内部自动降级回 sqlite
      return createEastmoneyProvider(db, options);
    default:
      throw new Error(`未知 DATA_PROVIDER: ${name}（支持 ${SUPPORTED_PROVIDERS.join(' / ')}）`);
  }
}
