// ============================================================
// 持仓图片识别服务：调用视觉大模型，从股票/基金持仓截图提取候选持仓
//
// 处理两类截图：
//   1) 股票持仓：列通常包含 名称、市值、盈亏、持仓/可用、成本/现价
//      → name, code(6位数字), asset_class='stock', quantity=持仓数量, cost_price=成本价
//   2) 基金持有：列通常包含 名称、金额、昨日收益、持有收益/率
//      → 截图给出「金额」，后端按最新净值换算为「份额」入库，
//        保证后续用 fund_nav 估值时市值、当日盈亏计算正确。
//
// 代码回填顺序：模型原始输出 → 本地 securities 表精确匹配 → 天天基金按名称搜索。
// 仍缺失时 code 留空，由用户在导入弹窗补齐。
// ============================================================
import { callVisionLLM } from './aiService.js';
import { searchFundByName } from '../providers/tiantianFundProvider.js';
import { createFundNavService } from './fundNavService.js';
import env from '../config/env.js';
import { ASSET_CLASS } from '../../../shared/constants.js';

/** 默认视觉模型（可被环境变量覆盖） */
const DEFAULT_VISION_MODEL = env.AI_VISION_MODEL || 'Qwen/Qwen3-VL-32B-Instruct';

/** 基金关键词（用于辅助判定 asset_class；注意场内 ETF 已单独按股票口径处理） */
const FUND_KEYWORDS = [
  '联接', '基金', 'LOF', 'QDII', 'FOF', '债券', '货币', '理财',
  '指数', '增强', '混合', '股票型', '债券型', '货币基金',
];

/**
 * 识别持仓截图，返回候选持仓数组
 * @param {import('../db/driver.js').Database} db
 * @param {string[]} imageBase64List 图片 base64 数组
 * @param {object} [opts]
 * @param {string} [opts.model] 指定视觉模型
 * @param {string} [opts.hint] 额外提示（如 'stock' | 'fund'）
 * @param {object} [opts.aiConfig] 来自 resolveAiConfig 的用户自定义配置（BYOK）；null 时回落 .env
 * @returns {Promise<{candidates: object[], warnings: string[]}>}
 */
export async function recognizeHoldingsFromImages(db, imageBase64List, opts = {}) {
  if (!Array.isArray(imageBase64List) || imageBase64List.length === 0) {
    return { candidates: [], warnings: ['未提供任何图片'] };
  }

  // 逐张并发识别：单张图慢 / 失败不影响其它图，多图导入更快也更稳。
  // 并发上限 3，避免对单一 AI Key 一次性打满请求触发限流。
  const CONCURRENCY = 3;
  const perImage = await mapPool(imageBase64List, (b64) => processOneImage(db, b64, opts), CONCURRENCY);

  const candidates = [];
  const warnings = [];
  const failures = [];
  perImage.forEach((r, i) => {
    if (r && r.candidates) candidates.push(...r.candidates);
    if (r && r.warnings) warnings.push(...r.warnings);
    // 单图调用失败（超时 / 5xx / 网络）由 processOneImage 转成 error 字段，不会抛出
    if (!r || r.error) failures.push(`第 ${i + 1} 张：${r?.error?.message || '未知错误'}`);
  });

  // 全部图片都失败 → 整体报错，让路由返回清晰错误而非空结果误导用户；
  // 只要有一张成功就正常返回，失败原因保留在 warnings 里提示用户。
  if (candidates.length === 0 && failures.length === imageBase64List.length) {
    throw new Error(`全部图片识别失败：${failures.join('；')}`);
  }

  if (candidates.length === 0 && warnings.length === 0) {
    warnings.push('未识别到任何持仓记录，请检查图片清晰度或尝试手动添加。');
  }

  return { candidates, warnings };
}

/**
 * 识别单张持仓截图，返回该图的候选持仓与告警。
 * 单张失败（超时 / 5xx / 网络抖动）由调用方 mapPool 兜底捕获，不会向上抛出，
 * 保证一张图的问题不会拖垮整批导入。
 * @returns {Promise<{candidates: object[], warnings: string[], error?: Error}>}
 */
