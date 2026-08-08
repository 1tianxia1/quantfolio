// ============================================================
// useDebounce：防抖（搜索/预计命中数）
// ============================================================
import { useEffect, useState } from 'react';

/** 防抖值：value 变化后延迟 delay ms 才更新 */
export function useDebounce<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return debounced;
}
