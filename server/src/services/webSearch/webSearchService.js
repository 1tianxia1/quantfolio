// ============================================================
// 联网检索编排（架构 §1.5 / §6.2）—— 双路并联 + 去重 + 时效闸
//
// 拓扑：
//   路 1 zhipuSearchProvider（BYOK provider=zhipu 才启用）  ─┐
//   路 2 emNewsProvider（免 KEY，常驻执行）                  ─┼→ Promise.allSettled
//   路 3 customSearchProvider（P2 预留插槽）                 ─┘
//        ↓ URL 归一化去重 → 丢弃无 published_at 的条目 → 按新鲜度排序 → topK
//        ↓ freshness 判定：newestDays > thresholdDays → stale=true
//        → SearchBundle{ results, retrievedAt, freshness, providersUsed, degradedChannels }
//
// ⚠️ 本文件的最高红线（架构 §7.5 唯一的「硬失败」）：
//   **零结果 或 全部 stale → 抛 42401，绝不调用 LLM。**
//   结构性保障：本模块从头到尾不 import 任何 LLM 相关模块，
//   调用方（T03 模块 A）必须先 `searchOrThrow` 拿到 bundle 才可能走到 callLLM，
//   闸门抛错时调用链在此中断，LLM 无从被触发。
//   宁可不出结论，也不基于旧闻给错结论。
// ============================================================
import env from '../../config/env.js';
import { ApiError } from '../../util/errors.js';
import { SEARCH_PROVIDER, DEFAULT_FRESHNESS_DAYS } from '../../../../shared/constants.js';
import { zhipuSearchProvider } from './zhipuSearchProvider.js';
import { emNewsProvider } from './emNewsProvider.js';
import { normalizeUrl, daysAgo, withTimeout } from './searchCommon.js';

/**
 * @typedef {object} Freshness
 * @property {number|null} newestDays  最新一条距今天数；无结果为 null
 * @property {number} thresholdDays    时效阈值（天）
 * @property {boolean} stale           是否判定为「情报过期」
 */

/**
 * @typedef {object} SearchBundle
 * @property {object[]} results          规范化结果（含 url / publishedAt / retrievedAt / stale）
 * @property {string} retrievedAt        本次检索时间 ISO
 * @property {Freshness} freshness       时效判定
 * @property {string[]} providersUsed    实际产出结果的提供方 id
 * @property {string[]} degradedChannels 未产出结果的通道及原因
 * @property {string} query              实际使用的查询词
 * @property {string|null} code          关联标的代码
 * @property {number} droppedNoDate      因无法解析发布时间而被丢弃的条数
 */

/**
 * 创建检索服务
 * @param {object} [options] 覆盖配置
 * @param {object[]} [options.providers] 提供方数组（默认 [zhipu, eastmoney]）
 * @param {number} [options.freshnessDays] 时效阈值
 * @param {number} [options.topK] 结果条数
 * @param {number} [options.timeoutMs] 单路超时
 * @returns {object} 检索服务
 */
