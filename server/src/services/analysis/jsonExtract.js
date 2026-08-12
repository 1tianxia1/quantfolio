// ============================================================
// JSON 提取（三级容错，架构 §9 T03）
// 1) fenced ```json ... ```  2) 最外层 {...}  3) 直接 parse
// 任何一级失败返回 null，由上层走 degraded 兜底。
// ============================================================

/** 尝试 JSON.parse 一段文本 */
function tryParse(s) {
  try {
    return JSON.parse(s);
  } catch (_) {
    return null;
  }
}

/**
 * 从 LLM 回复文本中提取 JSON 对象
 * @param {string|null|undefined} text 模型回复
 * @returns {object|null} 解析结果；失败返回 null
 */
export function jsonExtract(text) {
  if (!text) return null;
  const s = String(text).trim();
  if (!s) return null;

  // 1) fenced code block
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence && fence[1]) {
    const r = tryParse(fence[1].trim());
    if (r) return r;
  }

  // 2) 最外层大括号（含数组包裹时取第一个对象）
  const obj = s.match(/\{[\s\S]*\}/);
  if (obj) {
    const r = tryParse(obj[0]);
    if (r) return r;
  }

  // 3) 原样
  return tryParse(s);
}

/**
 * 规范化结论字段（防御脏数据：类型不对则回退默认）
 * @param {object} parsed jsonExtract 结果
 * @returns {object} { summary, view, action, target_price, stop_loss, confidence, key_points, risks }
 */
export function normalizeConclusion(parsed) {
  const str = (v, dflt = '') => (typeof v === 'string' && v.trim() ? v.trim() : dflt);
  const arr = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).slice(0, 8) : []);
  const num = (v, dflt = 0) => (Number.isFinite(Number(v)) ? Math.min(100, Math.max(0, Number(v))) : dflt);

  const viewRaw = String(parsed?.view || '').toLowerCase();
  const view = ['乐观', '中性', '谨慎'].includes(viewRaw) || ['bullish', 'positive', '乐观'].includes(viewRaw)
    ? (viewRaw === 'bullish' || viewRaw === 'positive' ? '乐观' : viewRaw)
    : viewRaw === 'bearish' || viewRaw === 'negative' || viewRaw === '谨慎'
      ? '谨慎'
      : viewRaw === '中性' || viewRaw === 'neutral' || viewRaw === '观望'
        ? '中性'
        : '中性';

  // action 规范化：BUY / SELL / HOLD / WATCH（大小写不敏感），缺失时按 view 兜底
  const actionRaw = String(parsed?.action || '').toUpperCase().trim();
  let action;
  if (['BUY', 'SELL', 'HOLD', 'WATCH'].includes(actionRaw)) {
    action = actionRaw;
  } else {
    action = view === '乐观' ? 'BUY' : view === '谨慎' ? 'SELL' : 'HOLD';
  }

  // 目标价 / 止损价：仅当为合法正数数字字符串时保留
  const priceStr = (v) => {
    const s = str(v);
    if (!s) return null;
    const n = Number(s);
    return Number.isFinite(n) && n > 0 ? s : null;
  };

  return {
    summary: str(parsed?.summary, 'AI 未给出有效结论摘要。'),
    view,
    action,
    target_price: priceStr(parsed?.target_price),
    stop_loss: priceStr(parsed?.stop_loss),
    confidence: Math.round(num(parsed?.confidence, 50)),
    key_points: arr(parsed?.key_points),
    risks: arr(parsed?.risks),
  };
}

export default jsonExtract;
