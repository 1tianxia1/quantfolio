#!/usr/bin/env node
// ============================================================
// 东方财富接口探针 —— 校准 emEndpoints 的唯一工具
//
// 用途：
//   逐个打通 emEndpoints 里定义的每个端点，打印
//     · HTTP 状态 / 耗时 / 返回体大小
//     · 原始 f 字段 → 项目内部字段名 的实际映射与取值
//     · emClient 解码后的结果（验证解码链路，不只是「能连上」）
//   东财改版导致字段错位时，先跑本脚本，再照结果改 emEndpoints.js。
//
// 用法：
//   node scripts/probe-eastmoney.mjs                 # 全量探测
//   node scripts/probe-eastmoney.mjs --quick         # 只探 quote + kline
//   node scripts/probe-eastmoney.mjs --stock=600519  # 换探测标的
//   node scripts/probe-eastmoney.mjs --raw           # 额外打印原始 JSON 片段
//   node scripts/probe-eastmoney.mjs --timeout=15000
//   node scripts/probe-eastmoney.mjs --strict        # 有失败则退出码 1（供 CI）
//
// 设计约束：
//   · 本脚本**不写数据库**，纯只读探测，随时可跑；
//   · 网络不通时不卡死：每个端点独立超时 + 捕获，最后照常打印汇总并优雅退出；
//   · 默认退出码恒为 0（离线环境不该让流水线红掉），需要严格模式加 --strict。
// ============================================================
import process from 'node:process';
import {
  emEndpoints,
  buildUrl,
  EM_HEADERS,
  CLIST_FS,
  KLINE_MAX_LIMIT,
} from '../server/src/providers/emEndpoints.js';
import { createEmClient } from '../server/src/providers/emClient.js';
import {
  toSecid,
  parseSecid,
  isFundCode,
  guessType,
  marketFromCode,
  normalizeCode,
  tryNormalizeCode,
} from '../server/src/util/codeUtil.js';

// ------------------------------------------------------------
// 参数解析
// ------------------------------------------------------------
function argOf(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}
function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

const OPT = {
  stock: argOf('stock', '600009'),
  stock2: argOf('stock2', '000878'),
  fund: argOf('fund', '510300'),
  timeoutMs: Number(argOf('timeout', '12000')) || 12000,
  quick: hasFlag('quick'),
  raw: hasFlag('raw'),
  strict: hasFlag('strict'),
};

// ------------------------------------------------------------
// 输出小工具
// ------------------------------------------------------------
const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', cyan: '\x1b[36m',
};
function title(s) {
  console.log(`\n${C.bold}${C.cyan}${'─'.repeat(66)}${C.reset}`);
  console.log(`${C.bold}${C.cyan}  ${s}${C.reset}`);
  console.log(`${C.bold}${C.cyan}${'─'.repeat(66)}${C.reset}`);
}
function okLine(s) { console.log(`  ${C.green}✓${C.reset} ${s}`); }
function badLine(s) { console.log(`  ${C.red}✗${C.reset} ${s}`); }
function infoLine(s) { console.log(`  ${C.dim}·${C.reset} ${s}`); }

/** 值的短展示（避免长串刷屏） */
function brief(v, max = 42) {
  if (v === null || v === undefined) return `${C.dim}null${C.reset}`;
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** @type {Array<{name:string, ok:boolean, ms:number, note:string}>} */
const results = [];
function record(name, ok, ms, note) {
  results.push({ name, ok, ms, note });
}

// ------------------------------------------------------------
// 原始 HTTP 探测（绕开 emClient，用于校准字段）
// ------------------------------------------------------------
/**
 * 直连打一个端点，返回原始 JSON
 * @param {object} endpoint emEndpoints 项
 * @param {object} params query 参数
 * @returns {Promise<{ok:boolean, ms:number, status:number|null, json:object|null, bytes:number, error:string|null}>}
 */
async function rawProbe(endpoint, params) {
  const url = buildUrl(endpoint, params);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OPT.timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(url, { headers: EM_HEADERS, signal: controller.signal });
    const text = await res.text();
    const ms = Date.now() - started;
    if (!res.ok) {
      return { ok: false, ms, status: res.status, json: null, bytes: text.length, error: `HTTP ${res.status}` };
    }
    let json = null;
    try {
      json = JSON.parse(text);
    } catch (e) {
      return { ok: false, ms, status: res.status, json: null, bytes: text.length, error: `非 JSON：${text.slice(0, 60)}` };
    }
    return { ok: true, ms, status: res.status, json, bytes: text.length, error: null };
  } catch (e) {
    const ms = Date.now() - started;
    const reason = e.name === 'AbortError' ? `超时 >${OPT.timeoutMs}ms` : `${e.name}: ${e.message}`;
    return { ok: false, ms, status: null, json: null, bytes: 0, error: reason };
  } finally {
    clearTimeout(timer);
  }
}

