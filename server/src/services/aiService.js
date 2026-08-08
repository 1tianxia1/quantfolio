// ============================================================
// AI 服务：统一封装大模型调用
// 支持两类协议：
//   - openai   ：OpenAI 兼容 /chat/completions（SiliconFlow/DeepSeek/OpenAI/智谱/Moonshot/Qwen/Gemini/Ollama/自定义）
//   - anthropic：Claude Messages API（api.anthropic.com/v1/messages）
//
// 配置来源优先级：
//   1. 调用方传入的 aiConfig（来自登录用户的 user_ai_config 表，即「自定义模型」功能）
//   2. 服务端 .env 的 AI_* 变量（系统默认）
// 任一方式缺失 Key 时抛错；调用失败由上层服务回落本地规则摘要。
// ============================================================
import env from '../config/env.js';

/**
 * 解析最终生效的 AI 配置
 * @param {object} [aiConfig] 用户自定义配置 { apiKey, baseUrl, model, apiStyle }
 * @returns {{apiKey:string, baseUrl:string, model:string, apiStyle:string}}
 */
function resolveConfig(aiConfig) {
  const fallback = {
    apiKey: env.AI_API_KEY,
    baseUrl: env.AI_BASE_URL,
    model: env.AI_MODEL,
    apiStyle: 'openai',
  };
  if (!aiConfig) return fallback;
  return {
    apiKey: aiConfig.apiKey || fallback.apiKey,
    baseUrl: aiConfig.baseUrl || fallback.baseUrl,
    model: aiConfig.model || fallback.model,
    apiStyle: aiConfig.apiStyle || fallback.apiStyle,
  };
}

/**
 * 调用大模型
 * @param {string} prompt 用户侧提示词（已含系统要求）
 * @param {object} opts
 * @param {object} [opts.aiConfig] 用户自定义配置（覆盖 .env 默认）
 * @param {number} [opts.temperature]
 * @param {number} [opts.maxTokens]
 * @returns {Promise<string>} 模型回复文本
 */
