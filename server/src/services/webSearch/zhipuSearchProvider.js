// ============================================================
// 检索路 1（主）：智谱 Web Search（架构 §6.2）
//
// 关键设计：**不新接任何第三方 Key**。
//   这里用的就是用户在「模型设置」里已经填过的智谱 Key，
//   由 ai/resolveAiConfig.js 统一解析后传进来（capabilities.webSearch 为真才启用）。
//   用户若选了别家模型，本路自动不可用，检索由东财兜底路承担（不失能）。
//
// 两种调用形态，对上层完全透明：
//   形态 A（首选）POST /api/paas/v4/web_search
//                 → 结构化 { title, link, content, publish_date }，可直接映射
//   形态 B（退化）POST /chat/completions + tools:[{type:'web_search'}]
//                 → 从响应的 web_search / tool_calls 块里抽来源
//
// 红线：
//   · 任何失败都返回空数组 + 记录 degraded 原因，**绝不抛异常穿透**；
//   · 绝不伪造 publish_date —— 上游没给就是 null，由 service 丢弃该条。
// ============================================================
import env from '../../config/env.js';
import { getDispatcher } from '../../util/httpAgent.js';
import { SEARCH_PROVIDER } from '../../../../shared/constants.js';
import { makeSearchResult, withTimeout } from './searchCommon.js';

/** 代理通道名（httpAgent 未知通道回落读 process.env.WEBSEARCH_USE_PROXY） */
const CHANNEL = 'webSearch';

/** 智谱 chat/completions 默认地址（形态 B 用；用户自配 baseUrl 优先） */
const ZHIPU_CHAT_URL = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';

/**
 * 从形态 A 的响应体里抽取结果数组
 * 智谱不同版本字段名有 search_result / web_search 两种，这里都认。
 * @param {object|null} json 响应 JSON
 * @returns {object[]} 原始条目数组
 */
function pickRawList(json) {
  if (!json || typeof json !== 'object') return [];
  if (Array.isArray(json.search_result)) return json.search_result;
  if (Array.isArray(json.web_search)) return json.web_search;
  if (Array.isArray(json.data)) return json.data;
  if (json.choices && Array.isArray(json.choices)) {
    // 形态 B：从 message 里翻 web_search 块
    for (const choice of json.choices) {
      const msg = choice?.message;
      if (!msg) continue;
      if (Array.isArray(msg.web_search)) return msg.web_search;
      if (Array.isArray(msg.tool_calls)) {
        for (const call of msg.tool_calls) {
          const payload = call?.web_search || call?.search_result;
          if (Array.isArray(payload)) return payload;
        }
      }
    }
  }
  return [];
}

/**
 * 单条原始记录 → SearchResult
 * @param {object} raw 智谱原始条目
 * @param {string} retrievedAt 本次检索时间 ISO
 * @returns {object|null} SearchResult 或 null
 */
function mapItem(raw, retrievedAt) {
  if (!raw || typeof raw !== 'object') return null;
  return makeSearchResult({
    title: raw.title || raw.name || '',
    url: raw.link || raw.url || '',
    snippet: raw.content || raw.snippet || raw.summary || '',
    publishedAt: raw.publish_date || raw.publishDate || raw.published_at || raw.date || null,
    site: raw.media || raw.media_name || raw.site || '',
    providerId: SEARCH_PROVIDER.ZHIPU,
    retrievedAt,
  });
}

/**
 * 创建智谱检索提供方
 * @param {object} [options] 覆盖配置（便于自测注入）
 * @param {string} [options.searchUrl] Web Search 接口地址
 * @param {string} [options.engine] 检索引擎名（search_std / search_pro …）
 * @param {number} [options.timeoutMs] 超时
 * @param {Function} [options.fetchImpl] 自定义 fetch（自测打桩用）
 * @returns {object} SearchProvider 实例
 */