/** 打印「f 字段 → 内部字段」的实际取值表 */
function printFieldMap(raw, fieldMap, limit = 99) {
  let n = 0;
  for (const [emKey, def] of Object.entries(fieldMap)) {
    if (n >= limit) break;
    const v = raw ? raw[emKey] : undefined;
    const missing = v === undefined;
    const mark = missing ? `${C.yellow}缺失${C.reset}` : '';
    console.log(
      `      ${C.dim}${emKey.padEnd(5)}${C.reset}→ ${String(def.key).padEnd(18)} = ${brief(v)} ${mark}`,
    );
    n += 1;
  }
}

/** 打印顺序型 klines 的列对齐情况 */
function printOrderedMap(line, orderedFields) {
  if (typeof line !== 'string') {
    badLine('klines 首行不是字符串，字段顺序无法校准');
    return;
  }
  const parts = line.split(',');
  console.log(`      ${C.dim}原始行：${brief(line, 90)}${C.reset}`);
  console.log(`      ${C.dim}列数：${parts.length}，映射表期望：${orderedFields.length}${C.reset}`);
  if (parts.length !== orderedFields.length) {
    badLine(`列数不匹配！需要更新 emEndpoints 的顺序映射（实际 ${parts.length} 列）`);
  }
  for (let i = 0; i < orderedFields.length; i += 1) {
    const def = orderedFields[i];
    console.log(
      `      ${C.dim}[${String(i).padStart(2)}] ${def.em.padEnd(4)}${C.reset}→ `
      + `${String(def.key).padEnd(18)} = ${brief(parts[i])}`,
    );
  }
}

/**
 * 网络根因判别：区分「整机断网」/「东财风控拉黑行情主机」/「仅个别端点异常」
 *
 * 判别依据：行情主机 push2*.eastmoney.com 与东财官网 quote.eastmoney.com 是同一家、
 * 不同集群。官网通而行情主机 socket 被拒，几乎必然是行情接口侧的 IP 风控。
 *
 * @returns {Promise<{internet: boolean, emSite: boolean, emQuoteHost: boolean, verdict: string}>}
 */
async function diagnoseNetwork() {
  async function tryGet(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch(url, { headers: EM_HEADERS, signal: controller.signal });
      await res.text();
      return { ok: true, detail: `HTTP ${res.status}` };
    } catch (e) {
      const cause = e.cause ? (e.cause.code || e.cause.message) : e.message;
      return { ok: false, detail: String(cause) };
    } finally {
      clearTimeout(timer);
    }
  }

  const site = await tryGet('https://quote.eastmoney.com/');
  const quoteHost = await tryGet(buildUrl(emEndpoints.quote, { secid: '1.000001' }));
  // 用一个与东财无关的境内站点确认基础出网能力
  const internet = site.ok ? { ok: true, detail: '略过（东财官网已通）' } : await tryGet('https://www.baidu.com/');

  let verdict;
  if (!internet.ok) {
    verdict = '本机/沙箱完全无法出网。请在有网络的环境重跑，或配置 HTTP_PROXY_URL + EM_USE_PROXY=true。';
  } else if (site.ok && !quoteHost.ok) {
    verdict = '出网正常、东财官网可达，但行情主机 push2*.eastmoney.com 在 socket 层被拒 '
      + `（${quoteHost.detail}）。这是东财对当前出口 IP 的风控限流，不是代码问题。`
      + ' 处置：静置数十分钟后重试 / 调低 EM_QPS / 更换出口 IP。';
  } else if (quoteHost.ok) {
    verdict = '行情主机本身可达，失败项集中在个别端点 —— 优先怀疑该端点参数或字段映射需要校准。';
  } else {
    verdict = '东财整体不可达（官网与行情主机均失败），疑似 DNS 污染或网络策略拦截。';
  }

  return { internet: internet.ok, emSite: site.ok, emQuoteHost: quoteHost.ok, verdict };
}