async function processOneImage(db, base64, opts) {
  try {
    const prompt = buildRecognitionPrompt(opts.hint);
    // 单图调用体更小，通常更易在 60s 内返回；超时/5xx/网络的自动重试在 callVisionLLM 内
    const rawText = await callVisionLLM(prompt, [base64], {
      model: opts.model || DEFAULT_VISION_MODEL,
      aiConfig: opts.aiConfig,
      maxTokens: 4096,
      temperature: 0.1,
    });

    const rows = parseModelJson(rawText);
    const candidates = [];
    const warnings = [];

    for (const row of rows) {
      let candidate = normalizeCandidate(row);
      if (!candidate) {
        warnings.push(`无法解析行：${JSON.stringify(row).slice(0, 120)}`);
        continue;
      }

      // 代码回填：模型原始输出 → 本地 securities 精确匹配 → 天天基金远程搜索
      if (!candidate.code && candidate.name) {
        const matched = lookupSecurityByNameExact(db, candidate.name);
        if (matched) {
          candidate.code = matched.code;
        }
      }
      if (!candidate.code && candidate.asset_class === ASSET_CLASS.FUND && candidate.name) {
        const remote = await searchFundByName(candidate.name);
        if (remote) {
          candidate.code = remote.code;
          // 用天天基金的标准简称替换 OCR 名称，减少 A/C 份额等后缀偏差
          if (remote.name && remote.name !== candidate.name) {
            candidate.name = remote.name;
          }
        }
      }

      // 基金：截图给的是「金额」，需按最新净值换算成「份额」入库，
      // 同时把净值持久化到 fund_nav，保证当日盈亏立即生效。
      if (candidate.asset_class === ASSET_CLASS.FUND && candidate.code) {
        try {
          const fn = createFundNavService(db);
          const syncResult = await fn.syncFundNav({ codes: [candidate.code] });
          const nav = syncResult.navs?.find((n) => n.code === candidate.code);
          if (nav && Number.isFinite(nav.nav) && nav.nav > 0) {
            candidate = convertFundAmountToShares(candidate, nav.nav);
            candidate.current_price = nav.nav;
          } else if (syncResult.failed > 0) {
            warnings.push(`${candidate.name} 净值同步失败：${syncResult.failures.map((f) => f.reason).join('; ')}`);
          }
        } catch (e) {
          warnings.push(`获取 ${candidate.name} 净值失败：${e.message}`);
        }
      }

      candidates.push(candidate);
    }

    return { candidates, warnings };
  } catch (e) {
    return {
      candidates: [],
      warnings: [`图片识别失败：${e.message}`],
      error: e instanceof Error ? e : new Error(String(e)),
    };
  }
}

/**
 * 带并发上限的 map：游标 + Promise.all 实现，避免一次性发起过多异步任务把 AI Key 打满。
 * @template T
 * @param {T[]} items
 * @param {(item: T, index: number) => Promise<any>} worker
 * @param {number} concurrency
 * @returns {Promise<any[]>}
 */
async function mapPool(items, worker, concurrency) {
  const results = new Array(items.length);
  let idx = 0;
  async function run() {
    while (idx < items.length) {
      const cur = idx++;
      results[cur] = await worker(items[cur], cur);
    }
  }
  const n = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: n }, run));
  return results;
}

/**
 * 构建识别提示词
 * @param {string} [hint]
 * @returns {string}
 */
function buildRecognitionPrompt(hint) {
  const typeHint = hint === 'stock'
    ? '已知这是股票持仓截图。'
    : hint === 'fund'
      ? '已知这是基金持有截图。'
      : '截图可能是股票持仓或基金持有，请根据表头/内容自行判断每条记录的 type。';

  return [
    '你是一名证券持仓截图 OCR 助手。请识别图片中的持仓列表，并返回严格合法的 JSON 数组。',
    typeHint,
    '',
    '每个数组元素必须包含以下字段：',
    '  - type: "stock" 或 "fund"',
    '  - name: 证券名称（字符串，保留完整名称）',
    '  - code: 证券代码（股票为 6 位数字；基金截图顶部或标题附近通常显示基金代码，如 017141/001938，请务必提取。若截图未显示则省略此字段）',
    '  - quantity: 数量（股票为持仓数量，基金为持有金额；纯数字，去掉千分位逗号）',
    '  - cost_price: 成本价（股票填写截图中的成本价；基金没有成本价则固定填 1）',
    '',
    '以下字段可选，但截图里只要有就必须填写（用于正确显示盈亏）：',
    '  - current_price: 现价（股票「成本/现价」列中斜杠后面的那个数）',
    '  - profit: 累计盈亏金额（是金额不是百分比，保留正负号；基金对应「持有收益」）',
    '  - profit_rate: 累计盈亏率（小数形式，如 -0.0391；基金对应「持有收益率」）',
    '  - day_profit: 当日盈亏金额（保留正负号；场内 ETF/股票对应「当日盈亏」列）',
    '  - day_profit_rate: 当日盈亏率（小数形式，如 0.0123）',
    '',
    '注意：',
    '1. 股票截图通常包含多列：市值、盈亏、持仓/可用、成本/现价。请正确区分「持仓数量」和「成本价」。',
    '2. 基金截图通常包含「金额」「持有收益」「持有收益率」。金额填 quantity，持有收益填 profit，持有收益率填 profit_rate；cost_price 保持 1（后端会根据 profit 自动反推真实成本价）。',
    '3. 名称中若包含 6 位数字代码（如 "000539 粤电力A"），请把代码单独提取到 code 字段，并清理 name。',
    '4. 所有数字请原样照抄截图上显示的位数，不要自己四舍五入或补零。',
    '5. 只输出 JSON 数组，不要 Markdown 代码块，不要任何解释。',
    '',
    '输出示例：',
    '[{"type":"stock","name":"粤电力A","code":"000539","quantity":100,"cost_price":5.966,"current_price":6.01,"profit":4.38},{"type":"fund","name":"华宝中证有色金属ETF联接C","code":"017141","quantity":4028,"cost_price":1,"profit":-163.92,"profit_rate":-0.0391}]',
  ].join('\n');
}

