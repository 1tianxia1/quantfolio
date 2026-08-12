// ============================================================
// 模块三：尾盘选股器（五步法漏斗 + 通用量化指标筛选 + AI）
// ============================================================
import { useCallback, useEffect, useState } from 'react';
import { Box, Typography, Button, Alert, ToggleButton, ToggleButtonGroup, FormControlLabel, Checkbox, Chip, Stack } from '@mui/material';
import PipelineFunnel from '../components/screener/PipelineFunnel';
import ConditionPanelClosing, { type ClosingConditions } from '../components/screener/ConditionPanelClosing';
import ScreenerResultsTable from '../components/screener/ScreenerResultsTable';
import StockDetailDrawer from '../components/screener/StockDetailDrawer';
import StrategySaveDialog from '../components/screener/StrategySaveDialog';
import AiPanel from '../components/ai/AiPanel';
import Loading from '../components/common/Loading';
import { useSnackbar } from '../components/common/SnackbarProvider';
import { screenerApi, type PipelineResult, type PipelineStepConfig, type ScreenerResult, type Strategy } from '../api/screener';
import { aiApi } from '../api/ai';
import { strategyApi } from '../api/strategy';
import { marketApi } from '../api/market';
import { useAuthStore } from '../store/authStore';
import { useAiConfigStore } from '../store/aiConfigStore';
import { useNavigate } from 'react-router-dom';
import WbTwilightIcon from '@mui/icons-material/WbTwilight';
import PageHeader from '../components/common/PageHeader';
import SectionCard from '../components/common/SectionCard';

