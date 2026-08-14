// ============================================================
// 按通道提供 fetch dispatcher（代理开关 + 代理池轮转）
//
// 背景（架构 §1.2 / §6.2）：
//   Node 原生 fetch 不认 HTTP_PROXY 环境变量，必须显式传 dispatcher。
//   东财 / 智谱均为境内域名，默认直连（走代理反而更慢更容易失败）。
//   HTTP_PROXY_URL=http://127.0.0.1:7890 仅为「将来接海外信源」预留，
//   由各通道的 *_USE_PROXY 单独开关控制。
//
// 东财解限流 PoC（2026-08-12）：
//   生产机 push2his 被东财域名级封 IP、fflow 单 IP 限流 44 只即熔断。
//   配置 EM_PROXY_LIST（逗号分隔多出口代理）+ EM_PROXY_QUOTA（每代理请求配额）后，
//   每次 getDispatcher() 调用按 round-robin + 配额轮换取不同出口 IP 的 dispatcher，
//   把「单 IP 44 只熔断」摊薄到多 IP。配合 emClient 的 reportFailure() 做失败切换。
//
//   兼容性红线：**未配置 EM_PROXY_LIST 时行为与 PoC 前完全一致**（单代理 or 直连），
//   本组新增逻辑仅在显式配置多代理后才激活，生产主路径零影响。
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

/** 单代理 dispatcher 缓存：通道 → dispatcher 实例（或 null 表示直连） */
const cache = new Map();
/** 已警告过的通道，避免刷屏 */
const warned = new Set();

/**
 * 代理池状态（EM_PROXY_LIST 配置后激活）：
 *   urls[]       代理 URL 列表
 *   agents[]     对应 ProxyAgent 实例（lazy 构造）
 *   reqCounts[]  每代理已发放请求数（用于配额轮换）
 *   failCounts[] 每代理连续失败数（reportFailure 累积）
 *   cooldownUntil[] 每代理冷却截止时间戳（失败轮换后暂停）
 *   activeIdx    当前轮转指针
 */
const pool = {
  urls: [],
  agents: [],
  reqCounts: [],
  failCounts: [],
  cooldownUntil: [],
  activeIdx: 0,
};

/** 布尔解析：'true' / '1' / 'yes' 视为真 */
function toBool(v) {
  if (typeof v === 'boolean') return v;
  const s = String(v ?? '').trim().toLowerCase();
  return s === 'true' || s === '1' || s === 'yes' || s === 'on';
}

/**
 * 解析逗号分隔代理列表（EM_PROXY_LIST）
 * 容错：去空白、去空项、去重复；无法解析时返回 []（不抛，退回单代理/直连）
 * @returns {string[]}
 */
function parseProxyList(raw) {
  if (!raw) return [];
  const seen = new Set();
  const out = [];
  for (const part of String(raw).split(',')) {
    const u = part.trim();
    if (u && !seen.has(u)) {
      seen.add(u);
      out.push(u);
    }
  }
  return out;
}

/** 代理池是否激活：EM_PROXY_LIST 非空且代理通道开关已开 */
function isPoolActive(channel) {
  if (!isProxyEnabled(channel)) return false;
  return pool.urls.length > 0;
}

/** 从环境重建代理池（配置变更 / 单测 / reset 时调用） */
function refreshPool() {
  pool.urls = parseProxyList(String(env.EM_PROXY_LIST || ''));
  pool.agents = new Array(pool.urls.length).fill(null);
  pool.reqCounts = new Array(pool.urls.length).fill(0);
  pool.failCounts = new Array(pool.urls.length).fill(0);
  pool.cooldownUntil = new Array(pool.urls.length).fill(0);
  pool.activeIdx = 0;
}

/**
 * 判断某通道是否应当走代理
 * @param {string} channel 通道名，如 'eastmoney' / 'webSearch'
 * @returns {boolean} 是否启用代理
 */
export function isProxyEnabled(channel) {
  const proxyUrl = String(env.HTTP_PROXY_URL || '').trim();
  const proxyList = String(env.EM_PROXY_LIST || '').trim();
  if (!proxyUrl && !proxyList) return false;
  const getter = CHANNEL_FLAG[channel];
  const raw = getter
    ? getter()
    : process.env[`${String(channel || '').replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}_USE_PROXY`];
  return toBool(raw);
}

/**
 * 代理池内部：惰性构造指定索引的 ProxyAgent
 * @param {number} idx 代理索引
 * @returns {Promise<object|null>} ProxyAgent 实例或 null（构造失败）
 */
async function getPoolAgent(idx) {
  if (pool.agents[idx]) return pool.agents[idx];
  try {
    const { ProxyAgent } = await import('undici');
    const agent = new ProxyAgent(pool.urls[idx]);
    pool.agents[idx] = agent;
    console.log(`[httpAgent] 代理池已启用出口 ${idx}: ${pool.urls[idx]}`);
    return agent;
  } catch (e) {
    if (!warned.has('pool')) {
      warned.add('pool');
      console.warn(
        `[httpAgent] 代理池出口 ${idx} (${pool.urls[idx]}) 构造失败：${e.message}。`
        + ' 已跳过该出口。如需代理请在 server/ 下执行：npm i undici',
      );
    }
    return null;
  }
}

