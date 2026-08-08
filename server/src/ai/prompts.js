// ============================================================
// AI Prompt 模板（与业务代码分离，便于调优）
// 输出约定：固定小节标题的 Markdown（不强制 JSON，避免解析失败）
// ============================================================

/** 组合诊断 prompt（P-12） */
export function portfolioDiagnosisPrompt({ summary, concentration }) {
  return [
    '你是一位专业的 A 股个人投资组合诊断顾问。请基于以下组合数据输出诊断报告。',
    '',
    '## 组合数据',
    `- 总资产: ${summary.total_asset} 元`,
    `- 总盈亏: ${summary.total_profit} 元（${summary.total_profit_rate}%）`,
    `- 当日盈亏: ${summary.day_profit} 元`,
    `- 持仓数: ${summary.holding_count}`,
    `- 前三大持仓占比 CR3: ${concentration.cr3}%`,
    `- 集中度 HHI: ${concentration.hhi}`,
    `- 行业分布: ${JSON.stringify(concentration.industry_map || {})}`,
    '',
    '## 持仓明细',
    // 占比/偏离必须区分口径：current_pct 是单行占比，target_pct / deviation_pct 是
    // 整个 target_key 类别的目标与偏离，写进 prompt 时要标注清楚，否则模型会把
    // 「单行占比 vs 类别目标」错当成同一口径来点评（历史 P1 缺陷的同源坑）。
    (summary.holdings || []).map((h) =>
      `- ${h.code || '现金'} ${h.name}：${h.asset_class}，市值 ${h.market_value} 元，盈亏率 ${h.profit_rate}%，`
      + `本行占比 ${h.current_pct}%`
      + `（所属类别 ${h.target_key ?? '无'}：类别占比 ${h.group_current_pct ?? '—'}%，`
      + `类别目标 ${h.target_pct ?? '无'}%，类别偏离 ${h.deviation_pct ?? '—'}pt）`
    ).join('\n'),
    '',
    '请严格按以下 Markdown 小节输出（每个小节用 ## 开头）：',
    '## 集中度评价',
    '## 行业分布评价',
    '## 风险提示（至少 2 条）',
    '## 调仓建议（至少 3 条，人话版）',
    '',
    '要求：客观、克制，不构成投资建议。',
  ].join('\n');
}

/** 早盘点评 prompt（M-08） */
export function morningCommentPrompt({ overview, topItems, auctionTop }) {
  return [
    '你是一位 A 股早盘短线情绪分析师。请基于以下数据输出早盘点评。',
    '',
    '## 市场概况',
    `- 交易日: ${overview.trade_date}`,
    `- 上涨家数: ${overview.up_count}，下跌家数: ${overview.down_count}`,
    `- 涨停家数: ${overview.limit_up_count}`,
    `- 全市场平均涨幅: ${overview.avg_pct_chg}%`,
    '',
    '## 竞价涨幅 Top 标的（前 15）',
    (auctionTop || []).slice(0, 15).map((a) =>
      `- ${a.code} ${a.name}：竞价涨幅 ${a.auction_pct}%，量比 ${a.volume_ratio}`
    ).join('\n'),
    '',
    '## 早盘筛选 Top 标的',
    (topItems || []).slice(0, 10).map((r) =>
      `- ${r.code} ${r.name}：评分 ${r.score}，涨幅 ${r.pct_chg}%，命中标签 ${(r.hit_tags || []).join('、')}`
    ).join('\n'),
    '',
    '请严格按以下 Markdown 小节输出：',
    '## 市场情绪（乐观/中性/谨慎 + 理由）',
    '## 板块主线',
    '## 操作提示（仓位建议 + 至少 2 条注意事项）',
    '',
    '要求：简洁有力，不构成投资建议。',
  ].join('\n');
}

/** 尾盘解读 prompt（C-16） */
export function closingInterpretationPrompt({ conditions, topItems }) {
  return [
    '你是一位 A 股尾盘量化选股解读专家。请基于以下筛选逻辑与结果输出解读。',
    '',
    '## 用户筛选条件摘要',
    typeof conditions === 'string' ? conditions : JSON.stringify(conditions || {}),
    '',
    '## 筛选结果 Top 标的',
    (topItems || []).slice(0, 5).map((r) =>
      `- ${r.code} ${r.name}：评分 ${r.score}，涨幅 ${r.pct_chg}%，换手 ${r.metrics?.turnover_rate}%，PE ${r.metrics?.pe_ttm}，命中指标 ${(r.hit_tags || []).join('、')}`
    ).join('\n'),
    '',
    '请严格按以下 Markdown 小节输出：',
    '## 本次筛选在讲什么故事',
    '## Top5 逐只解读（每只 2-3 句，解释量化逻辑）',
    '## 风险提示',
    '',
    '要求：数据驱动，不构成投资建议。',
  ].join('\n');
}
