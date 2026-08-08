// ============================================================
// KlineChart：个股 K 线（标注真实/派生来源）+ 成交量
// ============================================================
import ReactECharts from 'echarts-for-react';
import { useMemo } from 'react';
import { useTheme } from '@mui/material/styles';
import type { KlineBar } from '../../api/market';
import { COLORS } from '@shared/constants';

interface KlineChartProps {
  bars: KlineBar[];
  height?: number;
}

/** 蜡烛图 + MA5/MA10/MA20 + 成交量 */
export default function KlineChart({ bars, height = 360 }: KlineChartProps) {
  const theme = useTheme();

  const option = useMemo(() => {
    const dates = bars.map((b) => b.date);
    const kData = bars.map((b) => [b.open, b.close, b.low, b.high].map((v) => (v == null ? 0 : v)));
    const vols = bars.map((b) => b.volume ?? 0);
    // MA 计算
    const ma = (n: number) =>
      bars.map((_, i) => {
        if (i < n - 1) return '-';
        const slice = bars.slice(i - n + 1, i + 1);
        const avg = slice.reduce((s, b) => s + (b.close ?? 0), 0) / n;
        return +avg.toFixed(2);
      });

    // 真实/派生分隔点：最后一根为 real
    const lastRealIndex = bars.length - 1;

    const markLine = {
      silent: true,
      symbol: 'none',
      lineStyle: { type: 'dashed', color: '#FFB020' },
      label: { formatter: '真实锚定', color: '#FFB020', fontSize: 10 },
      data: [{ xAxis: dates[lastRealIndex] }],
    };

    return {
      animation: false,
      legend: {
        data: ['K线', 'MA5', 'MA10', 'MA20'],
        top: 0,
        textStyle: { color: theme.palette.text.secondary, fontSize: 11 },
      },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'cross' },
        formatter: (params: { axisValue: string; data: number[] | number; seriesName: string }[]) => {
          const date = params[0]?.axisValue || '';
          const bar = bars.find((b) => b.date === date);
          const line = `<div>${date}${bar ? (bar.data_origin === 'real' ? ' <span style="color:#FFB020">[真实]</span>' : ' <span style="color:#8B949E">[派生]</span>') : ''}</div>`;
          const ohcl = bar ? `开 ${bar.open} 高 ${bar.high} 低 ${bar.low} 收 ${bar.close}<br/>涨跌 ${bar.pct_chg}% 量比 ${bar.volume_ratio ?? '—'}` : '';
          return line + ohcl;
        },
      },
      axisPointer: { link: [{ xAxisIndex: 'all' }] },
      grid: [
        { left: 50, right: 20, top: 30, height: '58%' },
        { left: 50, right: 20, top: '72%', height: '18%' },
      ],
      xAxis: [
        { type: 'category', data: dates, boundaryGap: true, axisLine: { lineStyle: { color: theme.palette.divider } }, axisLabel: { color: theme.palette.text.secondary, fontSize: 10 } },
        { type: 'category', gridIndex: 1, data: dates, axisLabel: { show: false }, axisLine: { lineStyle: { color: theme.palette.divider } } },
      ],
      yAxis: [
        { scale: true, splitLine: { lineStyle: { color: theme.palette.divider, opacity: 0.4 } }, axisLabel: { color: theme.palette.text.secondary, fontSize: 10 } },
        { gridIndex: 1, scale: true, splitLine: { show: false }, axisLabel: { show: false } },
      ],
      dataZoom: [
        { type: 'inside', xAxisIndex: [0, 1], start: 60, end: 100 },
        { type: 'slider', xAxisIndex: [0, 1], top: '94%', height: 14, start: 60, end: 100 },
      ],
      series: [
        {
          name: 'K线',
          type: 'candlestick',
          data: kData,
          itemStyle: { color: COLORS.UP, color0: COLORS.DOWN, borderColor: COLORS.UP, borderColor0: COLORS.DOWN },
          markLine,
        },
        { name: 'MA5', type: 'line', data: ma(5), smooth: true, showSymbol: false, lineStyle: { width: 1, color: '#F5A623' } },
        { name: 'MA10', type: 'line', data: ma(10), smooth: true, showSymbol: false, lineStyle: { width: 1, color: '#4A90E2' } },
        { name: 'MA20', type: 'line', data: ma(20), smooth: true, showSymbol: false, lineStyle: { width: 1, color: '#9B59B6' } },
        {
          name: '成交量',
          type: 'bar',
          xAxisIndex: 1,
          yAxisIndex: 1,
          data: vols,
          itemStyle: { color: (p: { dataIndex: number }) => (bars[p.dataIndex].close >= (bars[p.dataIndex].open ?? 0) ? COLORS.UP : COLORS.DOWN) },
        },
      ],
    };
  }, [bars, theme]);

  return <ReactECharts option={option} style={{ height, width: '100%' }} notMerge />;
}
