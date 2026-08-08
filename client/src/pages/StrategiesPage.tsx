// ============================================================
// 我的策略页（列表/应用/重命名/删除）
// ============================================================
import { useCallback, useEffect, useState } from 'react';
import { Box, Typography, Button, Grid, Card, CardContent, CardActions, Chip, ToggleButtonGroup, ToggleButton, Dialog, DialogTitle, DialogContent, DialogActions, TextField, Alert } from '@mui/material';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import EditIcon from '@mui/icons-material/Edit';
import DeleteIcon from '@mui/icons-material/Delete';
import { useNavigate } from 'react-router-dom';
import { strategyApi } from '../api/strategy';
import type { Strategy } from '../api/screener';
import { useAuthStore } from '../store/authStore';
import { useSnackbar } from '../components/common/SnackbarProvider';
import ConfirmDialog from '../components/common/ConfirmDialog';
import PageHeader from '../components/common/PageHeader';
import EmptyState from '../components/common/EmptyState';
import StarIcon from '@mui/icons-material/Star';
import { STRATEGY_TYPE_LABEL } from '@shared/constants';

export default function StrategiesPage() {
  const navigate = useNavigate();
  const { isLoggedIn } = useAuthStore();
  const snackbar = useSnackbar();

  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'morning' | 'closing'>('all');
  const [renameTarget, setRenameTarget] = useState<Strategy | null>(null);
  const [renameName, setRenameName] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<Strategy | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await strategyApi.list();
      setStrategies(list);
    } catch (e) {
      snackbar.show((e as Error).message, 'error');
    } finally {
      setLoading(false);
    }
  }, [snackbar]);

  useEffect(() => {
    load();
  }, [load]);

  const filtered = strategies.filter((s) => {
    if (filter === 'all') return true;
    if (filter === 'morning') return s.type === 'morning' || s.type === 'pipeline_morning';
    return s.type === 'closing' || s.type === 'pipeline_closing';
  });

  const apply = (s: Strategy) => {
    if (s.type === 'morning' || s.type === 'pipeline_morning') navigate('/morning');
    else navigate('/closing');
    snackbar.show(`已选择「${s.name}」，在对应模块中应用`, 'info');
  };

  const rename = async () => {
    if (!renameTarget) return;
    await strategyApi.update(renameTarget.id, { name: renameName });
    snackbar.show('策略已重命名', 'success');
    setRenameTarget(null);
    load();
  };

  const remove = async () => {
    if (!deleteTarget) return;
    await strategyApi.remove(deleteTarget.id);
    snackbar.show('策略已删除', 'success');
    setDeleteTarget(null);
    load();
  };

  const isMy = (s: Strategy) => !s.is_preset;

  return (
    <Box>
      <PageHeader
        title="我的策略"
        subtitle="保存、应用与管理你的选股策略"
        icon={<StarIcon />}
        actions={
          <ToggleButtonGroup size="small" exclusive value={filter} onChange={(_e, v) => v && setFilter(v)}>
            <ToggleButton value="all">全部</ToggleButton>
            <ToggleButton value="morning">早盘</ToggleButton>
            <ToggleButton value="closing">尾盘</ToggleButton>
          </ToggleButtonGroup>
        }
      />

      {!isLoggedIn() && (
        <Alert severity="info" sx={{ mb: 2 }}>
          当前为游客模式，仅展示预置模板。登录后可保存、重命名、删除「我的策略」。
        </Alert>
      )}

      {loading ? (
        <Typography variant="body2" color="text.secondary">加载中…</Typography>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<StarIcon />}
          title="暂无策略"
          description={isLoggedIn() ? '在早盘或尾盘选股页点击「保存为我的策略」即可在此管理。' : '登录后保存的策略将显示在这里。'}
        />
      ) : (
        <Grid container spacing={2}>
          {filtered.map((s) => {
            let cond: Record<string, unknown> = {};
            try { cond = JSON.parse(s.conditions); } catch { cond = {}; }
            const stepCount = Array.isArray(cond.steps) ? cond.steps.length : 0;
            const tag = STRATEGY_TYPE_LABEL[s.type] || s.type;
            return (
              <Grid item xs={12} sm={6} md={4} key={s.id}>
                <Card variant="outlined">
                  <CardContent>
                    <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>{s.name}</Typography>
                      <Chip label={tag} size="small" color={s.is_preset ? 'default' : 'primary'} variant={s.is_preset ? 'outlined' : 'filled'} />
                    </Box>
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
                      {stepCount ? `漏斗步骤 ${stepCount} 个` : '通用指标条件'}
                      {s.is_preset ? ' · 预置模板' : ' · 我的策略'}
                    </Typography>
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                      更新于 {new Date(s.updated_at || s.created_at).toLocaleDateString('zh-CN')}
                    </Typography>
                  </CardContent>
                  <CardActions>
                    <Button size="small" startIcon={<PlayArrowIcon />} onClick={() => apply(s)}>应用</Button>
                    {isMy(s) && (
                      <>
                        <Button size="small" startIcon={<EditIcon />} onClick={() => { setRenameTarget(s); setRenameName(s.name); }}>重命名</Button>
                        <Button size="small" color="error" startIcon={<DeleteIcon />} onClick={() => setDeleteTarget(s)}>删除</Button>
                      </>
                    )}
                  </CardActions>
                </Card>
              </Grid>
            );
          })}
        </Grid>
      )}

      {/* 重命名弹窗 */}
      <Dialog open={!!renameTarget} onClose={() => setRenameTarget(null)} maxWidth="xs" fullWidth>
        <DialogTitle>重命名策略</DialogTitle>
        <DialogContent sx={{ pt: 2 }}>
          <TextField label="策略名称" value={renameName} onChange={(e) => setRenameName(e.target.value)} size="small" fullWidth autoFocus />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRenameTarget(null)}>取消</Button>
          <Button onClick={rename} variant="contained" disabled={!renameName.trim()}>保存</Button>
        </DialogActions>
      </Dialog>

      <ConfirmDialog
        open={!!deleteTarget}
        title="删除策略"
        message={`确定删除「${deleteTarget?.name}」？删除后不可恢复。`}
        onConfirm={remove}
        onCancel={() => setDeleteTarget(null)}
      />
    </Box>
  );
}
