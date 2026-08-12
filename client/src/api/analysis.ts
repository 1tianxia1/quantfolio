// ============================================================
// 智能分析中心 API 封装
// ============================================================
import http, { unwrap } from './http';

export interface RuleHit {
  id: string;
  label: string;
  direction: 'bullish' | 'bearish' | 'neutral';
  weight: number;
  detail?: string | null;
}

export interface IndicatorSnapshot {
  price: number | null;
  pct_chg: number | null;
  volume_ratio: number | null;
  vol_ratio_5: number | null;
  turnover_rate: number | null;
  ma5: number | null;
  ma10: number | null;
  ma20: number | null;
  ma60: number | null;
  macd_dif: number | null;
  macd_dea: number | null;
  macd_bar: number | null;
  rsi12: number | null;
  kdj_k: number | null;
  kdj_d: number | null;
  kdj_j: number | null;
  net_inflow_5d: number | null;
  main_net_inflow: number | null;
}

export interface SeriesBar {
  date: string;
  open: number | null;
  close: number | null;
  high: number | null;
  low: number | null;
  volume: number | null;
  pct_chg: number | null;
  volume_ratio: number | null;
  dif: number | null;
  dea: number | null;
  bar: number | null;
}

export interface TechnicalReport {
  code: string;
  name: string;
  type: string;
  trade_date: string;
  is_otc_fund?: boolean;
  data_origin: string;
  action: 'buy' | 'sell' | 'hold';
  strength: number;
  raw: number;
  reasons: string[];
  rules: RuleHit[];
  indicators: IndicatorSnapshot;
  series: SeriesBar[];
  meta: { degraded: boolean; generated_at: string };
}

/** 模块 B：技术面信号 */
export async function fetchTechnicalSignal(code: string): Promise<TechnicalReport> {
  return unwrap(http.post('/analysis/technical', { code }));
}

// ---------- 模块 A：量化分析 ----------

export interface SourceItem {
  title: string;
  url: string;
  published_at: string | null;
  retrieved_at: string | null;
  stale?: boolean;
}

export interface Conclusion {
  summary: string;
  view: '乐观' | '中性' | '谨慎';
  action: 'BUY' | 'SELL' | 'HOLD' | 'WATCH';
  target_price: string | null;
  stop_loss: string | null;
  confidence: number;
  key_points: string[];
  risks: string[];
}

export interface FundamentalReport {
  code: string;
  name: string;
  type: string;
  trade_date: string;
  is_otc_fund?: boolean;
  conclusion: Conclusion;
  sources: SourceItem[];
  search: {
    query: string;
    providers_used: string[];
    degraded_channels: string[];
    freshness: { newestDays: number | null; thresholdDays: number; stale: boolean } | null;
    retrieved_at: string;
  };
  meta: {
    degraded: boolean;
    degrade_reason: string | null;
    ai_provider: string | null;
    ai_model: string | null;
    generated_at: string;
  };
}

/** 模块 A：量化分析（AI 基本面 + 消息面） */
export async function fetchQuantAnalysis(code: string): Promise<FundamentalReport> {
  return unwrap(http.post('/analysis/quant', { code }));
}

// ---------- 模块 A：流式量化分析（SSE，进度 + 180s 倒计时） ----------

export interface QuantStreamEvent {
  type: 'status' | 'error' | 'done' | 'ping';
  step?: 'fetching' | 'resolving' | 'searching' | 'generating' | 'done';
  message?: string;
  code?: number;
  report?: FundamentalReport;
}

/**
 * 流式调用量化分析。服务端以 text/event-stream 推送进度事件，
 * 前端逐块解析并回调 onEvent。signal 用于取消（例如 180s 倒计时归零）。
 */
export function fetchQuantAnalysisStream(
  code: string,
  handlers: { onEvent: (e: QuantStreamEvent) => void; signal?: AbortSignal },
): void {
  fetch('/api/analysis/quant/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
    signal: handlers.signal,
  })
    .then((resp) => {
      if (!resp.ok || !resp.body) {
        handlers.onEvent({ type: 'error', code: resp.status, message: `请求失败（HTTP ${resp.status}）` });
        return;
      }
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      const pump = () => {
        reader
          .read()
          .then(({ done, value }) => {
            if (done) return;
            buf += decoder.decode(value, { stream: true });
            const parts = buf.split('\n\n');
            buf = parts.pop() || '';
            for (const part of parts) {
              const line = part.split('\n').find((l) => l.startsWith('data:'));
              if (!line) continue;
              const payload = line.slice(5).trim();
              if (!payload) continue;
              try {
                handlers.onEvent(JSON.parse(payload) as QuantStreamEvent);
              } catch (_) {
                /* 忽略非法分片 */
              }
            }
            pump();
          })
          .catch(() => {
            /* 连接中断 */
          });
      };
      pump();
    })
    .catch((e) => {
      const err = e as Error & { name?: string };
      if (err?.name === 'AbortError') return; // 主动取消（倒计时归零）由调用方处理
      handlers.onEvent({ type: 'error', code: 0, message: e?.message || '网络异常，请稍后重试' });
    });
}

// ---------- 流水线（T05） ----------

export interface PipelineStep {
  id: number;
  step: 'select' | 'timing' | 'backtest';
  seq: number;
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  error: string | null;
}

export interface PipelineRun {
  id: number;
  name: string;
  status: string;
  context: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  steps: PipelineStep[];
}

export async function createPipelineRun(name?: string): Promise<PipelineRun> {
  return unwrap(http.post('/analysis/pipeline/runs', { name }));
}

export async function getPipelineRun(id: number): Promise<PipelineRun> {
  return unwrap(http.get(`/analysis/pipeline/runs/${id}`));
}

export async function pipelineSelect(
  id: number,
  input: { sector?: string; code?: string; style?: 'value' | 'trend' },
): Promise<PipelineRun> {
  return unwrap(http.post(`/analysis/pipeline/runs/${id}/select`, input));
}

export async function pipelineTiming(
  id: number,
  input: { code: string; strategy?: string },
): Promise<PipelineRun> {
  return unwrap(http.post(`/analysis/pipeline/runs/${id}/timing`, input));
}

export async function pipelineBacktest(id: number, input: { code: string }): Promise<PipelineRun> {
  return unwrap(http.post(`/analysis/pipeline/runs/${id}/backtest`, input));
}

/** 能力概览（AI 配置 + 检索能力） */
export interface Capabilities {
  ai: {
    notConfigured: boolean;
    provider: string | null;
    model: string | null;
    capabilities: { webSearch: boolean } | null;
  };
  search: {
    enabled: boolean;
    freshnessDays: number;
    topK: number;
    providers: Array<{ id: string; label: string; available: boolean; alwaysOn: boolean }>;
  };
}

export async function fetchCapabilities(): Promise<Capabilities> {
  return unwrap(http.get('/analysis/capabilities'));
}
