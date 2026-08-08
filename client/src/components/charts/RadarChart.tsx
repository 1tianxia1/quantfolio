// ============================================================
// RadarChart：评分雷达图
// ============================================================
import ReactECharts from 'echarts-for-react';
import { useMemo } from 'react';
import { useTheme } from '@mui/material/styles';
import type { FactorScore } from '../../api/screener';

interface RadarChartProps {
  factors: FactorScore[];
  height?: number;
}

/** 评分分项雷达图 */
export default function RadarChart({ factors, height = 260 }: RadarChartProps) {
  const theme = useTheme();

  const option = useMemo(() => {
    const names = factors.map((f) => f.label);
    const values = factors.map((f) => Math.round(f.score));
    return {
      tooltip: {},
      radar: {
        indicator: names.map((n) => ({ name: n, max: 100 })),
        radius: '65%',
        splitArea: { areaStyle: { color: ['rgba(46,124,246,0.02)', 'rgba(46,124,246,0.05)'] } },
        axisName: { color: theme.palette.text.secondary, fontSize: 11 },
      },
      series: [
        {
          type: 'radar',
          data: [
            {
              value: values,
              name: '评分',
              areaStyle: { color: 'rgba(46,124,246,0.25)' },
              lineStyle: { color: '#2E7CF6' },
              itemStyle: { color: '#2E7CF6' },
            },
          ],
        },
      ],
    };
  }, [factors, theme]);

  return <ReactECharts option={option} style={{ height, width: '100%' }} notMerge />;
}
