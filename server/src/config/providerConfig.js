// ============================================================
// 运行时数据源配置：meta_kv('data_provider') 覆盖 env.DATA_PROVIDER，带短缓存。
// 让「设置页开关」能热切换数据源，无需改 .env / 重启。
// 注意：刻意不在此文件 import dataProvider.js，避免与后者形成循环依赖；
//       允许列表本地维护一份（与 dataProvider.SUPPORTED_PROVIDERS 同步）。
// ============================================================
import env from './env.js';

/** 允许的数据源（与 providers/dataProvider.js 的 SUPPORTED_PROVIDERS 保持一致） */
const ALLOWED = ['sqlite', 'http', 'eastmoney'];

const META_KEY = 'data_provider';
const CACHE_TTL_MS = 10_000;

let cache = { name: null, ts: 0 };

function readMetaProvider(db) {
  try {
    const row = db.get('SELECT v FROM meta_kv WHERE k=?', [META_KEY]);
    return row?.v ?? null;
  } catch (_e) {
    return null;
  }
}

function writeMetaProvider(db, name) {
  db.run(
    `INSERT INTO meta_kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`,
    [META_KEY, name],
  );
}

/**
 * 取当前生效的数据源名称。
 * 优先 meta_kv 运行时配置，回退 env.DATA_PROVIDER，再回退 sqlite。
 * 带 10s 缓存，避免热路径每次读库。
 * @param {import('../db/driver.js').Database} db
 */
export function getEffectiveProviderName(db) {
  const now = Date.now();
  if (cache.name && now - cache.ts < CACHE_TTL_MS) return cache.name;
  const meta = db ? readMetaProvider(db) : null;
  const name = (meta && ALLOWED.includes(meta)) ? meta : (env.DATA_PROVIDER || 'sqlite');
  cache = { name, ts: now };
  return name;
}

/**
 * 写入运行时数据源选择（持久化到 meta_kv 并刷新缓存）。
 * @param {import('../db/driver.js').Database} db
 * @param {string} name
 */
export function setEffectiveProviderName(db, name) {
  if (!ALLOWED.includes(name)) {
    throw new Error(`不支持的数据源：${name}（支持 ${ALLOWED.join(' / ')}）`);
  }
  writeMetaProvider(db, name);
  cache = { name, ts: Date.now() };
  return name;
}

/** 是否已启用实时行情（东方财富） */
export function isRealtimeEnabled(db) {
  return getEffectiveProviderName(db) === 'eastmoney';
}

/** 仅供测试/运维：清空运行时覆盖，回到 env 默认 */
export function resetProviderCache() {
  cache = { name: null, ts: 0 };
}
