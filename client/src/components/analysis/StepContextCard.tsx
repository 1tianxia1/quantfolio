// ============================================================
// StepContextCard：流水线单步的上下文卡片（承前启后的可视化）
// 展示步骤名 + 状态徽标 + 错误 + 子内容（该步的输入/产出摘要）
// ============================================================
import { Box, Chip, Typography } from '@mui/material';
import type { ReactNode } from 'react';
import { stepLabel, stepStatusLabel } from '../../utils/analysisFormat';
import { COLORS } from '@shared/constants';

const STATUS_BG: Record<string, string> = {
  done: '#26A69A',
  failed: COLORS.DOWN,
  running: COLORS.PRIMARY,
  skipped: '#8B949E',
  pending: '#8B949E',
};

interface StepContextCardProps {
  step: string;
  status: string;
  error?: string | null;
  children?: ReactNode;
}

export default function StepContextCard({ step, status, error, children }: StepContextCardProps) {
  return (
    <Box sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 2, p: 1.5, mb: 1 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
        <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
          {stepLabel(step)}
        </Typography>
        <Chip
          size="small"
          label={stepStatusLabel(status)}
          sx={{ height: 20, fontSize: 11, bgcolor: STATUS_BG[status] || '#8B949E', color: '#fff' }}
        />
      </Box>
      {error && (
        <Typography variant="caption" sx={{ color: COLORS.DOWN, display: 'block', mb: 0.5 }}>
          {error}
        </Typography>
      )}
      {children}
    </Box>
  );
}
