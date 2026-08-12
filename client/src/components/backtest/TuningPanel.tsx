// ============================================================
// 调参面板：权重滑块 + 网格搜索调参 + 保存为策略
// ============================================================
import { useMemo, useState } from 'react';
import {
  Box, Typography, Button, Slider, Select, MenuItem, FormControl, InputLabel, Stack, Alert, Divider,
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Paper, Chip, CircularProgress,
} from '@mui/material';
import TuneIcon from '@mui/icons-material/Tune';
import SaveIcon from '@mui/icons-material/Save';
import { backtestApi, type BacktestModelMeta, type TuneCombo } from '../../api/backtest';
import { strategyApi } from '../../api/strategy';

interface Props {
  modelMeta: BacktestModelMeta;
  range: [string, string];
  topN: number;
  minScore: number;
}

/** 模型 key -> 策略 type 枚举 */
function toStrategyType(modelKey: string): string {
  switch (modelKey) {
    case 'morning': return 'morning';
    case 'closing': return 'closing';
    case 'morningPipeline': return 'pipeline_morning';
    case 'closingPipeline': return 'pipeline_closing';
    default: return modelKey;
  }
}

const round2 = (v: number) => Math.round(v * 100) / 100;

export default function TuningPanel({ modelMeta, range, topN, minScore }: Props) {
  const isWeighted = !!modelMeta.defaultWeights;
  const factorKeys = modelMeta.factorKeys;

  // 滑块权重（初始 = 默认权重）
  const [weights, setWeights] = useState<Record<string, number>>(
    () => ({ ...(modelMeta.defaultWeights || {}) }),
  );
  const [objective, setObjective] = useState<'winRate' | 'avgRet'>('winRate');
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<TuneCombo[]>([]);
  const [combinations, setCombinations] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  // 由滑块值生成调参网格：每个因子候选 = [当前值, 默认值]（去重），组合数 ≤ 2^因子数
  const tuneTargets = useMemo(() => {
    const targets: Record<string, number[]> = {};
    if (!isWeighted) return targets;
    for (const k of factorKeys) {
      const v = round2(weights[k] ?? modelMeta.defaultWeights?.[k] ?? 0);
      const d = round2(modelMeta.defaultWeights?.[k] ?? v);
      const set = Array.from(new Set([v, d]));
      targets[k] = set;
    }
    return targets;
  }, [weights, factorKeys, isWeighted, modelMeta.defaultWeights]);

  const comboCount = useMemo(() => {
    const lens = Object.values(tuneTargets).map((a) => a.length);
    return lens.reduce((p, n) => p * n, 1);
  }, [tuneTargets]);

  function setFactor(key: string, value: number) {
    setWeights((w) => ({ ...w, [key]: value }));
  }

  async function handleTune() {
    setLoading(true);
    setError(null);
    setSaveMsg(null);
    try {
      const res = await backtestApi.tune({
        model: modelMeta.key,
        range,
        topN,
        minScore,
        tuneTargets,
        objective,
        sampling: { step: 5 },
        topK: 10,
      });
      setResults(res.results);
      setCombinations(res.combinations);
    } catch (e) {
      setError((e as Error).message || '调参失败');
    } finally {
      setLoading(false);
    }
  }

  async function handleSave(weightsToSave: Record<string, number>, labelSuffix: string) {
    setSaveMsg(null);
    try {
      const name = `回测策略-${modelMeta.label}-${labelSuffix}-${new Date().toISOString().slice(0, 10)}`;
      await strategyApi.create({
        name,
        type: toStrategyType(modelMeta.key),
        conditions: { weights: weightsToSave, model: modelMeta.key },
      });
      setSaveMsg(`已保存策略「${name}」`);
    } catch (e) {
      setSaveMsg(`保存失败：${(e as Error).message || '未知错误'}`);
    }
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Typography variant="subtitle1" sx={{ fontWeight: 700, display: 'flex', alignItems: 'center', gap: 1 }}>
        <TuneIcon fontSize="small" /> 权重调参
      </Typography>

      {!isWeighted && (
        <Alert severity="info">
          该模型（{modelMeta.label}）为点数制，权重不参与评分，无需调参。可直接「保存为策略」以记录当前模型。
        </Alert>
      )}

      {/* 权重滑块 */}
      {isWeighted && (
        <Paper variant="outlined" sx={{ p: 2, borderRadius: 2 }}>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
            拖动调整因子权重（初值取自默认权重）；「开始调参」将对各因子在「当前值 / 默认值」间做网格搜索。
          </Typography>
          <Stack spacing={2}>
            {factorKeys.map((k) => (
              <Box key={k}>
                <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
                  <Typography variant="body2">{k}</Typography>
                  <Typography variant="body2" color="primary" sx={{ fontWeight: 700 }}>
                    {(weights[k] ?? modelMeta.defaultWeights?.[k] ?? 0).toFixed(2)}
                  </Typography>
                </Box>
                <Slider
                  size="small"
                  min={0}
                  max={1}
                  step={0.05}
                  value={weights[k] ?? modelMeta.defaultWeights?.[k] ?? 0}
                  onChange={(_e, v) => setFactor(k, v as number)}
                  valueLabelDisplay="auto"
                />
              </Box>
            ))}
          </Stack>
        </Paper>
      )}

      {/* 目标 + 操作 */}
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems={{ sm: 'center' }}>
        <FormControl size="small" sx={{ minWidth: 160 }}>
          <InputLabel id="objective-label">优化目标</InputLabel>
          <Select
            labelId="objective-label"
            label="优化目标"
            value={objective}
            onChange={(e) => setObjective(e.target.value as 'winRate' | 'avgRet')}
          >
            <MenuItem value="winRate">天天红（胜率）</MenuItem>
            <MenuItem value="avgRet">多赚钱（平均收益）</MenuItem>
          </Select>
        </FormControl>

        <Button
          variant="contained"
          startIcon={loading ? <CircularProgress size={16} color="inherit" /> : <TuneIcon />}
          onClick={handleTune}
          disabled={loading || !isWeighted}
        >
          {loading ? '调参中…' : '开始调参'}
        </Button>

        <Button
          variant="outlined"
          startIcon={<SaveIcon />}
          onClick={() => handleSave(isWeighted ? weights : {}, '当前')}
        >
          保存为策略
        </Button>

        {isWeighted && (
          <Chip size="small" color="default" variant="outlined" label={`组合数 ≈ ${comboCount}（采样步长5）`} />
        )}
      </Stack>

      {error && <Alert severity="error">{error}</Alert>}
      {saveMsg && <Alert severity="success">{saveMsg}</Alert>}

      {/* 调参结果 TopK */}
      {results.length > 0 && (
        <Box>
          <Divider sx={{ my: 1 }} />
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            共 {combinations} 组组合，按「{objective === 'winRate' ? '胜率' : '平均收益'}」排序取 Top {results.length}：
          </Typography>
          <TableContainer component={Paper} variant="outlined" sx={{ borderRadius: 2 }}>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>#</TableCell>
                  <TableCell>权重组合</TableCell>
                  <TableCell align="right">胜率</TableCell>
                  <TableCell align="right">平均次日</TableCell>
                  <TableCell align="right">赢家均</TableCell>
                  <TableCell align="right">笔数</TableCell>
                  <TableCell align="right">保存</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {results.map((r) => (
                  <TableRow key={r.rank} hover>
                    <TableCell>{r.rank}</TableCell>
                    <TableCell sx={{ fontSize: 12, maxWidth: 320 }}>
                      {Object.entries(r.weights).map(([k, v]) => (
                        <Chip key={k} size="small" label={`${k}:${v.toFixed(2)}`} sx={{ mr: 0.5, mb: 0.5 }} />
                      ))}
                    </TableCell>
                    <TableCell align="right">{(r.metrics.winRate * 100).toFixed(1)}%</TableCell>
                    <TableCell align="right" sx={{ color: r.metrics.avgNextRet >= 0 ? '#e53935' : '#2e9e4f', fontWeight: 700 }}>
                      {r.metrics.avgNextRet.toFixed(2)}%
                    </TableCell>
                    <TableCell align="right">{r.metrics.avgWinRet.toFixed(2)}%</TableCell>
                    <TableCell align="right">{r.metrics.picks}</TableCell>
                    <TableCell align="right">
                      <Button size="small" startIcon={<SaveIcon />} onClick={() => handleSave(r.weights, `Top${r.rank}`)}>
                        存
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        </Box>
      )}
    </Box>
  );
}
