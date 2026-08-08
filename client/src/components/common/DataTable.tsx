// ============================================================
// DataTable：通用表格（排序/分页/空态）—— 基于 MUI Table
// 避免 @mui/x-data-grid 的 peer 依赖风险，改为轻量自研
// ============================================================
import { Box, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TableSortLabel, TablePagination, Typography } from '@mui/material';
import { ReactNode, useState } from 'react';

export interface ColumnDef<T> {
  key: string;
  label: string;
  sortable?: boolean;
  width?: number | string;
  align?: 'left' | 'right' | 'center';
  render?: (row: T) => ReactNode;
  getSortValue?: (row: T) => number | string | null | undefined;
}

interface DataTableProps<T> {
  columns: ColumnDef<T>[];
  rows: T[];
  rowKey: (row: T) => string | number;
  defaultSort?: { key: string; order: 'asc' | 'desc' };
  pageSize?: number;
  emptyText?: string;
  onRowClick?: (row: T) => void;
}

export default function DataTable<T>({
  columns, rows, rowKey, defaultSort, pageSize = 20, emptyText = '暂无数据', onRowClick,
}: DataTableProps<T>) {
  const [sortKey, setSortKey] = useState(defaultSort?.key || columns[0]?.key || '');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>(defaultSort?.order || 'desc');
  const [page, setPage] = useState(0);

  const handleSort = (key: string) => {
    if (sortKey === key) {
      setSortOrder((o) => (o === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortOrder('desc');
    }
    setPage(0);
  };

  const sorted = [...rows].sort((a, b) => {
    const col = columns.find((c) => c.key === sortKey);
    const getVal = col?.getSortValue;
    if (!getVal) return 0;
    const va = getVal(a);
    const vb = getVal(b);
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    if (typeof va === 'string' || typeof vb === 'string') {
      return sortOrder === 'asc' ? String(va).localeCompare(String(vb), 'zh') : String(vb).localeCompare(String(va), 'zh');
    }
    return sortOrder === 'asc' ? (va as number) - (vb as number) : (vb as number) - (va as number);
  });

  const total = sorted.length;
  const paged = sorted.slice(page * pageSize, (page + 1) * pageSize);

  return (
    <Box>
      <TableContainer>
        <Table size="small" sx={{ minWidth: 600 }}>
          <TableHead>
            <TableRow>
              {columns.map((col) => (
                <TableCell
                  key={col.key}
                  align={col.align || 'left'}
                  sx={{ whiteSpace: 'nowrap', width: col.width, fontWeight: 600 }}
                >
                  {col.sortable ? (
                    <TableSortLabel
                      active={sortKey === col.key}
                      direction={sortKey === col.key ? sortOrder : 'desc'}
                      onClick={() => handleSort(col.key)}
                    >
                      {col.label}
                    </TableSortLabel>
                  ) : (
                    col.label
                  )}
                </TableCell>
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {paged.length === 0 && (
              <TableRow>
                <TableCell colSpan={columns.length} align="center" sx={{ py: 6 }}>
                  <Typography variant="body2" color="text.secondary">
                    {emptyText}
                  </Typography>
                </TableCell>
              </TableRow>
            )}
            {paged.map((row) => (
              <TableRow
                key={rowKey(row)}
                hover
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                sx={onRowClick ? { cursor: 'pointer' } : undefined}
              >
                {columns.map((col) => (
                  <TableCell key={col.key} align={col.align || 'left'} sx={{ whiteSpace: 'nowrap' }}>
                    {col.render ? col.render(row) : String((row as Record<string, unknown>)[col.key] ?? '—')}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
      {total > pageSize && (
        <TablePagination
          component="div"
          count={total}
          page={page}
          onPageChange={(_e, p) => setPage(p)}
          rowsPerPage={pageSize}
          rowsPerPageOptions={[pageSize]}
          labelRowsPerPage="每页"
        />
      )}
    </Box>
  );
}
