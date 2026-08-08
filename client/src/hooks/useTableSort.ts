// ============================================================
// useTableSort：列排序状态机
// ============================================================
import { useMemo, useState } from 'react';

export type SortOrder = 'asc' | 'desc';

export interface SortState {
  key: string;
  order: SortOrder;
}

/**
 * 表格列排序状态机
 * @param initialKey 默认排序列
 * @param initialOrder 默认顺序
 */
export function useTableSort<T>(initialKey = 'score', initialOrder: SortOrder = 'desc') {
  const [sort, setSort] = useState<SortState>({ key: initialKey, order: initialOrder });

  /** 点击列头：同列切换升降序，异列默认降序 */
  const onSort = (key: string) => {
    setSort((prev) =>
      prev.key === key ? { key, order: prev.order === 'asc' ? 'desc' : 'asc' } : { key, order: 'desc' },
    );
  };

  /** 对数组排序（数值空值排最后） */
  const sorted = useMemo(() => {
    return (rows: T[], getValue: (row: T) => number | null | undefined) => {
      const dir = sort.order === 'asc' ? 1 : -1;
      return [...rows].sort((a, b) => {
        const va = getValue(a);
        const vb = getValue(b);
        if (va == null && vb == null) return 0;
        if (va == null) return 1;
        if (vb == null) return -1;
        return (va - vb) * dir;
      });
    };
  }, [sort]);

  return { sort, onSort, sorted };
}