/** 取 diff（clist / ulist.np 有时返回对象、有时返回数组） */
function diffRows(data) {
  const diff = data?.diff;
  if (Array.isArray(diff)) return diff;
  if (diff && typeof diff === 'object') return Object.values(diff);
  return [];
}

// ------------------------------------------------------------
// 阶段 0：codeUtil 离线自测（不联网，必须 100% 通过）
// ------------------------------------------------------------
function probeCodeUtil() {
  title('阶段 0 · codeUtil 离线自测（代码 ↔ secid 唯一转换入口）');
  const cases = [
    { in: '600009', secid: '1.600009', market: 'SH', type: 'stock', fund: false },
    { in: '601318', secid: '1.601318', market: 'SH', type: 'stock', fund: false },
    { in: '688981', secid: '1.688981', market: 'SH', type: 'stock', fund: false },
    { in: '000878', secid: '0.000878', market: 'SZ', type: 'stock', fund: false },
    { in: '300750', secid: '0.300750', market: 'SZ', type: 'stock', fund: false },
    { in: '830799', secid: '0.830799', market: 'BJ', type: 'stock', fund: false },
    { in: '510300', secid: '1.510300', market: 'SH', type: 'fund', fund: true },
    { in: '159915', secid: '0.159915', market: 'SZ', type: 'fund', fund: true },
    { in: ' sh600009 ', secid: '1.600009', market: 'SH', type: 'stock', fund: false },
    { in: '000878.SZ', secid: '0.000878', market: 'SZ', type: 'stock', fund: false },
  ];

  let pass = 0;
  for (const c of cases) {
    const code = tryNormalizeCode(c.in);
    const secid = toSecid(c.in);
    const market = marketFromCode(code, undefined);
    const type = guessType(code);
    const fund = isFundCode(code);
    const parsed = parseSecid(secid);
    const good = secid === c.secid
      && market === c.market
      && type === c.type
      && fund === c.fund
      && parsed?.code === code;
    if (good) {
      pass += 1;
      okLine(`${String(c.in).trim().padEnd(11)} → secid=${secid.padEnd(9)} market=${market} type=${type} fund=${fund}`);
    } else {
      badLine(
        `${String(c.in).trim()} → secid=${secid}（期望 ${c.secid}）market=${market}（期望 ${c.market}）`
        + ` type=${type}（期望 ${c.type}）fund=${fund}（期望 ${c.fund}）`,
      );
    }
  }

  // 非法输入必须抛 40001，而不是静默返回脏值
  let rejected = 0;
  for (const bad of ['', '  ', '60000', '6000091', 'abcdef', null, undefined, '6000a9']) {
    try {
      normalizeCode(bad);
      badLine(`非法输入 ${JSON.stringify(bad)} 未被拒绝（应抛 40001）`);
    } catch (e) {
      rejected += 1;
    }
  }
  okLine(`非法输入拦截：${rejected}/8 全部抛错`);

  const allOk = pass === cases.length && rejected === 8;
  record('codeUtil 自测', allOk, 0, `${pass}/${cases.length} 转换用例 + ${rejected}/8 非法拦截`);
  return allOk;
}

