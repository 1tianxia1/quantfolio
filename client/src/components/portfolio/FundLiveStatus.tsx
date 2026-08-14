// ============================================================
// 场外基金实时估值状态条（醒目）
// 显示：脉冲点 + 实时/休眠/初始化状态 + 估值更新时间 + 刷新频率 + 下次刷新倒计时
// 数据源：持仓 summary 中的 estimate_time（由前端采集天天基金 fundgz 推回后端）
// ============================================================
import { useEffect, useMemo, useState } from 'react';
import { alpha, useTheme } from '@mui/material/styles';
import { Box, Typography, Chip } from '@mui/material';
import type { Holding } from '../../api/portfolio';

interface Props {
  holdings: Holding[];
  /** 最近一次采集完成的时间戳（ms）；null 表示尚未开始采集 */
  lastCollectAt: number | null;
  /** 是否正在采集估值 */
  collecting: boolean;
}

/** 是否处于交易时段盘中（周一~周五 09:30-15:00，本地时间判断） */
function isMarketOpen(): boolean {
  const d = new Date();
  const day = d.getDay();
  if (day === 0 || day === 6) return false;
  const mins = d.getHours() * 60 + d.getMinutes();
  return mins >= 9 * 60 + 30 && mins < 15 * 60;
}

const REFRESH_SEC = 55;

export default function FundLiveStatus({ holdings, lastCollectAt, collecting }: Props) {
  const theme = useTheme();
  const funds = useMemo(() => holdings.filter((h) => h.asset_class === 'fund'), [holdings]);
  const [now, setNow] = useState(() => Date.now());

  // 内部 1s 心跳，仅驱动倒计时显示，不污染父组件其它重渲染
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  if (!funds.length) return null;

  // 取所有基金里最新的有效估值时间（estimate_time 最大者）
  const latestGzTime = useMemo(() => {
    const times = funds
      .map((h) => (h.data_origin === 'estimate' || h.data_origin === 'mixed' ? h.estimate_time || null : null))
      .filter(Boolean) as string[];
    if (!times.length) return null;
    return times.sort().slice(-1)[0];
  }, [funds]);

  const open = isMarketOpen();
  const nextIn = lastCollectAt ? Math.max(0, REFRESH_SEC - Math.floor((now - lastCollectAt) / 1000)) : null;

  let status: 'live' | 'idle' | 'init';
  let text: string;
  if (!lastCollectAt) {
    status = 'init';
    text = '正在初始化基金估值采集…';
  } else if (open) {
    status = 'live';
    text = `实时估值中 · 估值更新于 ${latestGzTime || '—'}`;
  } else {
    status = 'idle';
    text = `已收盘 · 估值冻结于 ${latestGzTime || '—'}（今晚官方净值公布后自动更新，次日 09:30 恢复实时）`;
  }

  const isLive = status === 'live';
  const dotColor = isLive ? theme.palette.success.main : theme.palette.text.disabled;

  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1.5,
        flexWrap: 'wrap',
        px: 2,
        py: 1.1,
        mb: 2,
        borderRadius: 2,
        border: '1px solid',
        borderColor: isLive ? alpha(theme.palette.success.main, 0.45) : 'divider',
        background: isLive
          ? `linear-gradient(90deg, ${alpha(theme.palette.success.main, 0.14)}, ${alpha(theme.palette.success.main, 0.03)})`
          : 'action.hover',
      }}
    >
      {/* 脉冲点 */}
      <Box sx={{ position: 'relative', width: 10, height: 10, flexShrink: 0 }}>
        <Box
          sx={{
            width: 10,
            height: 10,
            borderRadius: '50%',
            bgcolor: dotColor,
            ...(isLive ? { animation: 'flPulse 1.6s ease-in-out infinite' } : {}),
          }}
        />
        {isLive && (
          <Box
            sx={{
              position: 'absolute',
              inset: 0,
              borderRadius: '50%',
              bgcolor: dotColor,
              animation: 'flRing 1.6s ease-out infinite',
            }}
          />
        )}
      </Box>

      <Typography
        variant="body2"
        sx={{ fontWeight: 700, flexShrink: 0, color: isLive ? 'success.main' : 'text.secondary' }}
      >
        {status === 'live' ? '● 实时' : status === 'init' ? '估值' : '休眠'}
      </Typography>

      <Typography
        variant="body2"
        sx={{
          color: 'text.primary',
          flexGrow: 1,
          minWidth: 200,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {text}
      </Typography>

      <Chip
        size="small"
        variant="outlined"
        label={`每 ${REFRESH_SEC}s 刷新`}
        sx={{ flexShrink: 0, height: 22 }}
      />
      {isLive && nextIn != null && (
        <Chip
          size="small"
          color="success"
          label={`下次 ${nextIn}s`}
          sx={{ flexShrink: 0, height: 22, fontWeight: 700 }}
        />
      )}
      {collecting && (
        <Chip size="small" color="info" label="采集中…" sx={{ flexShrink: 0, height: 22 }} />
      )}

      <style>{`
        @keyframes flPulse { 0%{opacity:1} 50%{opacity:.45} 100%{opacity:1} }
        @keyframes flRing { 0%{transform:scale(1);opacity:.55} 100%{transform:scale(2.6);opacity:0} }
      `}</style>
    </Box>
  );
}
