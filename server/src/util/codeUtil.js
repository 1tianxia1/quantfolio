// ============================================================
// 证券代码工具 —— 全链路唯一转换入口（架构 §7.1）
//
// 口径（不得在其它文件重复实现）：
//   前端 / API / DB   : 6 位纯数字裸码，如 000878 / 600009 / 510300
//   东方财富 secid    : {emMarket}.{code}，emMarket 1=SH，0=SZ/BJ
//
// 任何文件禁止自己拼 secid、禁止自己判断市场，一律 import 本模块。
// 红线：非法输入抛 40001（ApiError.validation），绝不静默猜测。
// ============================================================
import { ApiError } from './errors.js';

/** 6 位纯数字代码正则（首版仅支持 A 股 + 场内基金，架构 §6.8 A2） */
export const CODE_RE = /^\d{6}$/;

/** 东财市场编号：上交所 = 1，深交所/北交所 = 0 */
export const EM_MARKET = Object.freeze({ SH: 1, SZ: 0, BJ: 0 });

/**
 * 是否为形如 6 位数字的代码（不抛错版本，供搜索框等弱校验场景）
 * @param {*} input 任意输入
 * @returns {boolean}
 */
export function isValidCode(input) {
  return CODE_RE.test(String(input ?? '').trim());
}

/**
 * 宽松归一化：去空格、去 sh/sz/bj 前后缀与分隔符，返回 6 位裸码；失败返回 null。
 * 支持：'600009'、' sh600009 '、'SH.600009'、'600009.SH'、'sz000878'
 * @param {*} input 任意输入
 * @returns {string|null} 6 位裸码或 null
 */
export function tryNormalizeCode(input) {
  if (input === null || input === undefined) return null;
  let s = String(input).trim();
  if (s === '') return null;
  // 去掉市场前缀：sh600009 / SH.600009 / sh_600009
  s = s.replace(/^(sh|sz|bj)\s*[.\-_:]?\s*/i, '');
  // 去掉市场后缀：600009.SH / 600009_SZ
  s = s.replace(/\s*[.\-_:]\s*(sh|sz|bj)$/i, '');
  // 去掉内部空白
  s = s.replace(/\s+/g, '');
  return CODE_RE.test(s) ? s : null;
}

/**
 * 严格归一化：不合法直接抛 40001（架构 §3.3 错误码约定）
 * @param {*} input 任意输入
 * @returns {string} 6 位裸码
 * @throws {ApiError} 40001 code 非法
 */
export function normalizeCode(input) {
  const code = tryNormalizeCode(input);
  if (!code) {
    throw ApiError.validation(`证券代码非法：${String(input ?? '')}，仅支持 6 位数字（A 股 / 场内基金）`);
  }
  return code;
}

/**
 * 由代码前缀推断市场（SH / SZ / BJ）
 *
 * ⚠️ 本实现从 services/securityResolver.js 原样抽取，行为必须逐字保持一致，
 *    否则存量 seed 数据与新链路会出现市场口径分裂。修改前请先跑对照单测。
 *
 * @param {string} code 6 位裸码
 * @param {string} [type] 证券类型：'stock' | 'fund' | 'index'
 * @returns {'SH'|'SZ'|'BJ'} 市场标签
 */
export function marketFromCode(code, type) {
  if (type === 'index') return /^000/.test(code) ? 'SH' : 'SZ';
  if (/^[569]/.test(code) || /^900/.test(code) || /^688|^601|^603|^600|^604|^605|^689/.test(code)) return 'SH';
  if (/^[84]/.test(code) || /^920/.test(code)) return 'BJ';
  return 'SZ';
}

/**
 * 市场标签 → 东财市场编号
 * @param {string} market 'SH' | 'SZ' | 'BJ'
 * @returns {number} 1（沪）或 0（深/北）
 */
export function emMarketFromMarket(market) {
  const key = String(market || '').toUpperCase();
  return EM_MARKET[key] ?? EM_MARKET.SZ;
}

/**
 * 由代码直接推断东财市场编号
 * @param {string} code 6 位裸码
 * @param {string} [type] 证券类型
 * @returns {number} 1（沪）或 0（深/北）
 */
export function emMarketFromCode(code, type) {
  return emMarketFromMarket(marketFromCode(code, type));
}

/**
 * 构造东方财富 secid（全项目唯一入口）
 * @param {string} input 6 位裸码（允许带 sh/sz 前缀，内部会归一化）
 * @param {string} [market] 已知市场标签（'SH'|'SZ'|'BJ'），优先于代码推断
 * @param {string} [type] 证券类型（market 缺省时参与推断）
 * @returns {string} 形如 '1.600009' / '0.000878'
 * @throws {ApiError} 40001 code 非法
 */