/**
 * 从模型回复中解析 JSON 数组（兼容 Markdown 代码块）
 * @param {string} text
 * @returns {any[]}
 */
function parseModelJson(text) {
  if (!text || typeof text !== 'string') return [];
  const cleaned = text
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();

  // 优先尝试完整文本作为 JSON
  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.candidates)) return parsed.candidates;
    if (parsed && Array.isArray(parsed.data)) return parsed.data;
    return [];
  } catch {
    // 尝试从文本中提取 JSON 数组
    const match = cleaned.match(/\[[\s\S]*\]/);
    if (match) {
      try {
        const parsed = JSON.parse(match[0]);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    }
    return [];
  }
}

/**
 * 将模型输出行标准化为 holdings 字段
 * @param {object} row
 * @returns {object|null}
 */
function normalizeCandidate(row) {
  if (!row || typeof row !== 'object') return null;
  const rawName = String(row.name ?? '').trim();
  if (!rawName) return null;

  const assetClass = inferAssetClass(row.type, rawName, row.asset_class);
  const quantity = parseNumber(row.quantity);
  const costPrice = parseNumber(row.cost_price);

  if (!Number.isFinite(quantity) || quantity < 0) return null;

  // 字段映射：优先使用模型明确输出的 code；其次从名称中提取 6 位数字代码
  const name = cleanName(rawName);
  let code = (row.code ? String(row.code).trim() : null) || extractCodeFromName(rawName) || null;

  const ocrCost = Number.isFinite(costPrice) && costPrice >= 0 ? costPrice : 0;
  const finalCost = assetClass === ASSET_CLASS.FUND
    ? deriveFundCostPrice(quantity, parseNumber(row.profit), parseNumber(row.profit_rate)) || 1
    : refineCostPrice(ocrCost, parseNumber(row.current_price), parseNumber(row.profit), quantity);

  // 截图中识别到的「现价」：股票行直接保留，供导入后估值优先使用（避免无行情时回退成本价）。
  // 基金行稍后会被 convertFundAmountToShares 重写为 NAV，此处先原样记录。
  const parsedCurrent = parseNumber(row.current_price);
  const currentPrice = Number.isFinite(parsedCurrent) && parsedCurrent > 0 ? parsedCurrent : null;

  // 截图 OCR 回填的盈亏字段：原样保留，供导入后估值优先展示（保证与券商 App 截图完全一致）。
  // profit / day_profit 允许为负（亏损持仓）；非有限值视为未提供（null）。
  const parsedProfit = parseNumber(row.profit);
  const ocrProfit = Number.isFinite(parsedProfit) ? parsedProfit : null;
  const parsedProfitRate = parseNumber(row.profit_rate);
  const ocrProfitRate = Number.isFinite(parsedProfitRate) ? parsedProfitRate : null;
  const parsedDayProfit = parseNumber(row.day_profit);
  const ocrDayProfit = Number.isFinite(parsedDayProfit) ? parsedDayProfit : null;
  const parsedDayProfitRate = parseNumber(row.day_profit_rate);
  const ocrDayProfitRate = Number.isFinite(parsedDayProfitRate) ? parsedDayProfitRate : null;

  return {
    code,
    name,
    asset_class: assetClass,
    quantity: Math.round(quantity * 10000) / 10000,
    cost_price: finalCost,
    current_price: currentPrice,
    profit: ocrProfit,
    profit_rate: ocrProfitRate,
    day_profit: ocrDayProfit,
    day_profit_rate: ocrDayProfitRate,
  };
}

