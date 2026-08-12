// ============================================================
// 顶栏：Logo/搜索框/实时行情状态/主题切换/用户菜单
// ============================================================
import { useState, useEffect, useRef } from 'react';
import {
  AppBar, Toolbar, Box, TextField, InputAdornment, IconButton,
  Avatar, Menu, MenuItem, Tooltip, Typography, Button, Divider, CircularProgress,
} from '@mui/material';
import MenuIcon from '@mui/icons-material/Menu';
import SearchIcon from '@mui/icons-material/Search';
import DarkModeIcon from '@mui/icons-material/DarkMode';
import LightModeIcon from '@mui/icons-material/LightMode';
import AccountCircleIcon from '@mui/icons-material/AccountCircle';
import LogoutIcon from '@mui/icons-material/Logout';
import RefreshIcon from '@mui/icons-material/Refresh';
import { useNavigate, useLocation } from 'react-router-dom';
import { keyframes } from '@emotion/react';
import { useUiStore } from '../../store/uiStore';
import { useAuthStore } from '../../store/authStore';
import { useLastRefresh, isMarketOpenNow, REFRESH_INTERVAL_MS } from '../../store/realtimeStore';
import { APP_NAME } from '@shared/constants';
import { marketApi } from '../../api/market';
import { authApi } from '../../api/auth';
import { useSnackbar } from '../common/SnackbarProvider';
import { useDebounce } from '../../hooks/useDebounce';
import type { SearchItem, MarketStatus } from '../../api/market';

/** 实时点脉冲动画 */
const pulse = keyframes`
  0% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.45; transform: scale(0.82); }
  100% { opacity: 1; transform: scale(1); }
`;

