// ============================================================
// AuctionLeaderboard：竞价涨幅 Top60 独立榜
// ============================================================
import { Box, Typography } from '@mui/material';
import DataTable, { ColumnDef } from '../common/DataTable';
import { formatPercent, colorOf, formatYi } from '../../utils/format';
import type { AuctionItem } from '../../api/screener';

interface AuctionLeaderboardProps {
  items: AuctionItem[];
}

export default function AuctionLeaderboard({ items }: AuctionLeaderboardProps) {
  const columns: ColumnDef<AuctionItem>[] = [
    { key: 'code', label: '代码', sortable: true, getSortValue: (a) => Number(a.code), render: (a) => a.code },
    { key: 'name', label: '名称', render: (a) => a.name },
    { key: 'auction_pct', label: '竞价涨幅', align: 'right', sortable: true, getSortValue: (a) => a.auction_pct, render: (a) => <Typography variant="body2" sx={{ color: colorOf(a.auction_pct) }}>{formatPercent(a.auction_pct)}</Typography> },
    { key: 'auction_vol_ratio', label: '竞价量比', align: 'right', sortable: true, getSortValue: (a) => a.auction_vol_ratio, render: (a) => (a.auction_vol_ratio != null ? a.auction_vol_ratio.toFixed(2) : '—') },
    { key: 'volume_ratio', label: '量比', align: 'right', sortable: true, getSortValue: (a) => a.volume_ratio, render: (a) => (a.volume_ratio != null ? a.volume_ratio.toFixed(2) : '—') },
    { key: 'first_trade_vol_ratio', label: '首笔量比', align: 'right', sortable: true, getSortValue: (a) => a.first_trade_vol_ratio, render: (a) => (a.first_trade_vol_ratio != null ? a.first_trade_vol_ratio.toFixed(2) : '—') },
    { key: 'circ_mv', label: '流通市值', align: 'right', sortable: true, getSortValue: (a) => a.circ_mv, render: (a) => (a.circ_mv != null ? formatYi(a.circ_mv) : '—') },
    { key: 'pct_chg', label: '当日涨幅', align: 'right', sortable: true, getSortValue: (a) => a.pct_chg, render: (a) => <Typography variant="body2" sx={{ color: colorOf(a.pct_chg) }}>{formatPercent(a.pct_chg)}</Typography> },
  ];

  return (
    <Box>
      <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 1 }}>
        竞价涨幅排行榜 Top {items.length}
      </Typography>
      <DataTable columns={columns} rows={items} rowKey={(a) => a.code} defaultSort={{ key: 'auction_pct', order: 'desc' }} pageSize={20} emptyText="暂无竞价数据" />
    </Box>
  );
}