export function toSecid(input, market, type) {
  const code = normalizeCode(input);
  const em = market ? emMarketFromMarket(market) : emMarketFromCode(code, type);
  return `${em}.${code}`;
}

/**
 * 解析 secid 回裸码与市场
 * @param {string} secid 形如 '1.600009'
 * @returns {{ emMarket: number, code: string, market: string }|null} 解析结果，非法返回 null
 */
export function parseSecid(secid) {
  const m = /^([01])\.(\d{6})$/.exec(String(secid ?? '').trim());
  if (!m) return null;
  const emMarket = Number(m[1]);
  const code = m[2];
  // emMarket=0 覆盖深/北两市，回推时以代码前缀区分，保证与 marketFromCode 同口径
  const market = emMarket === 1 ? 'SH' : marketFromCode(code, 'stock');
  return { emMarket, code, market };
}

/**
 * 是否为「场内」基金代码（ETF / LOF / 封闭式，与股票同源 secid）
 *
 * 覆盖范围（架构 §6.8 A1 首版口径）：
 *   沪市：50xxxx（LOF/封闭）、51xxxx / 52xxxx（ETF）、56xxxx / 58xxxx（科创及跨市场 ETF）
 *   深市：15xxxx / 16xxxx / 18xxxx（ETF / LOF / 封闭）
 *
 * ⚠️ 场外开放式基金（净值走 fund.eastmoney.com 另一套接口）不在首版范围，
 *    其代码与股票代码空间重叠，无法由 6 位数字可靠区分，故不做猜测。
 *
 * @param {string} input 6 位裸码
 * @returns {boolean}
 */
export function isFundCode(input) {
  const code = tryNormalizeCode(input);
  if (!code) return false;
  return /^(50|51|52|56|58|15|16|18)/.test(code);
}

/**
 * 是否为沪深京 **A 股** 代码
 *
 * 沪市：60xxxx（主板）、688xxx / 689xxx（科创板）
 * 深市：000/001（主板）、002/003（原中小板）、300/301（创业板）
 * 北交所：43xxxx / 83xxxx / 87xxxx / 920xxx
 *
 * @param {string} input 6 位裸码
 * @returns {boolean}
 */
export function isAShareStockCode(input) {
  const code = tryNormalizeCode(input);
  if (!code) return false;
  return /^(60|688|689|000|001|002|003|300|301|43|83|87|920)/.test(code);
}

/**
 * 是否为债券代码（国债 / 地方债 / 企业债 / 可转债 / 回购等）
 *
 * ⚠️ 存在意义：`guessType` 早期实现是「不是基金就是股票」，导致东财返回的
 *    3 万余只债券代码被写成 type='stock'，把 screener 的股票池从 5.5K 撑到
 *    36.7K，漏斗第一步即产生 3 万条「数据缺失」淘汰记录。
 *
 * 沪市债券：01xxxx~02xxxx（国债/地方债）、10xxxx~13xxxx、11xxxx(可转债)、
 *          15xxxx~19xxxx（企业债/私募债，与深市基金码空间不重叠因交易所不同）
 * 深市债券：10xxxx~12xxxx（可转债 128/127/123 等）、2xxxxx（深市各类债券）
 *
 * @param {string} input 6 位裸码
 * @returns {boolean}
 */
export function isBondCode(input) {
  const code = tryNormalizeCode(input);
  if (!code) return false;
  if (isAShareStockCode(code)) return false; // A 股优先，避免误伤
  if (isFundCode(code)) return false;        // 基金优先
  // 1xxxxx / 2xxxxx 且非 A 股非基金 → 债券空间
  return /^[12]/.test(code);
}

/**
 * 由代码推断证券类型（仅用于本地缺省兜底，东财返回名称时以东财为准）
 *
 * 返回 null 表示「既不是 A 股也不是场内基金」（多为债券/回购），
 * 调用方应据此**拒绝入库**，而不是兜底成 'stock' 污染股票池。
 *
 * @param {string} input 6 位裸码
 * @returns {'stock'|'fund'|null} 证券类型；无法归类时为 null
 */
export function guessType(input) {
  if (isFundCode(input)) return 'fund';
  if (isAShareStockCode(input)) return 'stock';
  return null;
}

/**
 * 批量归一化：过滤非法项并去重，保持输入顺序
 * @param {Array<*>} list 任意代码数组
 * @returns {string[]} 合法且去重后的 6 位裸码数组
 */
export function normalizeCodes(list) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(list) ? list : []) {
    const code = tryNormalizeCode(item);
    if (code && !seen.has(code)) {
      seen.add(code);
      out.push(code);
    }
  }
  return out;
}
