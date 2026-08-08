// ============================================================
// 选股 API：morning/closing/pipeline/auction-leaderboard/presets/export
// ============================================================
import http, { unwrap } from './http';

export interface FactorScore {
  key: string;
  label: string;
  score: number;
  weight: number;
  contribution: number;
  note: string;
}

export interface ScoreDetail {
  total: number;
  factors: FactorScore[];
}

export interface ScreenerResult {
  rank: number;
  code: string;
  name: string;
  price: number | null;
  pct_chg: number | null;
  score: number;
  score_detail: ScoreDetail;
  hit_tags: string[];
  hit_step_tags: string[];
  metrics: Record<string, number | null>;
  data_origin: string;
}

export interface PipelineFunnelStep {
  step_id: string;
  label: string;
  survivors: number;
  eliminated: number;
  top_reasons: { reason: string; count: number }[];
}

export interface PipelineResult {
  funnel: PipelineFunnelStep[];
  items: ScreenerResult[];
}

export interface PipelineStepConfig {
  id: string;
  label: string;
  enabled: boolean;
  params: Record<string, unknown>;
}

export interface Strategy {
  id: number;
  user_id: number | null;
  name: string;
  type: string;
  conditions: string;
  is_preset: number;
  created_at: string;
  updated_at: string;
}

export interface ScreenerConditions {
  type?: string;
  universe?: Record<string, unknown>;
  [key: string]: unknown;
}

export const screenerApi = {
  morning(conditions: ScreenerConditions) {
    return unwrap<{ total: number; items: ScreenerResult[]; score_weights: Record<string, number> }>(
      http.post('/screener/morning', conditions),
    );
  },
  closing(conditions: ScreenerConditions) {
    return unwrap<{ total: number; items: ScreenerResult[]; score_weights: Record<string, number> }>(
      http.post('/screener/closing', conditions),
    );
  },
  presets() {
    return unwrap<{ morning: Strategy[]; closing: Strategy[] }>(http.get('/screener/pipeline/presets'));
  },
  runPipeline(data: { type: 'morning' | 'closing'; steps?: PipelineStepConfig[]; loose_mode?: boolean }) {
    return unwrap<PipelineResult>(http.post('/screener/pipeline/run', data));
  },
  auctionLeaderboard(top = 60) {
    return unwrap<{ items: AuctionItem[] }>(http.get('/screener/auction-leaderboard', { params: { top } }));
  },
  estimate(type: 'morning' | 'closing', conditions: ScreenerConditions) {
    return unwrap<{ estimated_count: number }>(http.post('/screener/estimate', { type, ...conditions }));
  },
  exportCsv(type: 'morning' | 'closing', conditions: ScreenerConditions) {
    return http.post('/screener/export.csv', { type, ...conditions }, { responseType: 'blob' });
  },
};

export interface AuctionItem {
  code: string;
  name: string;
  circ_mv: number | null;
  auction_pct: number | null;
  auction_vol_ratio: number | null;
  first_trade_vol_ratio: number | null;
  volume_ratio: number | null;
  pct_chg: number | null;
  turnover_rate: number | null;
}
