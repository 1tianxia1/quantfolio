// ============================================================
// EmClient —— 东方财富公开接口客户端（架构 §6.1 三道闸）
//
// 三道闸（外部不可控信源的标准防护）：
//   闸 1 限频：令牌桶 5QPS + 端点子桶 + 并发上限（util/rateLimiter.js）
//   闸 2 缓存：TTL 缓存 + 单飞，同 key 并发只回源一次（util/ttlCache.js）
//   闸 3 熔断：连续失败 N 次即打开，冷却期内直接短路返回 null（本文件）
//
// 红线（架构 §7）：
//   · 任何失败都**返回 null / 空数组**，绝不抛异常穿透到路由层，绝不白屏；
//   · 任何缺失字段都**返回 null**，绝不用 0 或上一根 K 线的值顶替（那是编造）；
//   · 所有 URL / 字段号只来自 emEndpoints.js，本文件不硬编码任何东财字符串。
//
// 本文件只负责「把东财原始报文翻译成项目内部字段」，
// 不做业务判断、不碰数据库 —— 那是 eastmoneyProvider / quoteSyncService 的事。
// ============================================================
import env from '../config/env.js';
import { getDispatcher } from '../util/httpAgent.js';
import { createRateLimiter } from '../util/rateLimiter.js';
import { createTtlCache } from '../util/ttlCache.js';
import { toSecid, tryNormalizeCode } from '../util/codeUtil.js';
import {
  emEndpoints,
  buildUrl,
  stripJsonp,
  EM_HEADERS,
  EM_NEWS_HEADERS,
  BATCH_SECID_LIMIT,
  KLINE_MAX_LIMIT,
  KLT,
  CLIST_FS,
} from './emEndpoints.js';

/** 代理通道名（对应 httpAgent 的 CHANNEL_FLAG.eastmoney） */
const CHANNEL = 'eastmoney';

/** 东财用 '-' 表示「无数据」，必须映射为 null 而不是 0 */
function toNum(raw, scale = 1) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw * scale : null;
  const s = String(raw).trim();
  if (s === '' || s === '-' || s === '--') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n * scale : null;
}

/** 文本字段：空串 / '-' 统一为 null */
function toText(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  return s === '' || s === '-' ? null : s;
}