// ------------------------------------------------------------
// 阶段 1：原始端点探测
// ------------------------------------------------------------
async function probeQuote() {
  title(`阶段 1.1 · quote 单标的快照（${emEndpoints.quote.host}${emEndpoints.quote.path}）`);
  const secid = toSecid(OPT.stock);
  infoLine(`secid=${secid}  超时=${OPT.timeoutMs}ms`);
  const r = await rawProbe(emEndpoints.quote, { secid });
  if (!r.ok) {
    badLine(`失败：${r.error}（${r.ms}ms）`);
    record('quote', false, r.ms, r.error);
    return;
  }
  const data = r.json?.data;
  if (!data) {
    badLine(`返回体无 data 字段（rc=${r.json?.rc}）`);
    record('quote', false, r.ms, 'data 为空');
    return;
  }
  okLine(`HTTP ${r.status}  ${r.ms}ms  ${r.bytes}B  rc=${r.json.rc}`);
  console.log(`    ${C.bold}字段映射实测：${C.reset}`);
  printFieldMap(data, emEndpoints.quote.fieldMap);
  if (OPT.raw) console.log(`    ${C.dim}RAW: ${JSON.stringify(data).slice(0, 600)}${C.reset}`);
  record('quote', true, r.ms, `${data.f58 ?? '-'} 最新价 ${data.f43 ?? '-'}`);
}

async function probeQuotes() {
  title(`阶段 1.2 · quotes 批量快照（${emEndpoints.quotes.path}）`);
  const secids = [OPT.stock, OPT.stock2, OPT.fund].map((c) => toSecid(c)).join(',');
  infoLine(`secids=${secids}`);
  const r = await rawProbe(emEndpoints.quotes, { secids });
  if (!r.ok) {
    badLine(`失败：${r.error}（${r.ms}ms）`);
    record('quotes', false, r.ms, r.error);
    return;
  }
  const rows = diffRows(r.json?.data);
  if (rows.length === 0) {
    badLine('返回 diff 为空');
    record('quotes', false, r.ms, 'diff 为空');
    return;
  }
  okLine(`HTTP ${r.status}  ${r.ms}ms  ${r.bytes}B  返回 ${rows.length} 条`);
  console.log(`    ${C.bold}字段映射实测（第 1 条）：${C.reset}`);
  printFieldMap(rows[0], emEndpoints.quotes.fieldMap);
  for (const row of rows) {
    infoLine(`${row.f12 ?? '-'} ${String(row.f14 ?? '-').padEnd(8)} 价=${row.f2 ?? '-'} 涨跌幅=${row.f3 ?? '-'}%`);
  }
  record('quotes', true, r.ms, `${rows.length} 条`);
}

async function probeKline() {
  title(`阶段 1.3 · kline 日线（${emEndpoints.kline.host}${emEndpoints.kline.path}）`);
  const secid = toSecid(OPT.stock);
  for (const lmt of [5, 250]) {
    // eslint-disable-next-line no-await-in-loop
    const r = await rawProbe(emEndpoints.kline, { secid, lmt });
    if (!r.ok) {
      badLine(`lmt=${lmt} 失败：${r.error}（${r.ms}ms）`);
      record(`kline lmt=${lmt}`, false, r.ms, r.error);
      continue;
    }
    const data = r.json?.data;
    const klines = Array.isArray(data?.klines) ? data.klines : [];
    if (klines.length === 0) {
      badLine(`lmt=${lmt} 返回 klines 为空`);
      record(`kline lmt=${lmt}`, false, r.ms, 'klines 为空');
      continue;
    }
    okLine(`lmt=${lmt}  HTTP ${r.status}  ${r.ms}ms  ${r.bytes}B  实际 ${klines.length} 根  name=${data.name ?? '-'}`);
    if (lmt === 5) {
      console.log(`    ${C.bold}klines 列顺序实测：${C.reset}`);
      printOrderedMap(klines[klines.length - 1], emEndpoints.kline.orderedFields);
    }
    record(`kline lmt=${lmt}`, true, r.ms, `${klines.length} 根，末根 ${String(klines[klines.length - 1]).slice(0, 10)}`);
  }

  // P2 回测埋点：确认 2500 根上限是否真的能取到
  infoLine(`探测回测上限 lmt=${KLINE_MAX_LIMIT}（P2 回测埋点，失败不影响 T01 验收）`);
  const rMax = await rawProbe(emEndpoints.kline, { secid, lmt: KLINE_MAX_LIMIT });
  if (rMax.ok) {
    const n = Array.isArray(rMax.json?.data?.klines) ? rMax.json.data.klines.length : 0;
    okLine(`lmt=${KLINE_MAX_LIMIT} → 实际返回 ${n} 根，${rMax.ms}ms，${(rMax.bytes / 1024).toFixed(1)}KB`);
    record(`kline lmt=${KLINE_MAX_LIMIT}`, true, rMax.ms, `${n} 根`);
  } else {
    badLine(`lmt=${KLINE_MAX_LIMIT} 失败：${rMax.error}（${rMax.ms}ms）—— 大批量易触发东财限流，属预期风险`);
    record(`kline lmt=${KLINE_MAX_LIMIT}`, false, rMax.ms, rMax.error);
  }
}

