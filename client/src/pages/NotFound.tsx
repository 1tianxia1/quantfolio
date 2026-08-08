// ============================================================
// 404 页
// ============================================================
import { Box, Typography, Button } from '@mui/material';
import { useNavigate } from 'react-router-dom';

export default function NotFound() {
  const navigate = useNavigate();
  return (
    <Box sx={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2 }}>
      <Typography variant="h2" sx={{ fontWeight: 800 }}>404</Typography>
      <Typography variant="body1" color="text.secondary">页面不存在</Typography>
      <Button variant="contained" onClick={() => navigate('/')}>返回首页</Button>
    </Box>
  );
}
