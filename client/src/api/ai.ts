// ============================================================
// AI API
// ============================================================
import http, { unwrap } from './http';
import { useAuthStore } from '../store/authStore';

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

  /**
   * 组合诊断 SSE 流式接口。
   * 使用原生 fetch + ReadableStream 读取 text/event-stream，支持 Authorization token。
   */
  diagnoseStream(params: {
    force_refresh?: boolean;
    onChunk: (chunk: { delta: string; content: string; cached?: boolean }) => void;
    onDone?: (payload: { content: string; generatedAt?: string; cached?: boolean; aiMeta?: AiReport['ai_meta'] }) => void;
    onError?: (message: string) => void;
  }) {
    return new Promise<void>((resolve, reject) => {
      const qs = new URLSearchParams();
      if (params.force_refresh) qs.set('force_refresh', 'true');
      const token = useAuthStore.getState().token;

      fetch(`/api/ai/diagnose/stream?${qs.toString()}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      }).then(async (res) => {
        if (!res.ok) {
          const text = await res.text().catch(() => '流式请求失败');
          reject(new Error(`HTTP ${res.status}: ${text}`));
          return;
        }
        const reader = res.body?.getReader();
        if (!reader) {
          reject(new Error('响应流不可用'));
          return;
        }
        const decoder = new TextDecoder();
        let buffer = '';
        let doneReceived = false;
        while (!doneReceived) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          let currentEvent = '';
          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('event:')) {
              currentEvent = trimmed.slice(6).trim();
            } else if (trimmed.startsWith('data:')) {
              const data = trimmed.slice(5).trim();
              try {
                const payload = JSON.parse(data);
                if (currentEvent === 'chunk') {
                  params.onChunk(payload);
                } else if (currentEvent === 'done') {
                  doneReceived = true;
                  params.onDone?.(payload);
                } else if (currentEvent === 'error') {
                  params.onError?.(payload.message || 'AI 流式请求失败');
                }
              } catch (_) {
                // 忽略无法解析的 SSE 数据行
              }
            }
          }
        }
        resolve();
      }).catch((err) => reject(err));
    });
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
