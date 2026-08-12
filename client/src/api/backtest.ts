// ============================================================
// 回测 / 调参 API
// ============================================================
import http, { httpLong, unwrap } from './http';

export interface RetBucket {
  bucket: string;
  count: number;
}

export interface BacktestSummary {
  days: number;
  picks: number;
  winRate: number;
  avgNextRet: number;
  avgWinRet: number;
  avgLossRet: number;
  retDistribution: RetBucket[];
}

export interface TradeRow {
  tradeDate: string;
  code: string;
  name: string;
  score: number;
  nextRet: number;
}

export interface BacktestModelMeta {
  key: string;
  label: string;
  faithful: boolean;
  dataCaveat: string | null;
  factorKeys: string[];
  weightsSource: string;
  defaultWeights: Record<string, number> | null;
}

export interface BacktestRequest {
  model: string;
  range: [string, string];
  topN?: number;
  minScore?: number;
  weightsOverride?: Record<string, number> | null;
  nextDayReturnField?: string;
  sampling?: { step: number } | null;
  cap?: number;
}

export interface BacktestResult {
  model: string;
  dataCaveat: string | null;
  summary: BacktestSummary;
  trades: TradeRow[];
  params: Record<string, unknown>;
}

export interface TuneCombo {
  rank: number;
  weights: Record<string, number>;
  metrics: BacktestSummary;
}

export interface TuneRequest {
  model: string;
  range: [string, string];
  topN?: number;
  minScore?: number;
  tuneTargets: Record<string, number[]>;
  objective: 'winRate' | 'avgRet';
  sampling: { step: number };
  topK?: number;
}

export interface TuneResult {
  model: string;
  objective: string;
  combinations: number;
  dataCaveat: string | null;
  results: TuneCombo[];
}

export const backtestApi = {
  /** 单次回测（长超时：同步全量可能数秒~数十秒） */
  run(req: BacktestRequest) {
    return unwrap<BacktestResult>(httpLong.post('/backtest/run', req));
  },
  /** 网格搜索调参（长超时） */
  tune(req: TuneRequest) {
    return unwrap<TuneResult>(httpLong.post('/backtest/tune', req));
  },
  /** 模型元数据（faithful / dataCaveat / 因子键 / 默认权重） */
  models() {
    return unwrap<{ models: BacktestModelMeta[] }>(http.get('/backtest/models'));
  },
};
