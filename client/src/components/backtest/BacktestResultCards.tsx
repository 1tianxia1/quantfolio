// ============================================================
// 回测指标卡：胜率 / 平均次日收益 / 赢家均收益
// ============================================================
import { Box } from '@mui/material';
import { CheckCircleOutline, TrendingUp, EmojiEvents } from '@mui/icons-material';
import StatCard from '../common/StatCard';
import type { BacktestSummary } from '../../api/backtest';

interface Props {
  summary: BacktestSummary;
}

/** 百分比格式化 */
function pct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

/** 带正负号的收益格式化 */
function signed(v: number): string {
  const s = v.toFixed(2);
  return v > 0 ? `+${s}%` : `${s}%`;
}

export default function BacktestResultCards({ summary }: Props) {
  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'repeat(3, 1fr)' }, gap: 2 }}>
      <StatCard
        label="胜率（次日上涨占比）"
        value={pct(summary.winRate)}
        sub={`共 ${summary.picks} 笔入选 / ${summary.days} 个交易日`}
        color="#2E7CF6"
        icon={<CheckCircleOutline fontSize="small" />}
      />
      <StatCard
        label="平均次日收益"
        value={signed(summary.avgNextRet)}
        sub={summary.avgNextRet >= 0 ? '平均为正' : '平均为负'}
        color={summary.avgNextRet >= 0 ? '#e53935' : '#2e9e4f'}
        icon={<TrendingUp fontSize="small" />}
      />
      <StatCard
        label="赢家均收益（次日上涨）"
        value={signed(summary.avgWinRet)}
        sub={`亏损日均 ${signed(summary.avgLossRet)}`}
        color="#e53935"
        icon={<EmojiEvents fontSize="small" />}
      />
    </Box>
  );
}
