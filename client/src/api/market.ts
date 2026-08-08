// ============================================================
// 市场 API：overview/search/kline/sectors/meta/watchlist
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
}

export interface WatchItem {
  id: number;
  code: string;
  name: string | null;
  type: string | null;
  sector: string | null;
  created_at: string;
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
  watchlist() {
    return unwrap<WatchItem[]>(http.get('/market/watchlist'));
  },
  addWatchlist(code: string) {
    return unwrap<null>(http.post('/market/watchlist', { code }));
  },
  removeWatchlist(id: number) {
    return unwrap<null>(http.delete(`/market/watchlist/${id}`));
  },
};
