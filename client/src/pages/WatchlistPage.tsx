// ============================================================
// 我的自选页
// ============================================================
import { useCallback, useEffect, useState } from 'react';
import { Box, Typography, Button, Alert, IconButton } from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import { useNavigate } from 'react-router-dom';
import StarIcon from '@mui/icons-material/Star';
import ListAltIcon from '@mui/icons-material/ListAlt';
import { marketApi, type WatchItem } from '../api/market';
import { useAuthStore } from '../store/authStore';
import { useSnackbar } from '../components/common/SnackbarProvider';
import DataTable, { ColumnDef } from '../components/common/DataTable';
import ConfirmDialog from '../components/common/ConfirmDialog';
import PageHeader from '../components/common/PageHeader';
import SectionCard from '../components/common/SectionCard';

export default function WatchlistPage() {
  const navigate = useNavigate();
  const { isLoggedIn } = useAuthStore();
  const snackbar = useSnackbar();

  const [items, setItems] = useState<WatchItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleteTarget, setDeleteTarget] = useState<WatchItem | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await marketApi.watchlist());
    } catch (e) {
      snackbar.show((e as Error).message, 'error');
    } finally {
      setLoading(false);
    }
  }, [snackbar]);

  useEffect(() => {
    load();
  }, [load]);

  const remove = async () => {
    if (!deleteTarget) return;
    await marketApi.removeWatchlist(deleteTarget.id);
    snackbar.show('已移除自选', 'success');
    setDeleteTarget(null);
    load();
  };

  const columns: ColumnDef<WatchItem>[] = [
    { key: 'code', label: '代码', sortable: true, getSortValue: (w) => Number(w.code), render: (w) => w.code },
    { key: 'name', label: '名称', render: (w) => w.name || '—' },
    { key: 'sector', label: '板块', render: (w) => w.sector || '—' },
    {
      key: 'actions', label: '操作', align: 'center',
      render: (w) => (
        <IconButton size="small" color="error" onClick={() => setDeleteTarget(w)}>
          <DeleteIcon fontSize="small" />
        </IconButton>
      ),
    },
  ];

  return (
    <Box>
      <PageHeader title="我的自选" subtitle="从选股结果页一键加入，集中跟踪" icon={<StarIcon />} />

      {!isLoggedIn() ? (
        <Alert severity="info" sx={{ mb: 2 }}>
          请先登录，登录后可从选股结果页一键加入自选。
          <Button size="small" sx={{ ml: 1 }} onClick={() => navigate('/login?redirect=/watchlist')}>去登录</Button>
        </Alert>
      ) : loading ? (
        <Typography variant="body2" color="text.secondary">加载中…</Typography>
      ) : (
        <SectionCard title="自选列表" icon={<ListAltIcon />} noPadding>
          <DataTable columns={columns} rows={items} rowKey={(w) => w.id} emptyText="暂无自选，去「早盘/尾盘选股」结果页点击加入自选" />
        </SectionCard>
      )}

      <ConfirmDialog
        open={!!deleteTarget}
        title="移除自选"
        message={`确定将「${deleteTarget?.name}」移出自选？`}
        onConfirm={remove}
        onCancel={() => setDeleteTarget(null)}
      />
    </Box>
  );
}
