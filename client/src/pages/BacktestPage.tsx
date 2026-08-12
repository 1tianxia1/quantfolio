// ============================================================
// 回测结果页：选模型/区间/阈值 -> 跑回测 -> 指标卡 + 收益分布 + 逐笔表 + 调参面板
// ============================================================
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Box, Typography, Button, Select, MenuItem, FormControl, InputLabel, TextField, Stack, CircularProgress, Alert,
} from '@mui/material';
import InsightsIcon from '@mui/icons-material/Insights';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import ReactECharts from 'echarts-for-react';
import PageHeader from '../components/common/PageHeader';
import SectionCard from '../components/common/SectionCard';
import BacktestResultCards from '../components/backtest/BacktestResultCards';
import DataCaveatBanner from '../components/backtest/DataCaveatBanner';
import TradeTable from '../components/backtest/TradeTable';
import TuningPanel from '../components/backtest/TuningPanel';
import { backtestApi, type BacktestModelMeta, type BacktestResult, type RetBucket } from '../api/backtest';

const DEFAULT_RANGE: [string, string] = ['2025-08-12', '2026-08-10'];

/** 收益分布直方图（ECharts 柱状图） */
function DistributionChart({ distribution }: { distribution: RetBucket[] }) {
  const option = useMemo(() => ({
    grid: { left: 40, right: 16, top: 24, bottom: 48 },
    tooltip: { trigger: 'axis' },
    xAxis: {
      type: 'category',
      data: distribution.map((d) => d.bucket),
      axisLabel: { color: '#888', fontSize: 11, interval: 0, rotate: 30 },
    },
    yAxis: { type: 'value', name: '笔数', axisLabel: { color: '#888' }, splitLine: { lineStyle: { color: 'rgba(0,0,0,0.06)' } } },
    series: [
      {
        type: 'bar',
        data: distribution.map((d) => d.count),
        itemStyle: {
          color: (p: { dataIndex: number }) =>
            ['[0,1)', '[1,3)', '[3,5)', '[5,inf)'].includes(distribution[p.dataIndex]?.bucket)
              ? '#e53935'
              : '#90a4ae',
          borderRadius: [3, 3, 0, 0],
        },
        barWidth: '60%',
      },
    ],
  }), [distribution]);

  return <ReactECharts option={option} style={{ height: 260, width: '100%' }} notMerge />;
}

export default function BacktestPage() {
  const [models, setModels] = useState<BacktestModelMeta[]>([]);
  const [selectedModel, setSelectedModel] = useState<string>('closing');
  const [range, setRange] = useState<[string, string]>(DEFAULT_RANGE);
  const [topN, setTopN] = useState<number>(20);
  const [minScore, setMinScore] = useState<number>(0);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 加载模型元数据
  useEffect(() => {
    (async () => {
      try {
        const { models: ms } = await backtestApi.models();
        setModels(ms);
        if (ms.length && !ms.find((m) => m.key === selectedModel)) {
          setSelectedModel(ms[0].key);
        }
      } catch (e) {
        setError((e as Error).message || '加载模型失败');
      }
    })();
  }, [selectedModel]);

  const selectedMeta = useMemo(
    () => models.find((m) => m.key === selectedModel) || null,
    [models, selectedModel],
  );

  const handleRun = useCallback(async () => {
    if (!selectedMeta) return;
    setLoading(true);
    setError(null);
    try {
      const res = await backtestApi.run({
        model: selectedMeta.key,
        range,
        topN,
        minScore,
        weightsOverride: null,
        sampling: null,
        cap: 2000,
      });
      setResult(res);
    } catch (e) {
      setError((e as Error).message || '回测失败');
    } finally {
      setLoading(false);
    }
  }, [selectedMeta, range, topN, minScore]);

  return (
    <Box sx={{ p: { xs: 2, md: 3 } }}>
      <PageHeader
        title="回测 / 调参"
        subtitle="历史区间模拟选股表现，并网格搜索最优因子权重（早盘历史辅助数据缺失，结果仅供参考）"
        icon={<InsightsIcon />}
      />

      {/* 表单 */}
      <SectionCard sx={{ mb: 2 }}>
        <Stack
          direction={{ xs: 'column', md: 'row' }}
          spacing={2}
          alignItems={{ md: 'center' }}
          flexWrap="wrap"
        >
          <FormControl size="small" sx={{ minWidth: 180 }}>
            <InputLabel id="model-label">模型</InputLabel>
            <Select
              labelId="model-label"
              label="模型"
              value={selectedModel}
              onChange={(e) => setSelectedModel(e.target.value)}
            >
              {models.map((m) => (
                <MenuItem key={m.key} value={m.key}>
                  {m.label}{!m.faithful ? '（数据待补）' : ''}
                </MenuItem>
              ))}
            </Select>
          </FormControl>

          <TextField
            size="small"
            type="date"
            label="开始日"
            value={range[0]}
            onChange={(e) => setRange([e.target.value, range[1]])}
            InputLabelProps={{ shrink: true }}
          />
          <TextField
            size="small"
            type="date"
            label="结束日"
            value={range[1]}
            onChange={(e) => setRange([range[0], e.target.value])}
            InputLabelProps={{ shrink: true }}
          />
          <TextField
            size="small"
            type="number"
            label="每期入选数 topN"
            value={topN}
            onChange={(e) => setTopN(Math.max(1, Number(e.target.value) || 1))}
            sx={{ width: 140 }}
          />
          <TextField
            size="small"
            type="number"
            label="最低分 minScore"
            value={minScore}
            onChange={(e) => setMinScore(Number(e.target.value) || 0)}
            sx={{ width: 140 }}
          />
          <Button
            variant="contained"
            startIcon={loading ? <CircularProgress size={16} color="inherit" /> : <PlayArrowIcon />}
            onClick={handleRun}
            disabled={loading || !selectedMeta}
          >
            {loading ? '回测中…' : '运行回测'}
          </Button>
        </Stack>
      </SectionCard>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>
      )}

      {loading && (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
          <CircularProgress />
        </Box>
      )}

      {result && selectedMeta && !loading && (
        <Stack spacing={2}>
          <DataCaveatBanner show={!selectedMeta.faithful} text={result.dataCaveat || undefined} />

          <BacktestResultCards summary={result.summary} />

          <SectionCard title="次日收益分布" subtitle="按收益率区间统计入选标的笔数（红=正收益区间）">
            <DistributionChart distribution={result.summary.retDistribution} />
          </SectionCard>

          <SectionCard title="逐笔明细" subtitle={`共 ${result.trades.length} 笔（按交易日倒序展示最近 2000 笔）`} noPadding>
            <Box sx={{ p: 2 }}>
              <TradeTable trades={result.trades} />
            </Box>
          </SectionCard>

          <SectionCard title="权重调参" subtitle={`基于模型「${selectedMeta.label}」做网格搜索`}>
            <TuningPanel
              modelMeta={selectedMeta}
              range={range}
              topN={topN}
              minScore={minScore}
            />
          </SectionCard>
        </Stack>
      )}

      {!result && !loading && !error && (
        <Alert severity="info">选择模型与区间后点击「运行回测」。</Alert>
      )}
    </Box>
  );
}
