// ============================================================
// 模块一：投资组合仪表盘
// ============================================================
import { useCallback, useEffect, useState } from 'react';
import { Box, Grid, Typography, Button, Alert, ToggleButtonGroup, ToggleButton } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import UploadIcon from '@mui/icons-material/Upload';
import ImageIcon from '@mui/icons-material/Image';
import SettingsIcon from '@mui/icons-material/Settings';
import DashboardIcon from '@mui/icons-material/Dashboard';
import PieChartIcon from '@mui/icons-material/PieChart';
import BalanceIcon from '@mui/icons-material/Balance';
import ListAltIcon from '@mui/icons-material/ListAlt';
import SummaryCards from '../components/portfolio/SummaryCards';
import HoldingsTable from '../components/portfolio/HoldingsTable';
import AllocationPanel from '../components/portfolio/AllocationPanel';
import RebalancePanel from '../components/portfolio/RebalancePanel';
import HoldingDialog from '../components/portfolio/HoldingDialog';
import CsvImportDialog from '../components/portfolio/CsvImportDialog';
import ImageImportDialog from '../components/portfolio/ImageImportDialog';
import TargetDialog from '../components/portfolio/TargetDialog';
import AiPanel from '../components/ai/AiPanel';
import Loading from '../components/common/Loading';
import ConfirmDialog from '../components/common/ConfirmDialog';
import PageHeader from '../components/common/PageHeader';
import SectionCard from '../components/common/SectionCard';
import { useSnackbar } from '../components/common/SnackbarProvider';
import { portfolioApi, type Holding, type PortfolioSummary, type RebalanceResult } from '../api/portfolio';
import { aiApi } from '../api/ai';
import { useAuthStore } from '../store/authStore';
import { useAiConfigStore } from '../store/aiConfigStore';
import { useNavigate } from 'react-router-dom';