export default function ClosingScreen() {
  const navigate = useNavigate();
  const { isLoggedIn } = useAuthStore();
  const snackbar = useSnackbar();

  const [mode, setMode] = useState<'pipeline' | 'general'>('pipeline');
  const [presets, setPresets] = useState<Strategy[]>([]);
  const [selectedPreset, setSelectedPreset] = useState<Strategy | null>(null);
  const [steps, setSteps] = useState<PipelineStepConfig[]>([]);
  const [pipeline, setPipeline] = useState<PipelineResult | null>(null);
  // 严格五步法 0 命中时自动放宽，保证有数据可看
  const [relaxed, setRelaxed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [marketTotal, setMarketTotal] = useState(97);
  const [demoMode, setDemoMode] = useState(false);
  const [tradeDate, setTradeDate] = useState<string>('--');

  const [conditions, setConditions] = useState<ClosingConditions>({
    universe: { excludeST: true, excludeNew: true, types: ['stock'] },
    ma: { pattern: 'bullish' },
    volRatio5: { min: 1.5 },
    mv: { range: [50, 5000] },
  });
  const [generalResult, setGeneralResult] = useState<{ total: number; items: ScreenerResult[] } | null>(null);
  const [generalLoading, setGeneralLoading] = useState(false);
  const [estimated, setEstimated] = useState<number | null>(null);

  const [aiContent, setAiContent] = useState<string | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiCached, setAiCached] = useState(false);
  const [aiGeneratedAt, setAiGeneratedAt] = useState<string | undefined>();

  const [detail, setDetail] = useState<{ open: boolean; stock: ScreenerResult | null }>({ open: false, stock: null });
  const [saveOpen, setSaveOpen] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const overview = await marketApi.overview();
        setMarketTotal(overview.stock_count);
        const [meta, status] = await Promise.all([
          marketApi.meta().catch(() => null),
          marketApi.status().catch(() => null),
        ]);
        if (meta?.trade_date) setTradeDate(meta.trade_date);
        setDemoMode(!(status?.realtimeEnabled));
        const p = await screenerApi.presets();
        setPresets(p.closing);
        const defaultPreset = p.closing.find((s) => s.type === 'pipeline_closing') || p.closing[0];
        if (defaultPreset) applyPreset(defaultPreset);
      } catch (e) {
        snackbar.show((e as Error).message, 'error');
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const applyPreset = (strategy: Strategy) => {
    setSelectedPreset(strategy);
    let cond = {} as Record<string, unknown>;
    try { cond = JSON.parse(strategy.conditions); } catch { cond = {}; }
    if (strategy.type === 'pipeline_closing' || cond.steps) {
      setMode('pipeline');
      setSteps((cond.steps as PipelineStepConfig[]) || []);
    } else {
      setMode('general');
      setConditions((cond as ClosingConditions) || {});
    }
  };

  // 尾盘五步法「放宽」：关闭放量连日限制，放宽 市值/涨幅/换手 区间
  const buildRelaxedSteps = (st: PipelineStepConfig[]): PipelineStepConfig[] =>
    st.map((s) => {
      if (s.id === 'vol_streak') return { ...s, enabled: false };
      if (s.id === 'mv50_500') return { ...s, params: { ...s.params, min: 20, max: 8000 } };
      if (s.id === 'pct3_5') return { ...s, params: { ...s.params, min: 1, max: 9 } };
      if (s.id === 'turnover5_20') return { ...s, params: { ...s.params, min: 3, max: 25 } };
      return s;
    });

  const runPipeline = useCallback(async (st = steps, autoRelax = true) => {
    setLoading(true);
    try {
      const r = await screenerApi.runPipeline({ type: 'closing', steps: st });
      setPipeline(r);
      if (r.items.length === 0 && autoRelax) {
        const rr = await screenerApi.runPipeline({ type: 'closing', steps: buildRelaxedSteps(st) });
        setPipeline(rr);
        setRelaxed(true);
      } else {
        setRelaxed(false);
      }
      return r;
    } catch (e) {
      snackbar.show((e as Error).message, 'error');
      return null;
    } finally {
      setLoading(false);
    }
  }, [steps, snackbar]);

  // 手动切换严格/放宽
  const toggleRelax = () => {
    if (relaxed) {
      setRelaxed(false);
      void runPipeline(steps, false);
    } else {
      setRelaxed(true);
      void runPipeline(buildRelaxedSteps(steps), false);
    }
  };

  const runGeneral = useCallback(async (cond = conditions) => {
    setGeneralLoading(true);
    try {
      const r = await screenerApi.closing({ ...cond, universe: { excludeST: true, excludeNew: true, types: ['stock'], ...(cond.universe || {}) } });
      setGeneralResult({ total: r.total, items: r.items });
    } catch (e) {
      snackbar.show((e as Error).message, 'error');
    } finally {
      setGeneralLoading(false);
    }
  }, [conditions, snackbar]);

  // 实时预估（C-18）
  useEffect(() => {
    if (mode !== 'general') return;
    const t = setTimeout(() => {
      screenerApi.estimate('closing', conditions as unknown as import('../api/screener').ScreenerConditions)
        .then((r) => setEstimated(r.estimated_count))
        .catch(() => undefined);
    }, 400);
    return () => clearTimeout(t);
  }, [conditions, mode]);

  useEffect(() => {
    if (steps.length && mode === 'pipeline') runPipeline();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadAi = async (force = false) => {
    setAiLoading(true);
    try {
      const items = (mode === 'pipeline' ? pipeline?.items : generalResult?.items) || [];
      const r = await aiApi.closingInterpret({
        items: items.slice(0, 5),
        conditions: mode === 'general' ? conditions : null,
        strategy_id: selectedPreset?.id ?? null,
        force_refresh: force,
      });
      setAiContent(r.content);
      setAiCached(r.cached);
      setAiGeneratedAt(r.generated_at);
      useAiConfigStore.getState().setFromMeta(r.ai_meta);
    } catch (e) {
      snackbar.show((e as Error).message, 'error');
    } finally {
      setAiLoading(false);
    }
  };

  const handleSave = async (name: string, savePipeline: boolean) => {
    if (!isLoggedIn()) {
      snackbar.show('请先登录后再保存策略', 'warning');
      navigate('/login?redirect=/closing');
      return;
    }
    const type = mode === 'pipeline' ? 'pipeline_closing' : 'closing';
    const cond = mode === 'pipeline'
      ? { type: 'pipeline_closing', steps: savePipeline ? steps : [] }
      : { type: 'closing', ...conditions };
    await strategyApi.create({ name, type, conditions: cond });
    snackbar.show('策略已保存', 'success');
  };

  const handleExport = async () => {
    try {
      const cond = mode === 'pipeline'
        ? { universe: { excludeST: true, types: ['stock'] } }
        : { ...conditions, universe: { excludeST: true, excludeNew: true, types: ['stock'], ...(conditions.universe || {}) } };
      const res = await screenerApi.exportCsv('closing', cond as unknown as import('../api/screener').ScreenerConditions);
      const blob = res.data as Blob;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `quantfolio_closing_${(tradeDate || '').replace(/-/g, '')}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      snackbar.show('CSV 已导出（UTF-8 BOM）', 'success');
    } catch (e) {
      snackbar.show((e as Error).message, 'error');
    }
  };

  const addWatchlist = async (code: string) => {
    await marketApi.addWatchlist(code);
  };

  const results = mode === 'pipeline' ? pipeline?.items || [] : generalResult?.items || [];
  const total = mode === 'pipeline' ? results.length : generalResult?.total || 0;
  const loadingNow = mode === 'pipeline' ? loading : generalLoading;

  return (
    <Box>
      {demoMode && (
        <Alert severity="warning" sx={{ mb: 2, fontSize: 13 }}>
          当前为演示数据（未接入真实行情），筛选与行情结果仅供功能演示；接入真实行情后将显示实盘数据。
        </Alert>
      )}
      <PageHeader
        title="尾盘选股器"
        subtitle={`交易日：${tradeDate} · 五步法漏斗 / 量化指标筛选`}
        icon={<WbTwilightIcon />}
        actions={
          <>
            <Button size="small" variant="outlined" onClick={() => setSaveOpen(true)}>保存为我的策略</Button>
            <Button size="small" variant="contained" onClick={() => (mode === 'pipeline' ? runPipeline() : runGeneral())}>
              开始筛选 ▶
            </Button>
          </>
        }
      />

      <ToggleButtonGroup size="small" exclusive value={mode} onChange={(_e, v) => v && setMode(v)} sx={{ mb: 2 }}>
        <ToggleButton value="pipeline">尾盘五步法（用户核心）</ToggleButton>
        <ToggleButton value="general">通用指标筛选（高级）</ToggleButton>
      </ToggleButtonGroup>

      <Stack direction={{ xs: 'column', lg: 'row' }} spacing={2}>
        <Box sx={{ width: { xs: '100%', lg: 360 }, flexShrink: 0 }}>
          <SectionCard title="策略模板" action={<Chip label={selectedPreset?.name || '未选择'} size="small" variant="outlined" />}>
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, mb: 2 }}>
              {presets.map((p) => (
                <Chip key={p.id} label={p.name} size="small" color={selectedPreset?.id === p.id ? 'primary' : 'default'} variant={selectedPreset?.id === p.id ? 'filled' : 'outlined'} onClick={() => applyPreset(p)} />
              ))}
            </Box>

            {mode === 'pipeline' ? (
              <>
                {steps.length > 0 && (
                  <Box sx={{ mb: 1 }}>
                    {steps.map((s) => (
                      <FormControlLabel
                        key={s.id}
                        control={<Checkbox size="small" checked={s.enabled} onChange={(e) => setSteps((st) => st.map((x) => (x.id === s.id ? { ...x, enabled: e.target.checked } : x)))} />}
                        label={<Typography variant="caption">{s.label}</Typography>}
                        sx={{ display: 'block', m: 0 }}
                      />
                    ))}
                  </Box>
                )}
                {relaxed && pipeline && pipeline.items.length > 0 && (
                  <Alert
                    severity="info"
                    sx={{ mb: 1, fontSize: 12 }}
                    action={
                      <Button size="small" color="inherit" onClick={toggleRelax} sx={{ whiteSpace: 'nowrap' }}>
                        还原严格五步法
                      </Button>
                    }
                  >
                    严格五步法 0 命中，已自动放宽（关闭「连续放量」、放宽市值/涨幅/换手区间）展示 {pipeline.items.length} 只。
                  </Alert>
                )}
                {pipeline && pipeline.items.length === 0 && (
                  <Alert severity="info" sx={{ mb: 1, fontSize: 12 }}>
                    {pipeline.dataHint || '当前严格五步法与放宽版均无命中（行情数据或形态条件限制）。可切换「通用指标筛选」放宽更多维度。'}
                  </Alert>
                )}
              </>
            ) : (
              <>
                <ConditionPanelClosing value={conditions} onChange={setConditions} />
                {estimated != null && (
                  <Alert severity="info" sx={{ mt: 1, fontSize: 12 }}>
                    预计命中约 <b>{estimated}</b> 只（实时预估）
                  </Alert>
                )}
              </>
            )}
          </SectionCard>
        </Box>

        <Box sx={{ flex: 1, minWidth: 0 }}>
          {mode === 'pipeline' && pipeline && <PipelineFunnel funnel={pipeline.funnel} totalStart={marketTotal} />}
          {loadingNow ? (
            <Loading rows={6} />
          ) : (
            <ScreenerResultsTable items={results} total={total} marketTotal={marketTotal} onExport={handleExport} onRowClick={(s) => setDetail({ open: true, stock: s })} />
          )}
          <AiPanel
            title="AI 量化解读（Top5）"
            content={aiContent}
            loading={aiLoading}
            cached={aiCached}
            generatedAt={aiGeneratedAt}
            onRefresh={() => loadAi(true)}
            emptyText="点击「重新生成」获取 AI 对 Top 标的的量化逻辑解读"
          />
        </Box>
      </Stack>

      <StockDetailDrawer open={detail.open} stock={detail.stock} onClose={() => setDetail({ open: false, stock: null })} onAddWatchlist={addWatchlist} />
      <StrategySaveDialog open={saveOpen} defaultName={selectedPreset?.name || '我的尾盘策略'} onClose={() => setSaveOpen(false)} onSave={handleSave} />
    </Box>
  );
}