export default function TopBar() {
  const navigate = useNavigate();
  const location = useLocation();
  const { mode, toggleMode, sidebarCollapsed, toggleSidebar } = useUiStore();
  const { user, isLoggedIn, clearAuth } = useAuthStore();
  const snackbar = useSnackbar();

  const [q, setQ] = useState('');
  const [results, setResults] = useState<SearchItem[]>([]);
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
  const debouncedQ = useDebounce(q, 300);

  // 实时行情状态 + 顶栏刷新
  const [mkt, setMkt] = useState<MarketStatus | null>(null);
  const [topRefreshing, setTopRefreshing] = useState(false);
  const topTimer = useRef<number | null>(null);

  // 实时刷新倒计时（读取组合页最近一次静默刷新时间）
  const lastRefresh = useLastRefresh();
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => setTick((x) => x + 1), 1000);
    return () => window.clearInterval(t);
  }, []);
  void tick;
  const open = isMarketOpenNow();
  const secondsAgo = lastRefresh ? Math.floor((Date.now() - lastRefresh) / 1000) : 0;
  const nextIn = Math.max(0, Math.round(REFRESH_INTERVAL_MS / 1000) - secondsAgo);

  // 防抖搜索：代码/名称模糊
  useEffect(() => {
    if (!debouncedQ.trim()) {
      setResults([]);
      return;
    }
    let cancelled = false;
    marketApi
      .search(debouncedQ.trim(), 8)
      .then((r) => { if (!cancelled) setResults(r); })
      .catch(() => { if (!cancelled) setResults([]); });
    return () => { cancelled = true; };
  }, [debouncedQ]);

  // 加载实时行情状态 + 卸载清理轮询
  useEffect(() => {
    let cancelled = false;
    marketApi.status().then((s) => { if (!cancelled) setMkt(s); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);
  useEffect(() => () => {
    if (topTimer.current) window.clearInterval(topTimer.current);
  }, []);

  const gotoStock = (code: string) => {
    setQ('');
    setResults([]);
    // 详情通过选股页抽屉查看；这里跳转到尾盘选股页并携带 code
    navigate(`/closing?focus=${code}`);
  };

  const handleLogout = async () => {
    setAnchorEl(null);
    try {
      await authApi.logout();
    } catch {
      /* 忽略 */
    }
    clearAuth();
    snackbar.show('已退出登录', 'info');
    navigate('/login');
  };

  const handleTopRefresh = async () => {
    if (!mkt?.realtimeEnabled) {
      snackbar.show('请先在设置中开启实时行情', 'info');
      return;
    }
    setTopRefreshing(true);
    try {
      await marketApi.refresh({ limit: 120 });
      if (topTimer.current) window.clearInterval(topTimer.current);
      topTimer.current = window.setInterval(async () => {
        try {
          const s = await marketApi.status();
          setMkt(s);
          if (s.refresh.status === 'done' || s.refresh.status === 'failed') {
            if (topTimer.current) window.clearInterval(topTimer.current);
            setTopRefreshing(false);
            snackbar.show(s.refresh.status === 'done' ? '行情刷新完成' : '行情刷新失败', s.refresh.status === 'done' ? 'success' : 'error');
          }
        } catch (_e) { /* 继续轮询 */ }
      }, 2000);
    } catch (e) {
      setTopRefreshing(false);
      snackbar.show((e as Error).message || '刷新失败', 'error');
    }
  };

  return (
    <AppBar position="sticky" color="default" elevation={0} sx={{ borderBottom: '1px solid', borderColor: 'divider', bgcolor: 'background.paper' }}>
      <Toolbar sx={{ minHeight: 56, gap: 2 }}>
        <Tooltip title={sidebarCollapsed ? '展开侧栏' : '收起侧栏'}>
          <IconButton size="small" onClick={toggleSidebar} sx={{ color: 'text.secondary' }}>
            <MenuIcon />
          </IconButton>
        </Tooltip>

        <Box
          sx={{ display: 'flex', alignItems: 'center', gap: 1, cursor: 'pointer', fontWeight: 700, fontSize: 18, color: 'primary.main' }}
          onClick={() => navigate('/')}
        >
          <span>📊</span>
          <span>{APP_NAME}</span>
        </Box>

        {/* 搜索框 */}
        <Box sx={{ position: 'relative', flex: 1, maxWidth: 420 }}>
          <TextField
            size="small"
            fullWidth
            placeholder="搜索股票代码 / 名称"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && results[0]) gotoStock(results[0].code); }}
            sx={{
              '& .MuiOutlinedInput-root': { bgcolor: 'action.hover', borderRadius: 2 },
              '& .MuiOutlinedInput-notchedOutline': { borderColor: 'transparent' },
              '& .MuiOutlinedInput-root:hover .MuiOutlinedInput-notchedOutline': { borderColor: 'divider' },
              '& .MuiOutlinedInput-root.Mui-focused .MuiOutlinedInput-notchedOutline': { borderColor: 'primary.main' },
            }}
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon fontSize="small" />
                </InputAdornment>
              ),
            }}
          />
          {debouncedQ && results.length > 0 && (
            <Box
              sx={{
                position: 'absolute', top: 44, left: 0, right: 0, zIndex: 1300,
                bgcolor: 'background.paper', border: '1px solid', borderColor: 'divider', borderRadius: 1,
                boxShadow: 3, maxHeight: 320, overflowY: 'auto',
              }}
            >
              {results.map((r) => (
                <Box
                  key={r.code}
                  sx={{ px: 2, py: 1, cursor: 'pointer', '&:hover': { bgcolor: 'action.hover' }, display: 'flex', justifyContent: 'space-between' }}
                  onClick={() => gotoStock(r.code)}
                >
                  <span>{r.code} {r.name}</span>
                  <Typography variant="caption" color="text.secondary">{r.sector || r.type}</Typography>
                </Box>
              ))}
            </Box>
          )}
        </Box>

        <Box sx={{ flex: 1 }} />

        {/* 实时行情状态 + 一键刷新 */}
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
          <Box
            sx={{
              width: 8, height: 8, borderRadius: '50%',
              bgcolor: mkt?.realtimeEnabled
                ? open
                  ? 'success.main'
                  : 'warning.main'
                : 'text.disabled',
              animation: mkt?.realtimeEnabled && open ? `${pulse} 1.4s ease-in-out infinite` : 'none',
            }}
            title={
              mkt?.realtimeEnabled
                ? open
                  ? '实时行情已连接（东方财富）· 每 15 秒自动刷新'
                  : '实时行情已连接（东方财富）· 当前为盘中休市时段'
                : '本地缓存数据'
            }
          />
          <Typography
            variant="caption"
            color={mkt?.realtimeEnabled ? (open ? 'success.main' : 'warning.main') : 'text.secondary'}
            sx={{ whiteSpace: 'nowrap', fontWeight: mkt?.realtimeEnabled ? 600 : 400 }}
          >
            {mkt?.realtimeEnabled
              ? open
                ? `实时 · ${nextIn}s 后刷新`
                : '盘中休市'
              : '本地'}
          </Typography>
          {isLoggedIn() && (
            <Tooltip title={topRefreshing ? '刷新中…' : '刷新真实行情'}>
              <span>
                <IconButton
                  size="small"
                  onClick={handleTopRefresh}
                  disabled={topRefreshing || !mkt?.realtimeEnabled}
                  sx={{ color: 'text.secondary' }}
                >
                  {topRefreshing ? <CircularProgress size={14} /> : <RefreshIcon fontSize="small" />}
                </IconButton>
              </span>
            </Tooltip>
          )}
        </Box>

        {/* 主题切换 */}
        <Tooltip title={mode === 'dark' ? '切换浅色主题' : '切换深色主题'}>
          <IconButton onClick={toggleMode} size="small">
            {mode === 'dark' ? <LightModeIcon /> : <DarkModeIcon />}
          </IconButton>
        </Tooltip>

        {/* 用户菜单 */}
        {isLoggedIn() && user ? (
          <>
            <IconButton size="small" onClick={(e) => setAnchorEl(e.currentTarget)}>
              <Avatar sx={{ width: 30, height: 30, bgcolor: 'primary.main', fontSize: 14 }}>
                {user.username?.[0]?.toUpperCase()}
              </Avatar>
            </IconButton>
            <Menu anchorEl={anchorEl} open={!!anchorEl} onClose={() => setAnchorEl(null)}>
              <Box sx={{ px: 2, py: 1 }}>
                <Typography variant="body2">{user.username}</Typography>
                <Typography variant="caption" color="text.secondary">{user.email}</Typography>
              </Box>
              <Divider />
              <MenuItem onClick={() => { setAnchorEl(null); navigate('/strategies'); }}>
                <AccountCircleIcon fontSize="small" sx={{ mr: 1 }} /> 我的策略
              </MenuItem>
              <MenuItem onClick={handleLogout}>
                <LogoutIcon fontSize="small" sx={{ mr: 1 }} /> 退出登录
              </MenuItem>
            </Menu>
          </>
        ) : (
          <Button
            size="small"
            variant="contained"
            onClick={() => navigate(`/login?redirect=${encodeURIComponent(location.pathname)}`)}
          >
            登录 / 注册
          </Button>
        )}
      </Toolbar>
    </AppBar>
  );
}
