// ============================================================
// 东方财富公开接口「端点 + 字段」常量表（架构 §6.1）
//
// 设计红线：**一处改、全局生效**。
//   任何东财 URL、query 参数、f 字段号，只允许出现在本文件。
//   emClient / eastmoneyProvider / quoteSyncService / probe 脚本
//   一律从这里取值，禁止在别处硬编码字符串 'push2.eastmoney.com' 或 'f43'。
//
// 校准方式：`node scripts/probe-eastmoney.mjs`
//   探针会逐个打端点、打印真实响应的字段映射与耗时。
//   若东财改版导致字段错位，只需回来改本文件的 *_FIELD_MAP。
//
// 免 KEY 说明：以下均为东财前端公开行情接口，无需注册、无需 token；
//   ut 参数是其前端固定的公开串，不含任何个人身份信息。
// ============================================================

/** 东财主机（行情实时 / 行情历史 / 资讯检索） */
export const EM_HOST = Object.freeze({
  /** 实时快照、列表、板块（实时，但部分出口 IP 会被东财风控 502） */
  PUSH2: 'https://push2.eastmoney.com',
  /** 延迟行情镜像（约 15 分钟延迟，数据结构与 push2 完全一致；本网络实测可用） */
  PUSH2_DELAY: 'http://push2delay.eastmoney.com',
  /** 历史 K 线、历史资金流（部分出口 IP 会被风控，emClient 内置腾讯 K 线兜底） */
  PUSH2HIS: 'https://push2his.eastmoney.com',
  /** 腾讯公开 K 线接口（免 KEY，A 股/场内基金，前复权；push2his 被风控时的真实数据兜底） */
  TENCENT_KLINE: 'https://web.ifzq.gtimg.cn',
  /** 全站资讯搜索（JSONP，需剥壳） */
  SEARCH: 'https://search-api-web.eastmoney.com',
  /** 个股公告列表 */
  ANNOUNCE: 'https://np-anotice-stock.eastmoney.com',
  /** 券商研报列表 */
  REPORT: 'https://reportapi.eastmoney.com',
});

/** 东财前端公开固定串（非密钥，不含身份信息） */
export const EM_UT = 'fa5fd1943c7b386f172d6893dbfba10b';

// ------------------------------------------------------------
// 行情主机选择（实时 push2 vs 延迟镜像 push2delay）
//
// 背景：quote/quotes/clist 原先固定走 push2delay（约 15 分钟延迟），
//   集合竞价（9:15–9:25）时段完全拿不到竞价数据，盘中实时性也先天不足。
//   push2 实时源在部分出口 IP（如腾讯云）会被风控拦截，故做成运行时可切换：
//     · setQuoteHost(EM_HOST.PUSH2)       切实时（探测可达后由 emClient 自动调用）
//     · setQuoteHost(EM_HOST.PUSH2_DELAY) 切回延迟镜像（默认值）
//   端点定义用 getter 引用当前值，保证「一处改、全局生效」。
// ------------------------------------------------------------
let quoteHost = EM_HOST.PUSH2_DELAY;

/** 当前行情主机（实时/延迟镜像） */
export function getQuoteHost() {
  return quoteHost;
}

/** 切换行情主机（仅接受 PUSH2 / PUSH2_DELAY 两个合法值） */
export function setQuoteHost(host) {
  if (host === EM_HOST.PUSH2 || host === EM_HOST.PUSH2_DELAY) {
    quoteHost = host;
  }
}

/** 请求头：伪装成普通浏览器访问，附 Referer 避免被风控直接拒绝 */
export const EM_HEADERS = Object.freeze({
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) '
    + 'Chrome/122.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'zh-CN,zh;q=0.9',
  Referer: 'https://quote.eastmoney.com/',
});

// ------------------------------------------------------------
// 枚举
// ------------------------------------------------------------

/** K 线周期（klt） */
export const KLT = Object.freeze({
  MIN1: 1, MIN5: 5, MIN15: 15, MIN30: 30, MIN60: 60,
  DAY: 101, WEEK: 102, MONTH: 103,
});