/**
 * 基金成本价反推 —— 用持有金额 + 持有收益/率算出「相对成本价」。
 *
 * 基金截图给出的是「持有金额」而非份额，在换算成份额前先把成本价
 * 表示为「成本金额 / 持有金额」的相对值（≈1）：
 *   相对 cost_price = 成本金额 / 持有金额 = 1 − profit / quantity
 *
 * 后续 convertFundAmountToShares 会把它转成真实的「每份成本净值」。
 *
 * @param {number} quantity 持有金额
 * @param {number} profit 持有收益金额（可能为 NaN）
 * @param {number} profitRate 持有收益率（可能为 NaN）
 * @returns {number|null} 反推后的相对 cost_price，无有效数据时返回 null
 */
function deriveFundCostPrice(quantity, profit, profitRate) {
  if (!Number.isFinite(quantity) || quantity <= 0) return null;

  // 优先使用「持有收益金额」反推，因为它与截图显示完全一致
  if (Number.isFinite(profit)) {
    const derived = (quantity - profit) / quantity;
    if (Number.isFinite(derived) && derived > 0) return derived;
  }

  // 没有收益金额时，用持有收益率兜底
  if (Number.isFinite(profitRate)) {
    const derived = 1 - profitRate;
    if (Number.isFinite(derived) && derived > 0) return derived;
  }

  return null;
}

/**
 * 把基金截图的「金额模型」转换为「份额模型」。
 *
 * 截图给出：amount（持有金额）、relativeCost（成本金额/持有金额，≈1）。
 * 通过最新净值 nav 计算：
 *   份额 quantity = amount / nav
 *   每份成本 cost_price = (amount × relativeCost) / quantity = relativeCost × nav
 *
 * 转换后成本金额保持不变，市值与当日盈亏可用标准公式计算。
 *
 * @param {object} candidate
 * @param {number} nav 最新单位净值
 * @returns {object}
 */
function convertFundAmountToShares(candidate, nav) {
  if (!Number.isFinite(nav) || nav <= 0) return candidate;
  const amount = candidate.quantity;
  if (!Number.isFinite(amount) || amount <= 0) return candidate;

  const shares = amount / nav;
  const relativeCost = Number.isFinite(candidate.cost_price) && candidate.cost_price > 0
    ? candidate.cost_price
    : 1;
  const costPerShare = relativeCost * nav;

  return {
    ...candidate,
    quantity: Math.round(shares * 10000) / 10000,
    cost_price: Math.round(costPerShare * 10000) / 10000,
  };
}

/**
 * ★ 成本价精度校正 —— 修复「截图成本价只有 3 位小数」导致盈亏与券商对不上的问题
 *
 * 券商 App（同花顺等）的「成本/现价」列是四舍五入后的展示值（如 5.966），
 * 但同一行的「盈亏」却是用未舍入的真实成本算出来的。直接把展示值写库会失真：
 *   (6.01 − 5.966 ) × 100 = 4.40  ← 用展示成本，与券商差 0.02
 *   (6.01 − 5.9662) × 100 = 4.38  ← 券商真实值
 *
 * 因此当截图同时给出「现价 + 盈亏」时，反解出真实成本价：
 *   cost = current_price − profit / quantity
 *
 * 安全阀：只有当反解值与 OCR 成本价之差在「展示位数的舍入误差」以内才采信，
 * 否则说明 OCR 把某一列读错了（如把盈亏率当成盈亏），此时保留原值不动。
 *
 * @param {number} ocrCost OCR 读到的成本价（展示值）
 * @param {number} currentPrice OCR 读到的现价（可能为 NaN）
 * @param {number} profit OCR 读到的累计盈亏金额（可能为 NaN）
 * @param {number} quantity 持仓数量
 * @returns {number} 校正后的成本价（最多 4 位小数）
 */
function refineCostPrice(ocrCost, currentPrice, profit, quantity) {
  if (!Number.isFinite(currentPrice) || !Number.isFinite(profit)) return ocrCost;
  if (!Number.isFinite(quantity) || quantity <= 0) return ocrCost;
  if (!Number.isFinite(ocrCost) || ocrCost <= 0) return ocrCost;

  const derived = currentPrice - profit / quantity;
  if (!Number.isFinite(derived) || derived <= 0) return ocrCost;

  // 展示值的最大舍入误差：小数位数 d 对应 0.5 × 10^-d，再留一点浮点余量
  const decimals = decimalPlacesOf(ocrCost);
  const tolerance = 0.5 * 10 ** -decimals + 1e-9;
  if (Math.abs(derived - ocrCost) > tolerance) return ocrCost;

  // 存储精度统一 4 位（与 server/src/util/money.js 的 round4 一致）
  return Math.round((derived + Number.EPSILON) * 10000) / 10000;
}

