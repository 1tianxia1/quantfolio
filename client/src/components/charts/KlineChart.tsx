// ============================================================
// KlineChart：个股 K 线（标注真实/派生来源）+ 成交量
// 向后兼容扩展（架构 §9 T04）：
//   - 可选 macd：叠加 MACD 副图（bar + DIF/DEA 线）
//   - 可选 markers：在 K 线主图标记买卖点（买入=UP 色，卖出=DOWN 色）
// 旧调用方（StockDetailDrawer 等）不传新 props 时行为与之前完全一致。
// ============================================================
import ReactECharts from 'echarts-for-react';
import { useMemo } from 'react';
import { useTheme } from '@mui/material/styles';
import type { KlineBar } from '../../api/market';
import { COLORS } from '@shared/constants';

interface MacdSeries {
  dif: (number | null)[];
  dea: (number | null)[];
  bar: (number | null)[];
}

interface Marker {
  type: 'buy' | 'sell';
  index: number;
}

interface KlineChartProps {
  bars: KlineBar[];
  height?: number;
  macd?: MacdSeries;
  markers?: Marker[];
}

/** 蜡烛图 + MA5/MA10/MA20 + 成交量 +（可选）MACD 副图 + 买卖点 */
export default function KlineChart({ bars, height = 360, macd, markers = [] }: KlineChartProps) {
  const theme = useTheme();

  const option = useMemo(() => {
    const dates = bars.map((b) => b.date);
    const kData = bars.map((b) => [b.open, b.close, b.low, b.high].map((v) => (v == null ? 0 : v)));
    const vols = bars.map((b) => b.volume ?? 0);
    const hasMacd = Boolean(macd);
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

    // 买卖点标记（K 线主图）
    const markPoint = markers.length
      ? {
          symbol: 'pin',
          symbolSize: 38,
          label: {
            formatter: (p: { data: { type: string } }) => (p.data.type === 'buy' ? '买' : '卖'),
            color: '#fff',
            fontSize: 11,
            fontWeight: 700 as const,
          },
          data: markers.map((m) => ({
            name: m.type === 'buy' ? '买入' : '卖出',
            type: m.type,
            coord: [dates[m.index], bars[m.index]?.close ?? 0],
            itemStyle: { color: m.type === 'buy' ? COLORS.UP : COLORS.DOWN, borderColor: '#fff', borderWidth: 1 },
          })),
        }
      : undefined;

    // 图例（条件添加 MACD）
    const legendData = ['K线', 'MA5', 'MA10', 'MA20'];
    if (hasMacd) legendData.push('MACD', 'DIF', 'DEA');

    // 网格：主图 + 成交量 +（可选）MACD
    const grid: object[] = [
      { left: 50, right: 20, top: 30, height: hasMacd ? '46%' : '58%' },
      { left: 50, right: 20, top: hasMacd ? '58%' : '72%', height: '14%' },
    ];
    if (hasMacd) grid.push({ left: 50, right: 20, top: '76%', height: '13%' });

    const xAxis: object[] = [
      { type: 'category', data: dates, boundaryGap: true, axisLine: { lineStyle: { color: theme.palette.divider } }, axisLabel: { color: theme.palette.text.secondary, fontSize: 10 } },
      { type: 'category', gridIndex: 1, data: dates, axisLabel: { show: false }, axisLine: { lineStyle: { color: theme.palette.divider } } },
    ];
    if (hasMacd) {
      xAxis.push({ type: 'category', gridIndex: 2, data: dates, axisLabel: { show: false }, axisLine: { lineStyle: { color: theme.palette.divider } } });
    }

    const yAxis: object[] = [
      { scale: true, splitLine: { lineStyle: { color: theme.palette.divider, opacity: 0.4 } }, axisLabel: { color: theme.palette.text.secondary, fontSize: 10 } },
      { gridIndex: 1, scale: true, splitLine: { show: false }, axisLabel: { show: false } },
    ];
    if (hasMacd) {
      yAxis.push({ gridIndex: 2, scale: true, splitLine: { show: false }, axisLabel: { show: false } });
    }

    // MACD bar 着色（>0 用 UP 色，<0 用 DOWN 色；红涨绿跌）
    const macdBars = macd ? macd.bar.map((v) => ({ value: v == null ? 0 : v, itemStyle: { color: (v ?? 0) >= 0 ? COLORS.UP : COLORS.DOWN } })) : [];

    const series: object[] = [
      {
        name: 'K线',
        type: 'candlestick',
        data: kData,
        itemStyle: { color: COLORS.UP, color0: COLORS.DOWN, borderColor: COLORS.UP, borderColor0: COLORS.DOWN },
        markLine,
        ...(markPoint ? { markPoint } : {}),
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
    ];
    if (hasMacd && macd) {
      series.push(
        {
          name: 'MACD',
          type: 'bar',
          xAxisIndex: 2,
          yAxisIndex: 2,
          data: macdBars,
        },
        { name: 'DIF', type: 'line', xAxisIndex: 2, yAxisIndex: 2, data: macd.dif, smooth: true, showSymbol: false, lineStyle: { width: 1, color: '#F5A623' } },
        { name: 'DEA', type: 'line', xAxisIndex: 2, yAxisIndex: 2, data: macd.dea, smooth: true, showSymbol: false, lineStyle: { width: 1, color: '#4A90E2' } },
      );
    }

    return {
      animation: false,
      legend: { data: legendData, top: 0, textStyle: { color: theme.palette.text.secondary, fontSize: 11 } },
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
      grid,
      xAxis,
      yAxis,
      dataZoom: [
        { type: 'inside', xAxisIndex: [0, 1, ...(hasMacd ? [2] : [])], start: 60, end: 100 },
        { type: 'slider', xAxisIndex: [0, 1, ...(hasMacd ? [2] : [])], top: '94%', height: 14, start: 60, end: 100 },
      ],
      series,
    };
  }, [bars, theme, macd, markers]);

  return <ReactECharts option={option} style={{ height, width: '100%' }} notMerge />;
}
