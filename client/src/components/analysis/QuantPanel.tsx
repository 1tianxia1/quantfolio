// ============================================================
// QuantPanel：模块 A 量化分析（AI 基本面 + 消息面）结果面板
// 状态来自 analysisStore（路由切换不中断，切回页面可恢复）
// 结论卡片 + 情报来源链 + 检索信息；42401/42402 错误友好提示
// ============================================================
import { useEffect, useRef } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  Stack,
  Typography,
} from '@mui/material';
import { useNavigate } from 'react-router-dom';
import { useQuantSession, startQuant } from '../../store/analysisStore';
import ConclusionCard from './ConclusionCard';
import SourceList from './SourceList';

const PROVIDER_LABEL: Record<string, string> = {
  zhipu: '智谱 Web Search',
  eastmoney: '东方财富财经信源',
};

/** 最大等待时长（秒）：接口等待 180，倒计时展示 */
const MAX_WAIT_SECONDS = 180;

interface QuantPanelProps {
  /** 待分析的 6 位代码 */
  code: string;
  /**
   * 运行令牌序号，由 AnalysisCenter 在用户点击时自增。
   * 它是本组件唯一的「重新请求」触发器：只要 runId 不变（例如切换 Tab 只改 CSS
   * display 导致的重渲染），就绝不会再次调用 /api/analysis/quant/stream。
   * 传入 <= 0 表示尚未发起过运行，组件保持静默。
   */
  runId: number;
}

export default function QuantPanel({ code, runId }: QuantPanelProps) {
  const navigate = useNavigate();
  const session = useQuantSession(code);
  /** 记录已为哪个 runId 发起过请求，避免重复发起 / 路由重挂时重复触发 */
  const startedRef = useRef<number>(-1);

  useEffect(() => {
    // 未被用户显式触发过 → 不发任何请求（切 Tab / 重渲染都走不到这里）
    if (!code || runId <= 0) return;
    // 路由重挂 / 重渲染时 runId 不变则不重复发起，保留后台运行结果
    if (startedRef.current === runId) return;
    startedRef.current = runId;
    startQuant(code);
    // 注意：此处**不** abort —— 切到其他页面时请求在 store 中继续运行，
    // 回到本页时 useQuantSession 会恢复最新状态（running / done / error）。
    return () => {
      /* 保留后台运行，不中断 */
    };
    // 依赖里只有「用户主动触发」的量：code / runId。
  }, [code, runId]);

  /** 重试：直接重新发起（绕过 runId 守卫） */
  const handleRetry = () => {
    startedRef.current = runId;
    startQuant(code);
  };

  const { status, report, error, logs, step, remaining } = session;

  // 加载中：倒计时 + 进度日志
  if (status === 'running') {
    const progress = ((MAX_WAIT_SECONDS - remaining) / MAX_WAIT_SECONDS) * 100;
    return (
      <Box sx={{ py: 4 }}>
        <Stack direction="column" alignItems="center" spacing={2}>
          <Box sx={{ position: 'relative', display: 'inline-flex' }}>
            <CircularProgress variant="determinate" value={progress} size={96} thickness={4} />
            <Box
              sx={{
                position: 'absolute',
                inset: 0,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Typography variant="caption" color="text.secondary">
                剩余
              </Typography>
              <Typography variant="h6" component="div" sx={{ fontWeight: 700 }}>
                {remaining}s
              </Typography>
            </Box>
          </Box>
          <Typography variant="body2" color="text.secondary">
            {step === 'fetching' && '正在获取行情 / 场外基金净值…'}
            {step === 'resolving' && '正在校验 AI 模型配置…'}
            {step === 'searching' && '正在联网检索资讯…'}
            {step === 'generating' && 'AI 正在生成分析结论…'}
          </Typography>
          <Typography variant="caption" color="text.disabled">
            切到其他页面也不会中断，返回本页可继续查看
          </Typography>
        </Stack>

        {logs.length > 0 && (
          <Box sx={{ mt: 2, mx: 'auto', maxWidth: 520 }}>
            <Stack spacing={0.5}>
              {logs.map((m, i) => (
                <Typography
                  key={i}
                  variant="caption"
                  color={i === logs.length - 1 ? 'primary' : 'text.secondary'}
                  sx={{ display: 'block' }}
                >
                  · {m}
                </Typography>
              ))}
            </Stack>
          </Box>
        )}
      </Box>
    );
  }

  // 42402：未配置 AI Key → 引导跳模型设置
  if (error?.code === 42402) {
    return (
      <Alert severity="info" action={<Button color="inherit" size="small" onClick={() => navigate('/settings')}>去配置</Button>}>
        {error.message}
      </Alert>
    );
  }

  // 42401：情报时效不达标（用户红线）
  if (error?.code === 42401) {
    return (
      <Alert
        severity="warning"
        action={<Button color="inherit" size="small" onClick={handleRetry}>重试</Button>}
      >
        {error.message}
      </Alert>
    );
  }

  if (error) {
    return (
      <Alert
        severity="warning"
        action={
          <Button color="inherit" size="small" onClick={handleRetry}>
            重试
          </Button>
        }
      >
        {error.message}
      </Alert>
    );
  }

  if (!report) return null;

  return (
    <Box>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1.5, flexWrap: 'wrap' }}>
        <Typography variant="body2" color="text.secondary">
          {report.name}（{report.code}）· 截至 {report.trade_date}
          {report.meta.ai_model ? ` · 模型 ${report.meta.ai_model}` : ''}
        </Typography>
        {report.is_otc_fund && (
          <Chip size="small" label="场外基金·净值口径" color="warning" variant="outlined" />
        )}
        {(report.search.providers_used || []).map((p) => (
          <Chip key={p} size="small" label={PROVIDER_LABEL[p] || p} variant="outlined" />
        ))}
      </Stack>

      <ConclusionCard conclusion={report.conclusion} degraded={report.meta.degraded} />

      {report.sources.length > 0 && (
        <>
          <Divider sx={{ my: 1.5 }} />
          <Typography variant="subtitle2" sx={{ mb: 0.75 }}>
            情报来源（检索于 {report.search.retrieved_at.slice(0, 16).replace('T', ' ')}）
          </Typography>
          <SourceList sources={report.sources} />
        </>
      )}
    </Box>
  );
}