/**
 * 取数值的小数位数（用于推断券商展示精度）
 * @param {number} n
 * @returns {number}
 */
function decimalPlacesOf(n) {
  const s = String(n);
  const dot = s.indexOf('.');
  return dot < 0 ? 0 : s.length - dot - 1;
}

/**
 * 仅供单元测试使用的内部函数导出。
 *
 * refineCostPrice 是「成本价精度」的防复发关卡，一旦被改坏，
 * 券商盈亏对不上的 Bug 会静默回归，因此必须有单测守住。
 * 这些函数属于模块实现细节，业务代码请勿直接引用。
 */
export const __test__ = {
  refineCostPrice,
  decimalPlacesOf,
  normalizeCandidate,
  parseNumber,
  deriveFundCostPrice,
};

/**
 * 推断资产类别
 * @param {string} [type]
 * @param {string} name
 * @param {string} [assetClass]
 * @returns {string}
 */
function inferAssetClass(type, name, assetClass) {
  if (assetClass && Object.values(ASSET_CLASS).includes(assetClass)) return assetClass;
  const t = String(type || '').toLowerCase();
  if (t === 'stock' || t === '股票') return ASSET_CLASS.STOCK;
  if (t === 'fund' || t === '基金') return ASSET_CLASS.FUND;
  // 含基金关键词 → 强制基金，避免「黄金 ETF 华安」等被错判为股票
  const upper = name.toUpperCase();
  // 场外基金（联接/LOF/QDII/FOF 等）：截图给「持有金额」，走金额÷净值→份额换算
  if (upper.includes('联接') || upper.includes('LOF') || upper.includes('QDII') || upper.includes('FOF')) {
    return ASSET_CLASS.FUND;
  }
  // ★ 场内 ETF（名称含 ETF 但非联接/LOF）：按股票口径处理（现价×份额），
  // 不要走场外基金的「金额÷净值→份额」换算——否则会把「持仓份额」当「持有金额」
  // 除净值，算出错份额且市值归零（典型症状：黄金ETF华安显示 ¥0.0000 / 0.0000% / ¥0.0000）。
  if (upper.includes('ETF')) return ASSET_CLASS.STOCK;
  if (FUND_KEYWORDS.some((kw) => upper.includes(kw))) return ASSET_CLASS.FUND;
  return ASSET_CLASS.STOCK;
}

/**
 * 清洗名称（去掉首尾代码、多余空格）
 * @param {string} name
 * @returns {string}
 */
function cleanName(name) {
  return name
    .replace(/^\d{6}\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 从名称中提取 6 位数字代码
 * @param {string} name
 * @returns {string|null}
 */
function extractCodeFromName(name) {
  const m = String(name).match(/\b\d{6}\b/);
  return m ? m[0] : null;
}

/**
 * 解析数值（去掉千分位、正号、百分号；★ 负号必须保留）
 *
 * ⚠ 不要「顺手」把 `-` 也剥掉：profit 字段允许为负（亏损持仓），
 * 一旦剥掉负号，refineCostPrice 会把成本价反解到相反方向
 * （如亏损 −1908 被读成 +1908），所有亏损持仓的成本价都会被写错。
 *
 * @param {any} v
 * @returns {number}
 */
function parseNumber(v) {
  if (v === null || v === undefined || v === '') return NaN;
  if (typeof v === 'number') return v;
  const s = String(v)
    .replace(/,/g, '')
    .replace(/\+/g, '')
    .replace(/%/g, '')
    .trim();
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}


/**
 * 按名称在本地 securities 表中精确查找代码（用于基金回填，避免串码）
 * @param {import('../db/driver.js').Database} db
 * @param {string} name
 * @returns {{code:string,name:string,type:string}|null}
 */
export function lookupSecurityByNameExact(db, name) {
  try {
    const exact = db.get('SELECT code, name, type FROM securities WHERE name = ? LIMIT 1', [name]);
    if (exact) return exact;

    // 去除常见份额后缀（A/C）后再试，例如「华夏黄金ETF联接A」→「华夏黄金ETF联接」
    const stripped = name.replace(/[ＡＢＣABC]$/g, '').trim();
    if (stripped !== name) {
      const strippedExact = db.get('SELECT code, name, type FROM securities WHERE name = ? LIMIT 1', [stripped]);
      if (strippedExact) return strippedExact;
    }
  } catch (e) {
    console.warn('[holdingImageService] 名称精确查库失败:', e.message);
  }
  return null;
}


