// ============================================================
// AI API
// ============================================================
import http, { unwrap } from './http';

export interface AiReport {
  id: number;
  report_type: string;
  ref_key: string;
  trade_date: string;
  content: string;
  cached: boolean;
  generated_at: string;
  /** 登录但未配置 AI Key 时为真，前端据此引导去「模型设置」 */
  notConfigured?: boolean;
  ai_meta?: {
    provider?: string;
    providerLabel?: string;
    model?: string;
    custom?: boolean;
  };
}

export const aiApi = {
  diagnose(data: { force_refresh?: boolean }) {
    return unwrap<AiReport>(http.post('/ai/diagnose', data));
  },
  morningComment(data: { items?: unknown[]; force_refresh?: boolean }) {
    return unwrap<AiReport>(http.post('/ai/morning-comment', data));
  },
  closingInterpret(data: { items?: unknown[]; conditions?: unknown; strategy_id?: number | null; force_refresh?: boolean }) {
    return unwrap<AiReport>(http.post('/ai/closing-interpret', data));
  },

  // ---------- 自定义模型（厂商注册表 / 个人配置 / 测试） ----------
  providers() {
    return unwrap<AiProvider[]>(http.get('/ai/providers'));
  },
  getConfig() {
    return unwrap<AiConfigMasked>(http.get('/ai/config'));
  },
  saveConfig(data: AiConfigInput) {
    return unwrap<AiConfigMasked>(http.put('/ai/config', data));
  },
  testConfig(data: AiConfigInput & { apiKey?: string }) {
    return unwrap<{ ok: boolean; model: string }>(http.post('/ai/config/test', data));
  },
};

// ---------- 类型 ----------
export interface AiProvider {
  id: string;
  label: string;
  apiStyle: 'openai' | 'anthropic';
  baseUrl: string;
  keyHint: string;
  models: { id: string; label: string; recommended?: boolean }[];
  /** 该厂商的推荐模型 id（后端 listProviders 计算：recommended 优先，回落首个） */
  recommendedModel?: string;
  freeModel?: boolean;
  freeBaseUrl?: boolean;
}

export interface AiConfigMasked {
  userId?: number;
  provider: string;
  apiKeyMasked?: string;
  hasKey: boolean;
  baseUrl: string;
  model: string;
  apiStyle: 'openai' | 'anthropic';
  updatedAt?: string;
}

export interface AiConfigInput {
  provider?: string;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  apiStyle?: 'openai' | 'anthropic';
}