async function probeClist() {
  title(`阶段 1.4 · clist 全市场列表（${emEndpoints.clist.path}）`);
  const scenes = [
    { label: '沪深京 A 股', fs: CLIST_FS.A_SHARE, pz: 5 },
    { label: '场内 ETF/LOF', fs: CLIST_FS.FUND_ETF, pz: 5 },
  ];
  for (const s of scenes) {
    // eslint-disable-next-line no-await-in-loop
    const r = await rawProbe(emEndpoints.clist, { fs: s.fs, pn: 1, pz: s.pz });
    if (!r.ok) {
      badLine(`${s.label} 失败：${r.error}（${r.ms}ms）`);
      record(`clist ${s.label}`, false, r.ms, r.error);
      continue;
    }
    const total = r.json?.data?.total ?? 0;
    const rows = diffRows(r.json?.data);
    okLine(`${s.label}  HTTP ${r.status}  ${r.ms}ms  total=${total}  本页 ${rows.length} 条`);
    if (rows.length > 0 && s.label === '沪深京 A 股') {
      console.log(`    ${C.bold}字段映射实测（第 1 条）：${C.reset}`);
      printFieldMap(rows[0], emEndpoints.clist.fieldMap);
    }
    record(`clist ${s.label}`, true, r.ms, `total=${total}`);
  }

  // 探测大 pz 是否可用：决定全市场快照要翻 57 页还是 2 页
  infoLine('探测大分页能力 pz=1000（决定全市场快照的翻页成本）');
  const rBig = await rawProbe(emEndpoints.clist, { fs: CLIST_FS.A_SHARE, pn: 1, pz: 1000 });
  if (rBig.ok) {
    const n = diffRows(rBig.json?.data).length;
    okLine(`pz=1000 → 实际返回 ${n} 条，${rBig.ms}ms，${(rBig.bytes / 1024).toFixed(1)}KB`);
    if (n >= 500) {
      infoLine(`${C.green}建议：可把 EM_CLIST_PAGE_SIZE 提到 ${n}，全市场快照仅需 ${Math.ceil(5700 / n)} 页${C.reset}`);
    } else {
      infoLine(`东财实际截断到 ${n} 条/页，保持 EM_CLIST_PAGE_SIZE=100 更稳`);
    }
    record('clist pz=1000', true, rBig.ms, `实收 ${n} 条`);
  } else {
    badLine(`pz=1000 失败：${rBig.error}`);
    record('clist pz=1000', false, rBig.ms, rBig.error);
  }
}

