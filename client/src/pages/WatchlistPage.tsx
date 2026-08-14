// ============================================================
// 我的自选页（基金自选 / A股自选双 Tab + 分组管理 + 实时行情）
// ============================================================
import { useCallback, useEffect, useState, useRef } from 'react';
import {
  Box, Typography, Button, Alert, IconButton, Tabs, Tab, Select, MenuItem,
  Dialog, DialogTitle, DialogContent, TextField, Tooltip,
} from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import StarIcon from '@mui/icons-material/Star';
import ListAltIcon from '@mui/icons-material/ListAlt';
import VisibilityIcon from '@mui/icons-material/Visibility';
import AnalyticsIcon from '@mui/icons-material/Analytics';
import NoteIcon from '@mui/icons-material/Note';
import { useNavigate } from 'react-router-dom';
import { marketApi, type WatchItem, type WatchGroup, type KlineBar } from '../api/market';
import { useAuthStore } from '../store/authStore';
import { useSnackbar } from '../components/common/SnackbarProvider';
import DataTable, { ColumnDef } from '../components/common/DataTable';
import ConfirmDialog from '../components/common/ConfirmDialog';
import PageHeader from '../components/common/PageHeader';
import SectionCard from '../components/common/SectionCard';
import KlineChart from '../components/charts/KlineChart';
import { isMarketOpen } from '../util/tradingTime';

const fmtVol = (v: number | null | undefined): string =>
  v == null ? '—' : v >= 1e8 ? (v / 1e8).toFixed(2) + '亿手' : (v / 1e4).toFixed(1) + '万手';
const fmtTime = (v: string | null | undefined): string =>
  v ? String(v).replace('T', ' ').slice(0, 16) : '—';
const pctColor = (v: number | null | undefined): string =>
  v == null ? 'text.secondary' : v > 0 ? '#e53935' : v < 0 ? '#00897b' : 'text.secondary';

