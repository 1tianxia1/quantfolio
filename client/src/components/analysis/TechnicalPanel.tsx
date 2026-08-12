// ============================================================
// TechnicalPanel：模块 B 策略指标（技术面）结果面板
// 信号徽标 + 命中原因 + K线/MACD 图 + 规则明细表
// 铁律：只展示盘面指标，不含任何「公司好坏/基本面」文字。
// 状态来自 analysisStore：路由切换不中断。
// ============================================================
import { useEffect, useRef } from 'react';
import { Alert, Box, Chip, CircularProgress, Stack, Typography } from '@mui/material';
import { useTechSession, startTech } from '../../store/analysisStore';
import type { KlineBar } from '../../api/market';
import SignalBadge from './SignalBadge';
import IndicatorTable from './IndicatorTable';
import KlineChart from '../charts/KlineChart';

interface TechnicalPanelProps {
  /** 待分析的 6 位代码 */
  code: string;
  /**
   * 运行令牌序号，由 AnalysisCenter 在用户点击时自增。
   * 与 QuantPanel 保持一致：只有 runId 变化才会重新调用 /api/analysis/technical，
   * 切换 Tab（仅改 CSS display）不会触发任何请求。传入 <= 0 表示尚未运行。
   */
  runId: number;
}

export default function TechnicalPanel({ code, runId }: TechnicalPanelProps) {
  const session = useTechSession(code);
  const startedRef = useRef<number>(-1);

  useEffect(() => {
    if (!code || runId <= 0) return;
    if (startedRef.current === runId) return;
    startedRef.current = runId;
    startTech(code);
    return () => {
      /* 保留后台运行，不中断 */
    };
  }, [code, runId]);

  const { status, report, error } = session;

  if (status === 'running') {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
        <CircularProgress size={28} />
      </Box>
    );
  }

  if (error) {
    return <Alert severity="warning">{error}</Alert>;
  }

  if (!report) return null;

  // 场外基金没有盘中行情，无法生成技术面信号
  if (report.is_otc_fund) {
    return (
      <Box>
        <Alert severity="info" sx={{ mb: 2 }}>
          {report.name}（{report.code}）是场外基金，仅每日披露一次净值，没有盘中 K 线、成交量与 MACD 等技术指标，因此不提供技术面买卖信号。建议切换到「量化分析 · AI 基本面」查看其基本面与消息面分析。
        </Alert>
        <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1.5 }}>
          <SignalBadge action={report.action} strength={report.strength} />
          <Typography variant="body2" color="text.secondary">
            {report.name}（{report.code}）· 净值日期 {report.trade_date}
            {report.meta.degraded ? ' · 数据源降级' : ''}
          </Typography>
        </Stack>
      </Box>
    );
  }

  // 组装 K 线 bars（供图表 tooltip / 真实锚定标注）
  const bars: KlineBar[] = report.series.map((b) => ({
    date: b.date,
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close ?? 0,
    volume: b.volume,
    amount: null,
    pct_chg: b.pct_chg,
    turnover_rate: null,
    volume_ratio: b.volume_ratio,
    data_origin: report.data_origin,
  }));

  const markers =
    report.action === 'buy'
      ? [{ type: 'buy' as const, index: report.series.length - 1 }]
      : report.action === 'sell'
        ? [{ type: 'sell' as const, index: report.series.length - 1 }]
        : [];

  const macd = {
    dif: report.series.map((b) => b.dif),
    dea: report.series.map((b) => b.dea),
    bar: report.series.map((b) => b.bar),
  };

  return (
    <Box>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems="center" sx={{ mb: 1.5 }}>
        <SignalBadge action={report.action} strength={report.strength} />
        <Typography variant="body2" color="text.secondary">
          {report.name}（{report.code}）· 截至 {report.trade_date}
          {report.meta.degraded ? ' · 数据源降级' : ''}
        </Typography>
      </Stack>

      {report.reasons.length > 0 && (
        <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap', mb: 1.5 }}>
          {report.reasons.map((r) => (
            <Chip key={r} size="small" label={r} variant="outlined" />
          ))}
        </Stack>
      )}

      <KlineChart bars={bars} macd={macd} markers={markers} height={440} />

      <Box sx={{ mt: 1.5 }}>
        <Typography variant="subtitle2" sx={{ mb: 0.5 }}>规则命中明细</Typography>
        <IndicatorTable rules={report.rules} />
      </Box>
    </Box>
  );
}
