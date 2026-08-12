// ============================================================
// 模块二：早盘选股（七步法漏斗 + 竞价榜 + 通用筛选 + AI）
// ============================================================
import { useCallback, useEffect, useState } from 'react';
import { Box, Typography, Button, Alert, ToggleButton, ToggleButtonGroup, FormControlLabel, Checkbox, Stack, Chip } from '@mui/material';
import PipelineFunnel from '../components/screener/PipelineFunnel';
import AuctionLeaderboard from '../components/screener/AuctionLeaderboard';
import ConditionPanelMorning, { type MorningConditions } from '../components/screener/ConditionPanelMorning';
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
import WbSunnyIcon from '@mui/icons-material/WbSunny';
import PageHeader from '../components/common/PageHeader';
import SectionCard from '../components/common/SectionCard';

export default function MorningScreen() {
  const navigate = useNavigate();
  const { isLoggedIn } = useAuthStore();
  const snackbar = useSnackbar();

  const [mode, setMode] = useState<'pipeline' | 'general'>('pipeline');
  const [presets, setPresets] = useState<Strategy[]>([]);
  const [selectedPreset, setSelectedPreset] = useState<Strategy | null>(null);
  const [steps, setSteps] = useState<PipelineStepConfig[]>([]);
  const [looseMode, setLooseMode] = useState(false);
  // 严格七步法 0 命中时自动放宽（去除 热点板块/小盘/首笔量比/多头排列 限制），保证有数据可看
  const [relaxed, setRelaxed] = useState(false);
  const [pipeline, setPipeline] = useState<PipelineResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [marketTotal, setMarketTotal] = useState(97);
  const [demoMode, setDemoMode] = useState(false);
  const [tradeDate, setTradeDate] = useState<string>('--');

  // 通用筛选（放宽默认：去掉过严的 3 日主力净流入≥3000万，扩大涨跌幅/换手/竞价区间）
  const [conditions, setConditions] = useState<MorningConditions>({ universe: { excludeST: true, excludeNew: true }, prevPctChg: [-5, 9], volumeRatio: { min: 1 }, turnover: [1, 25], auction: { pct: [0, 8] } });
  const [generalResult, setGeneralResult] = useState<{ total: number; items: ScreenerResult[] } | null>(null);
  const [generalLoading, setGeneralLoading] = useState(false);

  const [leaderboard, setLeaderboard] = useState<{ items: import('../api/screener').AuctionItem[] } | null>(null);
  const [hotSectors, setHotSectors] = useState<string[]>([]);

  const [aiContent, setAiContent] = useState<string | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiCached, setAiCached] = useState(false);
  const [aiGeneratedAt, setAiGeneratedAt] = useState<string | undefined>();

  const [detail, setDetail] = useState<{ open: boolean; stock: ScreenerResult | null }>({ open: false, stock: null });
  const [saveOpen, setSaveOpen] = useState(false);

  // 初始化：加载预置模板 + 竞价榜 + 板块
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
        const [p, lb] = await Promise.all([screenerApi.presets(), screenerApi.auctionLeaderboard(60)]);
        setPresets(p.morning);
        setLeaderboard(lb);
        const defaultPreset = p.morning.find((s) => s.type === 'pipeline_morning') || p.morning[0];
        if (defaultPreset) applyPreset(defaultPreset);
        // 板块（sector 维度 Top 30 名称）
        const sectors = await marketApi.sectors('sector', 30);
        setHotSectors(sectors.map((s) => s.sector_name));
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
    if (strategy.type === 'pipeline_morning' || cond.steps) {
      setMode('pipeline');
      setSteps((cond.steps as PipelineStepConfig[]) || []);
      setLooseMode(!!cond.loose_mode);
    } else {
      setMode('general');
      setConditions((cond as MorningConditions) || {});
    }
  };

  // 早盘七步法中「放宽」时跳过的步骤（数据缺失或过于严苛，导致全市场 0 命中）
  const MORNING_RELAX_SKIP = ['hot_sector', 'mv_lt10', 'first_trade_vol', 'ma_bullish60'];

  const runPipeline = useCallback(async (st = steps, loose = looseMode, autoRelax = true) => {
    setLoading(true);
    try {
      const r = await screenerApi.runPipeline({ type: 'morning', steps: st, loose_mode: loose });
      setPipeline(r);
      // 严格版 0 命中 → 自动放宽，保证用户总能看到数据；放宽版仍 0 才算真没数据
      if (r.items.length === 0 && autoRelax) {
        const relaxedSteps = st.map((s) => ({ ...s, enabled: MORNING_RELAX_SKIP.includes(s.id) ? false : s.enabled }));
        const rr = await screenerApi.runPipeline({ type: 'morning', steps: relaxedSteps, loose_mode: true });
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
  }, [steps, looseMode, snackbar]);

  // 手动切换严格/放宽
  const toggleRelax = () => {
    if (relaxed) {
      setRelaxed(false);
      void runPipeline(steps, looseMode, false);
    } else {
      const relaxedSteps = steps.map((s) => ({ ...s, enabled: MORNING_RELAX_SKIP.includes(s.id) ? false : s.enabled }));
      setRelaxed(true);
      void runPipeline(relaxedSteps, true, false);
    }
  };

  // 批量勾选：全选 / 取消勾选（全不选 = 查看全市场所有可筛股票，再按勾选逐步过滤）
  const selectAllSteps = () => {
    const next = steps.map((s) => ({ ...s, enabled: true }));
    setSteps(next);
    setRelaxed(false);
    void runPipeline(next, looseMode, false);
  };
  const deselectAllSteps = () => {
    const next = steps.map((s) => ({ ...s, enabled: false }));
    setSteps(next);
    setRelaxed(false);
    void runPipeline(next, looseMode, false);
  };

  const runGeneral = useCallback(async (cond = conditions) => {
    setGeneralLoading(true);
    try {
      const r = await screenerApi.morning({ ...cond, universe: { excludeST: true, excludeNew: true, ...(cond.universe || {}) } });
      setGeneralResult({ total: r.total, items: r.items });
    } catch (e) {
      snackbar.show((e as Error).message, 'error');
    } finally {
      setGeneralLoading(false);
    }
  }, [conditions, snackbar]);

  // 默认自动跑一次
  useEffect(() => {
    if (steps.length && mode === 'pipeline') runPipeline();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadAi = async (force = false) => {
    setAiLoading(true);
    try {
      const items = (mode === 'pipeline' ? pipeline?.items : generalResult?.items) || [];
      const r = await aiApi.morningComment({ items: items.slice(0, 10), force_refresh: force });
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
      navigate('/login?redirect=/morning');
      return;
    }
    const type = mode === 'pipeline' ? 'pipeline_morning' : 'morning';
    const cond = mode === 'pipeline'
      ? { type: 'pipeline_morning', steps: savePipeline ? steps : [], loose_mode: looseMode }
      : { type: 'morning', ...conditions };
    await strategyApi.create({ name, type, conditions: cond });
    snackbar.show('策略已保存', 'success');
  };

  const handleExport = async () => {
    try {
      const type = mode === 'pipeline' ? 'morning' : 'morning';
      const cond = mode === 'pipeline' ? { universe: { excludeST: true, types: ['stock'] } } : { ...conditions, universe: { excludeST: true, excludeNew: true, ...(conditions.universe || {}) } };
      const res = await screenerApi.exportCsv(type, cond as unknown as import('../api/screener').ScreenerConditions);
      const blob = res.data as Blob;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `quantfolio_morning_${(tradeDate || '').replace(/-/g, '')}.csv`;
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
        title="早盘选股"
        subtitle={`交易日：${tradeDate} · 七步法漏斗 / 通用筛选`}
        icon={<WbSunnyIcon />}
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
        <ToggleButton value="pipeline">早盘七步法（用户核心）</ToggleButton>
        <ToggleButton value="general">通用指标筛选</ToggleButton>
      </ToggleButtonGroup>

      <Stack direction={{ xs: 'column', lg: 'row' }} spacing={2}>
        {/* 左侧：条件/漏斗 */}
        <Box sx={{ width: { xs: '100%', lg: 360 }, flexShrink: 0 }}>
          <SectionCard title="策略模板" action={<Chip label={selectedPreset?.name || '未选择'} size="small" variant="outlined" />}>
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, mb: 2 }}>
              {presets.map((p) => (
                <Chip key={p.id} label={p.name} size="small" color={selectedPreset?.id === p.id ? 'primary' : 'default'} variant={selectedPreset?.id === p.id ? 'filled' : 'outlined'} onClick={() => applyPreset(p)} />
              ))}
            </Box>

            {mode === 'pipeline' ? (
              <>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
                  <Button size="small" variant="outlined" onClick={selectAllSteps} disabled={!steps.length}>全选</Button>
                  <Button size="small" variant="outlined" onClick={deselectAllSteps} disabled={!steps.length}>取消勾选</Button>
                  <Typography variant="caption" color="text.secondary" sx={{ ml: 'auto' }}>
                    勾选即过滤，全不选=看全市场
                  </Typography>
                </Box>
                {steps.length > 0 && (
                  <Box sx={{ mb: 1 }}>
                    {steps.map((s) => (
                      <FormControlLabel
                        key={s.id}
                        control={
                          <Checkbox
                            size="small"
                            checked={s.enabled}
                            onChange={(e) => {
                              const next = steps.map((x) => (x.id === s.id ? { ...x, enabled: e.target.checked } : x));
                              setSteps(next);
                              setRelaxed(false);
                              void runPipeline(next, looseMode, false);
                            }}
                          />
                        }
                        label={<Typography variant="caption">{s.label}</Typography>}
                        sx={{ display: 'block', m: 0 }}
                      />
                    ))}
                  </Box>
                )}
                <FormControlLabel
                  control={
                    <Checkbox
                      size="small"
                      checked={looseMode}
                      onChange={(e) => {
                        const next = e.target.checked;
                        setLooseMode(next);
                        setRelaxed(false);
                        void runPipeline(steps, next, false);
                      }}
                    />
                  }
                  label={<Typography variant="caption">宽松模式（第4步 &lt;30亿，默认 &lt;10亿）</Typography>}
                  sx={{ mb: 1 }}
                />
                {relaxed && pipeline && pipeline.items.length > 0 && (
                  <Alert
                    severity="info"
                    sx={{ mb: 1, fontSize: 12 }}
                    action={
                      <Button size="small" color="inherit" onClick={toggleRelax} sx={{ whiteSpace: 'nowrap' }}>
                        还原严格七步法
                      </Button>
                    }
                  >
                    严格七步法 0 命中，已自动放宽（去除「热点板块 / 小盘 / 首笔量比 / 多头排列」限制）展示 {pipeline.items.length} 只。
                  </Alert>
                )}
                {pipeline && pipeline.items.length === 0 && (
                  <Alert severity="info" sx={{ mb: 1, fontSize: 12 }}>
                    {pipeline.dataHint || '当前严格七步法与放宽版均无命中（行情数据或形态条件限制）。可切换「通用指标筛选」放宽更多维度。'}
                  </Alert>
                )}
              </>
            ) : (
              <ConditionPanelMorning value={conditions} onChange={setConditions} hotSectors={hotSectors} />
            )}
          </SectionCard>
        </Box>

        {/* 右侧：结果 */}
        <Box sx={{ flex: 1, minWidth: 0 }}>
          {mode === 'pipeline' && (
            <>
              {pipeline && <PipelineFunnel funnel={pipeline.funnel} totalStart={marketTotal} />}
              {loading && <Loading rows={4} />}
            </>
          )}
          {loadingNow ? (
            <Loading rows={6} />
          ) : (
            <ScreenerResultsTable items={results} total={total} marketTotal={marketTotal} onExport={handleExport} onRowClick={(s) => setDetail({ open: true, stock: s })} />
          )}
          <AiPanel
            title="AI 早盘点评"
            content={aiContent}
            loading={aiLoading}
            cached={aiCached}
            generatedAt={aiGeneratedAt}
            onRefresh={() => loadAi(true)}
            emptyText="点击「重新生成」获取 AI 早盘点评（未配置 ZHIPU_API_KEY 时返回本地规则版）"
          />
        </Box>
      </Stack>

      {/* 竞价榜（独立视图） */}
      <Box sx={{ mt: 3 }}>
        {leaderboard ? <AuctionLeaderboard items={leaderboard.items} /> : <Loading rows={4} />}
      </Box>

      <StockDetailDrawer open={detail.open} stock={detail.stock} onClose={() => setDetail({ open: false, stock: null })} onAddWatchlist={addWatchlist} />
      <StrategySaveDialog open={saveOpen} defaultName={selectedPreset?.name || '我的早盘策略'} onClose={() => setSaveOpen(false)} onSave={handleSave} />
    </Box>
  );
}