export default function PortfolioDashboard() {
  const navigate = useNavigate();
  const { isLoggedIn } = useAuthStore();
  const snackbar = useSnackbar();

  const [summary, setSummary] = useState<PortfolioSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [dimension, setDimension] = useState('asset_class');
  const [threshold, setThreshold] = useState(5);
  const [rebalance, setRebalance] = useState<RebalanceResult | null>(null);
  const [rebalanceLoading, setRebalanceLoading] = useState(false);
  const [aiContent, setAiContent] = useState<string | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiCached, setAiCached] = useState(false);
  const [aiGeneratedAt, setAiGeneratedAt] = useState<string | undefined>();

  const [holdingDialog, setHoldingDialog] = useState<{ open: boolean; initial: Holding | null }>({ open: false, initial: null });
  const [csvOpen, setCsvOpen] = useState(false);
  const [imgOpen, setImgOpen] = useState(false);
  const [targetOpen, setTargetOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Holding | null>(null);

  const loadSummary = useCallback(async (dim?: string) => {
    setLoading(true);
    try {
      const s = await portfolioApi.summary(dim || dimension);
      setSummary(s);
      setDimension(s.active_dimension || dim || 'asset_class');
      const settings = await portfolioApi.settings().catch(() => null);
      if (settings) setThreshold(settings.rebalance_threshold);
    } catch (e) {
      snackbar.show((e as Error).message, 'error');
    } finally {
      setLoading(false);
    }
  }, [dimension, snackbar]);

  const loadRebalance = useCallback(async (thr?: number, dim?: string) => {
    setRebalanceLoading(true);
    try {
      const r = await portfolioApi.rebalance({ threshold: thr ?? threshold, dimension: dim ?? dimension });
      setRebalance(r);
    } catch (e) {
      snackbar.show((e as Error).message, 'error');
    } finally {
      setRebalanceLoading(false);
    }
  }, [threshold, dimension, snackbar]);

  const loadAi = useCallback(async (force = false) => {
    setAiLoading(true);
    try {
      const r = await aiApi.diagnose({ force_refresh: force });
      setAiContent(r.content);
      setAiCached(r.cached);
      setAiGeneratedAt(r.generated_at);
      useAiConfigStore.getState().setFromMeta(r.ai_meta);
    } catch (e) {
      snackbar.show((e as Error).message, 'error');
    } finally {
      setAiLoading(false);
    }
  }, [snackbar]);

  useEffect(() => {
    loadSummary();
  }, []);

  // 维度切换联动
  const changeDimension = (dim: string) => {
    setDimension(dim);
    loadSummary(dim);
    loadRebalance(threshold, dim);
  };

  // 写操作游客拦截
  const requireLogin = () => {
    if (!isLoggedIn()) {
      snackbar.show('请先登录后再进行该操作', 'warning');
      navigate('/login?redirect=/portfolio');
      return false;
    }
    return true;
  };

  const handleSaveHolding = async (data: { code?: string | null; name: string; asset_class: string; quantity: number; cost_price: number }) => {
    if (!requireLogin()) return;
    const payload = {
      code: data.code ?? null,
      name: data.name,
      asset_class: data.asset_class as Holding['asset_class'],
      quantity: data.quantity,
      cost_price: data.cost_price,
    };
    if (holdingDialog.initial) {
      await portfolioApi.updateHolding(holdingDialog.initial.id, payload);
      snackbar.show('持仓已更新', 'success');
    } else {
      await portfolioApi.addHolding(payload);
      snackbar.show('持仓已添加', 'success');
    }
    loadSummary();
    loadRebalance();
  };

  const handleDeleteHolding = async () => {
    if (!deleteTarget) return;
    if (!requireLogin()) return;
    await portfolioApi.deleteHolding(deleteTarget.id);
    snackbar.show('持仓已删除', 'success');
    setDeleteTarget(null);
    loadSummary();
    loadRebalance();
  };

  const handleImportCsv = async (csvText: string) => {
    if (!requireLogin()) return { imported: 0, skipped: 0, errors: [] };
    const r = await portfolioApi.importCsv(csvText);
    loadSummary();
    loadRebalance();
    return r;
  };

  // 图片导入：先调用视觉模型识别，再批量写入 holdings
  const handleRecognizeImage = async (images: string[], hint?: 'stock' | 'fund') => {
    return portfolioApi.importImage(images, hint);
  };

  const handleImportImage = async (rows: { code: string | null; name: string; asset_class: string; quantity: number; cost_price: number }[]) => {
    if (!requireLogin()) return { imported: 0, errors: [] };
    let imported = 0;
    const errors: { row: number; msg: string }[] = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      try {
        await portfolioApi.addHolding({
          code: r.code ?? null,
          name: r.name,
          asset_class: r.asset_class as Holding['asset_class'],
          quantity: r.quantity,
          cost_price: r.cost_price,
        });
        imported += 1;
      } catch (e) {
        errors.push({ row: i + 1, msg: (e as Error).message || '导入失败' });
      }
    }
    loadSummary();
    loadRebalance();
    return { imported, errors };
  };

  const handleSaveTargets = async (dim: string, items: { target_key: string; target_pct: number }[]) => {
    if (!requireLogin()) return;
    await portfolioApi.saveTargets(dim, items);
    loadSummary();
    loadRebalance();
  };

  const handleExport = () => {
    // 组合导出暂不提供（CSV 导出在选股模块）
    snackbar.show('组合导出将在选股模块提供', 'info');
  };

  return (
    <Box>
      <PageHeader
        title="投资组合仪表盘"
        subtitle={isLoggedIn() ? '持仓估值 / 目标配置 / 再平衡建议 / AI 诊断' : '演示数据模式（只读）'}
        icon={<DashboardIcon />}
        actions={
          <>
            <Button size="small" variant="contained" startIcon={<AddIcon />} onClick={() => setHoldingDialog({ open: true, initial: null })}>
              添加持仓
            </Button>
            <Button size="small" variant="outlined" startIcon={<UploadIcon />} onClick={() => setCsvOpen(true)}>
              导入CSV
            </Button>
            <Button size="small" variant="outlined" startIcon={<ImageIcon />} onClick={() => setImgOpen(true)}>
              图片导入
            </Button>
            <Button size="small" variant="outlined" startIcon={<SettingsIcon />} onClick={() => setTargetOpen(true)}>
              目标配置
            </Button>
          </>
        }
      />

      {!isLoggedIn() && (
        <Alert severity="info" sx={{ mb: 2 }} onClose={() => undefined}>
          当前为演示数据模式（只读），登录后可保存您的持仓与配置。
        </Alert>
      )}

      {loading && !summary ? (
        <Loading rows={8} />
      ) : summary ? (
        <>
          <SummaryCards summary={summary} />

          <Grid container spacing={2} sx={{ mt: 0.5 }}>
            <Grid item xs={12} lg={7}>
              <SectionCard title="资产配置" icon={<PieChartIcon />} sx={{ height: '100%' }}>
                <AllocationPanel
                  dimension={dimension}
                  allocation={summary.allocation}
                  onDimensionChange={changeDimension}
                  onOpenTarget={() => setTargetOpen(true)}
                />
              </SectionCard>
            </Grid>
            <Grid item xs={12} lg={5}>
              <SectionCard title="再平衡建议" icon={<BalanceIcon />} sx={{ height: '100%' }}>
                <RebalancePanel
                  result={rebalance}
                  threshold={threshold}
                  loading={rebalanceLoading}
                  onThresholdChange={(v) => {
                    setThreshold(v);
                    loadRebalance(v);
                  }}
                  onRecalc={() => loadRebalance()}
                />
              </SectionCard>
            </Grid>
          </Grid>

          <Box sx={{ mt: 2 }}>
            <SectionCard title="持仓明细" icon={<ListAltIcon />}>
              <HoldingsTable holdings={summary.holdings} onEdit={(h) => setHoldingDialog({ open: true, initial: h })} onDelete={(h) => setDeleteTarget(h)} />
            </SectionCard>
          </Box>

          <AiPanel
            title="AI 持仓诊断"
            content={aiContent}
            loading={aiLoading}
            cached={aiCached}
            generatedAt={aiGeneratedAt}
            onRefresh={() => loadAi(true)}
            emptyText="点击「重新生成」获取 AI 持仓诊断（未配置 ZHIPU_API_KEY 时返回本地规则版）"
          />
        </>
      ) : (
        <Alert severity="error">组合加载失败</Alert>
      )}

      <HoldingDialog
        open={holdingDialog.open}
        initial={holdingDialog.initial}
        onClose={() => setHoldingDialog({ open: false, initial: null })}
        onSave={handleSaveHolding}
      />
      <CsvImportDialog open={csvOpen} onClose={() => setCsvOpen(false)} onImport={handleImportCsv} />
      <ImageImportDialog
        open={imgOpen}
        onClose={() => setImgOpen(false)}
        onRecognize={handleRecognizeImage}
        onImport={handleImportImage}
      />
      <TargetDialog
        open={targetOpen}
        dimension={dimension}
        items={summary?.allocation?.filter((a) => a.target_pct != null).map((a) => ({ target_key: a.key, target_pct: a.target_pct as number })) || []}
        onClose={() => setTargetOpen(false)}
        onSave={handleSaveTargets}
      />
      <ConfirmDialog
        open={!!deleteTarget}
        title="删除持仓"
        message={`确定删除「${deleteTarget?.name}」？`}
        onConfirm={handleDeleteHolding}
        onCancel={() => setDeleteTarget(null)}
      />
    </Box>
  );
}
