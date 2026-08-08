// ============================================================
// 登录 / 注册页（含演示模式入口）
// ============================================================
import { useState } from 'react';
import { Box, Paper, Tabs, Tab, TextField, Button, Typography, Divider } from '@mui/material';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { authApi } from '../api/auth';
import { useAuthStore } from '../store/authStore';
import { useSnackbar } from '../components/common/SnackbarProvider';
import { APP_NAME } from '@shared/constants';

export default function LoginPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const redirect = params.get('redirect') || '/portfolio';
  const [tab, setTab] = useState(0);
  const [account, setAccount] = useState('');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const { setAuth } = useAuthStore();
  const snackbar = useSnackbar();

  const handleSubmit = async () => {
    if (!password) {
      snackbar.show('请输入密码', 'warning');
      return;
    }
    setLoading(true);
    try {
      if (tab === 0) {
        if (!account) {
          snackbar.show('请输入邮箱或用户名', 'warning');
          return;
        }
        const r = await authApi.login({ account, password });
        setAuth(r.token, r.user);
        snackbar.show(`欢迎回来，${r.user.username}`, 'success');
      } else {
        if (!username || !email) {
          snackbar.show('请完整填写注册信息', 'warning');
          return;
        }
        const r = await authApi.register({ username, email, password });
        setAuth(r.token, r.user);
        snackbar.show('注册成功', 'success');
      }
      navigate(redirect);
    } catch (e) {
      snackbar.show((e as Error).message || '操作失败', 'error');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Box
      sx={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        bgcolor: 'background.default',
        p: 2,
      }}
    >
      <Paper sx={{ width: 420, p: 4, borderRadius: 3 }}>
        <Box sx={{ textAlign: 'center', mb: 3 }}>
          <Typography variant="h4" sx={{ fontWeight: 800, color: 'primary.main' }}>
            📊 {APP_NAME}
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            量化投资，从看清自己的持仓开始
          </Typography>
        </Box>

        <Tabs value={tab} onChange={(_e, v) => setTab(v)} variant="fullWidth" sx={{ mb: 3 }}>
          <Tab label="登录" />
          <Tab label="注册" />
        </Tabs>

        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {tab === 0 ? (
            <TextField label="邮箱 / 用户名" value={account} onChange={(e) => setAccount(e.target.value)} size="small" fullWidth />
          ) : (
            <>
              <TextField label="用户名" value={username} onChange={(e) => setUsername(e.target.value)} size="small" fullWidth />
              <TextField label="邮箱" value={email} onChange={(e) => setEmail(e.target.value)} size="small" fullWidth />
            </>
          )}
          <TextField
            label="密码"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            size="small"
            fullWidth
            onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
            helperText={tab === 1 ? '密码至少 8 位' : undefined}
          />
          <Button variant="contained" fullWidth onClick={handleSubmit} disabled={loading}>
            {loading ? '处理中…' : tab === 0 ? '登录' : '注册'}
          </Button>
        </Box>

        <Divider sx={{ my: 3 }}>或</Divider>

        <Button variant="outlined" fullWidth onClick={() => navigate('/portfolio')}>
          先逛逛（演示模式）→
        </Button>

        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', textAlign: 'center', mt: 2 }}>
          演示模式下展示只读 demo 数据，保存/编辑需登录
        </Typography>
      </Paper>
    </Box>
  );
}
