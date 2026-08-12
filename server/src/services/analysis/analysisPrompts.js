// ============================================================
// 模块 A 量化分析提示词（架构 §9 T03）
// 要求模型只输出指定 JSON；来源必须取自提供的情报，禁止编造 URL/时间；
// 含「情报时效」声明（检索时间 + 最新一条距今天数）。
// ============================================================

/**
 * 组装模块 A 的 LLM 提示词
 * @param {object} ctx
 * @param {object} ctx.snap indicatorService 快照单条（价格/指标/资金流）
 * @param {object} ctx.bundle SearchBundle（联网检索结果）
 * @returns {string} 完整提示词
 */
export function buildQuantPrompt({ snap, bundle }) {
  const now = new Date().toISOString();
  const items = (bundle.results || [])
    .map((r, i) => `${i + 1}. 【${r.publishedAt || '未知时间'}】${r.title || '(无标题)'}\n   来源: ${r.url || '(无链接)'}\n   ${r.snippet || ''}`.slice(0, 400))
    .join('\n');

  const snapshotText = [
    `标的: ${snap.name}（${snap.code}）`,
    `最新交易日: ${snap.trade_date} | 现价: ${snap.price} | 当日涨跌: ${snap.pct_chg}%`,
    `量比: ${snap.volume_ratio ?? '—'} | 换手: ${snap.turnover_rate ?? '—'}%`,
    `MA5/10/20: ${snap.ma5 ?? '—'} / ${snap.ma10 ?? '—'} / ${snap.ma20 ?? '—'}`,
    `MACD DIF/DEA/柱: ${snap.macd_dif ?? '—'} / ${snap.macd_dea ?? '—'} / ${snap.macd_bar ?? '—'}`,
    `5日主力净流入: ${snap.net_inflow_5d ?? '—'} 万 | 当日主力净流入: ${snap.main_net_inflow ?? '—'} 万`,
  ].join('\n');

  return [
    '你是一名专业的 A 股/场内基金基本面分析师。请基于【实时情报】与【盘面快照】对标的做量化分析（基本面 + 消息面 + 资金面 + 板块/产业链表现）。',
    '',
    '## 硬性要求',
    '1. 只输出一个 JSON 对象，不要 Markdown 代码块包裹，不要任何多余文字。',
    '2. 结论必须引用下面的【实时情报】，来源链接与发布时间**必须取自情报列表**，严禁编造 URL 或时间。',
    '3. 如果情报中关于公司/行业的关键事实缺失或互相矛盾，请在 risks 中明确说明「信息不足」。',
    '4. view 只能是 "乐观"、"中性"、"谨慎" 三者之一。',
    '5. action 只能是 "BUY"（建议买入）、"HOLD"（建议持有观望）、"SELL"（建议卖出）、"WATCH"（纳入观察，暂不操作）四者之一，综合 view 与风险给出明确倾向。',
    '6. target_price 为建议目标价（数字字符串，如 "12.50"），无法确定则填空字符串 ""；stop_loss 为建议止损价，无法确定则填空字符串 ""。',
    '',
    '## 输出 JSON 结构',
    '{',
    '  "summary": "一句话结论（50 字内）",',
    '  "view": "乐观 | 中性 | 谨慎",',
    '  "action": "BUY | HOLD | SELL | WATCH",',
    '  "target_price": "目标价，无可不填",',
    '  "stop_loss": "止损价，无可不填",',
    '  "confidence": 0-100 的整数（对结论的信心）',
    '  "key_points": ["核心要点1", "核心要点2", "最多6条"],',
    '  "risks": ["风险1", "风险2", "最多6条"]',
    '}',
    '',
    '## 盘面快照（供参考，只写数字不要展开）',
    snapshotText,
    '',
    '## 实时情报（本次检索时间 ' + now + '，最新一条距今 ' + (bundle.freshness?.newestDays ?? '未知') + ' 天）',
    items || '（本次检索无可用条目）',
    '',
    '请输出 JSON：',
  ].join('\n');
}

/**
 * 流水线 ①选股 —— AI 自主选股提示词（架构 §9 T05）
 * @param {object} ctx
 * @param {string} ctx.sector 板块名（如 "铜"）
 * @param {string} [ctx.style] 'value'（价值投资）| 'trend'（趋势投资）
 * @param {object} ctx.bundle SearchBundle
 * @returns {string}
 */
export function buildSelectPrompt({ sector, style = 'trend', bundle }) {
  const items = (bundle.results || [])
    .map((r, i) => `${i + 1}. 【${r.publishedAt || '未知时间'}】${r.title || '(无标题)'} - ${r.url || '(无链接)'}`)
    .join('\n');
  return [
    `你是 A 股板块研究助手。请基于【实时情报】从板块「${sector}」中选出 3-5 只值得关注的股票（龙头 1-2 只 + 潜力 1-3 只）。`,
    `投资风格：${style === 'value' ? '价值投资（重基本面/估值/股息）' : '趋势投资（重资金流/动量/板块热度）'}。`,
    '',
    '## 硬性要求',
    '1. 只输出一个 JSON 对象：{"candidates":[{"code":"6位代码","name":"名称","style":"龙头|潜力","reason":"一句话理由(40字内)"}]}',
    '2. code 必须是 6 位数字 A 股代码；name 必须准确；理由要基于情报或常识，不要编造具体数据。',
    '3. 只输出 JSON，不要 Markdown 代码块，不要多余文字。',
    '',
    '## 实时情报（检索时间 ' + new Date().toISOString() + '）',
    items || '（无可用情报，请基于常识给出候选）',
    '',
    '请输出 JSON：',
  ].join('\n');
}

export default buildQuantPrompt;
