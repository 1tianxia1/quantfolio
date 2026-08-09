// ============================================================
// 检索路 2（常驻兜底）：东方财富新闻 / 公告 / 研报（架构 §6.2）
//
// 为什么它是「常驻」而非「备用」：
//   用户可能把 BYOK 模型切成任何一家（路 1 随之失效），
//   但金融场景不能因此没有实时情报 —— 本路免 KEY、免注册、金融相关性最高，
//   因此**每次检索都执行**，是模块 A 不失能的最后一道保障。
//
// 三个子源（全部复用 emClient 的三道闸：限频 / 缓存 / 熔断）：
//   ① newsSearch     全站资讯关键词搜索（JSONP，emClient 已支持剥壳）
//   ② stockAnnounce  个股公告（有 code 时才打）
//   ③ researchReport 券商研报（有 code 时才打）
//
// 红线：任何子源失败都只是少几条结果，绝不抛异常；时间字段解析不出就留 null。
// ============================================================
import env from '../../config/env.js';
import { emClient } from '../../providers/emClient.js';
import { tryNormalizeCode } from '../../util/codeUtil.js';
import { SEARCH_PROVIDER } from '../../../../shared/constants.js';
import { makeSearchResult } from './searchCommon.js';

/** 东财资讯详情页基址（拼 URL 用，仅此处出现） */
const EM_WEB = Object.freeze({
  NOTICE_DETAIL: 'https://data.eastmoney.com/notices/detail',
  REPORT_DETAIL: 'https://data.eastmoney.com/report/zw_stock.jshtml',
});

/**
 * 组装东财资讯搜索的 param 串（东财要求整个查询是一个 JSON 字符串）
 * @param {string} keyword 关键词
 * @param {number} pageSize 条数
 * @returns {string} JSON 串
 */
function buildSearchParam(keyword, pageSize) {
  return JSON.stringify({
    uid: '',
    keyword,
    type: ['cmsArticleWebOld'],
    client: 'web',
    clientType: 'web',
    clientVersion: 'curr',
    param: {
      cmsArticleWebOld: {
        searchScope: 'default',
        sort: 'default',
        pageIndex: 1,
        pageSize,
        preTag: '',
        postTag: '',
      },
    },
  });
}

/**
 * 创建东财资讯提供方
 * @param {object} [options] 覆盖配置
 * @param {object} [options.client] emClient 实例（自测可注入桩）
 * @param {number} [options.ttlMs] 缓存 TTL
 * @returns {object} SearchProvider 实例
 */
