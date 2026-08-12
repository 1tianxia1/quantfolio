// ============================================================
// realtimeStore：记录最近一次组合盈亏静默刷新时间
// 供 TopBar 显示「X 秒后刷新」倒计时，让用户感知行情在持续更新。
// ============================================================
import { useSyncExternalStore } from 'react';

let lastRefreshAt = 0;
const listeners = new Set<() => void>();

/** 记录一次刷新发生（PortfolioDashboard 每次静默刷新后调用） */
export function setLastRefresh(): void {
  lastRefreshAt = Date.now();
  listeners.forEach((l) => l());
}

export function subscribeRealtime(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function getLastRefresh(): number {
  return lastRefreshAt;
}

/** 前端轮询间隔（毫秒），应与后端 intradayPoller 间隔保持一致 */
export const REFRESH_INTERVAL_MS = 15_000;

/** 判断当前是否处于 A 股交易时段（北京时间） */
export function isMarketOpenNow(): boolean {
  const now = new Date();
  const beijing = new Date(now.getTime() + 8 * 3600000);
  const day = beijing.getUTCDay();
  if (day === 0 || day === 6) return false;
  const t = beijing.getUTCHours() * 60 + beijing.getUTCMinutes();
  if (t >= 9 * 60 + 30 && t <= 11 * 60 + 30) return true;
  if (t >= 13 * 60 && t <= 15 * 60) return true;
  return false;
}

export function useLastRefresh(): number {
  return useSyncExternalStore(subscribeRealtime, getLastRefresh);
}
