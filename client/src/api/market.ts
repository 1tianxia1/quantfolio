// ============================================================
// 市场 API：overview/search/kline/sectors/meta/watchlist
// + 实时行情状态 / 后台刷新 / 数据源设置
// ============================================================
import http, { unwrap } from './http';

export interface Overview {
  trade_date: string | null;
  stock_count: number;
  fund_count: number;
  total_count: number;
  up_count: number;
  down_count: number;
  limit_up_count: number;
  avg_pct_chg: number;
}

export interface SearchItem {
  code: string;
  name: string;
  type: string;
  sector: string | null;
  industry: string | null;
}

export interface KlineBar {
  date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number;
  volume: number | null;
  amount: number | null;
  pct_chg: number | null;
  turnover_rate: number | null;
  volume_ratio: number | null;
  data_origin: string;
}

export interface KlineData {
  code: string;
  name: string;
  trade_date: string | null;
  data_origin: string;
  bars: KlineBar[];
}

export interface HotSector {
  id: number;
  dimension: string;
  sector_name: string;
  trade_date: string;
  sector_pct_chg: number | null;
  hot_rank: number | null;
  leading_stock: string | null;
  stock_count: number | null;
  total_amount: number | null;
  total_main_inflow: number | null;
  data_origin: string;
}

export interface MarketMeta {
  trade_date: string | null;
  version: string | null;
  stock_count: number;
  fund_count: number;
  lineage: Record<string, string>;
  compliance: string | null;
}

export interface WatchItem {
  id: number;
  code: string;
  name: string | null;
  type: string | null;
  sector: string | null;
  group_id: number | null;
  note: string | null;
  category?: 'a_share' | 'fund';
  latest_close: number | null;
  pre_close: number | null;
  pct_chg: number | null;
  volume: number | null;
  amount: number | null;
  quote_date: string | null;
  created_at: string;
}

export interface WatchGroup {
  id: number;
  user_id: number;
  name: string;
  category: 'all' | 'a_share' | 'fund';
  created_at: string;
}

/** 后台刷新任务状态 */
export interface RefreshState {
  status: 'idle' | 'running' | 'done' | 'failed';
  startedAt: string | null;
  finishedAt: string | null;
  lastError: string | null;
  lastResult: { tradeDate: string | null; stats: Record<string, unknown>; finishedAt: string } | null;
  running: boolean;
}

/** 实时行情总状态（供顶栏 / 设置页展示） */
export interface MarketStatus {
  realtimeEnabled: boolean;
  provider: string;
  tradeDate: string | null;
  refresh: RefreshState;
}

export const marketApi = {
  overview() {
    return unwrap<Overview>(http.get('/market/overview'));
  },
  search(q: string, limit = 10) {
    return unwrap<SearchItem[]>(http.get('/market/search', { params: { q, limit } }));
  },
  kline(code: string, days = 120) {
    return unwrap<KlineData>(http.get('/market/kline', { params: { code, days } }));
  },
  sectors(dimension = 'sector', top = 20) {
    return unwrap<HotSector[]>(http.get('/market/sectors', { params: { dimension, top } }));
  },
  meta() {
    return unwrap<MarketMeta>(http.get('/market/meta'));
  },
  watchlist(category?: 'a_share' | 'fund', groupId?: number | null) {
    const params: Record<string, string> = {};
    if (category) params.category = category;
    if (groupId != null) params.groupId = String(groupId);
    return unwrap<WatchItem[]>(http.get('/market/watchlist', { params }));
  },
  addWatchlist(code: string, opts?: { category?: 'a_share' | 'fund'; groupId?: number | null; note?: string }) {
    return unwrap<null>(http.post('/market/watchlist', { code, ...opts }));
  },
  removeWatchlist(id: number) {
    return unwrap<null>(http.delete(`/market/watchlist/${id}`));
  },
  // 分组
  watchlistGroups() {
    return unwrap<WatchGroup[]>(http.get('/market/watchlist-groups'));
  },
  createWatchlistGroup(name: string, category: 'all' | 'a_share' | 'fund' = 'all') {
    return unwrap<WatchGroup>(http.post('/market/watchlist-groups', { name, category }));
  },
  deleteWatchlistGroup(id: number) {
    return unwrap<null>(http.delete(`/market/watchlist-groups/${id}`));
  },
  renameWatchlistGroup(id: number, name: string) {
    return unwrap<WatchGroup>(http.patch(`/market/watchlist-groups/${id}`, { name }));
  },
  moveWatchlistItem(id: number, groupId: number | null) {
    return unwrap<null>(http.patch(`/market/watchlist/${id}/group`, { groupId }));
  },
  updateWatchlistNote(id: number, note: string) {
    return unwrap<null>(http.patch(`/market/watchlist/${id}/note`, { note }));
  },

  /** 实时行情状态（公开） */
  status() {
    return unwrap<MarketStatus>(http.get('/market/status'));
  },
  /** 触发后台刷新真实行情（需登录） */
  refresh(opts?: { limit?: number; max?: number }) {
    return unwrap<{ started: boolean; alreadyRunning?: boolean }>(http.post('/market/refresh', opts || {}));
  },
  /** 刷新任务进度 */
  refreshStatus() {
    return unwrap<RefreshState>(http.get('/market/refresh/status'));
  },
  /** 设置数据源（实时 / 本地，需登录） */
  setMarketSettings(body: { realtime: boolean }) {
    return unwrap<{ realtimeEnabled: boolean; provider: string }>(http.post('/market/settings', body));
  },
};
