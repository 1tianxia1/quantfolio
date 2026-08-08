// ============================================================
// 持仓图片识别服务：调用视觉大模型，从股票/基金持仓截图提取候选持仓
//
// 处理两类截图：
//   1) 股票持仓：列通常包含 名称、市值、盈亏、持仓/可用、成本/现价
//      → name, code(6位数字), asset_class='stock', quantity=持仓数量, cost_price=成本价
//   2) 基金持有：列通常包含 名称、金额、昨日收益、持有收益/率
//      → name, code(基金代码如有), asset_class='fund', quantity=金额, cost_price=1
//
// 识别结果会经本地 securities 表做名称→代码回填；仍缺失时 code 留空。
// ============================================================
import { callVisionLLM } from './aiService.js';
import env from '../config/env.js';
import { ASSET_CLASS } from '../../../shared/constants.js';

/** 默认视觉模型（可被环境变量覆盖） */
const DEFAULT_VISION_MODEL = env.AI_VISION_MODEL || 'Qwen/Qwen3-VL-32B-Instruct';

/** 基金关键词（用于辅助判定 asset_class） */
const FUND_KEYWORDS = [
  'ETF', '联接', '基金', 'LOF', 'QDII', 'FOF', '债券', '货币', '理财',
  '指数', '增强', '混合', '股票型', '债券型', '货币基金',
];

/**
 * 识别持仓截图，返回候选持仓数组
 * @param {import('../db/driver.js').Database} db
 * @param {string[]} imageBase64List 图片 base64 数组
 * @param {object} [opts]
 * @param {string} [opts.model] 指定视觉模型
 * @param {string} [opts.hint] 额外提示（如 'stock' | 'fund'）
 * @returns {Promise<{candidates: object[], warnings: string[]}>}
 */
export async function recognizeHoldingsFromImages(db, imageBase64List, opts = {}) {
  const prompt = buildRecognitionPrompt(opts.hint);
  const rawText = await callVisionLLM(prompt, imageBase64List, {
    model: opts.model || DEFAULT_VISION_MODEL,
    maxTokens: 4096,
    temperature: 0.1,
    timeoutMs: env.AI_VISION_TIMEOUT_MS || 60000,
  });

  const rows = parseModelJson(rawText);
  const candidates = [];
  const warnings = [];

  for (const row of rows) {
    const candidate = normalizeCandidate(row);
    if (!candidate) {
      warnings.push(`无法解析行：${JSON.stringify(row).slice(0, 120)}`);
      continue;
    }

    // 代码回填：仅当模型/名称均未提供代码时才进行。
    // 股票与基金都只做精确匹配回填——本地 securities 表仅含场内证券，
    // 模糊匹配极易把 A 基金错串成 B 基金代码（或股票串号），宁可不填让用户补齐。
    if (!candidate.code && candidate.name) {
      const matched = lookupSecurityByNameExact(db, candidate.name);
      if (matched) {
        candidate.code = matched.code;
      }
    }

    candidates.push(candidate);
  }

  if (candidates.length === 0 && warnings.length === 0) {
    warnings.push('未识别到任何持仓记录，请检查图片清晰度或尝试手动添加。');
  }

  return { candidates, warnings };
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

  return {
    code,
    name,
    asset_class: assetClass,
    quantity: Math.round(quantity * 10000) / 10000,
    cost_price: finalCost,
  };
}

/**
 * 基金成本价反推 —— 用持有金额 + 持有收益/率算出真实成本价
 *
 * 基金截图给出的是「持有金额」而非份额，我们把 quantity 记为金额，
 * current_price 固定视为 1，则：
 *   市值 = quantity × 1 = 持有金额
 *   成本 = 持有金额 − 持有收益
 *   cost_price = 成本 / quantity = 1 − profit / quantity = 1 − profit_rate
 *
 * 优先使用 profit（金额）计算，因为它与截图显示完全一致；
 * profit_rate 作为兜底，并做交叉校验防止 OCR 把盈亏率读错。
 *
 * @param {number} quantity 持有金额
 * @param {number} profit 持有收益金额（可能为 NaN）
 * @param {number} profitRate 持有收益率（可能为 NaN）
 * @returns {number|null} 反推后的 cost_price，无有效数据时返回 null
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


