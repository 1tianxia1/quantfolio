// ============================================================
// useApi：请求封装（loading/error/data + 手动刷新）
// ============================================================
import { useCallback, useEffect, useRef, useState } from 'react';

interface UseApiOptions<T> {
  /** 是否自动请求（默认 true） */
  auto?: boolean;
  /** 请求函数 */
  fetcher: () => Promise<T>;
  /** 默认数据 */
  initialData?: T;
}

/**
 * 通用请求 hook：管理 loading/error/data
 * @example const { data, loading, error, refresh } = useApi({ fetcher: () => api.xxx() })
 */
export function useApi<T>({ auto = true, fetcher, initialData }: UseApiOptions<T>) {
  const [data, setData] = useState<T | undefined>(initialData);
  const [loading, setLoading] = useState<boolean>(auto);
  const [error, setError] = useState<string | null>(null);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const run = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetcherRef.current();
      setData(result);
      return result;
    } catch (e) {
      const msg = (e as Error)?.message || '请求失败';
      setError(msg);
      throw e;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (auto) {
      run().catch(() => undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { data, loading, error, refresh: run, setData };
}