/** 秒级时间戳 → 北京时间 YYYY-MM-DD（不依赖运行环境时区） */
function tsToTradeDate(ts) {
  const n = toNum(ts);
  if (!n || n <= 0) return null;
  const ms = (n > 1e11 ? n : n * 1000) + 8 * 3600 * 1000;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/** 睡眠 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 指数退避 + 抖动（抖动避免多请求同时重试形成尖峰） */
function backoffMs(attempt, baseMs) {
  const raw = baseMs * (2 ** Math.max(0, attempt - 1));
  const jitter = 0.7 + Math.random() * 0.6; // ±30%
  return Math.min(8000, Math.round(raw * jitter));
}

/**
 * 按字段映射表解析一条东财记录（对象型报文，如 stock/get、clist diff 项）
 * @param {object} raw 东财原始对象
 * @param {object} fieldMap emEndpoints 中的 *_FIELD_MAP
 * @returns {object} 内部字段对象（缺失一律 null）
 */
function decodeByMap(raw, fieldMap) {
  const out = {};
  for (const [emKey, def] of Object.entries(fieldMap)) {
    const v = raw ? raw[emKey] : undefined;
    out[def.key] = def.text ? toText(v) : toNum(v, def.scale ?? 1);
  }
  return out;
}

/**
 * 按顺序映射解析 klines 中的一行（逗号分隔串）
 * @param {string} line 形如 '2024-01-02,10.00,...'
 * @param {Array<object>} orderedFields emEndpoints 中的 KLINE_FIELDS / FFLOW_FIELDS
 * @returns {object|null} 解析结果；列数不足返回 null（宁可丢弃也不臆测）
 */
function decodeOrdered(line, orderedFields) {
  if (typeof line !== 'string' || line === '') return null;
  const parts = line.split(',');
  if (parts.length < orderedFields.length) {
    // 东财改版导致列数变化 —— 明确丢弃并让上层记录，而不是错位赋值
    return null;
  }
  const out = {};
  for (let i = 0; i < orderedFields.length; i += 1) {
    const def = orderedFields[i];
    out[def.key] = def.text ? toText(parts[i]) : toNum(parts[i], def.scale ?? 1);
  }
  return out;
}

/** 把数组切成固定大小的批 */
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** 字段错位告警只打一次，避免刷屏 */
let klineMappingWarned = false;

/**
 * K 线字段错位自检（防止东财改版后静默算错指标）
 *
 * 原理：不依赖任何外部真值，只用同一批数据内部的恒等式互相印证 ——
 *   pct_chg ≈ (close - 前一根 close) / 前一根 close × 100
 * 若映射错位（例如 f58 振幅被当成涨跌幅），这条恒等式会大面积不成立。
 *
 * 检出后**只告警不修数**：自动纠偏等于猜，猜出来的行情就是编造（红线）。
 *
 * @param {object[]} bars 解码后的 bar 数组（时间升序）
 * @param {string} secid 用于日志定位
 * @returns {{checked: number, mismatched: number, suspicious: boolean}} 自检结论
 */
function validateKlineMapping(bars, secid) {
  const sample = bars.slice(-21);
  let checked = 0;
  let mismatched = 0;
  for (let i = 1; i < sample.length; i += 1) {
    const prev = sample[i - 1];
    const cur = sample[i];
    if (!prev || !cur || prev.close === null || cur.close === null || cur.pct_chg === null) continue;
    if (prev.close === 0) continue;
    const expected = ((cur.close - prev.close) / prev.close) * 100;
    checked += 1;
    // 容忍分红除权造成的跳空：只要偏差超过 0.5 个百分点且相对偏差 > 20% 才算异常
    const absDiff = Math.abs(expected - cur.pct_chg);
    if (absDiff > 0.5 && absDiff > Math.abs(expected) * 0.2) mismatched += 1;
  }
  const suspicious = checked >= 5 && mismatched / checked > 0.5;
  if (suspicious && !klineMappingWarned) {
    klineMappingWarned = true;
    console.warn(
      `[emClient] ⚠ K 线字段疑似错位（${secid}）：${mismatched}/${checked} 根的涨跌幅与前收自洽性校验失败。`
      + ' 东财很可能调整了 fields2 列序。请执行 `node scripts/probe-eastmoney.mjs` 查看实测列顺序，'
      + ' 并据此修正 server/src/providers/emEndpoints.js 的 KLINE_FIELDS。'
      + ' 本次数据仍按原映射返回（不自动纠偏，避免编造）。',
    );
  }
  return { checked, mismatched, suspicious };
}

/**
 * 创建东方财富客户端
 *
 * @param {object} [options] 覆盖配置（缺省读 config/env.js，便于单测注入）
 * @param {number} [options.qps] 全局 QPS
 * @param {number} [options.endpointQps] 单端点 QPS
 * @param {number} [options.maxConcurrency] 并发上限
 * @param {number} [options.timeoutMs] 单请求超时
 * @param {number} [options.retries] 失败重试次数（不含首次）
 * @param {number} [options.retryBaseMs] 退避基数
 * @param {number} [options.breakerThreshold] 连续失败多少次熔断
 * @param {number} [options.breakerCooldownMs] 熔断冷却时长
 * @param {number} [options.quoteTtlMs] 实时快照缓存 TTL
 * @param {number} [options.klineTtlMs] K 线缓存 TTL
 * @param {number} [options.listTtlMs] 列表/板块缓存 TTL
 * @param {boolean} [options.verbose] 打印每次请求耗时
 * @returns {object} EmClient 实例
 */
export function createEmClient(options = {}) {
  const cfg = {
    qps: Number(options.qps ?? env.EM_QPS) || 5,
    endpointQps: Number(options.endpointQps ?? env.EM_ENDPOINT_QPS) || 3,
    maxConcurrency: Number(options.maxConcurrency ?? env.EM_MAX_CONCURRENCY) || 4,
    timeoutMs: Number(options.timeoutMs ?? env.EM_TIMEOUT_MS) || 8000,
    retries: Number(options.retries ?? env.EM_RETRIES) || 2,
    retryBaseMs: Number(options.retryBaseMs ?? env.EM_RETRY_BASE_MS) || 400,
    breakerThreshold: Number(options.breakerThreshold ?? env.EM_BREAKER_THRESHOLD) || 6,
    breakerCooldownMs: Number(options.breakerCooldownMs ?? env.EM_BREAKER_COOLDOWN_MS) || 30000,
    quoteTtlMs: Number(options.quoteTtlMs ?? env.EM_QUOTE_TTL_MS) || 15000,
    klineTtlMs: Number(options.klineTtlMs ?? env.EM_KLINE_TTL_MS) || 300000,
    listTtlMs: Number(options.listTtlMs ?? env.EM_LIST_TTL_MS) || 60000,
    verbose: options.verbose ?? String(env.EM_VERBOSE || '') === 'true',
  };

  const limiter = createRateLimiter({
    qps: cfg.qps,
    endpointQps: cfg.endpointQps,
    maxConcurrency: cfg.maxConcurrency,
  });
  const cache = createTtlCache({ maxSize: 2000, defaultTtlMs: cfg.quoteTtlMs });

  /** 熔断状态 */
  const breaker = {
    consecutiveFailures: 0,
    openUntil: 0,
    halfOpenInFlight: false,
    trips: 0,
  };

  /** 运行统计（供 probe / 健康检查） */
  const stats = {
    requests: 0,
    ok: 0,
    failed: 0,
    retried: 0,
    shortCircuited: 0,
    totalMs: 0,
    lastError: null,
    lastErrorAt: null,
    lastOkAt: null,
  };

  /** 熔断是否处于「打开」状态（半开探针放行一个） */
  function breakerBlocked() {
    if (Date.now() >= breaker.openUntil) return false;
    if (!breaker.halfOpenInFlight && breaker.openUntil - Date.now() < cfg.breakerCooldownMs / 2) {
      // 冷却过半后放一个半开探针出去试水
      breaker.halfOpenInFlight = true;
      return false;
    }
    return true;
  }

  function recordSuccess() {
    breaker.consecutiveFailures = 0;
    breaker.openUntil = 0;
    breaker.halfOpenInFlight = false;
    stats.ok += 1;
    stats.lastOkAt = new Date().toISOString();
  }

  function recordFailure(err) {
    breaker.consecutiveFailures += 1;
    breaker.halfOpenInFlight = false;
    stats.failed += 1;
    stats.lastError = err ? String(err.message || err) : 'unknown';
    stats.lastErrorAt = new Date().toISOString();
    if (breaker.consecutiveFailures >= cfg.breakerThreshold) {
      breaker.openUntil = Date.now() + cfg.breakerCooldownMs;
      breaker.trips += 1;
      console.warn(
        `[emClient] 熔断打开：连续失败 ${breaker.consecutiveFailures} 次，`
        + `${Math.round(cfg.breakerCooldownMs / 1000)}s 内直接降级。最后错误：${stats.lastError}`,
      );
    }
  }

  /** 判定错误是否值得重试（4xx 业务错误重试无意义） */
  function retriable(err) {
    if (!err) return false;
    if (err.status && err.status >= 400 && err.status < 500 && err.status !== 429) return false;
    return true;
  }

  /**
   * 发起一次带限频 / 重试 / 熔断的 GET 请求
   * @param {object} endpoint emEndpoints 项
   * @param {object} params query 参数
   * @returns {Promise<object|null>} 解析后的 JSON；任何失败返回 null
   */
  async function requestJson(endpoint, params) {
    if (breakerBlocked()) {
      stats.shortCircuited += 1;
      return null;
    }

    const url = buildUrl(endpoint, params);
    let lastErr = null;

    for (let attempt = 0; attempt <= cfg.retries; attempt += 1) {
      if (attempt > 0) {
        stats.retried += 1;
        await sleep(backoffMs(attempt, cfg.retryBaseMs));
      }

      const started = Date.now();
      try {
        // eslint-disable-next-line no-await-in-loop
        const json = await limiter.run(endpoint.rateKey, async () => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
          try {
            const dispatcher = await getDispatcher(CHANNEL);
            stats.requests += 1;
            const headers = endpoint.jsonp || endpoint.news ? EM_NEWS_HEADERS : EM_HEADERS;
            const init = { headers, signal: controller.signal };
            if (dispatcher) init.dispatcher = dispatcher;
            const res = await fetch(url, init);
            if (!res.ok) {
              const e = new Error(`HTTP ${res.status} ${res.statusText}`);
              e.status = res.status;
              throw e;
            }
            const text = await res.text();
            if (!text || text.trim() === '') throw new Error('响应体为空');
            // JSONP 端点先剥壳再解析（东财资讯搜索只提供 JSONP 形态）
            const payload = endpoint.jsonp ? stripJsonp(text) : text;
            try {
              return JSON.parse(payload);
            } catch (_) {
              throw new Error(`响应非 JSON（前 80 字符：${payload.slice(0, 80)}）`);
            }
          } finally {
            clearTimeout(timer);
          }
        });

        const ms = Date.now() - started;
        stats.totalMs += ms;
        recordSuccess();
        if (cfg.verbose) {
          console.log(`[emClient] ${endpoint.name} ${ms}ms ok`);
        }
        return json;
      } catch (e) {
        lastErr = e;
        stats.totalMs += Date.now() - started;
        if (!retriable(e) || attempt === cfg.retries) break;
      }
    }

    recordFailure(lastErr);
    console.warn(`[emClient] ${endpoint.name} 请求失败（已重试 ${cfg.retries} 次）：${lastErr?.message || lastErr}`);
    return null;
  }

  // ----------------------------------------------------------
  // 公共方法
  // ----------------------------------------------------------

  /**
   * 单标的实时快照
   * @param {string} code 6 位裸码
   * @param {object} [opts] 选项
   * @param {string} [opts.market] 已知市场（'SH'|'SZ'|'BJ'），可省略由代码推断
   * @param {string} [opts.type] 证券类型（辅助市场推断）
   * @param {boolean} [opts.noCache] 跳过缓存
   * @returns {Promise<object|null>} 归一化快照；失败或无数据返回 null
   */
  async function fetchQuote(code, opts = {}) {
    const c = tryNormalizeCode(code);
    if (!c) return null;
    const secid = toSecid(c, opts.market, opts.type);
    const key = `quote:${secid}`;
    if (opts.noCache) cache.delete(key);

    const loaded = await cache.getOrLoad(key, cfg.quoteTtlMs, async () => {
      const json = await requestJson(emEndpoints.quote, { secid });
      // 请求级失败（网络/超时/熔断）返回 undefined —— ttlCache 不会缓存 undefined，
      // 避免把一次瞬时抖动固化成 15 秒的「查无此股」。
      if (json === null) return undefined;
      const raw = json?.data;
      // 有响应但 data 为空 = 东财确认没有这只标的，可以缓存，省得反复打
      if (!raw) return null;
      const q = decodeByMap(raw, emEndpoints.quote.fieldMap);
      // 东财偶尔返回壳对象（全 '-'），无最新价视为无效
      if (q.close === null && q.pre_close === null) return null;
      return {
        ...q,
        code: q.code || c,
        secid,
        trade_date: tsToTradeDate(q.ts),
        source: 'eastmoney',
        endpoint: 'quote',
      };
    });
    return loaded ?? null;
  }

  /**
   * 批量实时快照（自动分批 + 保持输入顺序）
   * @param {string[]} codes 6 位裸码数组
   * @param {object} [opts] 选项
   * @param {boolean} [opts.noCache] 跳过缓存
   * @returns {Promise<object[]>} 归一化快照数组（失败的代码直接缺席，不填充假值）
   */
  async function fetchQuotes(codes, opts = {}) {
    const list = Array.isArray(codes) ? codes : [];
    const valid = [];
    const seen = new Set();
    for (const item of list) {
      const c = tryNormalizeCode(item);
      if (c && !seen.has(c)) {
        seen.add(c);
        valid.push(c);
      }
    }
    if (valid.length === 0) return [];

    /** @type {Map<string, object>} code → quote */
    const result = new Map();
    const pending = [];

    for (const c of valid) {
      const secid = toSecid(c);
      const key = `quote:${secid}`;
      const hit = opts.noCache ? undefined : cache.get(key);
      if (hit !== undefined) {
        if (hit) result.set(c, hit);
      } else {
        pending.push({ code: c, secid });
      }
    }

    for (const batch of chunk(pending, BATCH_SECID_LIMIT)) {
      const secids = batch.map((b) => b.secid).join(',');
      // eslint-disable-next-line no-await-in-loop
      const json = await requestJson(emEndpoints.quotes, { secids });
      const diff = json?.data?.diff;
      const rows = Array.isArray(diff) ? diff : (diff && typeof diff === 'object' ? Object.values(diff) : []);
      for (const raw of rows) {
        const q = decodeByMap(raw, emEndpoints.quotes.fieldMap);
        const c = tryNormalizeCode(q.code);
        if (!c) continue;
        if (q.close === null && q.pre_close === null) continue;
        const item = {
          ...q,
          code: c,
          secid: `${q.em_market ?? ''}.${c}`,
          trade_date: tsToTradeDate(q.ts),
          source: 'eastmoney',
          endpoint: 'quotes',
        };
        cache.set(`quote:${toSecid(c)}`, item, cfg.quoteTtlMs);
        result.set(c, item);
      }
    }

    return valid.map((c) => result.get(c)).filter(Boolean);
  }

  /**
   * 历史 K 线
   * @param {string} code 6 位裸码
   * @param {object} [opts] 选项
   * @param {number} [opts.limit=250] 条数，硬上限 KLINE_MAX_LIMIT(2500)
   * @param {number} [opts.klt=101] 周期
   * @param {number} [opts.fqt=1] 复权方式
   * @param {string} [opts.market] 已知市场
   * @param {string} [opts.type] 证券类型
   * @param {boolean} [opts.noCache] 跳过缓存
   * @returns {Promise<{code:string,name:string|null,bars:object[]}|null>} K 线；失败返回 null
   */
  async function fetchKline(code, opts = {}) {
    const c = tryNormalizeCode(code);
    if (!c) return null;
    const limit = Math.min(KLINE_MAX_LIMIT, Math.max(1, Number(opts.limit) || 250));
    const klt = Number(opts.klt) || KLT.DAY;
    const fqt = opts.fqt === undefined || opts.fqt === null
      ? (Number(env.EM_FQT) >= 0 ? Number(env.EM_FQT) : emEndpoints.kline.defaults.fqt)
      : Number(opts.fqt);
    const secid = toSecid(c, opts.market, opts.type);
    const key = `kline:${secid}:${klt}:${fqt}:${limit}`;
    if (opts.noCache) cache.delete(key);

    const loaded = await cache.getOrLoad(key, cfg.klineTtlMs, async () => {
      const json = await requestJson(emEndpoints.kline, { secid, klt, fqt, lmt: limit });
      if (json === null) return undefined; // 请求级失败不落缓存
      const data = json?.data;
      if (!data || !Array.isArray(data.klines)) return null;
      const bars = [];
      let malformed = 0;
      for (const line of data.klines) {
        const bar = decodeOrdered(line, emEndpoints.kline.orderedFields);
        if (!bar || !bar.date || bar.close === null) {
          malformed += 1;
          continue;
        }
        // pre_close 由「收盘 - 涨跌额」还原；涨跌额缺失则如实置 null，不猜
        bar.pre_close = bar.change === null ? null : Number((bar.close - bar.change).toFixed(4));
        bars.push(bar);
      }
      if (malformed > 0) {
        console.warn(`[emClient] kline ${secid} 有 ${malformed} 行字段错位/缺收盘价，已丢弃（疑似东财改版，请跑 probe 校准）`);
      }
      if (bars.length === 0) return null;
      const audit = validateKlineMapping(bars, secid);
      return {
        code: c,
        secid,
        name: toText(data.name),
        klt,
        fqt,
        bars,
        // 字段自洽性审计结论，供 probe / QA 断言，也供上层决定要不要落库
        mappingAudit: audit,
        source: 'eastmoney',
      };
    });
    return loaded ?? null;
  }

  /**
   * 拉取列表型数据（clist / sectorList），自动翻页
   * @param {object} [opts] 选项
   * @param {string} [opts.fs] 选股范围，见 CLIST_FS
   * @param {'clist'|'sectorList'} [opts.endpoint='clist'] 使用哪个端点定义
   * @param {number} [opts.pageSize=100] 每页条数
   * @param {number} [opts.maxPages=1] 最多翻几页
   * @param {string} [opts.fid='f3'] 排序字段
   * @param {number} [opts.po=1] 1 降序 0 升序
   * @param {boolean} [opts.noCache] 跳过缓存
   * @returns {Promise<{total:number, rows:object[]}>} 列表结果；失败返回 {total:0, rows:[]}
   */
  async function fetchList(opts = {}) {
    const epKey = opts.endpoint === 'sectorList' ? 'sectorList' : 'clist';
    const endpoint = emEndpoints[epKey];
    const fs = opts.fs || endpoint.defaults.fs;
    const pageSize = Math.min(500, Math.max(1, Number(opts.pageSize) || Number(env.EM_CLIST_PAGE_SIZE) || 100));
    const maxPages = Math.max(1, Number(opts.maxPages) || 1);
    const fid = opts.fid || endpoint.defaults.fid;
    const po = opts.po === undefined ? endpoint.defaults.po : Number(opts.po);
    const key = `list:${epKey}:${fs}:${pageSize}:${maxPages}:${fid}:${po}`;
    if (opts.noCache) cache.delete(key);

    const loaded = await cache.getOrLoad(key, cfg.listTtlMs, async () => {
      const rows = [];
      let total = 0;
      for (let pn = 1; pn <= maxPages; pn += 1) {
        // eslint-disable-next-line no-await-in-loop
        const json = await requestJson(endpoint, { fs, pn, pz: pageSize, fid, po });
        // 首页就请求失败 → 返回 undefined，不缓存空结果（否则 60s 内持续空列表）
        if (json === null && pn === 1) return undefined;
        const data = json?.data;
        if (!data) break;
        total = toNum(data.total) ?? total;
        const diff = data.diff;
        const page = Array.isArray(diff) ? diff : (diff && typeof diff === 'object' ? Object.values(diff) : []);
        if (page.length === 0) break;
        for (const raw of page) {
          rows.push(decodeByMap(raw, endpoint.fieldMap));
        }
        if (rows.length >= total && total > 0) break;
      }
      return { total: total || rows.length, rows };
    });
    return loaded ?? { total: 0, rows: [] };
  }

  /**
   * 行业板块行情列表（供板块热度）
   * @param {object} [opts] 选项
   * @param {'industry'|'concept'|'region'} [opts.dimension='industry'] 板块维度
   * @param {number} [opts.limit=100] 取前 N 个
   * @param {boolean} [opts.noCache] 跳过缓存
   * @returns {Promise<object[]>} 板块数组（按涨跌幅降序，已带 rank）
   */
  async function fetchSectors(opts = {}) {
    const fsMap = {
      industry: CLIST_FS.SECTOR_INDUSTRY,
      concept: CLIST_FS.SECTOR_CONCEPT,
      region: CLIST_FS.SECTOR_REGION,
    };
    const fs = fsMap[opts.dimension] || CLIST_FS.SECTOR_INDUSTRY;
    const limit = Math.max(1, Number(opts.limit) || 100);
    const { rows } = await fetchList({
      endpoint: 'sectorList',
      fs,
      pageSize: Math.min(200, limit),
      maxPages: Math.ceil(limit / Math.min(200, limit)),
      noCache: opts.noCache,
    });
    return rows.slice(0, limit).map((r, i) => ({ ...r, hot_rank: i + 1 }));
  }

  /**
   * 个股历史资金流
   * @param {string} code 6 位裸码
   * @param {object} [opts] 选项
   * @param {number} [opts.limit=0] 取最近 N 日，0 表示全部
   * @param {boolean} [opts.noCache] 跳过缓存
   * @returns {Promise<object[]>} 资金流数组（按日期升序）；失败返回 []
   */
  async function fetchMoneyFlow(code, opts = {}) {
    const c = tryNormalizeCode(code);
    if (!c) return [];
    const secid = toSecid(c);
    const limit = Math.max(0, Number(opts.limit) || 0);
    const key = `fflow:${secid}:${limit}`;
    if (opts.noCache) cache.delete(key);

    const loaded = await cache.getOrLoad(key, cfg.klineTtlMs, async () => {
      const json = await requestJson(emEndpoints.fflow, { secid, lmt: limit });
      if (json === null) return undefined; // 请求级失败不落缓存
      const data = json?.data;
      if (!data || !Array.isArray(data.klines)) return [];
      const out = [];
      for (const line of data.klines) {
        const row = decodeOrdered(line, emEndpoints.fflow.orderedFields);
        if (row && row.date) out.push({ ...row, code: c });
      }
      return out;
    });
    return Array.isArray(loaded) ? loaded : [];
  }

  /**
   * 连通性自检（供 /health 与探针）
   * @returns {Promise<{ok:boolean, ms:number, detail:string}>}
   */
  async function ping() {
    const started = Date.now();
    // 上证指数是最轻量且永远存在的探测标的
    const json = await requestJson(emEndpoints.quote, { secid: '1.000001' });
    const ms = Date.now() - started;
    if (!json || !json.data) {
      return { ok: false, ms, detail: stats.lastError || '无数据返回' };
    }
    return { ok: true, ms, detail: `上证指数 ${toNum(json.data.f43) ?? '-'}` };
  }

  /**
   * 通用端点直取（供资讯类等无需字段映射的端点复用三道闸）
   *
   * 与 fetchQuote/fetchKline 等的区别：**不做字段映射**，原样返回上游 JSON，
   * 由调用方（如 emNewsProvider）自行解析。这样新增端点无需改动本文件。
   *
   * @param {string|object} endpointRef emEndpoints 的键名，或端点对象本身
   * @param {object} [params] query 参数
   * @param {object} [opts] 选项
   * @param {number} [opts.ttlMs] 缓存 TTL（默认 listTtlMs）；传 0 表示不缓存
   * @param {string} [opts.cacheKey] 自定义缓存键（默认由端点名 + params 生成）
   * @returns {Promise<object|null>} 上游 JSON；任何失败返回 null（红线：不抛穿透）
   */
  async function fetchEndpoint(endpointRef, params = {}, opts = {}) {
    const endpoint = typeof endpointRef === 'string' ? emEndpoints[endpointRef] : endpointRef;
    if (!endpoint) {
      console.warn(`[emClient] fetchEndpoint: 未知端点 ${String(endpointRef)}`);
      return null;
    }
    const ttlMs = opts.ttlMs === undefined ? cfg.listTtlMs : Number(opts.ttlMs);
    if (!ttlMs || ttlMs <= 0) {
      return requestJson(endpoint, params);
    }
    const key = opts.cacheKey || `ep:${endpoint.name}:${JSON.stringify(params)}`;
    return cache.getOrLoad(key, ttlMs, () => requestJson(endpoint, params));
  }

  return {
    name: 'eastmoney',
    config: Object.freeze({ ...cfg }),

    fetchQuote,
    fetchQuotes,
    fetchKline,
    fetchList,
    fetchSectors,
    fetchMoneyFlow,
    fetchEndpoint,
    ping,

    /** 运行统计快照 */
    getStats() {
      return {
        ...stats,
        avgMs: stats.requests > 0 ? Math.round(stats.totalMs / stats.requests) : 0,
        cache: cache.stats,
        breaker: {
          open: Date.now() < breaker.openUntil,
          consecutiveFailures: breaker.consecutiveFailures,
          trips: breaker.trips,
          reopenInMs: Math.max(0, breaker.openUntil - Date.now()),
        },
        limiter: { ...limiter.config, inFlight: limiter.inFlight },
      };
    },

    /** 熔断是否打开（provider 用来决定是否直接走降级，省一次无谓等待） */
    isCircuitOpen() {
      return Date.now() < breaker.openUntil;
    },

    /** 手动复位熔断与缓存（配置变更 / 单测） */
    reset() {
      breaker.consecutiveFailures = 0;
      breaker.openUntil = 0;
      breaker.halfOpenInFlight = false;
      cache.clear();
      limiter.reset();
    },

    /** 仅清缓存（强制下一次回源） */
    clearCache() {
      cache.clear();
    },
  };
}

/** 进程级默认单例：全项目共用同一套限频/缓存/熔断状态 */
export const emClient = createEmClient();

export default emClient;
