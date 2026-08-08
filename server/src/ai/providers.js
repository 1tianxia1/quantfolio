// ============================================================
// AI 厂商注册表（单一数据源，前后端共用同一份定义）
// - apiStyle: 'openai'（OpenAI 兼容 /chat/completions）| 'anthropic'（Claude Messages API）
// - baseUrl: 默认接口地址；用户可在「自定义」中覆盖
// - keyHint: Key 输入框占位提示
// - models: 预设模型列表（label 给用户看，id 发给 API）
//   · models[].recommended: 该厂商的首选模型（每个厂商至多一个），
//     用于「一键通」：切换厂商时自动带出，并在下拉中打「推荐」标记。
// 说明：前端通过 GET /api/ai/providers 拉取本表，不重复维护。
// ============================================================

const PROVIDERS = [
  {
    id: 'siliconflow',
    label: '硅基流动 SiliconFlow',
    apiStyle: 'openai',
    baseUrl: 'https://api.siliconflow.cn/v1/chat/completions',
    keyHint: 'SiliconFlow API Key（https://siliconflow.cn/ 获取）',
    models: [
      { id: 'deepseek-ai/DeepSeek-V4-Flash', label: 'DeepSeek-V4-Flash（默认）', recommended: true },
      { id: 'deepseek-ai/DeepSeek-V3', label: 'DeepSeek-V3' },
      { id: 'Qwen/Qwen3-235B-A22B', label: 'Qwen3-235B-A22B' },
      { id: 'THUDM/glm-4-Plus', label: 'GLM-4-Plus' },
      { id: 'Pro/INXYZ-AI/Mark-Large', label: 'Mark-Large' },
    ],
  },
  {
    id: 'deepseek',
    label: '深度求索 DeepSeek',
    apiStyle: 'openai',
    baseUrl: 'https://api.deepseek.com/v1/chat/completions',
    keyHint: 'DeepSeek API Key（https://platform.deepseek.com/ 获取）',
    models: [
      { id: 'deepseek-chat', label: 'deepseek-chat（默认）', recommended: true },
      { id: 'deepseek-reasoner', label: 'deepseek-reasoner（深度思考）' },
    ],
  },
  {
    id: 'openai',
    label: 'OpenAI',
    apiStyle: 'openai',
    baseUrl: 'https://api.openai.com/v1/chat/completions',
    keyHint: 'OpenAI API Key（sk-...）',
    models: [
      { id: 'gpt-4o', label: 'GPT-4o', recommended: true },
      { id: 'gpt-4o-mini', label: 'GPT-4o-mini' },
      { id: 'gpt-4-turbo', label: 'GPT-4 Turbo' },
      { id: 'o3-mini', label: 'o3-mini（推理）' },
      { id: 'gpt-5', label: 'GPT-5' },
    ],
  },
  {
    id: 'anthropic',
    label: 'Anthropic Claude',
    apiStyle: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1/messages',
    keyHint: 'Anthropic API Key（sk-ant-...）',
    models: [
      { id: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4', recommended: true },
      { id: 'claude-opus-4-20250514', label: 'Claude Opus 4' },
      { id: 'claude-3-5-sonnet-20241022', label: 'Claude 3.5 Sonnet' },
      { id: 'claude-3-haiku-20240307', label: 'Claude 3 Haiku' },
    ],
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    apiStyle: 'openai',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    keyHint: 'Gemini API Key（AI Studio 获取）',
    models: [
      { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', recommended: true },
      { id: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash' },
      { id: 'gemini-1.5-pro', label: 'Gemini 1.5 Pro' },
    ],
  },
  {
    id: 'zhipu',
    label: '智谱 GLM',
    apiStyle: 'openai',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    keyHint: '智谱 API Key（https://open.bigmodel.cn/ 获取）',
    models: [
      { id: 'glm-4-flash', label: 'GLM-4-Flash（免费额度）', recommended: true },
      { id: 'glm-4-plus', label: 'GLM-4-Plus' },
      { id: 'glm-4-air', label: 'GLM-4-Air' },
      { id: 'glm-4.5', label: 'GLM-4.5' },
    ],
  },
  {
    id: 'moonshot',
    label: '月之暗面 Moonshot (Kimi)',
    apiStyle: 'openai',
    baseUrl: 'https://api.moonshot.cn/v1/chat/completions',
    keyHint: 'Moonshot API Key（https://platform.moonshot.cn/ 获取）',
    models: [
      { id: 'kimi-k2', label: 'Kimi K2', recommended: true },
      { id: 'moonshot-v1-8k', label: 'Moonshot-v1-8k' },
      { id: 'moonshot-v1-32k', label: 'Moonshot-v1-32k' },
    ],
  },
  {
    id: 'qwen',
    label: '阿里通义千问 Qwen',
    apiStyle: 'openai',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    keyHint: 'DashScope API Key（https://dashscope.console.aliyun.com/ 获取）',
    models: [
      { id: 'qwen-max', label: 'qwen-max', recommended: true },
      { id: 'qwen-plus', label: 'qwen-plus' },
      { id: 'qwen-turbo', label: 'qwen-turbo' },
      { id: 'qwen2.5-72b-instruct', label: 'qwen2.5-72b-instruct' },
    ],
  },
  {
    id: 'ollama',
    label: 'Ollama（本地）',
    apiStyle: 'openai',
    baseUrl: 'http://localhost:11434/v1/chat/completions',
    keyHint: '本地 Ollama 一般无需 Key，可留空',
    models: [
      { id: 'llama3', label: 'llama3' },
      { id: 'qwen2.5', label: 'qwen2.5' },
      { id: 'deepseek-r1', label: 'deepseek-r1' },
    ],
    freeModel: true,
  },
  {
    id: 'custom',
    label: '自定义（自建 / 兼容网关）',
    apiStyle: 'openai',
    baseUrl: '',
    keyHint: '你的 API Key',
    models: [],
    freeModel: true,
    freeBaseUrl: true,
  },
];

/** 从模型列表里挑推荐模型 id：优先 recommended，其次首个，最后空串 */
function pickRecommended(models) {
  return models?.find((m) => m.recommended)?.id || models?.[0]?.id || '';
}

/** 全部厂商（前端下拉用） */
export function listProviders() {
  return PROVIDERS.map((p) => ({
    id: p.id,
    label: p.label,
    apiStyle: p.apiStyle,
    baseUrl: p.baseUrl,
    keyHint: p.keyHint,
    models: p.models,
    recommendedModel: pickRecommended(p.models),
    freeModel: !!p.freeModel,
    freeBaseUrl: !!p.freeBaseUrl,
  }));
}

/** 按 id 取厂商定义（找不到返回 undefined） */
export function getProvider(id) {
  return PROVIDERS.find((p) => p.id === id);
}

/** 按厂商 id 取推荐模型 id（找不到返回空串） */
export function getRecommendedModel(providerId) {
  const p = getProvider(providerId);
  return pickRecommended(p?.models);
}

export default PROVIDERS;
