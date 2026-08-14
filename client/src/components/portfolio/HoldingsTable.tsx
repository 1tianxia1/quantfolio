// ============================================================
// HoldingsTable：持仓明细表（可排序）
// ============================================================
import { Box, IconButton, Typography, Tooltip, Chip } from '@mui/material';
import EditIcon from '@mui/icons-material/Edit';
import DeleteIcon from '@mui/icons-material/Delete';
import DataTable, { ColumnDef } from '../common/DataTable';
import { formatMoney, formatQuantity, formatPercent, colorOf, formatSignedMoney } from '../../utils/format';
import { ASSET_CLASS_LABEL } from '@shared/constants';
import type { Holding } from '../../api/portfolio';

/** 判断净值/行情日期是否为今天（北京时间） */
function isToday(dateStr?: string | null): boolean {
  if (!dateStr) return false;
  const now = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
  return dateStr === now;
}

/**
 * 场外基金净值时效标签：
 * - 盘中实时估值（data_origin=mixed/estimate）→ 绿底"估"字 + 估值时间
 * - 官方净值且为今天 → 蓝底"今"
 * - 官方净值且非今天（T-1 披露）→ 灰底"昨" + 具体日期 tooltip
 */
function FundNavBadge({ h }: { h: Holding }) {
  if (h.asset_class !== 'fund') return null;
  if (h.data_origin === 'mixed' || h.data_origin === 'estimate') {
    const t = h.estimate_time || h.quote_date;
    const suffix = h.data_origin === 'estimate' ? '（浏览器实时估值）' : '';
    return (
      <Tooltip title={`盘中实时估值 · ${t ?? '未知'}${suffix}`}>
        <Chip size="small" label="估" color="success" sx={{ height: 18, fontSize: 11, ml: 0.5 }} />
      </Tooltip>
    );
  }
  // 关联板块指数兜底：fundgz 不可用时，用基金跟踪板块/指数今日涨跌幅预估当日盈亏
  if (h.data_origin === 'sector') {
    return (
      <Tooltip title={`关联板块预估 · 当日盈亏率=板块今日涨跌幅（fundgz 暂不可用时的近似估值）`}>
        <Chip size="small" label="板" color="secondary" sx={{ height: 18, fontSize: 11, ml: 0.5 }} />
      </Tooltip>
    );
  }
  // 腾讯兜底：fundgz 完全不可用时显示 T-1 官方净值（无今日估值，day_profit=null）
  // 注意：Tencent 的 gszzl 是 T-1 的涨跌幅，**不能**当作今日盈亏率（避免用昨日涨跌冒充今日）
  if (h.data_origin === 'tencent') {
    return (
      <Tooltip title={`腾讯兜底 · 累计基于 ${h.quote_date ?? '未知'} 官方净值；今日盘中估值暂不可用，当日盈亏暂不显示`}>
        <Chip size="small" label="兜" color="warning" sx={{ height: 18, fontSize: 11, ml: 0.5 }} />
      </Tooltip>
    );
  }
  const today = isToday(h.quote_date);
  if (today) {
    return (
      <Tooltip title={`今日官方净值 · ${h.quote_date}`}>
        <Chip size="small" label="今" color="primary" sx={{ height: 18, fontSize: 11, ml: 0.5 }} />
      </Tooltip>
    );
  }
  return (
    <Tooltip title={`净值 T-1 披露 · 数据日期 ${h.quote_date ?? '未知'}（收盘后至当晚公布前仅显示上一披露日）`}>
      <Chip size="small" label="昨" sx={{ height: 18, fontSize: 11, ml: 0.5, bgcolor: 'action.hover' }} />
    </Tooltip>
  );
}

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
    { key: 'current_price', label: '现价', align: 'right', sortable: true, getSortValue: (h) => h.current_price, render: (h) => (h.asset_class === 'cash' ? '—' : <Box sx={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'flex-end' }}>{formatMoney(h.current_price)}<FundNavBadge h={h} /></Box>) },
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
