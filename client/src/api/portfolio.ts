// ============================================================
// 组合 API：holdings/summary/targets/rebalance/settings
// ============================================================
import http, { httpLong, unwrap } from './http';

export interface Holding {
  id: number;
  user_id: number | null;
  code: string | null;
  name: string;
  asset_class: 'stock' | 'fund' | 'cash' | 'bond' | 'other';
  quantity: number;
  cost_price: number;
  current_price: number;
  market_value: number;
  cost_amount: number;
  profit: number;
  profit_rate: number;
  /** 当日盈亏 = 数量 ×（今收 − 昨收） */
  day_profit: number;
  /** 当日盈亏率 =（今收 − 昨收）/ 昨收 ×100；无昨收行情时为 null */
  day_profit_rate: number | null;
  /** 单行占总资产百分比（明细表展示用） */
  current_pct: number;
  /** 分组目标百分比：整个 target_key 的目标，不是单行目标 */
  target_pct: number | null;
  /**
   * 偏离度（★ 分组口径）= group_current_pct − target_pct。
   * 与 allocation / rebalance 同源，不要用 current_pct − target_pct 自行推算。
   */
  deviation_pct: number | null;
  deviation_ratio: number | null;
  /** 分组键（asset_class / industry / code 三选一的取值） */
  target_key?: string | null;
  /** 该 target_key 下所有持仓的占比之和 */
  group_current_pct?: number | null;
  /** 该 target_key 下所有持仓的市值之和 */
  group_market_value?: number | null;
  /** 分组偏离 = group_current_pct − target_pct */
  group_deviation_pct?: number | null;
  /** 行级偏离（单行占比 − 分组目标）：仅供参考，不用于再平衡判定 */
  row_deviation_pct?: number | null;
  industry?: string | null;
  sector?: string | null;
  quote_date?: string | null;
  data_origin?: string;
}

export interface AllocationItem {
  dimension: string;
  key: string;
  current_pct: number;
  target_pct: number | null;
  deviation_pct: number | null;
  /** 该分组的市值合计 */
  market_value?: number;
}

export interface PortfolioSummary {
  total_asset: number;
  total_cost: number;
  total_profit: number;
  total_profit_rate: number;
  day_profit: number;
  holding_count: number;
  holdings: Holding[];
  allocation: AllocationItem[];
  as_of: string | null;
  concentration: { cr3: number; hhi: number; industry_map: Record<string, number> };
  active_dimension: string;
}

export interface RebalanceSuggestion {
  action: 'BUY' | 'SELL' | 'HOLD';
  code: string | null;
  name: string;
  /** 分组目标市值（= totalAsset × target_pct / 100） */
  target_value: number;
  /** 该行分摊到的缺口（带符号：BUY 为正、SELL 为负） */
  diff_value: number;
  suggest_shares: number;
  /** 取整后回算：suggest_shares × current_price；现金行为分摊金额 */
  suggest_amount: number;
  /** 单行占比 */
  current_pct: number;
  /** 分组目标百分比 */
  target_pct: number;
  /** 分组偏离（判定是否超阈值用的就是它） */
  deviation_pct?: number;
  unit: string;
  /** 分组键 */
  target_key?: string;
  /** 分组当前占比 */
  group_current_pct?: number | null;
  /** 分组偏离 = group_current_pct − target_pct */
  group_deviation_pct?: number | null;
  /** 分组目标市值 */
  group_target_value?: number;
  /** 分组当前市值 */
  group_current_value?: number;
  /** 分组缺口 = group_target_value − group_current_value */
  group_diff_value?: number;
  /** true = 该分组下无持仓行，输出的是分组整体建议（asset_class/industry 维度下无 code） */
  is_group_level?: boolean;
  /**
   * true = code 维度下「目标已配置但一股未持有」的建仓建议。
   * 此时 code 已回填为 target_key 本身，可跳转详情；
   * 若缺口不足 1 手则 suggest_shares=0、unit='元'（退回金额口径）。
   */
  is_new_position?: boolean;
  /** 建仓建议的折股现价（仅 is_new_position 时下发） */
  current_price?: number;
}

export interface RebalanceResult {
  items: RebalanceSuggestion[];
  summary: {
    buy_total: number;
    sell_total: number;
    need_cash: number;
    balance_ok: boolean;
    cash_available: number;
    threshold: number;
    dimension: string;
    /** 分摊前的分组买入缺口合计（对账基准） */
    planned_buy_total?: number;
    /** 分摊前的分组卖出缺口合计（对账基准） */
    planned_sell_total?: number;
    /** 取整残差 = planned_buy_total − buy_total */
    rounding_residual_buy?: number;
    /** 取整残差 = planned_sell_total − sell_total */
    rounding_residual_sell?: number;
  };
}

export interface TargetItem {
  target_key: string;
  target_pct: number;
}

export interface Settings {
  rebalance_threshold: number;
  active_dimension: string;
  morning_loose_mode: number;
}

export const portfolioApi = {
  listHoldings(assetClass?: string) {
    return unwrap<{ holdings: Holding[]; as_of: string | null }>(
      http.get('/portfolio/holdings', { params: assetClass ? { asset_class: assetClass } : {} }),
    );
  },
  addHolding(data: Partial<Holding>) {
    return unwrap<Holding>(http.post('/portfolio/holdings', data));
  },
  updateHolding(id: number, data: Partial<Holding>) {
    return unwrap<Holding>(http.put(`/portfolio/holdings/${id}`, data));
  },
  deleteHolding(id: number) {
    return unwrap<null>(http.delete(`/portfolio/holdings/${id}`));
  },
  importCsv(csvText: string) {
    return unwrap<{ imported: number; skipped: number; errors: { row: number; msg: string }[] }>(
      http.post('/portfolio/holdings/import', { csv_text: csvText }),
    );
  },
  importImage(images: string[], hint?: 'stock' | 'fund') {
    // D8：视觉模型识别可能超过 30s，使用 90s 长超时实例
    return unwrap<{ candidates: Partial<Holding>[]; warnings: string[] }>(
      httpLong.post('/portfolio/holdings/import-image', { images, hint }),
    );
  },
  summary(dimension?: string) {
    return unwrap<PortfolioSummary>(http.get('/portfolio/summary', { params: dimension ? { dimension } : {} }));
  },
  targets(dimension?: string) {
    return unwrap<{ dimension: string; items: TargetItem[] }>(
      http.get('/portfolio/targets', { params: dimension ? { dimension } : {} }),
    );
  },
  saveTargets(dimension: string, items: TargetItem[]) {
    return unwrap<null>(http.put('/portfolio/targets', { dimension, items }));
  },
  settings() {
    return unwrap<Settings>(http.get('/portfolio/settings'));
  },
  saveSettings(data: Partial<Settings>) {
    return unwrap<Settings>(http.put('/portfolio/settings', data));
  },
  rebalance(data: { threshold?: number; dimension?: string }) {
    return unwrap<RebalanceResult>(http.post('/portfolio/rebalance', data));
  },
};