async function probeSectorList() {
  title(`阶段 1.5 · sectorList 行业板块（fs=${CLIST_FS.SECTOR_INDUSTRY}）`);
  const r = await rawProbe(emEndpoints.sectorList, { fs: CLIST_FS.SECTOR_INDUSTRY, pn: 1, pz: 5 });
  if (!r.ok) {
    badLine(`失败：${r.error}（${r.ms}ms）`);
    record('sectorList', false, r.ms, r.error);
    return;
  }
  const rows = diffRows(r.json?.data);
  if (rows.length === 0) {
    badLine('返回 diff 为空');
    record('sectorList', false, r.ms, 'diff 为空');
    return;
  }
  okLine(`HTTP ${r.status}  ${r.ms}ms  total=${r.json?.data?.total ?? 0}  本页 ${rows.length} 条`);
  console.log(`    ${C.bold}字段映射实测（第 1 条）：${C.reset}`);
  printFieldMap(rows[0], emEndpoints.sectorList.fieldMap);
  record('sectorList', true, r.ms, `${rows.length} 个板块`);
}

async function probeFflow() {
  title(`阶段 1.6 · fflow 历史资金流（${emEndpoints.fflow.host}${emEndpoints.fflow.path}）`);
  const secid = toSecid(OPT.stock);
  const r = await rawProbe(emEndpoints.fflow, { secid, lmt: 5 });
  if (!r.ok) {
    badLine(`失败：${r.error}（${r.ms}ms）`);
    record('fflow', false, r.ms, r.error);
    return;
  }
  const klines = Array.isArray(r.json?.data?.klines) ? r.json.data.klines : [];
  if (klines.length === 0) {
    badLine('返回 klines 为空');
    record('fflow', false, r.ms, 'klines 为空');
    return;
  }
  okLine(`HTTP ${r.status}  ${r.ms}ms  ${klines.length} 行`);
  console.log(`    ${C.bold}klines 列顺序实测：${C.reset}`);
  printOrderedMap(klines[klines.length - 1], emEndpoints.fflow.orderedFields);
  record('fflow', true, r.ms, `${klines.length} 行`);
}

