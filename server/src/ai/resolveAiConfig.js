// ============================================================
// BYOK 解析器（架构 §6.3 / §6.6）—— 全项目唯一的「当前生效 AI 配置」出口
//
// 本模块从 services/aiReportService.js 抽取而来，**行为完全一致**，
// 仅追加了 capabilities 判定，供智能分析中心（T02+）与 aiReportService 共用。
//
// 解析优先级（不可更改，与既有 AI 报告功能保持同一条链）：
//   1. 登录用户且已配置 user_ai_config.api_key → 用该配置（真 BYOK）
//   2. 游客（未登录）                          → 回落服务端 .env 默认（保证演示可用）
//   3. 登录用户但未配置 Key                    → notConfigured=true，禁止调用 AI
//
// 红线：本模块**只解析、不调用**，不发起任何网络请求，不写库。
//       返回的 aiConfig.apiKey 是明文，仅允许在服务端内部流转，
//       任何响应体都只能透出 aiMeta / capabilities，绝不能带 apiKey。
// ============================================================
import { getProvider } from './providers.js';
import env from '../config/env.js';

/**
 * @typedef {object} AiMeta
 * @property {string} provider      厂商 id（如 'zhipu' / 'siliconflow'）
 * @property {string} providerLabel 厂商展示名
 * @property {string} model         生效模型 id
 * @property {boolean} custom       true=用户自配置，false=服务端默认
 */

/**
 * @typedef {object} AiCapabilities
 * @property {boolean} webSearch 是否可用「模型内置联网检索」（当前仅智谱有 Web Search 接口）
 * @property {boolean} vision    是否配置了视觉模型
 */

/**
 * @typedef {object} AiResolution
 * @property {boolean} notConfigured  true = 登录用户未配 Key，调用方须直接拒绝
 * @property {object|null} aiConfig   传给 callLLM 的配置；null 表示回落服务端 .env
 * @property {AiMeta|null} aiMeta     展示用元信息
 * @property {AiCapabilities} capabilities 能力位（让能力差异对用户透明）
 */

/** 支持「独立 Web Search 接口」的厂商白名单（架构 §6.2 路 1） */
export const WEB_SEARCH_CAPABLE_PROVIDERS = Object.freeze(['zhipu']);

/**
 * 计算能力位
 * @param {string|null} provider 厂商 id
 * @param {boolean} hasKey 是否持有可用 Key（游客用服务端 Key 也算）
 * @returns {AiCapabilities} 能力位
 */
function buildCapabilities(provider, hasKey) {
  return {
    webSearch: Boolean(hasKey) && WEB_SEARCH_CAPABLE_PROVIDERS.includes(String(provider || '')),
    vision: Boolean(env.AI_VISION_MODEL),
  };
}

/**
 * 解析当前生效的 AI 配置（供调用 + 展示 + 能力判定）
 *
 * @param {{getRaw: (userId: number) => object|null}} userAiConfigModel 用户 AI 配置模型
 * @param {number|null} userId 当前用户 id；null / undefined 表示游客
 * @returns {AiResolution} 解析结果
 */
export function resolveAiConfig(userAiConfigModel, userId) {
  // 游客（未登录）：沿用服务端默认配置，保证演示可用
  if (!userId) {
    const hasServerKey = Boolean(env.AI_API_KEY);
    return {
      notConfigured: false,
      aiConfig: null, // callLLM 会回落到服务端 .env
      aiMeta: {
        provider: env.AI_PROVIDER,
        providerLabel: getProvider(env.AI_PROVIDER)?.label || env.AI_PROVIDER,
        model: env.AI_MODEL,
        custom: false,
      },
      capabilities: buildCapabilities(env.AI_PROVIDER, hasServerKey),
    };
  }

  const raw = userAiConfigModel && typeof userAiConfigModel.getRaw === 'function'
    ? userAiConfigModel.getRaw(userId)
    : null;

  if (raw && raw.apiKey) {
    const providerLabel = getProvider(raw.provider)?.label || raw.provider;
    return {
      notConfigured: false,
      aiConfig: {
        apiKey: raw.apiKey,
        baseUrl: raw.baseUrl || getProvider(raw.provider)?.baseUrl || '',
        model: raw.model,
        apiStyle: raw.apiStyle,
      },
      aiMeta: {
        provider: raw.provider, providerLabel, model: raw.model, custom: true,
      },
      capabilities: buildCapabilities(raw.provider, true),
    };
  }

  // 已登录但未配置 AI Key → 强制要求先配置，不可使用 AI 功能
  return {
    notConfigured: true,
    aiConfig: null,
    aiMeta: null,
    capabilities: buildCapabilities(null, false),
  };
}

export default resolveAiConfig;
