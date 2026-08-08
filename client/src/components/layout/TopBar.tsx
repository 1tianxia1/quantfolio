// ============================================================
// 顶栏：Logo/搜索框/主题切换/用户菜单
// ============================================================
import { useState, useEffect } from 'react';
import {
  AppBar, Toolbar, Box, TextField, InputAdornment, IconButton,
  Avatar, Menu, MenuItem, Tooltip, Typography, Button, Divider,
} from '@mui/material';
import MenuIcon from '@mui/icons-material/Menu';
import SearchIcon from '@mui/icons-material/Search';
import DarkModeIcon from '@mui/icons-material/DarkMode';
import LightModeIcon from '@mui/icons-material/LightMode';
import AccountCircleIcon from '@mui/icons-material/AccountCircle';
import LogoutIcon from '@mui/icons-material/Logout';
import { useNavigate, useLocation } from 'react-router-dom';
import { useUiStore } from '../../store/uiStore';
import { useAuthStore } from '../../store/authStore';
import { APP_NAME } from '@shared/constants';
import { marketApi } from '../../api/market';
import { authApi } from '../../api/auth';
import { useSnackbar } from '../common/SnackbarProvider';
import { useDebounce } from '../../hooks/useDebounce';
import type { SearchItem } from '../../api/market';

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