// ------------------------------------------------------------
// 阶段 2：emClient 解码链路验证
// ------------------------------------------------------------
async function probeClient() {
  title('阶段 2 · emClient 解码链路（限频 / 缓存 / 熔断 / 归一化）');
  const client = createEmClient({ timeoutMs: OPT.timeoutMs, retries: 1, verbose: false });

  // 2.1 ping
  const ping = await client.ping();
  if (ping.ok) okLine(`ping 通：${ping.ms}ms（${ping.detail}）`);
  else badLine(`ping 不通：${ping.detail}`);
  record('emClient.ping', ping.ok, ping.ms, ping.detail);

  // 2.2 fetchQuote
  const t1 = Date.now();
  const q = await client.fetchQuote(OPT.stock);
  const ms1 = Date.now() - t1;
  if (q) {
    okLine(`fetchQuote(${OPT.stock}) ${ms1}ms → ${q.name} 收=${q.close} 涨跌幅=${q.pct_chg}% `
      + `量=${q.volume}手 额=${q.amount}元 流通市值=${q.circ_mv}亿 PE=${q.pe_ttm} 日期=${q.trade_date}`);
    const nulls = Object.entries(q).filter(([, v]) => v === null).map(([k]) => k);
    if (nulls.length) infoLine(`${C.yellow}空字段（如实为 null，非编造）：${nulls.join(', ')}${C.reset}`);
  } else {
    badLine(`fetchQuote(${OPT.stock}) 返回 null（已降级，不抛异常）`);
  }
  record('emClient.fetchQuote', !!q, ms1, q ? `${q.name} ${q.close}` : 'null');

  // 2.3 缓存命中验证（第二次应几乎 0ms）
  const t2 = Date.now();
  await client.fetchQuote(OPT.stock);
  const ms2 = Date.now() - t2;
  okLine(`缓存复验：第二次 fetchQuote 耗时 ${ms2}ms（TTL 缓存${ms2 <= 5 ? '命中' : '未命中，请检查 EM_QUOTE_TTL_MS'}）`);
  record('emClient 缓存', ms2 <= 50, ms2, `二次耗时 ${ms2}ms`);

  // 2.4 fetchQuotes 批量
  const t3 = Date.now();
  const qs = await client.fetchQuotes([OPT.stock, OPT.stock2, OPT.fund, '999999']);
  const ms3 = Date.now() - t3;
  okLine(`fetchQuotes(4 个，含 1 个不存在的 999999) ${ms3}ms → 返回 ${qs.length} 条（不存在的不会被编造出来）`);
  for (const item of qs) infoLine(`${item.code} ${String(item.name).padEnd(8)} ${item.close} (${item.pct_chg}%)`);
  record('emClient.fetchQuotes', qs.length >= 1, ms3, `${qs.length}/3 有效`);

  // 2.5 fetchKline
  const t4 = Date.now();
  const k = await client.fetchKline(OPT.fund, { limit: 30 });
  const ms4 = Date.now() - t4;
  if (k && k.bars.length) {
    const last = k.bars[k.bars.length - 1];
    okLine(`fetchKline(${OPT.fund}, 30) ${ms4}ms → ${k.name} ${k.bars.length} 根，末根 `
      + `${last.date} O=${last.open} H=${last.high} L=${last.low} C=${last.close} `
      + `V=${last.volume} pre=${last.pre_close} 换手=${last.turnover_rate}%`);
    // 一致性校验：pre_close 反推是否自洽
    const recomputed = last.pct_chg !== null && last.pre_close
      ? Number((((last.close - last.pre_close) / last.pre_close) * 100).toFixed(2))
      : null;
    if (recomputed !== null) {
      const diff = Math.abs(recomputed - last.pct_chg);
      if (diff <= 0.05) okLine(`pre_close 自洽校验通过：反算涨跌幅 ${recomputed}% ≈ 东财 ${last.pct_chg}%`);
      else badLine(`pre_close 自洽校验失败：反算 ${recomputed}% vs 东财 ${last.pct_chg}%（字段可能错位）`);
    }
    const audit = k.mappingAudit || {};
    if (audit.suspicious) {
      badLine(`字段错位自检：${audit.mismatched}/${audit.checked} 根不自洽 —— 请按上方 klines 列顺序修正 KLINE_FIELDS`);
    } else {
      okLine(`字段错位自检通过：${audit.checked - (audit.mismatched || 0)}/${audit.checked} 根涨跌幅与前收自洽`);
    }
  } else {
    badLine(`fetchKline(${OPT.fund}) 返回 null`);
  }
  record('emClient.fetchKline', !!(k && k.bars.length), ms4, k ? `${k.bars.length} 根` : 'null');

  // 2.6 fetchSectors
  const t5 = Date.now();
  const sectors = await client.fetchSectors({ limit: 5 });
  const ms5 = Date.now() - t5;
  if (sectors.length) {
    okLine(`fetchSectors(5) ${ms5}ms → 领涨板块：`);
    for (const s of sectors) {
      infoLine(`#${s.hot_rank} ${String(s.sector_name).padEnd(10)} ${s.pct_chg}%  领涨=${s.leading_stock ?? '-'}`);
    }
  } else {
    badLine(`fetchSectors 返回空`);
  }
  record('emClient.fetchSectors', sectors.length > 0, ms5, `${sectors.length} 个`);

  // 2.7 fetchMoneyFlow
  const t6 = Date.now();
  const flow = await client.fetchMoneyFlow(OPT.stock, { limit: 3 });
  const ms6 = Date.now() - t6;
  if (flow.length) {
    const last = flow[flow.length - 1];
    okLine(`fetchMoneyFlow(${OPT.stock}, 3) ${ms6}ms → ${last.date} 主力净流入 `
      + `${(last.main_net_inflow / 1e4).toFixed(0)} 万元（占比 ${last.main_net_pct}%）`);
  } else {
    badLine('fetchMoneyFlow 返回空');
  }
  record('emClient.fetchMoneyFlow', flow.length > 0, ms6, `${flow.length} 行`);

  // 2.8 运行统计
  const st = client.getStats();
  console.log(`\n  ${C.bold}emClient 运行统计：${C.reset}`);
  infoLine(`请求 ${st.requests} 次｜成功 ${st.ok}｜失败 ${st.failed}｜重试 ${st.retried}｜熔断短路 ${st.shortCircuited}｜平均 ${st.avgMs}ms`);
  infoLine(`缓存 hit=${st.cache.hit} miss=${st.cache.miss} 单飞合并=${st.cache.coalesced} 条目=${st.cache.size}`);
  infoLine(`限频 qps=${st.limiter.qps} 端点qps=${st.limiter.endpointQps} 并发上限=${st.limiter.maxConcurrency}`);
  infoLine(`熔断 open=${st.breaker.open} 连续失败=${st.breaker.consecutiveFailures} 累计跳闸=${st.breaker.trips}`);
  if (st.lastError) infoLine(`${C.yellow}最后错误：${st.lastError}（${st.lastErrorAt}）${C.reset}`);
}

