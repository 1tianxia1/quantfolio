// ============================================================
// 策略 API
// ============================================================
import http, { unwrap } from './http';
import type { Strategy } from './screener';

export const strategyApi = {
  list(type?: string) {
    return unwrap<Strategy[]>(http.get('/strategies', { params: type ? { type } : {} }));
  },
  create(data: { name: string; type: string; conditions: unknown }) {
    return unwrap<Strategy>(http.post('/strategies', data));
  },
  update(id: number, data: { name?: string; conditions?: unknown }) {
    return unwrap<Strategy>(http.put(`/strategies/${id}`, data));
  },
  remove(id: number) {
    return unwrap<null>(http.delete(`/strategies/${id}`));
  },
};
