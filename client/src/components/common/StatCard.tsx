// ============================================================
// StatCard：汇总指标卡片（图标徽标 + 趋势色 + 悬停抬升）
// ============================================================
import { Box, Typography } from '@mui/material';
import type { ReactNode } from 'react';
import type { SxProps } from '@mui/material';
import type { Theme } from '@mui/material/styles';

interface StatCardProps {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  color?: string;
  icon?: ReactNode;
  sx?: SxProps<Theme>;
}

export default function StatCard({ label, value, sub, color, icon, sx }: StatCardProps) {
  return (
    <Box
      sx={{
        p: 2,
        borderRadius: 3,
        bgcolor: 'background.paper',
        border: '1px solid',
        borderColor: 'divider',
        minWidth: 0,
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        gap: 0.5,
        transition: 'border-color .18s ease, box-shadow .18s ease',
        '&:hover': { borderColor: 'rgba(46,124,246,0.35)', boxShadow: 2 },
        ...sx,
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1 }}>
        <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 500 }}>
          {label}
        </Typography>
        {icon && (
          <Box
            sx={{
              width: 30,
              height: 30,
              display: 'grid',
              placeItems: 'center',
              borderRadius: 2,
              bgcolor: color ? `${color}1f` : 'rgba(46,124,246,0.12)',
              color: color || 'primary.main',
              fontSize: 16,
              flexShrink: 0,
            }}
          >
            {icon}
          </Box>
        )}
      </Box>
      <Typography
        variant="h6"
        sx={{
          fontWeight: 700,
          fontSize: 22,
          color: color || 'text.primary',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {value}
      </Typography>
      {sub && (
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          {sub}
        </Typography>
      )}
    </Box>
  );
}