/** 复权方式（fqt）：0 不复权 / 1 前复权 / 2 后复权 */
export const FQT = Object.freeze({ NONE: 0, QFQ: 1, HFQ: 2 });

/** 单次 K 线请求条数硬上限（P2 回测需要 10 年 ≈ 2430 根，取整 2500） */
export const KLINE_MAX_LIMIT = 2500;

/** ulist.np 单次批量 secid 上限（超出需分批，实测 >60 易被截断） */
export const BATCH_SECID_LIMIT = 50;

// ------------------------------------------------------------
// 字段映射表
//   key      : 项目内部统一字段名
//   unit     : 东财返回值的原始单位（供换算参考，不参与解析）
//   scale    : 解析时的乘数（如 1e-8 表示「元 → 亿元」），缺省 1
//   text     : true 表示按字符串处理（不做数值转换）
// ------------------------------------------------------------

/** 单标的快照 push2/api/qt/stock/get 的字段映射（fltt=2 时价格已带小数） */
export const QUOTE_FIELD_MAP = Object.freeze({
  f43: { key: 'close', unit: '元' },
  f44: { key: 'high', unit: '元' },
  f45: { key: 'low', unit: '元' },
  f46: { key: 'open', unit: '元' },
  f47: { key: 'volume', unit: '手' },
  f48: { key: 'amount', unit: '元' },
  f50: { key: 'volume_ratio', unit: '倍' },
  f51: { key: 'limit_up_price', unit: '元' },
  f52: { key: 'limit_down_price', unit: '元' },
  f57: { key: 'code', text: true },
  f58: { key: 'name', text: true },
  f60: { key: 'pre_close', unit: '元' },
  f86: { key: 'ts', unit: '秒' },
  f107: { key: 'em_market', unit: '枚举' },
  f116: { key: 'total_mv', unit: '元', scale: 1e-8 },
  f117: { key: 'circ_mv', unit: '元', scale: 1e-8 },
  f162: { key: 'pe_ttm', unit: '倍' },
  f167: { key: 'pb', unit: '倍' },
  f168: { key: 'turnover_rate', unit: '%' },
  f169: { key: 'change', unit: '元' },
  f170: { key: 'pct_chg', unit: '%' },
  f171: { key: 'amplitude', unit: '%' },
});

/**
 * 列表型接口字段映射（clist/get 与 ulist.np/get 共用同一套 f 编号）
 * ⚠️ 注意与 QUOTE_FIELD_MAP 编号体系**完全不同**，切勿混用。
 */
export const LIST_FIELD_MAP = Object.freeze({
  f2: { key: 'close', unit: '元' },
  f3: { key: 'pct_chg', unit: '%' },
  f4: { key: 'change', unit: '元' },
  f5: { key: 'volume', unit: '手' },
  f6: { key: 'amount', unit: '元' },
  f7: { key: 'amplitude', unit: '%' },
  f8: { key: 'turnover_rate', unit: '%' },
  f9: { key: 'pe_ttm', unit: '倍' },
  f10: { key: 'volume_ratio', unit: '倍' },
  f12: { key: 'code', text: true },
  f13: { key: 'em_market', unit: '枚举' },
  f14: { key: 'name', text: true },
  f15: { key: 'high', unit: '元' },
  f16: { key: 'low', unit: '元' },
  f17: { key: 'open', unit: '元' },
  f18: { key: 'pre_close', unit: '元' },
  f20: { key: 'total_mv', unit: '元', scale: 1e-8 },
  f21: { key: 'circ_mv', unit: '元', scale: 1e-8 },
  f23: { key: 'pb', unit: '倍' },
  f26: { key: 'list_date', text: true },
  f100: { key: 'industry', text: true },
  f124: { key: 'ts', unit: '秒' },
});