export function createWebSearchService(options = {}) {
  const cfg = {
    freshnessDays: Number(options.freshnessDays ?? env.WEB_SEARCH_FRESHNESS_DAYS) || DEFAULT_FRESHNESS_DAYS,
    topK: Number(options.topK ?? env.WEB_SEARCH_TOPK) || 8,
    timeoutMs: Number(options.timeoutMs ?? env.WEB_SEARCH_TIMEOUT_MS) || 15000,
  };

  /** 提供方注册表：顺序即优先级（去重时靠前者胜出） */
  const providers = Array.isArray(options.providers) && options.providers.length
    ? options.providers
    : [zhipuSearchProvider, emNewsProvider];

  /**
   * 跨源去重：同一篇文章可能同时出现在智谱与东财
   * 优先级：providers 数组顺序在前者胜出；同源则保留发布时间更完整的一条
   * @param {object[]} results 合并后的结果
   * @returns {object[]} 去重后的结果
   */
  function dedupe(results) {
    const seen = new Map();
    for (const r of results) {
      const urlKey = normalizeUrl(r.url);
      // 双键：URL 归一化优先；URL 无法归一化时退化为「标题 + 站点」
      const key = urlKey || `t:${r.title}|${r.site}`;
      const exist = seen.get(key);
      if (!exist) {
        seen.set(key, r);
        continue;
      }
      // 已存在：只有「原来没时间、新的有时间」才替换，避免打乱优先级
      if (!exist.publishedAt && r.publishedAt) seen.set(key, r);
    }
    return [...seen.values()];
  }

  /**
   * 时效判定
   * @param {object[]} results 已按时间排序的结果
   * @param {number} thresholdDays 阈值（天）
   * @param {number} [now=Date.now()] 参照时刻
   * @returns {Freshness} 判定结果
   */
  function judgeFreshness(results, thresholdDays, now = Date.now()) {
    if (!results.length) {
      return { newestDays: null, thresholdDays, stale: true };
    }
    let newestDays = null;
    for (const r of results) {
      const d = daysAgo(r.publishedAt, now);
      if (d === null) continue;
      if (newestDays === null || d < newestDays) newestDays = d;
    }
    if (newestDays === null) {
      return { newestDays: null, thresholdDays, stale: true };
    }
    return { newestDays, thresholdDays, stale: newestDays > thresholdDays };
  }

  /**
   * 执行一次双路并联检索
   *
   * 注意：本方法**不抛时效错误**，只如实返回 bundle（含 stale 标记）。
   *       需要硬闸门的调用方请用 `searchOrThrow`。
   *
   * @param {string} query 查询词
   * @param {object} [opts] 选项
   * @param {string} [opts.code] 关联标的代码（东财路会额外拉公告/研报）
   * @param {object} [opts.aiResolution] resolveAiConfig 结果（智谱路取 Key）
   * @param {number} [opts.freshnessDays] 覆盖时效阈值
   * @param {number} [opts.topK] 覆盖条数
   * @returns {Promise<SearchBundle>} 检索结果包
   */
  async function search(query, opts = {}) {
    const retrievedAt = new Date().toISOString();
    const now = Date.parse(retrievedAt);
    const q = String(query || '').trim();
    const thresholdDays = Number(opts.freshnessDays ?? cfg.freshnessDays) || DEFAULT_FRESHNESS_DAYS;
    const topK = Number(opts.topK ?? cfg.topK) || 8;
    const code = opts.code ? String(opts.code) : null;

    const bundleBase = {
      retrievedAt,
      query: q,
      code,
      providersUsed: [],
      degradedChannels: [],
      droppedNoDate: 0,
    };

    if (String(env.WEB_SEARCH_ENABLED).toLowerCase() === 'false') {
      return {
        ...bundleBase,
        results: [],
        degradedChannels: ['config:WEB_SEARCH_ENABLED=false'],
        freshness: { newestDays: null, thresholdDays, stale: true },
      };
    }
    if (!q) {
      return {
        ...bundleBase,
        results: [],
        degradedChannels: ['input:查询词为空'],
        freshness: { newestDays: null, thresholdDays, stale: true },
      };
    }

    // ---------- 并联调度：单路失败/超时都不影响整体 ----------
    const active = providers.filter((p) => {
      try {
        return p.alwaysOn || p.isAvailable(opts.aiResolution || null);
      } catch (_) {
        return false;
      }
    });

    const skipped = providers.filter((p) => !active.includes(p));
    for (const p of skipped) {
      bundleBase.degradedChannels.push(`${p.id}:未启用`);
    }

    const settled = await Promise.allSettled(
      active.map((p) => withTimeout(
        p.query(q, { code, topK, retrievedAt, aiResolution: opts.aiResolution || null }),
        cfg.timeoutMs,
        p.label || p.id,
      )),
    );

    const merged = [];
    settled.forEach((res, i) => {
      const p = active[i];
      if (res.status !== 'fulfilled') {
        bundleBase.degradedChannels.push(`${p.id}:${String(res.reason?.message || res.reason)}`);
        return;
      }
      const payload = res.value || { results: [], error: '空响应' };
      if (!payload.results || !payload.results.length) {
        bundleBase.degradedChannels.push(`${p.id}:${payload.error || '无结果'}`);
        return;
      }
      bundleBase.providersUsed.push(p.id);
      merged.push(...payload.results);
    });

    // ---------- 归一化：去重 → 丢弃无发布时间 → 排序 → 截断 ----------
    const deduped = dedupe(merged);
    const dated = deduped.filter((r) => Boolean(r.publishedAt));
    bundleBase.droppedNoDate = deduped.length - dated.length;

    dated.sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
    const results = dated.slice(0, topK);

    // 回填每条的 stale 标记（单条时效，供前端高亮）
    for (const r of results) {
      const d = daysAgo(r.publishedAt, now);
      r.stale = d === null ? true : d > thresholdDays;
    }

    return {
      ...bundleBase,
      results,
      freshness: judgeFreshness(results, thresholdDays, now),
    };
  }

  /**
   * 时效闸（架构 §6.2 D3 红线 / §7.5 唯一硬失败）
   *
   * 零结果 或 全部 stale → 抛 `ApiError.staleIntel`（code 42401）。
   * 调用方拿到异常后必须**直接返回错误**，不得继续调用 LLM。
   *
   * @param {SearchBundle} bundle search() 的返回值
   * @throws {ApiError} 42401
   * @returns {SearchBundle} 校验通过的原 bundle（便于链式书写）
   */
  function assertFresh(bundle) {
    const days = bundle?.freshness?.thresholdDays ?? cfg.freshnessDays;
    const detail = {
      threshold_days: days,
      newest_days: bundle?.freshness?.newestDays ?? null,
      providers_used: bundle?.providersUsed || [],
      degraded_channels: bundle?.degradedChannels || [],
      retrieved_at: bundle?.retrievedAt || new Date().toISOString(),
      result_count: bundle?.results?.length || 0,
      dropped_no_date: bundle?.droppedNoDate || 0,
    };

    if (!bundle || !Array.isArray(bundle.results) || bundle.results.length === 0) {
      throw ApiError.staleIntel(
        `未获取到 ${days} 天内的实时情报（本次检索零结果），已拒绝生成结论`,
        detail,
      );
    }
    if (bundle.freshness?.stale) {
      const newest = bundle.freshness.newestDays;
      throw ApiError.staleIntel(
        `未获取到 ${days} 天内的实时情报（最新一条已是 ${newest ?? '未知'} 天前），已拒绝生成结论`,
        detail,
      );
    }
    return bundle;
  }

  /**
   * 检索 + 时效闸一步到位（模块 A 的标准入口）
   * @param {string} query 查询词
   * @param {object} [opts] 同 search
   * @throws {ApiError} 42401 情报时效不达标
   * @returns {Promise<SearchBundle>} 通过时效闸的结果包
   */
  async function searchOrThrow(query, opts = {}) {
    const bundle = await search(query, opts);
    return assertFresh(bundle);
  }

  /**
   * 当前检索能力概览（供 /api/analysis/capabilities）
   * @param {object|null} aiResolution resolveAiConfig 结果
   * @returns {{enabled:boolean, freshnessDays:number, topK:number, providers:Array<{id:string,label:string,available:boolean,alwaysOn:boolean}>}}
   */
  function describe(aiResolution) {
    return {
      enabled: String(env.WEB_SEARCH_ENABLED).toLowerCase() !== 'false',
      freshnessDays: cfg.freshnessDays,
      topK: cfg.topK,
      providers: providers.map((p) => {
        let available = false;
        try {
          available = Boolean(p.alwaysOn || p.isAvailable(aiResolution || null));
        } catch (_) {
          available = false;
        }
        return {
          id: p.id, label: p.label || p.id, available, alwaysOn: Boolean(p.alwaysOn),
        };
      }),
    };
  }

  return {
    config: Object.freeze({ ...cfg }),
    providers,
    search,
    searchOrThrow,
    assertFresh,
    describe,
    // 暴露内部纯函数，便于 QA 单测与打桩验证
    _internal: { dedupe, judgeFreshness },
  };
}

/** 进程级单例 */
export const webSearchService = createWebSearchService();

export { SEARCH_PROVIDER };

export default webSearchService;
