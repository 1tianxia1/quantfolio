// ============================================================
// 按通道提供 fetch dispatcher（代理开关）
//
// 背景（架构 §1.2 / §6.2）：
//   Node 原生 fetch 不认 HTTP_PROXY 环境变量，必须显式传 dispatcher。
//   东财 / 智谱均为境内域名，默认直连（走代理反而更慢更容易失败）。
//   HTTP_PROXY_URL=http://127.0.0.1:7890 仅为「将来接海外信源」预留，
//   由各通道的 *_USE_PROXY 单独开关控制。
//
// 关键约束（T01 验收点 9）：
//   未开启代理时**绝不 import undici**，做到「不用即零依赖」。
//   因此 undici 只在 getDispatcher() 判定需要代理后才 await import()。
// ============================================================
import env from '../config/env.js';

/**
 * 通道 → 「是否启用代理」的取值函数。
 * 已知通道走 config/env.js（有默认值、可被单测替换）；
 * 未知通道回落读 process.env[`${CHANNEL}_USE_PROXY`]，
 * 这样 T02 新增检索通道时无需修改本文件。
 */
const CHANNEL_FLAG = {
  eastmoney: () => env.EM_USE_PROXY,
};

/** dispatcher 缓存：通道 → dispatcher 实例（或 null 表示直连） */
const cache = new Map();
/** 已警告过的通道，避免刷屏 */
const warned = new Set();

/** 布尔解析：'true' / '1' / 'yes' 视为真 */
function toBool(v) {
  if (typeof v === 'boolean') return v;
  const s = String(v ?? '').trim().toLowerCase();
  return s === 'true' || s === '1' || s === 'yes' || s === 'on';
}

/**
 * 判断某通道是否应当走代理
 * @param {string} channel 通道名，如 'eastmoney' / 'webSearch'
 * @returns {boolean} 是否启用代理
 */
export function isProxyEnabled(channel) {
  const proxyUrl = String(env.HTTP_PROXY_URL || '').trim();
  if (!proxyUrl) return false;
  const getter = CHANNEL_FLAG[channel];
  const raw = getter
    ? getter()
    : process.env[`${String(channel || '').replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}_USE_PROXY`];
  return toBool(raw);
}

/**
 * 获取通道对应的 fetch dispatcher
 *
 * @param {string} channel 通道名，如 'eastmoney'
 * @returns {Promise<object|undefined>} undici ProxyAgent 实例；不走代理时返回 undefined
 *
 * 注意：返回 undefined 时调用方可直接 `fetch(url, { dispatcher: undefined })`，
 *       Node 会忽略该项，等价于默认全局 dispatcher。
 */
export async function getDispatcher(channel) {
  if (!isProxyEnabled(channel)) return undefined;

  if (cache.has(channel)) {
    return cache.get(channel) || undefined;
  }

  const proxyUrl = String(env.HTTP_PROXY_URL || '').trim();
  try {
    // ⚠️ 唯一的 undici 引用点：仅在确认需要代理时才加载
    const { ProxyAgent } = await import('undici');
    const agent = new ProxyAgent(proxyUrl);
    cache.set(channel, agent);
    console.log(`[httpAgent] 通道 ${channel} 已启用代理：${proxyUrl}`);
    return agent;
  } catch (e) {
    // 未安装 undici 或代理构造失败 → 退回直连，不阻断业务（红线：永不白屏）
    if (!warned.has(channel)) {
      warned.add(channel);
      console.warn(
        `[httpAgent] 通道 ${channel} 请求了代理（${proxyUrl}）但 undici 不可用：${e.message}。`
        + ' 已回退直连。如需代理请在 server/ 下执行：npm i undici',
      );
    }
    cache.set(channel, null);
    return undefined;
  }
}

/**
 * 清空 dispatcher 缓存（配置热更新或单测使用）
 * @returns {void}
 */
export function resetDispatcherCache() {
  for (const agent of cache.values()) {
    if (agent && typeof agent.close === 'function') {
      try { agent.close(); } catch (_) { /* 关闭失败不影响主流程 */ }
    }
  }
  cache.clear();
  warned.clear();
}
