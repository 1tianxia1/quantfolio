// ============================================================
// 设置页：模型设置（自定义 AI 模型） + 市场数据源（实时行情开关/刷新）
// ============================================================
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Box, Paper, Typography, TextField, Button, MenuItem, InputAdornment,
  Alert, CircularProgress, Divider, Chip, Link, Switch, FormControlLabel,
} from '@mui/material';
import KeyIcon from '@mui/icons-material/Key';
import SaveIcon from '@mui/icons-material/Save';
import CableIcon from '@mui/icons-material/Cable';
import SettingsIcon from '@mui/icons-material/Settings';
import ShowChartIcon from '@mui/icons-material/ShowChart';
import RefreshIcon from '@mui/icons-material/Refresh';
import { useNavigate } from 'react-router-dom';
import { aiApi, type AiProvider, type AiConfigMasked } from '../api/ai';
import { marketApi, type MarketStatus, type RefreshState } from '../api/market';
import { useSnackbar } from '../components/common/SnackbarProvider';
import { useAuthStore } from '../store/authStore';
import { useAiConfigStore } from '../store/aiConfigStore';
import PageHeader from '../components/common/PageHeader';

export default function SettingsPage() {
  const navigate = useNavigate();
  const snackbar = useSnackbar();
  const { isLoggedIn } = useAuthStore();
  const setFromMasked = useAiConfigStore((s) => s.setFromMasked);

  const [providers, setProviders] = useState<AiProvider[]>([]);
  const [loading, setLoading] = useState(true);

  const [provider, setProvider] = useState('siliconflow');
  const [model, setModel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [hasKey, setHasKey] = useState(false); // 已保存配置中是否含 Key
  const [apiKeyMasked, setApiKeyMasked] = useState('');

  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const current = useMemo(
    () => providers.find((p) => p.id === provider),
    [providers, provider],
  );

  // ---------- 市场数据源 ----------
  const [realtime, setRealtime] = useState(false);
  const [marketStatus, setMarketStatus] = useState<MarketStatus | null>(null);
  const [savingMarket, setSavingMarket] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshState, setRefreshState] = useState<RefreshState | null>(null);
  const [marketError, setMarketError] = useState<string | null>(null);
  const refreshTimer = useRef<number | null>(null);

  async function loadMarketStatus() {
    try {
      const s = await marketApi.status();
      setMarketStatus(s);
      setRealtime(s.realtimeEnabled);
      setRefreshState(s.refresh);
    } catch (_e) {
      /* 即便失败也不阻断 AI 设置展示 */
    }
  }

  // 初始化：拉厂商列表 + 当前配置
  useEffect(() => {
    if (!isLoggedIn()) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const [ps, cfg] = await Promise.all([aiApi.providers(), aiApi.getConfig()]);
        if (cancelled) return;
        setProviders(ps);
        applyConfig(cfg, ps);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoggedIn()]);

  // 加载市场状态 + 卸载时清理轮询
  useEffect(() => {
    if (isLoggedIn()) loadMarketStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoggedIn()]);
  useEffect(() => () => {
    if (refreshTimer.current) window.clearInterval(refreshTimer.current);
  }, []);

  async function saveMarketSettings(next: boolean) {
    setSavingMarket(true);
    setMarketError(null);
    try {
      const r = await marketApi.setMarketSettings({ realtime: next });
      setRealtime(r.realtimeEnabled);
      snackbar.show(next ? '已启用实时行情（东方财富）' : '已切换回本地数据', 'success');
      loadMarketStatus();
    } catch (e) {
      setMarketError((e as Error).message);
    } finally {
      setSavingMarket(false);
    }
  }

  function pollRefresh() {
    if (refreshTimer.current) window.clearInterval(refreshTimer.current);
    refreshTimer.current = window.setInterval(async () => {
      try {
        const st = await marketApi.refreshStatus();
        setRefreshState(st);
        if (st.status === 'done' || st.status === 'failed') {
          if (refreshTimer.current) window.clearInterval(refreshTimer.current);
          setRefreshing(false);
          loadMarketStatus();
        }
      } catch (_e) { /* 继续轮询 */ }
    }, 2000);
  }

  async function handleRefresh() {
    setRefreshing(true);
    setMarketError(null);
    try {
      await marketApi.refresh({ limit: 120 });
      pollRefresh();
    } catch (e) {
      setMarketError((e as Error).message);
      setRefreshing(false);
    }
  }

  // 把后端配置回填到表单
  function applyConfig(cfg: AiConfigMasked, ps: AiProvider[]) {
    const providerId = cfg.provider && ps.some((p) => p.id === cfg.provider) ? cfg.provider : 'siliconflow';
    const prov = ps.find((p) => p.id === providerId) || ps[0];
    setProvider(providerId);
    setModel(cfg.model || prov?.recommendedModel || prov?.models?.[0]?.id || '');
    setBaseUrl(cfg.baseUrl || prov?.baseUrl || '');
    setHasKey(!!cfg.hasKey);
    setApiKeyMasked(cfg.apiKeyMasked || '');
    setFromMasked(cfg);
  }

  // 切换厂商：自动带出默认 baseUrl 与推荐模型（无推荐则回落首个）
  function onProviderChange(id: string) {
    setProvider(id);
    const prov = providers.find((p) => p.id === id);
    if (prov) {
      const rec = prov.recommendedModel || prov.models?.[0]?.id || '';
      setBaseUrl(prov.baseUrl || '');
      setModel(rec);
    }
  }

  async function handleTest() {
    setTesting(true);
    setError(null);
    try {
      const res = await aiApi.testConfig({
        provider,
        apiKey: apiKey || undefined, // 空则后端用已存 Key
        baseUrl: current?.freeBaseUrl ? baseUrl : undefined,
        model,
        apiStyle: current?.apiStyle,
      });
      snackbar.show(`连接成功（模型 ${res.model}）`, 'success');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setTesting(false);
    }
  }

  async function handleSave() {
    if (!model) {
      setError('请先选择或填写模型');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const saved = await aiApi.saveConfig({
        provider,
        apiKey: apiKey || undefined, // 空串=保留原 Key
        baseUrl: current?.freeBaseUrl ? baseUrl : undefined,
        model,
        apiStyle: current?.apiStyle,
      });
      setHasKey(!!saved.hasKey);
      setApiKeyMasked(saved.apiKeyMasked || '');
      setFromMasked(saved);
      snackbar.show('AI 配置已保存', 'success');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  if (!isLoggedIn()) {
    return (
      <Box sx={{ p: 4, textAlign: 'center' }}>
        <Typography variant="h6" sx={{ mb: 2 }}>设置需要登录</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          自定义 AI 模型与实时行情配置按账号保存，请先登录后配置。
        </Typography>
        <Button variant="contained" onClick={() => navigate(`/login?redirect=${encodeURIComponent('/settings')}`)}>
          去登录
        </Button>
      </Box>
    );
  }

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
        <CircularProgress size={24} />
      </Box>
    );
  }

  const keyPlaceholder = current?.keyHint || '请输入 API Key';

  return (
    <Box sx={{ maxWidth: 680, mx: 'auto', p: 3 }}>
      <PageHeader title="设置" icon={<SettingsIcon />} />

      {/* ===== AI 模型 ===== */}
      <Typography variant="subtitle1" sx={{ mt: 1, mb: 1, fontWeight: 600 }}>AI 模型</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        选择你自己的 AI 厂商与模型，全站 AI 分析（组合诊断 / 早盘点评 / 尾盘解读）将使用你配置的模型生成。
        未配置时回落到服务端默认模型。Key 仅保存在本机服务端数据库，前端不展示明文。
      </Typography>

      {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>{error}</Alert>}

      <Paper variant="outlined" sx={{ p: 3 }}>
        {/* 厂商 */}
        <TextField
          select
          fullWidth
          label="AI 厂商"
          value={provider}
          onChange={(e) => onProviderChange(e.target.value)}
          sx={{ mb: 2 }}
        >
          {providers.map((p) => (
            <MenuItem key={p.id} value={p.id}>{p.label}</MenuItem>
          ))}
        </TextField>

        {/* 模型 */}
        {current?.freeModel ? (
          <TextField
            fullWidth
            label="模型名称"
            placeholder={current.models?.[0]?.id || '例如 gpt-4o'}
            value={model}
            onChange={(e) => setModel(e.target.value)}
            sx={{ mb: 2 }}
            helperText="该厂商可自由填写模型 ID"
          />
        ) : (
          <TextField
            select
            fullWidth
            label="模型"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            sx={{ mb: 2 }}
          >
            {current?.models?.map((m) => {
              const isRec = m.id === current.recommendedModel;
              return (
                <MenuItem key={m.id} value={m.id}>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, width: '100%' }}>
                    <span>{m.label}</span>
                    {isRec && <Chip size="small" color="primary" label="推荐" />}
                  </Box>
                </MenuItem>
              );
            })}
          </TextField>
        )}

        {/* 一键填入推荐模型（预设模型厂商专用） */}
        {!current?.freeModel && current?.recommendedModel && (
          <Button size="small" sx={{ mt: -1, mb: 2 }} onClick={() => setModel(current.recommendedModel!)}>
            ✨ 一键填入推荐模型
          </Button>
        )}

        {/* 接口地址（自定义/本地可改） */}
        {current?.freeBaseUrl && (
          <TextField
            fullWidth
            label="接口地址 (Base URL)"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            sx={{ mb: 2 }}
            helperText="自定义 / 本地部署（如 Ollama）可修改此地址"
          />
        )}

        {/* API Key */}
        <TextField
          fullWidth
          type="password"
          label="API Key"
          placeholder={keyPlaceholder}
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          sx={{ mb: 1 }}
          InputProps={{
            startAdornment: (
              <InputAdornment position="start"><KeyIcon fontSize="small" /></InputAdornment>
            ),
          }}
          helperText={
            hasKey
              ? `当前已保存：${apiKeyMasked || '****'}（留空则保留原 Key）`
              : '填写后点击「测试连接」验证可用性'
          }
        />

        <Divider sx={{ my: 2 }} />

        <Box sx={{ display: 'flex', gap: 1.5, alignItems: 'center', flexWrap: 'wrap' }}>
          <Button
            variant="outlined"
            startIcon={testing ? <CircularProgress size={16} /> : <CableIcon />}
            onClick={handleTest}
            disabled={testing || saving}
          >
            测试连接
          </Button>
          <Button
            variant="contained"
            startIcon={saving ? <CircularProgress size={16} /> : <SaveIcon />}
            onClick={handleSave}
            disabled={testing || saving}
          >
            保存配置
          </Button>
          {hasKey && (
            <Chip size="small" color="success" label="已配置" />
          )}
        </Box>
      </Paper>

      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 2 }}>
        提示：各厂商 Key 获取地址见其官网；海外厂商（OpenAI / Anthropic / Gemini）需自备可达网络。
        本地 Ollama 一般无需 Key。更多厂商支持可在后端 <code>server/src/ai/providers.js</code> 扩展。
      </Typography>

      {/* ===== 市场数据源 ===== */}
      <Typography variant="subtitle1" sx={{ mt: 4, mb: 1, fontWeight: 600 }}>市场数据源</Typography>
      <Paper variant="outlined" sx={{ p: 3 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
          <ShowChartIcon color="primary" />
          <Typography variant="h6">实时行情</Typography>
        </Box>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          开启后，K 线 / 报价走东方财富实时行情；分析层（选股 / 评分 / 指标）通过「立即刷新行情」回填真实数据。
          关闭则回落本地缓存数据。
        </Typography>

        <FormControlLabel
          control={
            <Switch
              checked={realtime}
              disabled={savingMarket}
              onChange={(e) => saveMarketSettings(e.target.checked)}
            />
          }
          label={realtime ? '实时行情已开启（东方财富）' : '使用本地缓存数据'}
        />

        <Box sx={{ display: 'flex', gap: 1.5, alignItems: 'center', flexWrap: 'wrap', mt: 1 }}>
          <Button
            variant="outlined"
            startIcon={refreshing ? <CircularProgress size={16} /> : <RefreshIcon />}
            onClick={handleRefresh}
            disabled={refreshing || !realtime || savingMarket}
          >
            {refreshing ? '刷新中…' : '立即刷新行情'}
          </Button>
          {marketStatus && (
            <Typography variant="caption" color="text.secondary">
              数据源：{marketStatus.provider} · 最近交易日：{marketStatus.tradeDate || '—'}
            </Typography>
          )}
        </Box>

        {refreshState && (refreshState.status === 'running' || refreshState.status === 'done' || refreshState.status === 'failed') && (
          <Alert
            severity={refreshState.status === 'failed' ? 'error' : refreshState.status === 'running' ? 'info' : 'success'}
            sx={{ mt: 2 }}
          >
            {refreshState.status === 'running' && '正在回填真实行情，请稍候（也可在顶栏查看进度）…'}
            {refreshState.status === 'done' && `刷新完成，最新交易日 ${refreshState.lastResult?.tradeDate || '—'}`}
            {refreshState.status === 'failed' && `刷新失败：${refreshState.lastError || '未知错误'}`}
          </Alert>
        )}

        {marketError && (
          <Alert severity="error" sx={{ mt: 2 }} onClose={() => setMarketError(null)}>{marketError}</Alert>
        )}
      </Paper>
    </Box>
  );
}
