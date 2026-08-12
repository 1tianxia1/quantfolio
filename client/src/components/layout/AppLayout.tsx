// ============================================================
// 布局：顶栏 + 侧栏 + 内容区 + 底部免责声明
// ============================================================
import { Box } from '@mui/material';
import InfoIcon from '@mui/icons-material/Info';
import TopBar from './TopBar';
import SideBar from './SideBar';
import DisclaimerBar from './DisclaimerBar';
import { Outlet } from 'react-router-dom';
import { useState, useEffect } from 'react';
import { useUiStore } from '../../store/uiStore';
import { marketApi } from '../../api/market';

export default function AppLayout() {
  const collapsed = useUiStore((s) => s.sidebarCollapsed);
  const sidebarWidth = collapsed ? 64 : 220;
  const [compliance, setCompliance] = useState<string>('行情数据加载中...');

  useEffect(() => {
    marketApi.meta()
      .then((m) => { if (m?.compliance) setCompliance(m.compliance); })
      .catch(() => {});
  }, []);

  return (
    <Box sx={{ display: 'flex', minHeight: '100vh', flexDirection: 'column' }}>
      <TopBar />
      <Box sx={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <SideBar width={sidebarWidth} />
        <Box
          component="main"
          sx={{
            flex: 1,
            minWidth: 0,
            p: { xs: 1.5, md: 3 },
            overflowX: 'hidden',
          }}
        >
          <Box sx={{ maxWidth: 1480, mx: 'auto', width: '100%' }}>
            {/* 数据合规提示条 */}
            <Box
              sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 1,
                mb: 2.5,
                px: 1.5,
                py: 0.75,
                borderRadius: 1.5,
                fontSize: 12,
                color: 'text.secondary',
                bgcolor: 'action.hover',
              }}
            >
              <InfoIcon fontSize="small" sx={{ color: 'primary.main', flexShrink: 0 }} />
              <span>{compliance}</span>
            </Box>
            <Outlet />
          </Box>
        </Box>
      </Box>
      <DisclaimerBar />
    </Box>
  );
}