export function createEmNewsProvider(options = {}) {
  const client = options.client || emClient;
  const ttlMs = Number(options.ttlMs ?? env.EM_NEWS_TTL_MS) || 180000;

  /**
   * 子源 ①：全站资讯关键词搜索
   * @param {string} keyword 关键词
   * @param {number} pageSize 条数
   * @param {string} retrievedAt 检索时间
   * @returns {Promise<object[]>} SearchResult 数组
   */
  async function queryNews(keyword, pageSize, retrievedAt) {
    const json = await client.fetchEndpoint(
      'newsSearch',
      { param: buildSearchParam(keyword, pageSize) },
      { ttlMs, cacheKey: `emnews:search:${keyword}:${pageSize}` },
    );
    const list = json?.result?.cmsArticleWebOld;
    if (!Array.isArray(list)) return [];
    return list
      .map((item) => makeSearchResult({
        title: item?.title,
        url: item?.url,
        snippet: item?.content,
        publishedAt: item?.date || item?.showTime || item?.publishTime,
        site: item?.mediaName || '东方财富',
        providerId: SEARCH_PROVIDER.EASTMONEY,
        retrievedAt,
      }))
      .filter(Boolean);
  }

  /**
   * 子源 ②：个股公告
   * @param {string} code 6 位裸码
   * @param {number} pageSize 条数
   * @param {string} retrievedAt 检索时间
   * @returns {Promise<object[]>} SearchResult 数组
   */
  async function queryAnnouncements(code, pageSize, retrievedAt) {
    const json = await client.fetchEndpoint(
      'stockAnnounce',
      { stock_list: code, page_size: pageSize },
      { ttlMs, cacheKey: `emnews:ann:${code}:${pageSize}` },
    );
    const list = json?.data?.list;
    if (!Array.isArray(list)) return [];
    return list
      .map((item) => {
        const artCode = item?.art_code;
        if (!artCode) return null;
        const column = Array.isArray(item?.columns) && item.columns.length
          ? item.columns[0]?.column_name
          : '';
        return makeSearchResult({
          title: column ? `[${column}] ${item?.title || ''}` : item?.title,
          url: `${EM_WEB.NOTICE_DETAIL}/${code}/${artCode}.html`,
          snippet: item?.title,
          publishedAt: item?.notice_date || item?.display_time || item?.eiTime,
          site: '东方财富·公告',
          providerId: SEARCH_PROVIDER.EASTMONEY,
          retrievedAt,
        });
      })
      .filter(Boolean);
  }

  /**
   * 子源 ③：券商研报
   * @param {string} code 6 位裸码
   * @param {number} pageSize 条数
   * @param {string} retrievedAt 检索时间
   * @returns {Promise<object[]>} SearchResult 数组
   */
  async function queryReports(code, pageSize, retrievedAt) {
    const json = await client.fetchEndpoint(
      'researchReport',
      { code, pageSize, pageNo: 1 },
      { ttlMs, cacheKey: `emnews:report:${code}:${pageSize}` },
    );
    const list = Array.isArray(json?.data) ? json.data : [];
    return list
      .map((item) => {
        const infoCode = item?.infoCode;
        if (!infoCode) return null;
        const org = item?.orgSName || item?.orgName || '';
        const rating = item?.sRatingName ? `｜评级：${item.sRatingName}` : '';
        return makeSearchResult({
          title: `[研报] ${item?.title || ''}`,
          url: `${EM_WEB.REPORT_DETAIL}?infocode=${encodeURIComponent(infoCode)}`,
          snippet: `${org}${rating}`,
          publishedAt: item?.publishDate || item?.notice_date,
          site: org ? `研报·${org}` : '东方财富·研报',
          providerId: SEARCH_PROVIDER.EASTMONEY,
          retrievedAt,
        });
      })
      .filter(Boolean);
  }

  /**
   * 常驻可用：只要没被全局关掉就参与并联
   * @returns {boolean} 可用性
   */
  function isAvailable() {
    return String(env.WEB_SEARCH_ENABLED).toLowerCase() !== 'false';
  }

  /**
   * 执行检索
   * @param {string} q 查询词（可为公司名 / 关键词组合）
   * @param {object} [opts] 选项
   * @param {string} [opts.code] 标的代码；给了就额外拉公告与研报
   * @param {number} [opts.topK=8] 期望总条数
   * @param {string} [opts.retrievedAt] 检索时间 ISO
   * @returns {Promise<{results: object[], error: string|null}>} 结果与失败原因
   */
  async function query(q, opts = {}) {
    const retrievedAt = opts.retrievedAt || new Date().toISOString();
    const topK = Number(opts.topK) || Number(env.WEB_SEARCH_TOPK) || 8;
    const code = tryNormalizeCode(opts.code || '');
    const keyword = String(q || '').trim() || code || '';

    if (!isAvailable()) return { results: [], error: '联网检索已全局关闭' };
    if (!keyword) return { results: [], error: '查询词为空' };

    const tasks = [queryNews(keyword, topK, retrievedAt)];
    if (code) {
      tasks.push(queryAnnouncements(code, Math.max(3, Math.ceil(topK / 2)), retrievedAt));
      tasks.push(queryReports(code, Math.max(3, Math.ceil(topK / 2)), retrievedAt));
    }

    const settled = await Promise.allSettled(tasks);
    const results = [];
    const errors = [];
    for (const r of settled) {
      if (r.status === 'fulfilled') results.push(...r.value);
      else errors.push(String(r.reason?.message || r.reason));
    }

    if (!results.length) {
      const detail = errors.length ? errors.join('；') : '上游无数据（可能被风控或网络不可达）';
      return { results: [], error: detail };
    }
    return { results, error: null };
  }

  /**
   * 按代码检索（语义化入口，等价于 query(name, { code })）
   * @param {string} code 6 位裸码
   * @param {object} [opts] 同 query
   * @returns {Promise<{results: object[], error: string|null}>} 结果
   */
  function byCode(code, opts = {}) {
    return query(opts.keyword || code, { ...opts, code });
  }

  return {
    id: SEARCH_PROVIDER.EASTMONEY,
    label: '东方财富财经信源',
    /** 常驻性：true 表示每次检索都参与（免 KEY 兜底） */
    alwaysOn: true,
    isAvailable,
    query,
    byCode,
  };
}

/** 进程级单例 */
export const emNewsProvider = createEmNewsProvider();

export default emNewsProvider;
