// ============================================================
// 逐笔交易表（分页，红涨绿跌着色）
// ============================================================
import { useState } from 'react';
import {
  Box, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TablePagination, Paper, Typography,
} from '@mui/material';
import type { TradeRow } from '../../api/backtest';

interface Props {
  trades: TradeRow[];
}

/** 红涨绿跌：正收益红、负收益绿、0 灰 */
function retColor(v: number): string {
  if (v > 0) return '#e53935';
  if (v < 0) return '#2e9e4f';
  return 'text.secondary';
}

function fmt(v: number): string {
  const s = v.toFixed(2);
  return v > 0 ? `+${s}` : s;
}

export default function TradeTable({ trades }: Props) {
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(25);

  const paged = trades.slice(page * rowsPerPage, page * rowsPerPage + rowsPerPage);

  if (!trades.length) {
    return (
      <Box sx={{ p: 3, textAlign: 'center' }}>
        <Typography color="text.secondary">无符合条件的逐笔记录（可能区间内无次日收益数据）</Typography>
      </Box>
    );
  }

  return (
    <Paper variant="outlined" sx={{ borderRadius: 2, overflow: 'hidden' }}>
      <TableContainer sx={{ maxHeight: 520 }}>
        <Table stickyHeader size="small">
          <TableHead>
            <TableRow>
              <TableCell>交易日</TableCell>
              <TableCell>代码</TableCell>
              <TableCell>名称</TableCell>
              <TableCell align="right">评分</TableCell>
              <TableCell align="right">次日收益(%)</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {paged.map((t, i) => (
              <TableRow key={`${t.tradeDate}-${t.code}-${i}`} hover>
                <TableCell>{t.tradeDate}</TableCell>
                <TableCell>{t.code}</TableCell>
                <TableCell>{t.name}</TableCell>
                <TableCell align="right">{t.score.toFixed(1)}</TableCell>
                <TableCell align="right" sx={{ color: retColor(t.nextRet), fontWeight: 700 }}>
                  {fmt(t.nextRet)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
      <TablePagination
        component="div"
        count={trades.length}
        page={page}
        onPageChange={(_e, p) => setPage(p)}
        rowsPerPage={rowsPerPage}
        onRowsPerPageChange={(e) => {
          setRowsPerPage(parseInt(e.target.value, 10));
          setPage(0);
        }}
        rowsPerPageOptions={[25, 50, 100, 200]}
        showFirstButton
        showLastButton
      />
    </Paper>
  );
}
