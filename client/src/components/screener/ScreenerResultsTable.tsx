// ============================================================
// ScreenerResultsTable：结果表（命中标签/评分排序/导出CSV）
// ============================================================
import { Box, Typography, Button } from '@mui/material';
import GetAppIcon from '@mui/icons-material/GetApp';
import DataTable, { ColumnDef } from '../common/DataTable';
import ProgressScore from '../common/ProgressScore';
import TagChip from '../common/TagChip';
import { formatPercent, colorOf, formatYi } from '../../utils/format';
import type { ScreenerResult } from '../../api/screener';

// 当服务端 turnover_rate 缺失时，用成交额/流通市值估算换手率作为兜底显示
function estimateTurnover(r: ScreenerResult): number | null {
  const m = r.metrics || {};
  if (m.circ_mv != null && m.circ_mv > 0 && m.amount != null && m.amount > 0) {
    // 换手率 ≈ 成交金额(元) / 流通市值(亿元) / 1e6 * 100，即成交金额/流通市值*100
    return m.amount / (m.circ_mv * 1e8) * 100;
  }
  if (m.circ_mv != null && m.circ_mv > 0 && r.price != null && r.price > 0 && m.volume != null && m.volume > 0) {
    // 换手率 ≈ 成交量(手)*100股/手 / (流通市值(亿元)*1e8/价格) * 100
    return (m.volume * 100) / ((m.circ_mv * 1e8) / r.price) * 100;
  }
  return null;
}

interface ScreenerResultsTableProps {
  items: ScreenerResult[];
  total: number;
  marketTotal: number;
  onExport: () => void;
  onRowClick?: (r: ScreenerResult) => void;
}

export default function ScreenerResultsTable({ items, total, marketTotal, onExport, onRowClick }: ScreenerResultsTableProps) {
  const columns: ColumnDef<ScreenerResult>[] = [
    { key: 'rank', label: '#', width: 40, align: 'center', sortable: true, getSortValue: (r) => r.rank, render: (r) => r.rank },
    { key: 'code', label: '代码', sortable: true, getSortValue: (r) => Number(r.code), render: (r) => r.code },
    { key: 'name', label: '名称', render: (r) => r.name },
    { key: 'price', label: '现价', align: 'right', sortable: true, getSortValue: (r) => r.price, render: (r) => (r.price != null ? r.price.toFixed(2) : '—') },
    { key: 'pct_chg', label: '涨跌幅', align: 'right', sortable: true, getSortValue: (r) => r.pct_chg, render: (r) => <Typography variant="body2" sx={{ color: colorOf(r.pct_chg) }}>{formatPercent(r.pct_chg)}</Typography> },
    { key: 'score', label: '评分', align: 'right', sortable: true, getSortValue: (r) => r.score, render: (r) => <ProgressScore score={r.score} size="small" /> },
    {
      key: 'turnover',
      label: '换手',
      align: 'right',
      sortable: true,
      getSortValue: (r) => r.metrics.turnover_rate ?? estimateTurnover(r),
      render: (r) => {
        const v = r.metrics.turnover_rate ?? estimateTurnover(r);
        if (v == null) return '—';
        const isEstimate = r.metrics.turnover_rate == null;
        return (
          <Typography variant="body2" sx={{ color: isEstimate ? 'text.secondary' : 'inherit' }} title={isEstimate ? '由成交额/流通市值估算，数据补全后将显示真实值' : undefined}>
            {v.toFixed(1)}%{isEstimate ? '*' : ''}
          </Typography>
        );
      },
    },
    { key: 'vol_ratio', label: '量比', align: 'right', sortable: true, getSortValue: (r) => r.metrics.volume_ratio ?? r.metrics.vol_ratio_5, render: (r) => { const v = r.metrics.volume_ratio ?? r.metrics.vol_ratio_5; return v != null ? v.toFixed(2) : '—'; } },
    { key: 'pe', label: 'PE', align: 'right', sortable: true, getSortValue: (r) => r.metrics.pe_ttm, render: (r) => (r.metrics.pe_ttm != null ? r.metrics.pe_ttm.toFixed(1) : '—') },
    { key: 'circ_mv', label: '流通市值', align: 'right', sortable: true, getSortValue: (r) => r.metrics.circ_mv, render: (r) => (r.metrics.circ_mv != null ? formatYi(r.metrics.circ_mv) : '—') },
    {
      key: 'tags', label: '命中标签',
      render: (r) => (
        <Box sx={{ maxWidth: 360 }}>
          {(r.hit_tags || []).slice(0, 6).map((t) => (
            <TagChip key={t} label={t} color={r.hit_step_tags?.includes(t) ? 'success' : 'primary'} />
          ))}
        </Box>
      ),
    },
  ];

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
        <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
          筛选结果：命中 <span style={{ color: '#2E7CF6' }}>{total}</span> 只 / 全市场 {marketTotal} 只
        </Typography>
        <Button size="small" startIcon={<GetAppIcon />} onClick={onExport} disabled={!items.length}>
          导出 CSV
        </Button>
      </Box>
      <DataTable columns={columns} rows={items} rowKey={(r) => r.code + r.rank} defaultSort={{ key: 'score', order: 'desc' }} pageSize={20} emptyText="无匹配标的，请调整筛选条件" onRowClick={onRowClick} />
    </Box>
  );
}
