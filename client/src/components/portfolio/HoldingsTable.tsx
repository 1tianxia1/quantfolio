// ============================================================
// HoldingsTable：持仓明细表（可排序）
// ============================================================
import { Box, IconButton, Typography } from '@mui/material';
import EditIcon from '@mui/icons-material/Edit';
import DeleteIcon from '@mui/icons-material/Delete';
import DataTable, { ColumnDef } from '../common/DataTable';
import { formatMoney, formatQuantity, formatPercent, colorOf, formatSignedMoney } from '../../utils/format';
import { ASSET_CLASS_LABEL } from '@shared/constants';
import type { Holding } from '../../api/portfolio';

interface HoldingsTableProps {
  holdings: Holding[];
  onEdit: (h: Holding) => void;
  onDelete: (h: Holding) => void;
}

export default function HoldingsTable({ holdings, onEdit, onDelete }: HoldingsTableProps) {
  const columns: ColumnDef<Holding>[] = [
    { key: 'code', label: '代码', sortable: true, getSortValue: (h) => (h.code ? Number(h.code) : -1), render: (h) => h.code || '—' },
    { key: 'name', label: '名称', render: (h) => h.name },
    {
      key: 'asset_class', label: '类别', sortable: true,
      getSortValue: (h) => h.asset_class,
      render: (h) => ASSET_CLASS_LABEL[h.asset_class] || h.asset_class,
    },
    { key: 'quantity', label: '数量', align: 'right', sortable: true, getSortValue: (h) => h.quantity, render: (h) => (h.asset_class === 'cash' ? '—' : formatQuantity(h.quantity)) },
    { key: 'cost_price', label: '成本价', align: 'right', sortable: true, getSortValue: (h) => h.cost_price, render: (h) => (h.asset_class === 'cash' ? '—' : formatMoney(h.cost_price, 4)) },
    { key: 'current_price', label: '现价', align: 'right', sortable: true, getSortValue: (h) => h.current_price, render: (h) => (h.asset_class === 'cash' ? '—' : formatMoney(h.current_price)) },
    { key: 'market_value', label: '市值', align: 'right', sortable: true, getSortValue: (h) => h.market_value, render: (h) => `¥${formatMoney(h.market_value)}` },
    // 盈亏类字段统一 4 位小数：2 位会把 0.7341% 抹成 0.73%，与券商对不上
    { key: 'profit', label: '累计盈亏', align: 'right', sortable: true, getSortValue: (h) => h.profit, render: (h) => (h.asset_class === 'cash' ? '—' : <Typography variant="body2" sx={{ color: colorOf(h.profit) }}>{formatSignedMoney(h.profit, 4)}</Typography>) },
    { key: 'profit_rate', label: '累计盈亏率', align: 'right', sortable: true, getSortValue: (h) => h.profit_rate, render: (h) => (h.asset_class === 'cash' ? '—' : <Typography variant="body2" sx={{ color: colorOf(h.profit_rate) }}>{formatPercent(h.profit_rate, 4)}</Typography>) },
    // 当日盈亏 = 数量 ×（今收 − 昨收），与累计盈亏口径不同，不受成本价影响
    { key: 'day_profit', label: '当日盈亏', align: 'right', sortable: true, getSortValue: (h) => h.day_profit, render: (h) => (h.asset_class === 'cash' ? '—' : <Typography variant="body2" sx={{ color: colorOf(h.day_profit) }}>{formatSignedMoney(h.day_profit, 4)}</Typography>) },
    { key: 'day_profit_rate', label: '当日盈亏率', align: 'right', sortable: true, getSortValue: (h) => h.day_profit_rate ?? 0, render: (h) => (h.asset_class === 'cash' || h.day_profit_rate == null ? '—' : <Typography variant="body2" sx={{ color: colorOf(h.day_profit_rate) }}>{formatPercent(h.day_profit_rate, 4)}</Typography>) },
    // 行级占比：单行市值 ÷ 总资产
    { key: 'current_pct', label: '当前占比', align: 'right', sortable: true, getSortValue: (h) => h.current_pct, render: (h) => `${h.current_pct.toFixed(2)}%` },
    // 类别当前占比：该 target_key 下所有持仓占比之和（与目标占比同口径，可直接相减）
    {
      key: 'group_current_pct', label: '类别占比', align: 'right', sortable: true,
      getSortValue: (h) => h.group_current_pct ?? -1,
      render: (h) => (h.group_current_pct != null ? `${h.group_current_pct.toFixed(2)}%` : '—'),
    },
    // 目标占比是「整个类别」的目标，不是单行目标
    { key: 'target_pct', label: '类别目标', align: 'right', sortable: true, getSortValue: (h) => h.target_pct, render: (h) => (h.target_pct != null ? `${h.target_pct.toFixed(0)}%` : '—') },
    // 偏离 = 类别占比 − 类别目标（分组口径，与再平衡判定完全一致）
    { key: 'deviation_pct', label: '类别偏离', align: 'right', sortable: true, getSortValue: (h) => h.deviation_pct, render: (h) => (h.deviation_pct != null ? <Typography variant="body2" sx={{ color: colorOf(h.deviation_pct) }}>{h.deviation_pct > 0 ? '+' : ''}{h.deviation_pct.toFixed(2)}pt</Typography> : '—') },
    {
      key: 'actions', label: '操作', align: 'center',
      render: (h) => (
        <Box sx={{ display: 'flex', gap: 0.5, justifyContent: 'center' }}>
          <IconButton size="small" onClick={() => onEdit(h)}>
            <EditIcon fontSize="small" />
          </IconButton>
          <IconButton size="small" color="error" onClick={() => onDelete(h)}>
            <DeleteIcon fontSize="small" />
          </IconButton>
        </Box>
      ),
    },
  ];

  return <DataTable columns={columns} rows={holdings} rowKey={(h) => h.id} defaultSort={{ key: 'market_value', order: 'desc' }} pageSize={20} emptyText="暂无持仓，点击右上角「添加持仓」" />;
}
