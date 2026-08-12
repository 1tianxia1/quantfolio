// ============================================================
// 场外基金净值获取（天天基金 FundMNFInfo 接口，免 KEY）
//
// 用途：quantfolio 的 daily_quotes 只覆盖场内证券（A股 + 场内 ETF，
//       由东方财富同步）。场外基金（联接/LOF/货币基金等）不在交易所交易，
//       无日 K 线，需单独从天天基金取「单位净值 + 当日涨跌」。
//
// 口径：
//   · 现价（current_price）= 最新单位净值 NAV
//   · 昨收（pre_nav）       = NAV / (1 + NAVCHGRT/100) 反推
//   · 当日盈亏率            = NAVCHGRT（基金净值日涨跌幅）
//   · 休息日/盘中：接口天然返回最近一个披露日的净值，无需本地回退
//   · 盘中估值 GSZ 存在时优先作为「现价」，昨收取官方净值（更贴近当日盈亏）
// ============================================================
import { tryNormalizeCode } from '../util/codeUtil.js';

const FUND_HOST = 'https://fundmobapi.eastmoney.com';
const REQUEST_TIMEOUT_MS = 8000;

/**
 * 宽松地把接口返回值转成有限数字（'-' / 空串 → NaN）。
 */
function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : Number.NaN;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '' || trimmed === '-') return Number.NaN;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : Number.NaN;
  }
  return Number.NaN;
}

/**
 * 带超时控制的 JSON 请求。
 */
async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json, text/plain, */*' },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 标准化基金名称用于匹配（去空格、统一半角、转小写）。
 */
function normalizeFundName(name) {
  return String(name || '')
    .replace(/[\s\u3000]+/g, '')
    .replace(/[ＡＢＣ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .toLowerCase();
}

/**
 * 取名称末尾的份额后缀（a/b/c），没有则返回空串。
 */
function shareClassSuffix(name) {
  const m = String(name || '').trim().match(/([ABCabc])[\s\u3000]*$/);
  return m ? m[1].toLowerCase() : '';
}

/**
 * 按名称搜索场外基金代码（天天基金搜索建议接口）。
 * @param {string} keyword 基金名称（可包含 A/C 份额后缀）
 * @returns {Promise<{code:string,name:string}|null>} 最佳匹配结果；无匹配返回 null
 */
export async function searchFundByName(keyword) {
  if (!keyword || typeof keyword !== 'string') return null;
  const key = keyword.trim();
  if (!key) return null;

  try {
    const url = `https://fundsuggest.eastmoney.com/FundSearch/api/FundSearchAPI.ashx?m=1&key=${encodeURIComponent(key)}&_=${Date.now()}`;
    const payload = await fetchJson(url);
    const items = Array.isArray(payload?.Datas) ? payload.Datas : [];
    if (items.length === 0) return null;

    const keyNorm = normalizeFundName(key);
    const keySuffix = shareClassSuffix(key);

    // 评分：名称完全匹配 > 同份额后缀且包含关键词 > 仅包含关键词 > 其他
    const scored = items
      .filter((it) => typeof it.CODE === 'string' && it.CODE)
      .map((it) => {
        const name = typeof it.NAME === 'string' ? it.NAME : key;
        const nameNorm = normalizeFundName(name);
        const suffix = shareClassSuffix(name);
        let score = 0;
        if (nameNorm === keyNorm) score += 1000;
        if (keySuffix && suffix === keySuffix) score += 100;
        if (nameNorm.includes(keyNorm)) score += 50;
        if (keyNorm.includes(nameNorm)) score += 30;
        if (nameNorm.replace(/[abc]$/, '').includes(keyNorm.replace(/[abc]$/, ''))) score += 20;
        return { code: it.CODE, name, score };
      })
      .sort((a, b) => b.score - a.score);

    const pick = scored[0];
    if (!pick) return null;
    return { code: pick.code, name: pick.name };
  } catch (e) {
    console.warn('[tiantianFund] searchFundByName failed:', e.message);
    return null;
  }
}

/**
 * 拉取场外基金最新净值。
 * @param {string[]} codes 6 位基金代码数组
 * @returns {Promise<Array<{code:string,name:string,nav:number,pre_nav:number,nav_chg_pct:number,nav_date:string,is_estimate:boolean}>>}
 */
export async function fetchFundNav(codes) {
  const list = (codes || []).map(tryNormalizeCode).filter(Boolean);
  if (list.length === 0) return [];

  const url =
    `${FUND_HOST}/FundMNewApi/FundMNFInfo?pageIndex=1&pageSize=${list.length}` +
    `&plat=Android&appType=ttjj&product=EFund&Version=1&deviceid=quantfolio` +
    `&Fcodes=${encodeURIComponent(list.join(','))}&_=${Date.now()}`;

  const payload = await fetchJson(url);
  const items = Array.isArray(payload?.Datas) ? payload.Datas : [];
  const out = [];

  for (const it of items) {
    const code = typeof it.FCODE === 'string' ? it.FCODE : '';
    const nav = toNumber(it.NAV);
    if (!code || !Number.isFinite(nav) || nav <= 0) continue;

    const chgPct = toNumber(it.NAVCHGRT);
    const changePct = Number.isFinite(chgPct) ? chgPct : 0;

    // 拒绝疑似占位/错误数据：净值恰好 1.00 且无涨跌，多半是接口默认值。
    if (nav === 1 && changePct === 0) continue;

    // 昨收（官方净值口径）：由当日涨跌幅反推
    const denom = 1 + changePct / 100;
    const prevNav = denom > 0 ? nav / denom : nav;

    // 盘中估值优先（仅交易日盘中有效），作为「现价」，昨收取官方净值
    const est = toNumber(it.GSZ);
    const estPct = toNumber(it.GSZZL);
    const useEst = Number.isFinite(est) && est > 0 && Number.isFinite(estPct);

    const today = new Date().toISOString().slice(0, 10);
    out.push({
      code,
      name: typeof it.SHORTNAME === 'string' ? it.SHORTNAME : code,
      nav: useEst ? est : nav,
      pre_nav: useEst ? nav : prevNav,
      nav_chg_pct: useEst ? estPct : changePct,
      nav_date: useEst ? today : (typeof it.PDATE === 'string' && it.PDATE ? it.PDATE : today),
      is_estimate: useEst,
    });
  }

  return out;
}