/** 板块列表（m:90）字段映射：板块代码为 BKxxxx，非 6 位裸码，单独一套 */
export const SECTOR_FIELD_MAP = Object.freeze({
  f12: { key: 'sector_code', text: true },
  f14: { key: 'sector_name', text: true },
  f2: { key: 'index_price', unit: '点' },
  f3: { key: 'pct_chg', unit: '%' },
  f6: { key: 'amount', unit: '元' },
  f20: { key: 'total_mv', unit: '元', scale: 1e-8 },
  f62: { key: 'main_net_inflow', unit: '元', scale: 1e-4 },
  f104: { key: 'up_count', unit: '家' },
  f105: { key: 'down_count', unit: '家' },
  f128: { key: 'leading_stock', text: true },
  f136: { key: 'leading_stock_pct', unit: '%' },
  f140: { key: 'leading_stock_code', text: true },
});

/**
 * 日 K 线 klines 数组的**顺序映射**。
 * 东财返回形如 "2024-01-02,10.00,10.20,10.30,9.90,123456,1.23e8,4.00,2.00,0.20,1.50"，
 * 顺序严格等于请求参数 fields2 的顺序 —— 因此 fields2 由本数组生成，天然不会错位。
 */
export const KLINE_FIELDS = Object.freeze([
  { em: 'f51', key: 'date', text: true },
  { em: 'f52', key: 'open', unit: '元' },
  { em: 'f53', key: 'close', unit: '元' },
  { em: 'f54', key: 'high', unit: '元' },
  { em: 'f55', key: 'low', unit: '元' },
  { em: 'f56', key: 'volume', unit: '手' },
  { em: 'f57', key: 'amount', unit: '元' },
  { em: 'f58', key: 'amplitude', unit: '%' },
  { em: 'f59', key: 'pct_chg', unit: '%' },
  { em: 'f60', key: 'change', unit: '元' },
  { em: 'f61', key: 'turnover_rate', unit: '%' },
]);

/** 历史资金流 klines 的顺序映射（金额单位：元） */
export const FFLOW_FIELDS = Object.freeze([
  { em: 'f51', key: 'date', text: true },
  { em: 'f52', key: 'main_net_inflow', unit: '元' },
  { em: 'f53', key: 'small_net_inflow', unit: '元' },
  { em: 'f54', key: 'medium_net_inflow', unit: '元' },
  { em: 'f55', key: 'large_net_inflow', unit: '元' },
  { em: 'f56', key: 'super_net_inflow', unit: '元' },
  { em: 'f57', key: 'main_net_pct', unit: '%' },
  { em: 'f58', key: 'small_net_pct', unit: '%' },
  { em: 'f59', key: 'medium_net_pct', unit: '%' },
  { em: 'f60', key: 'large_net_pct', unit: '%' },
  { em: 'f61', key: 'super_net_pct', unit: '%' },
  { em: 'f62', key: 'close', unit: '元' },
  { em: 'f63', key: 'pct_chg', unit: '%' },
]);

/** 由字段映射生成 fields 查询串（保证请求字段与解析字段永远同源） */
function fieldsOf(map) {
  return Object.keys(map).join(',');
}

/** 由顺序映射生成 fields2 查询串 */
function orderedFieldsOf(list) {
  return list.map((f) => f.em).join(',');
}

// ------------------------------------------------------------
// clist 的 fs（选股范围）常量：东财自己的市场筛选 DSL
// ------------------------------------------------------------
export const CLIST_FS = Object.freeze({
  /** 沪深京 A 股（深主板+创业板 / 沪主板+科创板 / 北交所） */
  A_SHARE: 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048',
  /** 仅沪深 A 股（不含北交所） */
  A_SHARE_SH_SZ: 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23',
  /** 场内基金：ETF + LOF */
  FUND_ETF: 'b:MK0021,b:MK0022,b:MK0023,b:MK0024',
  /** 行业板块 */
  SECTOR_INDUSTRY: 'm:90+t:2+f:!50',
  /** 概念板块 */
  SECTOR_CONCEPT: 'm:90+t:3+f:!50',
  /** 地域板块 */
  SECTOR_REGION: 'm:90+t:1+f:!50',
});