/** 当前代理是否处于冷却期 */
function poolCooling(idx) {
  return Date.now() < pool.cooldownUntil[idx];
}

/** 下一个可用（非冷却）代理索引；全冷却时返回 -1 */
function nextNonCooling(from) {
  const n = pool.urls.length;
  if (n === 0) return -1;
  for (let step = 0; step < n; step += 1) {
    const idx = (from + step) % n;
    if (!poolCooling(idx)) return idx;
  }
  return -1;
}

/** 推进轮转指针到下一个可用代理（跳过冷却中的） */
function advancePool() {
  const next = nextNonCooling(pool.activeIdx + 1);
  if (next >= 0) pool.activeIdx = next;
}

/**
 * 代理池：取当前应使用的 dispatcher（配额轮转）
 * 规则：
 *   · 当前代理若未超配额且非冷却 → 直接使用（reqCounts++）
 *   · 超配额 / 冷却中 → 推进到下一个可用代理（reqCounts 归零）
 *   · 全部冷却 → 返回 null（调用方走直连兜底，不阻断业务）
 * @param {string} channel 通道名（仅用于日志）
 * @returns {Promise<object|undefined>} ProxyAgent 或 undefined
 */
async function pickPoolDispatcher(channel) {
  // 当前代理超配额 → 轮换
  const quota = Number(env.EM_PROXY_QUOTA) || 0;
  const cur = pool.activeIdx;
  if (quota > 0 && pool.reqCounts[cur] >= quota) {
    if (pool.urls.length > 1) {
      advancePool();
    } else {
      // 单代理且超配额：重置计数继续用（没有别的出口可换）
      pool.reqCounts[cur] = 0;
    }
  } else if (poolCooling(cur)) {
    const next = nextNonCooling(cur);
    if (next >= 0) pool.activeIdx = next;
  }

  const idx = pool.activeIdx;
  // 当前出口冷却 → 尝试下一个；全冷却返回 null
  if (poolCooling(idx)) {
    const next = nextNonCooling(idx);
    if (next < 0) {
      if (!warned.has('pool-all-cooling')) {
        warned.add('pool-all-cooling');
        console.warn('[httpAgent] 代理池全部出口处于冷却期，本次请求回退直连');
      }
      return undefined;
    }
    pool.activeIdx = next;
  }

  // 决定使用该出口即计数（配额轮转的指针推进独立于 agent 构造成败，
  // 保证 undici 不可用/构造失败时轮转逻辑依然可测、可观察）
  pool.reqCounts[pool.activeIdx] += 1;
  const agent = await getPoolAgent(pool.activeIdx);
  if (!agent) return undefined;
  return agent;
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

  // 代理池模式：EM_PROXY_LIST 非空时按配额轮转取出口
  // ⚠️ 仅当代理列表发生变化时才 refreshPool（否则每次调用重置请求计数，配额轮换失效）
  const listRaw = String(env.EM_PROXY_LIST || '').trim();
  const poolRaw = pool.urls.join(',');
  if (listRaw && listRaw !== poolRaw) refreshPool();
  if (pool.urls.length > 0) {
    return pickPoolDispatcher(channel);
  }

  // 单代理模式（PoC 前行为不变）
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
 * 上报当前活动代理的请求失败（emClient 在请求失败时调用）
 * 连续失败达 EM_PROXY_FAIL_THRESHOLD → 该代理进入冷却并轮换到下一个
 * 未启用代理池时调用是 no-op（零影响）。
 * @param {string} channel 通道名
 */
export function reportFailure(channel) {
  if (!pool.urls.length) return;
  const threshold = Number(env.EM_PROXY_FAIL_THRESHOLD) || 0;
  if (threshold <= 0) return;
  const idx = pool.activeIdx;
  pool.failCounts[idx] += 1;
  if (pool.failCounts[idx] >= threshold) {
    const cooldownMs = Number(env.EM_PROXY_COOLDOWN_MS) || 60000;
    pool.cooldownUntil[idx] = Date.now() + cooldownMs;
    console.warn(
      `[httpAgent] 代理池出口 ${idx} (${pool.urls[idx]}) 连续失败 ${pool.failCounts[idx]} 次，`
      + `进入冷却 ${Math.round(cooldownMs / 1000)}s 并轮换`,
    );
    pool.failCounts[idx] = 0;
    advancePool();
  }
}

/** 代理池状态快照（供脚本 / 探针监控） */
export function getProxyPoolStats() {
  return {
    enabled: pool.urls.length > 0,
    urls: pool.urls.map((u, i) => ({
      url: u,
      requests: pool.reqCounts[i],
      failures: pool.failCounts[i],
      cooling: poolCooling(i),
      cooldownMsLeft: Math.max(0, pool.cooldownUntil[i] - Date.now()),
    })),
    activeIdx: pool.activeIdx,
    quota: Number(env.EM_PROXY_QUOTA) || 0,
    failThreshold: Number(env.EM_PROXY_FAIL_THRESHOLD) || 0,
  };
}

/**
 * 清空 dispatcher 缓存与代理池状态（配置热更新或单测使用）
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
  for (const agent of pool.agents) {
    if (agent && typeof agent.close === 'function') {
      try { agent.close(); } catch (_) { /* 同上 */ }
    }
  }
  refreshPool();
}