export async function callLLM(prompt, opts = {}) {
  const cfg = resolveConfig(opts.aiConfig);
  if (!cfg.apiKey) {
    throw new Error('AI_API_KEY 未配置（请到「模型设置」填写你的 Key，或联系管理员配置服务端 .env）');
  }
  if (!cfg.baseUrl) {
    throw new Error('AI 接口地址未配置');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.AI_TIMEOUT_MS);

  try {
    const content = cfg.apiStyle === 'anthropic'
      ? await callAnthropic(cfg, prompt, opts, controller.signal)
      : await callOpenAI(cfg, prompt, opts, controller.signal);
    return content;
  } catch (e) {
    if (e.name === 'AbortError') {
      throw new Error('AI 请求超时');
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 调用视觉大模型（支持 image_url 多图输入）
 * @param {string} prompt 用户侧提示词
 * @param {string[]} imageBase64List 图片 base64 数组（不含 data URI 前缀）
 * @param {object} opts
 * @param {string} [opts.model] 覆盖默认视觉模型
 * @param {object} [opts.aiConfig] 用户自定义配置（覆盖 .env 默认）
 * @param {number} [opts.temperature]
 * @param {number} [opts.maxTokens]
 * @param {number} [opts.timeoutMs] 覆盖默认超时
 * @returns {Promise<string>} 模型回复文本
 */
export async function callVisionLLM(prompt, imageBase64List, opts = {}) {
  const cfg = resolveConfig(opts.aiConfig);
  if (!cfg.apiKey) {
    throw new Error('AI_API_KEY 未配置（请到「模型设置」填写你的 Key，或联系管理员配置服务端 .env）');
  }
  if (!cfg.baseUrl) {
    throw new Error('AI 接口地址未配置');
  }
  if (!Array.isArray(imageBase64List) || imageBase64List.length === 0) {
    throw new Error('图片参数不能为空');
  }

  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? env.AI_VISION_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const content = cfg.apiStyle === 'anthropic'
      ? await callAnthropicVision(cfg, prompt, imageBase64List, opts, controller.signal)
      : await callOpenAIVision(cfg, prompt, imageBase64List, opts, controller.signal);
    return content;
  } catch (e) {
    if (e.name === 'AbortError') {
      throw new Error('AI 图片识别请求超时');
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** OpenAI 兼容协议 */
async function callOpenAI(cfg, prompt, opts, signal) {
  const res = await fetch(cfg.baseUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      messages: [
        { role: 'system', content: '你是 QuantFolio 的量化分析助手，输出使用中文 Markdown。' },
        { role: 'user', content: prompt },
      ],
      temperature: opts.temperature ?? 0.7,
      max_tokens: opts.maxTokens ?? 1024,
      stream: false,
    }),
    signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`AI API 返回 ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('AI API 响应缺少 content');
  return String(content);
}

/** OpenAI 兼容协议 — 视觉多图 */
async function callOpenAIVision(cfg, prompt, imageBase64List, opts, signal) {
  const content = [
    { type: 'text', text: prompt },
    ...imageBase64List.map((b64) => ({
      type: 'image_url',
      image_url: { url: b64.startsWith('data:') ? b64 : `data:image/jpeg;base64,${b64}` },
    })),
  ];
  const res = await fetch(cfg.baseUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: opts.model || cfg.model,
      messages: [
        { role: 'system', content: '你是 QuantFolio 的 OCR 助手，只输出请求指定的结构化数据，不要多余解释。' },
        { role: 'user', content },
      ],
      temperature: opts.temperature ?? 0.1,
      max_tokens: opts.maxTokens ?? 2048,
      stream: false,
    }),
    signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`AI API 返回 ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error('AI API 响应缺少 content');
  return String(text);
}

/** Anthropic Claude Messages 协议 — 视觉多图 */
async function callAnthropicVision(cfg, prompt, imageBase64List, opts, signal) {
  const content = [
    { type: 'text', text: prompt },
    ...imageBase64List.map((b64) => {
      const raw = b64.startsWith('data:') ? b64.split(',')[1] : b64;
      return { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: raw } };
    }),
  ];
  const res = await fetch(cfg.baseUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': cfg.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: opts.model || cfg.model,
      max_tokens: opts.maxTokens ?? 2048,
      system: '你是 QuantFolio 的 OCR 助手，只输出请求指定的结构化数据，不要多余解释。',
      messages: [{ role: 'user', content }],
    }),
    signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`AI API 返回 ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  const text = data?.content?.find((b) => b.type === 'text')?.text;
  if (!text) throw new Error('AI API 响应缺少 content');
  return String(text);
}

/** Anthropic Claude Messages 协议 */
async function callAnthropic(cfg, prompt, opts, signal) {
  const res = await fetch(cfg.baseUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': cfg.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: opts.maxTokens ?? 1024,
      system: '你是 QuantFolio 的量化分析助手，输出使用中文 Markdown。',
      messages: [{ role: 'user', content: prompt }],
    }),
    signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`AI API 返回 ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  const content = data?.content?.find((b) => b.type === 'text')?.text;
  if (!content) throw new Error('AI API 响应缺少 content');
  return String(content);
}

/**
 * 连通性测试：用极短提示词验证 Key / 地址 / 模型是否可用
 * @param {object} aiConfig { apiKey, baseUrl, model, apiStyle }
 * @returns {Promise<{ok:true, model:string}>}
 */
export async function testLLM(aiConfig) {
  const cfg = resolveConfig(aiConfig);
  if (!cfg.apiKey) throw new Error('请先填写 API Key');
  if (!cfg.baseUrl) throw new Error('请先填写接口地址');
  if (!cfg.model) throw new Error('请先选择模型');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.AI_TIMEOUT_MS);

  try {
    const content = cfg.apiStyle === 'anthropic'
      ? await callAnthropic(cfg, '请只回复「OK」两个字，不要多余内容。', { maxTokens: 16 })
      : await callOpenAI(cfg, '请只回复「OK」两个字，不要多余内容。', { maxTokens: 16 });
    if (!content || !String(content).trim()) throw new Error('模型返回为空');
    return { ok: true, model: cfg.model };
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('连接超时，请检查地址与网络');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 降级为本地规则版摘要（AI 失败时兜底，保证不白屏）
 * @param {'portfolio_diagnosis'|'morning_comment'|'closing_interpretation'} type
 * @param {object} ctx
 */
export function localFallback(type, ctx = {}) {
  if (type === 'portfolio_diagnosis') {
    const s = ctx.summary || {};
    const c = ctx.concentration || {};
    return [
      '## 集中度评价',
      `当前组合总资产 ${s.total_asset ?? '—'} 元，前三大持仓占比 CR3 = ${c.cr3 ?? '—'}%。`,
      c.cr3 >= 50 ? '集中度偏高，组合波动受少数标的影响较大。' : '集中度处于合理范围。',
      '',
      '## 行业分布评价',
      `主要行业分布：${JSON.stringify(c.industry_map || {})}。`,
      '',
      '## 风险提示',
      '1. 单一标的占比过高时，注意个股黑天鹅风险。',
      '2. 行业过度集中时，注意板块轮动带来的共振回撤。',
      '3. 浮亏标的需评估止损位与仓位上限。',
      '',
      '## 调仓建议',
      '1. 将偏离目标配置超过阈值的标的逐步调回目标比例。',
      '2. 可优先卖出超配且浮盈的标的，回补低配标的。',
      '3. 保持一定现金比例，等待确定性机会。',
      '',
      '> 注：AI 服务暂不可用，以上为本地规则版兜底摘要。',
    ].join('\n');
  }
  if (type === 'morning_comment') {
    const o = ctx.overview || {};
    return [
      '## 市场情绪',
      `上涨 ${o.up_count ?? '—'} 家 / 下跌 ${o.down_count ?? '—'} 家，涨停 ${o.limit_up_count ?? '—'} 家，全市场平均涨幅 ${o.avg_pct_chg ?? '—'}%。整体情绪${(o.up_count ?? 0) > (o.down_count ?? 0) ? '偏乐观' : '偏谨慎'}。`,
      '',
      '## 板块主线',
      '建议关注竞价涨幅靠前、量比放大的板块与个股，回避情绪退潮的高位股。',
      '',
      '## 操作提示',
      '1. 建议控制仓位，追高需谨慎。',
      '2. 竞价高开超过 5% 的标的注意回落风险。',
      '3. 优先选择量比靠前且属于热点板块的标的。',
      '',
      '> 注：AI 服务暂不可用，以上为本地规则版兜底摘要。',
    ].join('\n');
  }
  // closing_interpretation
  const top = (ctx.topItems || []).slice(0, 5);
  return [
    '## 本次筛选在讲什么故事',
    `本次筛选共命中 ${ctx.total ?? '—'} 只标的，条件组合为趋势/动能/量能/估值的多因子 AND 过滤，寻找技术形态与量能共振的机会。`,
    '',
    '## Top5 逐只解读',
    ...(top.length
      ? top.map((r, i) => `${i + 1}. ${r.code} ${r.name}：评分 ${r.score}，涨幅 ${r.pct_chg ?? '—'}%，命中标签 ${(r.hit_tags || []).join('、')}。`)
      : ['暂无筛选结果。']),
    '',
    '## 风险提示',
    '1. 指标筛选基于历史数据，不保证未来表现。',
    '2. 注意个股与板块的共振回撤风险。',
    '3. 建议结合基本面与仓位管理使用。',
    '',
    '> 注：AI 服务暂不可用，以上为本地规则版兜底摘要。',
  ].join('\n');
}
