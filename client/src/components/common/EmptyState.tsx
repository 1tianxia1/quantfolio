// ============================================================
// EmptyState：统一的空状态（插图 + 引导文案 + 可选操作）
// 改善「暂无数据」体验，给用户下一步指引。
// ============================================================
import { Box, Typography } from '@mui/material';
import type { ReactNode } from 'react';

interface EmptyStateProps {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}

export default function EmptyState({ icon, title, description, action }: EmptyStateProps) {
  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
        py: 6,
        px: 3,
      }}
    >
      {icon && (
        <Box
          sx={{
            width: 64,
            height: 64,
            display: 'grid',
            placeItems: 'center',
            borderRadius: '50%',
            bgcolor: 'action.hover',
            color: 'text.secondary',
            fontSize: 30,
            mb: 2,
          }}
        >
          {icon}
        </Box>
      )}
      <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
        {title}
      </Typography>
      {description && (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, maxWidth: 360 }}>
          {description}
        </Typography>
      )}
      {action && <Box sx={{ mt: 2 }}>{action}</Box>}
    </Box>
  );
}