export default function WatchlistPage() {
  const navigate = useNavigate();
  const { isLoggedIn } = useAuthStore();
  const snackbar = useSnackbar();

  const [tab, setTab] = useState<'a_share' | 'fund'>('a_share');
  const [items, setItems] = useState<WatchItem[]>([]);
  const [groups, setGroups] = useState<WatchGroup[]>([]);
  const [groupId, setGroupId] = useState<number | null>(null); // null = 全部
  const [loading, setLoading] = useState(true);

  const [deleteTarget, setDeleteTarget] = useState<WatchItem | null>(null);
  const [klineTarget, setKlineTarget] = useState<WatchItem | null>(null);
  const [klineBars, setKlineBars] = useState<KlineBar[]>([]);
  const [noteTarget, setNoteTarget] = useState<WatchItem | null>(null);
  const [noteText, setNoteText] = useState('');
  const [creating, setCreating] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');

  // 交易时段自动刷新定时器
  const refreshTimerRef = useRef<NodeJS.Timeout | null>(null);

  const loadGroups = useCallback(async () => {
    try { setGroups(await marketApi.watchlistGroups()); } catch (_e) { /* 静默 */ }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await marketApi.watchlist(tab, groupId));
    } catch (e) {
      snackbar.show((e as Error).message, 'error');
    } finally {
      setLoading(false);
    }
  }, [tab, groupId, snackbar]);

  useEffect(() => { if (isLoggedIn()) loadGroups(); }, [isLoggedIn, loadGroups]);
  useEffect(() => { if (isLoggedIn()) load(); }, [load]);

  // 交易时段自动刷新（15s）
  useEffect(() => {
    if (!isLoggedIn()) return;

    const startAutoRefresh = () => {
      // 清除已有定时器
      if (refreshTimerRef.current) {
        clearInterval(refreshTimerRef.current);
      }
      // 立即执行一次
      load();
      // 设置 15s 定时器
      refreshTimerRef.current = setInterval(() => {
        if (isMarketOpen()) {
          load();
        }
      }, 15_000);
    };

    const stopAutoRefresh = () => {
      if (refreshTimerRef.current) {
        clearInterval(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
    };

    startAutoRefresh();

    return () => {
      stopAutoRefresh();
    };
  }, [isLoggedIn, load]);

  const createGroup = async () => {
    const name = newGroupName.trim();
    if (!name) return;
    try {
      await marketApi.createWatchlistGroup(name, tab);
      setNewGroupName('');
      setCreating(false);
      await loadGroups();
      snackbar.show('已创建分组', 'success');
    } catch (e) { snackbar.show((e as Error).message, 'error'); }
  };

  const remove = async () => {
    if (!deleteTarget) return;
    try {
      await marketApi.removeWatchlist(deleteTarget.id);
      snackbar.show('已移除自选', 'success');
      setDeleteTarget(null);
      load();
    } catch (e) { snackbar.show((e as Error).message, 'error'); }
  };

  const moveGroup = async (w: WatchItem, gid: number | null) => {
    try { await marketApi.moveWatchlistItem(w.id, gid); load(); }
    catch (e) { snackbar.show((e as Error).message, 'error'); }
  };

  const openKline = async (w: WatchItem) => {
    setKlineTarget(w);
    setKlineBars([]);
    try {
      const data = await marketApi.kline(w.code, 120);
      setKlineBars(data.bars || []);
    } catch (e) { snackbar.show((e as Error).message, 'error'); }
  };

  const openNote = (w: WatchItem) => { setNoteTarget(w); setNoteText(w.note || ''); };
  const saveNote = async () => {
    if (!noteTarget) return;
    try { await marketApi.updateWatchlistNote(noteTarget.id, noteText); setNoteTarget(null); load(); }
    catch (e) { snackbar.show((e as Error).message, 'error'); }
  };

  const filteredGroups = groups.filter((g) => g.category === 'all' || g.category === tab);

  const columns: ColumnDef<WatchItem>[] = [
    { key: 'code', label: '代码', sortable: true, getSortValue: (w) => Number(w.code), render: (w) => w.code },
    { key: 'name', label: '名称', render: (w) => w.name || '—' },
    { key: 'sector', label: '板块', render: (w) => w.sector || '—' },
    { key: 'latest_close', label: '最新价', sortable: true, getSortValue: (w) => w.latest_close ?? -Infinity, render: (w) => (w.latest_close != null ? w.latest_close.toFixed(2) : '—') },
    { key: 'pct_chg', label: '涨跌幅', sortable: true, getSortValue: (w) => w.pct_chg ?? -Infinity, render: (w) => (
      <span style={{ color: pctColor(w.pct_chg), fontWeight: 600 }}>
        {w.pct_chg == null ? '—' : `${w.pct_chg > 0 ? '+' : ''}${w.pct_chg.toFixed(2)}%`}
      </span>
    ) },
    { key: 'change', label: '涨跌额', render: (w) => {
      const chg = w.latest_close != null && w.pre_close != null ? w.latest_close - w.pre_close : null;
      return <span style={{ color: pctColor(chg) }}>{chg == null ? '—' : `${chg > 0 ? '+' : ''}${chg.toFixed(2)}`}</span>;
    } },
    { key: 'volume', label: '成交量', sortable: true, getSortValue: (w) => w.volume ?? -Infinity, render: (w) => fmtVol(w.volume) },
    { key: 'created_at', label: '加入时间', sortable: true, getSortValue: (w) => w.created_at ?? '', render: (w) => fmtTime(w.created_at) },
    { key: 'note', label: '备注', render: (w) => (
      <Tooltip title={w.note || '点击添加备注'}>
        <IconButton size="small" onClick={() => openNote(w)}><NoteIcon fontSize="small" /></IconButton>
      </Tooltip>
    ) },
    {
      key: 'actions', label: '操作', align: 'center',
      render: (w) => (
        <Box sx={{ display: 'flex', gap: 0.5, justifyContent: 'center', alignItems: 'center' }}>
          <Tooltip title="查看K线"><IconButton size="small" onClick={() => openKline(w)}><VisibilityIcon fontSize="small" /></IconButton></Tooltip>
          <Tooltip title="智能分析"><IconButton size="small" onClick={() => navigate(`/analysis?code=${w.code}`)}><AnalyticsIcon fontSize="small" /></IconButton></Tooltip>
          <Select
            size="small" value={w.group_id ?? ''} sx={{ minWidth: 92, fontSize: 12 }}
            onChange={(e) => moveGroup(w, e.target.value === '' ? null : Number(e.target.value))}
            displayEmpty
          >
            <MenuItem value="">未分组</MenuItem>
            {filteredGroups.map((g) => <MenuItem key={g.id} value={g.id}>{g.name}</MenuItem>)}
          </Select>
          <Tooltip title="删除"><IconButton size="small" color="error" onClick={() => setDeleteTarget(w)}><DeleteIcon fontSize="small" /></IconButton></Tooltip>
        </Box>
      ),
    },
  ];

  return (
    <Box>
      <PageHeader title="我的自选" subtitle="从选股结果页一键加入，集中跟踪实时行情" icon={<StarIcon />} />

      <Tabs value={tab} onChange={(_, v) => { setTab(v); setGroupId(null); }} sx={{ mb: 2 }}>
        <Tab value="a_share" label="A股自选" />
        <Tab value="fund" label="基金自选" />
      </Tabs>

      {!isLoggedIn() ? (
        <Alert severity="info" sx={{ mb: 2 }}>
          请先登录，登录后可从选股结果页一键加入自选。
          <Button size="small" sx={{ ml: 1 }} onClick={() => navigate('/login?redirect=/watchlist')}>去登录</Button>
        </Alert>
      ) : (
        <Box>
          <Box sx={{ display: 'flex', gap: 2, mb: 2, alignItems: 'center', flexWrap: 'wrap' }}>
            <Select size="small" value={groupId ?? 'all'} sx={{ minWidth: 160 }} displayEmpty
              onChange={(e) => setGroupId(e.target.value === 'all' ? null : Number(e.target.value))}>
              <MenuItem value="all">全部分组</MenuItem>
              <MenuItem value="ungrouped">未分组</MenuItem>
              {filteredGroups.map((g) => <MenuItem key={g.id} value={g.id}>{g.name}</MenuItem>)}
            </Select>
            {creating ? (
              <Box sx={{ display: 'flex', gap: 1 }}>
                <TextField size="small" autoFocus placeholder="分组名" value={newGroupName}
                  onChange={(e) => setNewGroupName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') createGroup(); }} />
                <Button size="small" variant="contained" onClick={createGroup}>确定</Button>
                <Button size="small" onClick={() => { setCreating(false); setNewGroupName(''); }}>取消</Button>
              </Box>
            ) : (
              <Button size="small" variant="outlined" startIcon={<ListAltIcon />} onClick={() => setCreating(true)}>新建分组</Button>
            )}
            {groupId != null && (
              <Button size="small" color="warning" onClick={async () => {
                try { await marketApi.deleteWatchlistGroup(groupId); setGroupId(null); await loadGroups(); snackbar.show('已删除分组', 'success'); }
                catch (e) { snackbar.show((e as Error).message, 'error'); }
              }}>删除当前分组</Button>
            )}
          </Box>

          {loading ? (
            <Typography variant="body2" color="text.secondary">加载中…</Typography>
          ) : (
            <SectionCard title={tab === 'fund' ? '基金自选列表' : 'A股自选列表'} icon={<ListAltIcon />} noPadding>
              <DataTable columns={columns} rows={items} rowKey={(w) => w.id}
                emptyText="暂无自选，去「早盘/尾盘选股」结果页点击加入自选" />
            </SectionCard>
          )}
        </Box>
      )}

      <ConfirmDialog open={!!deleteTarget} title="移除自选"
        message={`确定将「${deleteTarget?.name}」移出自选？`}
        onConfirm={remove} onCancel={() => setDeleteTarget(null)} />

      <Dialog open={!!klineTarget} onClose={() => setKlineTarget(null)} maxWidth="md" fullWidth>
        <DialogTitle>{klineTarget?.name}（{klineTarget?.code}）K线</DialogTitle>
        <DialogContent>
          {klineBars.length ? <KlineChart bars={klineBars} height={400} /> : <Typography variant="body2">加载中…</Typography>}
        </DialogContent>
      </Dialog>

      <Dialog open={!!noteTarget} onClose={() => setNoteTarget(null)} maxWidth="xs" fullWidth>
        <DialogTitle>编辑备注</DialogTitle>
        <DialogContent>
          <TextField fullWidth multiline minRows={3} autoFocus value={noteText}
            onChange={(e) => setNoteText(e.target.value)} placeholder="记录关注理由 / 买入逻辑…" />
          <Box sx={{ mt: 2, textAlign: 'right' }}>
            <Button onClick={() => setNoteTarget(null)} sx={{ mr: 1 }}>取消</Button>
            <Button variant="contained" onClick={saveNote}>保存</Button>
          </Box>
        </DialogContent>
      </Dialog>
    </Box>
  );
}
