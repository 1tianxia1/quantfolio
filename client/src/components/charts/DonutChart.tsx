// ============================================================
// DonutChart：配置环形图（ECharts）
// ============================================================
import ReactECharts from 'echarts-for-react';
import { useMemo } from 'react';
import { useTheme } from '@mui/material/styles';

export interface DonutDatum {
  name: string;
  value: number;
}

interface DonutChartProps {
  data: DonutDatum[];
  title?: string;
  height?: number;
  /** 显示为百分比 */
  percentMode?: boolean;
}

/** 环形图（当前配置 / 目标配置对比） */
export default function DonutChart({ data, title, height = 240, percentMode = true }: DonutChartProps) {
  const theme = useTheme();

  const option = useMemo(() => {
    const valid = data.filter((d) => d.value > 0);
    return {
      title: title
        ? { text: title, left: 'center', top: 0, textStyle: { fontSize: 13, color: theme.palette.text.secondary } }
        : undefined,
      tooltip: {
        trigger: 'item',
        formatter: (p: { name: string; value: number; percent: number }) =>
          `${p.name}: ${percentMode ? p.percent.toFixed(1) + '%' : p.value}`,
      },
      legend: {
        bottom: 0,
        type: 'scroll',
        textStyle: { color: theme.palette.text.secondary, fontSize: 11 },
      },
      series: [
        {
          name: title || '配置',
          type: 'pie',
          radius: ['45%', '70%'],
          center: ['50%', '48%'],
          avoidLabelOverlap: true,
          itemStyle: { borderRadius: 4, borderColor: theme.palette.background.paper, borderWidth: 2 },
          label: { show: false },
          emphasis: { label: { show: true, fontWeight: 'bold' } },
          data: valid,
        },
      ],
    };
  }, [data, title, theme, percentMode]);

  return <ReactECharts option={option} style={{ height, width: '100%' }} notMerge />;
}
