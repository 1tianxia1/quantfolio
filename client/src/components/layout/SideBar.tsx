// ============================================================
// 侧栏：导航 + 激活态强调 + 折叠开关 + 游客提示卡
// ============================================================
import {
  Box, List, ListItemButton, ListItemIcon, ListItemText, Button, Divider, Typography, Tooltip, IconButton,
} from '@mui/material';
import DashboardIcon from '@mui/icons-material/Dashboard';
import WbSunnyIcon from '@mui/icons-material/WbSunny';
import WbTwilightIcon from '@mui/icons-material/WbTwilight';
import StarIcon from '@mui/icons-material/Star';
import FolderIcon from '@mui/icons-material/Folder';
import SettingsIcon from '@mui/icons-material/Settings';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuthStore } from '../../store/authStore';
import { useUiStore } from '../../store/uiStore';

const NAV_ITEMS = [
  { key: 'portfolio', label: '组合仪表盘', icon: <DashboardIcon fontSize="small" />, path: '/portfolio' },
  { key: 'morning', label: '早盘选股', icon: <WbSunnyIcon fontSize="small" />, path: '/morning' },
  { key: 'closing', label: '尾盘选股器', icon: <WbTwilightIcon fontSize="small" />, path: '/closing' },
  { key: 'strategies', label: '我的策略', icon: <FolderIcon fontSize="small" />, path: '/strategies' },
  { key: 'watchlist', label: '我的自选', icon: <StarIcon fontSize="small" />, path: '/watchlist' },
  { key: 'settings', label: '模型设置', icon: <SettingsIcon fontSize="small" />, path: '/settings', requireLogin: true },
];

// 激活态：左侧强调条 + 主色淡底 + 主色图标
const SELECTED_SX = {
  bgcolor: 'rgba(46,124,246,0.14)',
  color: 'primary.main',
  position: 'relative',
  '& .MuiListItemIcon-root': { color: 'primary.main' },
  '&:hover': { bgcolor: 'rgba(46,124,246,0.20)' },
  '&::before': {
    content: '""',
    position: 'absolute',
    left: 0,
    top: 8,
    bottom: 8,
    width: 3,
    borderRadius: 2,
    bgcolor: 'primary.main',
  },
};

export default function SideBar({ width }: { width: number }) {
  const navigate = useNavigate();
  const location = useLocation();
  const { isLoggedIn } = useAuthStore();
  const { sidebarCollapsed, toggleSidebar } = useUiStore();
  const collapsed = width <= 80;

  const current = location.pathname.split('/')[1] || 'portfolio';

  return (
    <Box
      component="nav"
      sx={{
        width,
        flexShrink: 0,
        borderRight: '1px solid',
        borderColor: 'divider',
        bgcolor: 'background.paper',
        transition: 'width 0.2s',
        overflowX: 'hidden',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <List sx={{ p: 1, flex: 1 }}>
        {NAV_ITEMS.filter((item) => !item.requireLogin || isLoggedIn()).map((item) => {
          const selected = current === item.key;
          const btn = (
            <ListItemButton
              selected={selected}
              onClick={() => navigate(item.path)}
              sx={{
                borderRadius: 1.5,
                mb: 0.5,
                justifyContent: collapsed ? 'center' : 'flex-start',
                ...(selected ? SELECTED_SX : { '&:hover': { bgcolor: 'action.hover' } }),
              }}
            >
              <ListItemIcon sx={{ minWidth: collapsed ? 0 : 36, justifyContent: 'center' }}>{item.icon}</ListItemIcon>
              {!collapsed && <ListItemText primary={item.label} primaryTypographyProps={{ fontSize: 14, fontWeight: selected ? 700 : 500 }} />}
            </ListItemButton>
          );
          return (
            <li key={item.key}>
              {collapsed ? (
                <Tooltip title={item.label} placement="right" disableInteractive>
                  {btn}
                </Tooltip>
              ) : (
                btn
              )}
            </li>
          );
        })}
      </List>

      {/* 折叠开关 */}
      <Box sx={{ p: 1, borderTop: '1px solid', borderColor: 'divider' }}>
        <Tooltip title={collapsed ? '展开侧栏' : '收起侧栏'} placement="right" disableInteractive>
          <IconButton size="small" onClick={toggleSidebar} sx={{ width: '100%', justifyContent: collapsed ? 'center' : 'flex-start', color: 'text.secondary' }}>
            {collapsed ? <ChevronRightIcon /> : <ChevronLeftIcon />}
            {!collapsed && <Typography variant="caption" sx={{ ml: 1 }}>收起</Typography>}
          </IconButton>
        </Tooltip>
      </Box>

      {/* 游客提示卡 */}
      {!isLoggedIn() && !collapsed && (
        <Box sx={{ p: 2 }}>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            当前为<b>演示数据</b>模式，操作不会被保存。
          </Typography>
          <Button size="small" variant="outlined" fullWidth onClick={() => navigate('/login')}>
            登录 / 注册
          </Button>
        </Box>
      )}
      {!isLoggedIn() && collapsed && (
        <Box sx={{ p: 1, textAlign: 'center' }}>
          <Typography variant="caption" color="text.secondary">游客</Typography>
        </Box>
      )}
    </Box>
  );
}
