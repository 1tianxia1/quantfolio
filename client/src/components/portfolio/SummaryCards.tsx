// ============================================================
// SummaryCards：仪表盘 5 张汇总卡
// ============================================================
import { Grid } from '@mui/material';
import StatCard from '../common/StatCard';
import { formatMoney, formatSignedMoney, formatPercent, colorOf } from '../../utils/format';
import type { PortfolioSummary } from '../../api/portfolio';

export default function SummaryCards({ summary }: { summary: PortfolioSummary }) {
  const profitColor = colorOf(summary.total_profit);
  const dayColor = colorOf(summary.day_profit);

  return (
    <Grid container spacing={2}>
      <Grid item xs={12} sm={6} md={4} lg={2.4}>
        <StatCard label="总资产" value={`¥${formatMoney(summary.total_asset)}`} sub={`行情截至 ${summary.as_of || '—'}`} />
      </Grid>
      <Grid item xs={12} sm={6} md={4} lg={2.4}>
        <StatCard label="总盈亏" value={formatSignedMoney(summary.total_profit)} color={profitColor} sub={`成本 ¥${formatMoney(summary.total_cost)}`} />
      </Grid>
      <Grid item xs={12} sm={6} md={4} lg={2.4}>
        <StatCard label="总盈亏率" value={formatPercent(summary.total_profit_rate)} color={profitColor} />
      </Grid>
      <Grid item xs={12} sm={6} md={4} lg={2.4}>
        <StatCard label="当日盈亏" value={formatSignedMoney(summary.day_profit)} color={dayColor} />
      </Grid>
      <Grid item xs={12} sm={6} md={4} lg={2.4}>
        <StatCard label="持仓标的数" value={summary.holding_count} sub={`CR3 ${summary.concentration.cr3}% · HHI ${summary.concentration.hhi}`} />
      </Grid>
    </Grid>
  );
}