// ------------------------------------------------------------
// 端点定义
//   host      : EM_HOST 中的主机
//   path      : 路径
//   defaults  : 固定 query（会被调用方 params 覆盖）
//   fieldMap  : 该端点的字段映射（供解析器使用）
//   rateKey   : 限频器的端点子桶键
// ------------------------------------------------------------
export const emEndpoints = Object.freeze({
  /** 单标的实时快照（host 由 getQuoteHost() 动态决定：push2 实时 / push2delay 延迟镜像） */
  quote: Object.freeze({
    name: 'quote',
    get host() { return getQuoteHost(); },
    path: '/api/qt/stock/get',
    rateKey: 'stock.get',
    fieldMap: QUOTE_FIELD_MAP,
    defaults: Object.freeze({
      ut: EM_UT,
      invt: 2,
      fltt: 2,
      fields: fieldsOf(QUOTE_FIELD_MAP),
    }),
  }),

  /** 批量实时快照（secids 逗号分隔，单次 ≤ BATCH_SECID_LIMIT） */
  quotes: Object.freeze({
    name: 'quotes',
    get host() { return getQuoteHost(); },
    path: '/api/qt/ulist.np/get',
    rateKey: 'ulist.np',
    fieldMap: LIST_FIELD_MAP,
    defaults: Object.freeze({
      ut: EM_UT,
      invt: 2,
      fltt: 2,
      fields: fieldsOf(LIST_FIELD_MAP),
    }),
  }),

  /** 历史日/周/月 K 线（push2his 被风控时 emClient 自动走腾讯 klineTencent 兜底） */
  kline: Object.freeze({
    name: 'kline',
    host: EM_HOST.PUSH2HIS,
    path: '/api/qt/stock/kline/get',
    rateKey: 'kline.get',
    orderedFields: KLINE_FIELDS,
    defaults: Object.freeze({
      ut: EM_UT,
      klt: KLT.DAY,
      fqt: FQT.QFQ,
      beg: 0,
      end: 20500101,
      fields1: 'f1,f2,f3,f4,f5,f6',
      fields2: orderedFieldsOf(KLINE_FIELDS),
    }),
  }),

  /** 腾讯 K 线兜底（push2his 不可达时使用；param 风格与东财不同，走 emClient 专用解析） */
  klineTencent: Object.freeze({
    name: 'klineTencent',
    host: EM_HOST.TENCENT_KLINE,
    path: '/appstock/app/fqkline/get',
    rateKey: 'kline.get',
  }),

  /** 全市场/板块成分列表（分页） */
  clist: Object.freeze({
    name: 'clist',
    get host() { return getQuoteHost(); },
    path: '/api/qt/clist/get',
    rateKey: 'clist.get',
    fieldMap: LIST_FIELD_MAP,
    defaults: Object.freeze({
      ut: EM_UT,
      pn: 1,
      pz: 100,
      po: 1,
      np: 1,
      invt: 2,
      fltt: 2,
      fid: 'f3',
      fs: CLIST_FS.A_SHARE,
      fields: fieldsOf(LIST_FIELD_MAP),
    }),
  }),

  /** 板块列表（行业 / 概念 / 地域），与 clist 同路径但字段体系不同 */
  sectorList: Object.freeze({
    name: 'sectorList',
    host: EM_HOST.PUSH2_DELAY,
    path: '/api/qt/clist/get',
    rateKey: 'clist.get',
    fieldMap: SECTOR_FIELD_MAP,
    defaults: Object.freeze({
      ut: EM_UT,
      pn: 1,
      pz: 100,
      po: 1,
      np: 1,
      invt: 2,
      fltt: 2,
      fid: 'f3',
      fs: CLIST_FS.SECTOR_INDUSTRY,
      fields: fieldsOf(SECTOR_FIELD_MAP),
    }),
  }),

  /** 个股历史资金流（日频） */
  fflow: Object.freeze({
    name: 'fflow',
    host: EM_HOST.PUSH2HIS,
    path: '/api/qt/stock/fflow/daykline/get',
    rateKey: 'fflow.daykline',
    orderedFields: FFLOW_FIELDS,
    defaults: Object.freeze({
      ut: EM_UT,
      klt: KLT.DAY,
      lmt: 0,
      fields1: 'f1,f2,f3,f7',
      fields2: orderedFieldsOf(FFLOW_FIELDS),
    }),
  }),

  // ----------------------------------------------------------
  // 资讯类端点（T02 联网检索兜底路，架构 §6.2 路 2）
  // 三者均为东财公开前端接口，免 KEY；返回体自带发布时间。
  // ----------------------------------------------------------

  /**
   * 全站资讯关键词搜索（JSONP：必须带 cb，响应形如 `cb({...})`，由 emClient 剥壳）
   * 复杂 query 走 `param` 这一 JSON 串，由 emNewsProvider 组装后传入。
   */
  newsSearch: Object.freeze({
    name: 'newsSearch',
    host: EM_HOST.SEARCH,
    path: '/search/jsonp',
    rateKey: 'search.jsonp',
    jsonp: true,
    defaults: Object.freeze({ cb: 'quantfolio' }),
  }),

  /** 个股公告列表（JSON） */
  stockAnnounce: Object.freeze({
    name: 'stockAnnounce',
    host: EM_HOST.ANNOUNCE,
    path: '/api/security/ann',
    rateKey: 'security.ann',
    defaults: Object.freeze({
      sr: -1,
      page_size: 20,
      page_index: 1,
      ann_type: 'A',
      client_source: 'web',
      f_node: 0,
      s_node: 0,
    }),
  }),

  /** 券商研报列表（JSON；qType=0 个股研报） */
  researchReport: Object.freeze({
    name: 'researchReport',
    host: EM_HOST.REPORT,
    path: '/report/list',
    rateKey: 'report.list',
    defaults: Object.freeze({
      industryCode: '*',
      pageSize: 20,
      pageNo: 1,
      qType: 0,
      rating: '*',
      ratingChange: '*',
      beginTime: '',
      endTime: '',
      fields: '',
      p: 1,
      pageNum: 1,
    }),
  }),
});

