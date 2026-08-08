// ============================================================
// ProgressScore：评分进度条（≥80红/60-80橙/<60灰）
// ============================================================
import { Box, LinearProgress, Typography } from '@mui/material';
import { scoreColor } from '../../utils/format';

interface ProgressScoreProps {
  score: number | null | undefined;
  size?: 'small' | 'medium';
}

export default function ProgressScore({ score, size = 'medium' }: ProgressScoreProps) {
  const value = Math.max(0, Math.min(100, score ?? 0));
  const color = scoreColor(score);
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 90 }}>
      <LinearProgress
        variant="determinate"
        value={value}
        sx={{
          flex: 1,
          height: size === 'small' ? 6 : 8,
          borderRadius: 4,
          bgcolor: 'action.hover',
          '& .MuiLinearProgress-bar': { bgcolor: color, borderRadius: 4 },
        }}
      />
      <Typography variant={size === 'small' ? 'caption' : 'body2'} sx={{ fontWeight: 700, color, minWidth: 24, textAlign: 'right' }}>
        {score ?? '—'}
      </Typography>
    </Box>
  );
}
