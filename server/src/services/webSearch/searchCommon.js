// ============================================================
// 检索层公共工具（URL 归一化 / 时间解析 / SearchResult 构造）
//
// 说明：架构 §2.1 只列了 webSearchService + 两个 provider 三个文件。
//   本文件是为避免「同一份日期解析逻辑在两个 provider 里各抄一遍」而抽出的
//   纯函数工具模块（无状态、无 IO、无上游依赖），不改变分层结构：
//   provider 负责「拿数据 + 认自家字段」，service 负责「合并 + 判定」，
//   本文件只提供两者共用的字符串/时间原语。
//
// 红线（架构 §7.5）：
//   · 时间解析失败一律返回 null —— **绝不用 Date.now() 顶替**，那等于伪造时效；
//   · 解析不出 published_at 的条目会被 service 丢弃，不参与 LLM 推理。
// ============================================================

/** 一天的毫秒数 */
export const DAY_MS = 24 * 60 * 60 * 1000;

/** 纯数字时间戳（秒 / 毫秒）判定阈值 */
const MS_TIMESTAMP_MIN = 1e12;

/**
 * 尽力把上游各式各样的时间串解析为 ISO 8601 字符串
 *
 * 已覆盖形态：
 *   '2026-08-07'、'2026-08-07 15:04:05'、'2026/08/07 15:04'、
 *   '2026-08-07T15:04:05+08:00'、'20260807'、1754500000（秒）、1754500000000（毫秒）
 *
 * @param {string|number|Date|null|undefined} raw 上游原始时间
 * @returns {string|null} ISO 字符串；无法解析返回 null（调用方须丢弃该条目）
 */
export function toIsoDate(raw) {
  if (raw === null || raw === undefined || raw === '') return null;

  if (raw instanceof Date) {
    return Number.isNaN(raw.getTime()) ? null : raw.toISOString();
  }

  // 纯数字：秒级 / 毫秒级时间戳
  if (typeof raw === 'number' || /^\d{10,13}$/.test(String(raw).trim())) {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return null;
    const ms = n >= MS_TIMESTAMP_MIN ? n : n * 1000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }

  let s = String(raw).trim();
  if (!s) return null;

  // 'YYYYMMDD' → 'YYYY-MM-DD'
  if (/^\d{8}$/.test(s)) {
    s = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  }

  // 'YYYY/MM/DD' → 'YYYY-MM-DD'
  s = s.replace(/\//g, '-');
  // 中文日期 '2026年08月07日'
  s = s.replace(/(\d{4})年(\d{1,2})月(\d{1,2})日/, (_m, y, mo, d) => `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`);

  // 'YYYY-MM-DD HH:mm[:ss]' → 补 'T'，并按东八区解释（东财/智谱均为境内源）
  const cn = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (cn) {
    const [, y, mo, d, hh = '00', mm = '00', ss = '00'] = cn;
    const iso = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`
      + `T${String(hh).padStart(2, '0')}:${mm}:${ss}+08:00`;
    const parsed = new Date(iso);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }

  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * URL 归一化（用于跨源去重）：去协议差异、去 www、去尾斜杠、去常见追踪参数
 * @param {string|null|undefined} url 原始 URL
 * @returns {string} 归一化后的 key；输入非法返回空串
 */
export function normalizeUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  try {
    const u = new URL(raw.startsWith('//') ? `https:${raw}` : raw);
    const host = u.hostname.replace(/^www\./i, '').toLowerCase();
    const dropParams = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'from', 'spm', '_'];
    for (const p of dropParams) u.searchParams.delete(p);
    const query = u.searchParams.toString();
    const path = u.pathname.replace(/\/+$/, '');
    return `${host}${path}${query ? `?${query}` : ''}`;
  } catch (_) {
    // 非法 URL：退化为「小写去空白」，仍可用于粗粒度去重
    return raw.toLowerCase().replace(/\s+/g, '');
  }
}

/**
 * 从 URL 提取站点名（展示用）
 * @param {string|null|undefined} url 原始 URL
 * @returns {string} 主机名；无法解析返回空串
 */
export function siteFromUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  try {
    return new URL(raw).hostname.replace(/^www\./i, '');
  } catch (_) {
    return '';
  }
}

/**
 * 清洗上游文本：剥离高亮标签 / HTML 实体 / 多余空白，并截断
 * @param {string|null|undefined} text 原始文本
 * @param {number} [maxLen=300] 最大长度
 * @returns {string} 清洗后的纯文本
 */
export function cleanText(text, maxLen = 300) {
  let s = String(text ?? '');
  if (!s) return '';
  s = s.replace(/<[^>]+>/g, '');
  s = s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > maxLen ? `${s.slice(0, maxLen)}…` : s;
}

/**
 * 距今天数（保留一位小数）
 * @param {string|null} isoDate ISO 时间串
 * @param {number} [now=Date.now()] 参照时刻（毫秒）
 * @returns {number|null} 天数；isoDate 非法返回 null
 */
export function daysAgo(isoDate, now = Date.now()) {
  if (!isoDate) return null;
  const t = new Date(isoDate).getTime();
  if (Number.isNaN(t)) return null;
  return Math.round(((now - t) / DAY_MS) * 10) / 10;
}

/**
 * 构造标准 SearchResult（字段口径全项目唯一，前后端契约 1:1）
 *
 * @param {object} input 原始字段
 * @param {string} input.title 标题
 * @param {string} input.url 原文链接（必须非空，否则视为不可溯源）
 * @param {string} [input.snippet] 摘要
 * @param {string|number|Date|null} [input.publishedAt] 发布时间（任意形态，内部转 ISO）
 * @param {string} input.providerId 来源提供方 id
 * @param {string} [input.site] 站点名；缺省由 url 推断
 * @param {string} [input.retrievedAt] 检索时间 ISO；缺省取当前时刻
 * @returns {{title:string,url:string,site:string,snippet:string,publishedAt:string|null,retrievedAt:string,providerId:string,stale:boolean}|null}
 *          规范化结果；title 或 url 为空时返回 null（不可溯源的条目直接丢弃）
 */
export function makeSearchResult(input) {
  const title = cleanText(input?.title, 200);
  const url = String(input?.url || '').trim();
  if (!title || !url) return null;
  return {
    title,
    url,
    site: input?.site ? String(input.site) : siteFromUrl(url),
    snippet: cleanText(input?.snippet, 300),
    publishedAt: toIsoDate(input?.publishedAt),
    retrievedAt: input?.retrievedAt || new Date().toISOString(),
    providerId: String(input?.providerId || 'unknown'),
    stale: false, // 由 webSearchService 统一判定后回填
  };
}

/**
 * 带超时的 Promise 包装（单路超时不拖垮并联整体）
 * @template T
 * @param {Promise<T>} promise 原始 Promise
 * @param {number} timeoutMs 超时毫秒
 * @param {string} label 超时错误信息中的标识
 * @returns {Promise<T>} 原 Promise 或超时 reject
 */
export function withTimeout(promise, timeoutMs, label = 'task') {
  if (!timeoutMs || timeoutMs <= 0) return promise;
  let timer = null;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超时（${timeoutMs}ms）`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