/** 资讯类端点的 Referer（与东财前端一致，避免被风控直接拒绝） */
export const EM_NEWS_HEADERS = Object.freeze({
  ...EM_HEADERS,
  Referer: 'https://so.eastmoney.com/',
});

/**
 * 剥离 JSONP 外壳：`cb({...})` / `cb({...});` → `{...}`
 * @param {string} text 原始响应文本
 * @returns {string} 纯 JSON 文本；非 JSONP 时原样返回
 */
export function stripJsonp(text) {
  const s = String(text ?? '').trim();
  if (!s) return s;
  if (s.startsWith('{') || s.startsWith('[')) return s;
  const start = s.indexOf('(');
  const end = s.lastIndexOf(')');
  if (start === -1 || end === -1 || end <= start) return s;
  return s.slice(start + 1, end).trim();
}

/**
 * 构造完整请求 URL
 * @param {object} endpoint emEndpoints 中的某一项
 * @param {object} [params] 覆盖/追加的 query 参数（undefined / null 的项会被丢弃）
 * @returns {string} 完整 URL
 */
export function buildUrl(endpoint, params = {}) {
  if (!endpoint || !endpoint.host || !endpoint.path) {
    throw new Error('buildUrl: endpoint 定义非法（缺 host / path）');
  }
  const merged = { ...endpoint.defaults, ...params };
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(merged)) {
    if (v === undefined || v === null || v === '') continue;
    search.append(k, String(v));
  }
  // 加时间戳打散 CDN 缓存，与东财前端行为一致
  search.append('_', String(Date.now()));
  return `${endpoint.host}${endpoint.path}?${search.toString()}`;
}

/**
 * 端点键清单（供探针脚本遍历）
 * @returns {string[]}
 */
export function listEndpointKeys() {
  return Object.keys(emEndpoints);
}