export function createZhipuSearchProvider(options = {}) {
  const cfg = {
    searchUrl: options.searchUrl || env.WEB_SEARCH_ZHIPU_URL,
    engine: options.engine || env.WEB_SEARCH_ZHIPU_ENGINE,
    timeoutMs: Number(options.timeoutMs ?? env.WEB_SEARCH_TIMEOUT_MS) || 15000,
    fetchImpl: options.fetchImpl || null,
  };

  /**
   * 是否可用：必须是智谱厂商且持有 Key（由 resolveAiConfig 的 capabilities 判定）
   * @param {object|null} aiResolution resolveAiConfig 的返回值
   * @returns {boolean} 可用性
   */
  function isAvailable(aiResolution) {
    if (String(env.WEB_SEARCH_ENABLED).toLowerCase() === 'false') return false;
    if (!aiResolution || aiResolution.notConfigured) return false;
    return Boolean(aiResolution.capabilities?.webSearch) && Boolean(resolveKey(aiResolution));
  }

  /**
   * 取出可用的智谱 Key：用户 BYOK 优先，游客回落服务端 .env
   * @param {object|null} aiResolution resolveAiConfig 的返回值
   * @returns {string} API Key；无则空串
   */
  function resolveKey(aiResolution) {
    const byok = aiResolution?.aiConfig?.apiKey;
    if (byok) return String(byok);
    // 游客路径：aiConfig 为 null，回落服务端默认（仅当服务端默认厂商就是智谱）
    if (aiResolution?.aiMeta && !aiResolution.aiMeta.custom && env.AI_PROVIDER === 'zhipu') {
      return String(env.AI_API_KEY || '');
    }
    return '';
  }

  /**
   * 发起一次 HTTP POST（带超时 + 代理开关）
   * @param {string} url 目标地址
   * @param {object} body 请求体
   * @param {string} apiKey Bearer Key
   * @returns {Promise<object|null>} 响应 JSON；失败抛错由调用方兜住
   */
  async function post(url, body, apiKey) {
    const doFetch = cfg.fetchImpl || fetch;
    const dispatcher = await getDispatcher(CHANNEL);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
    try {
      const init = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      };
      if (dispatcher) init.dispatcher = dispatcher;
      const res = await doFetch(url, init);
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        const e = new Error(`HTTP ${res.status} ${res.statusText}${detail ? ` - ${detail.slice(0, 120)}` : ''}`);
        e.status = res.status;
        throw e;
      }
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 形态 A：独立 Web Search 接口
   * @param {string} q 查询词
   * @param {number} count 期望条数
   * @param {string} apiKey Key
   * @returns {Promise<object[]>} 原始条目数组
   */
  async function queryStandalone(q, count, apiKey) {
    const json = await post(cfg.searchUrl, {
      search_engine: cfg.engine,
      search_query: q,
      count,
      content_size: 'medium',
    }, apiKey);
    return pickRawList(json);
  }

  /**
   * 形态 B：chat/completions + web_search 工具
   * @param {string} q 查询词
   * @param {string} apiKey Key
   * @param {object|null} aiConfig BYOK 配置（取 model / baseUrl）
   * @returns {Promise<object[]>} 原始条目数组
   */
  async function queryViaChat(q, apiKey, aiConfig) {
    const url = aiConfig?.baseUrl || ZHIPU_CHAT_URL;
    const model = aiConfig?.model || 'glm-4-flash';
    const json = await post(url, {
      model,
      messages: [{ role: 'user', content: `检索并列出与「${q}」相关的最新财经信息来源` }],
      tools: [{ type: 'web_search', web_search: { enable: true, search_query: q } }],
      stream: false,
    }, apiKey);
    return pickRawList(json);
  }

  /**
   * 执行检索
   * @param {string} q 查询词
   * @param {object} [opts] 选项
   * @param {object} [opts.aiResolution] resolveAiConfig 的返回值（取 Key）
   * @param {number} [opts.topK=8] 期望条数
   * @param {string} [opts.retrievedAt] 本次检索时间 ISO
   * @returns {Promise<{results: object[], error: string|null}>} 结果与失败原因
   */
  async function query(q, opts = {}) {
    const retrievedAt = opts.retrievedAt || new Date().toISOString();
    const topK = Number(opts.topK) || Number(env.WEB_SEARCH_TOPK) || 8;
    const aiResolution = opts.aiResolution || null;

    if (!isAvailable(aiResolution)) {
      return { results: [], error: '未启用（当前模型非智谱或未配置 Key）' };
    }

    const apiKey = resolveKey(aiResolution);
    let raw = [];
    let lastErr = null;

    // 形态 A
    try {
      raw = await withTimeout(queryStandalone(q, topK, apiKey), cfg.timeoutMs, '智谱 Web Search');
    } catch (e) {
      lastErr = e;
      raw = [];
    }

    // 形态 A 无结果 → 退化形态 B
    if (!raw.length) {
      try {
        raw = await withTimeout(
          queryViaChat(q, apiKey, aiResolution?.aiConfig || null),
          cfg.timeoutMs,
          '智谱 chat web_search',
        );
        lastErr = null;
      } catch (e) {
        lastErr = lastErr || e;
        raw = [];
      }
    }

    const results = raw
      .map((item) => mapItem(item, retrievedAt))
      .filter(Boolean)
      .slice(0, topK);

    if (!results.length) {
      return { results: [], error: lastErr ? String(lastErr.message || lastErr) : '无结果' };
    }
    return { results, error: null };
  }

  return {
    id: SEARCH_PROVIDER.ZHIPU,
    label: '智谱 Web Search',
    /** 常驻性：false 表示需满足条件才参与并联 */
    alwaysOn: false,
    config: Object.freeze({ ...cfg, fetchImpl: undefined }),
    isAvailable,
    query,
  };
}

/** 进程级单例 */
export const zhipuSearchProvider = createZhipuSearchProvider();

export default zhipuSearchProvider;