// ------------------------------------------------------------
// 主流程
// ------------------------------------------------------------
async function main() {
  console.log(`${C.bold}东方财富接口探针${C.reset}  ${C.dim}${new Date().toISOString()}${C.reset}`);
  console.log(`${C.dim}探测标的：股票 ${OPT.stock} / ${OPT.stock2}，基金 ${OPT.fund}；`
    + `模式=${OPT.quick ? 'quick' : 'full'}；超时=${OPT.timeoutMs}ms${C.reset}`);

  probeCodeUtil();

  const steps = OPT.quick
    ? [probeQuote, probeKline]
    : [probeQuote, probeQuotes, probeKline, probeClist, probeSectorList, probeFflow];

  for (const step of steps) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await step();
    } catch (e) {
      badLine(`探测步骤 ${step.name} 异常：${e.message}`);
      record(step.name, false, 0, e.message);
    }
  }

  try {
    await probeClient();
  } catch (e) {
    badLine(`emClient 探测异常：${e.message}`);
    record('emClient', false, 0, e.message);
  }

  // 汇总
  title('汇总');
  const pad = Math.max(...results.map((r) => r.name.length), 10);
  for (const r of results) {
    const flag = r.ok ? `${C.green}PASS${C.reset}` : `${C.red}FAIL${C.reset}`;
    console.log(`  ${flag}  ${r.name.padEnd(pad)}  ${String(r.ms).padStart(6)}ms  ${C.dim}${r.note}${C.reset}`);
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n  合计 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`);

  if (failed.length > 0) {
    title('网络根因判别');
    try {
      const diag = await diagnoseNetwork();
      infoLine(`基础出网：${diag.internet ? `${C.green}通${C.reset}` : `${C.red}不通${C.reset}`}`);
      infoLine(`东财官网 quote.eastmoney.com：${diag.emSite ? `${C.green}通${C.reset}` : `${C.red}不通${C.reset}`}`);
      infoLine(`东财行情主机 push2.eastmoney.com：${diag.emQuoteHost ? `${C.green}通${C.reset}` : `${C.red}不通${C.reset}`}`);
      console.log(`\n  ${C.yellow}判定：${diag.verdict}${C.reset}`);
    } catch (e) {
      badLine(`根因判别自身异常：${e.message}`);
    }

    console.log(`\n  ${C.yellow}通用排查清单：${C.reset}`);
    console.log('    1) 全部网络项失败且基础出网不通 → 换能联网的环境重跑；');
    console.log('       需要代理时：.env 设 HTTP_PROXY_URL=http://127.0.0.1:7890 与 EM_USE_PROXY=true，并 npm i undici。');
    console.log('    2) UND_ERR_SOCKET / ECONNRESET → 东财对出口 IP 限流。调低 EM_QPS、EM_MAX_CONCURRENCY，静置后重试。');
    console.log('    3) 字段「缺失」或 klines 列数不匹配 → 东财改版，按上方实测结果修改 server/src/providers/emEndpoints.js。');
    console.log('    4) 代码未联通东财时，DATA_PROVIDER 保持 sqlite 即可，业务链路不受影响（降级已内建）。');
  }

  // 默认优雅退出（离线环境不应判定为失败）
  if (OPT.strict && failed.length > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(`${C.red}探针主流程异常（已捕获，不影响其它任务）：${C.reset}`, e?.stack || e);
  if (OPT.strict) process.exitCode = 1;
});
