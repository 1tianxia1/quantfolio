// ============================================================
// PageHeader：统一的页面头部（标题 + 副标题 + 图标 + 右侧操作区）
// 用法：<PageHeader title="组合仪表盘" subtitle="..." icon={<Icon/>} actions={<Button/>} />
// ============================================================
import { Box, Typography, Stack } from '@mui/material';
import type { ReactNode } from 'react';
import type { SxProps } from '@mui/material';
import type { Theme } from '@mui/material/styles';

interface PageHeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  sx?: SxProps<Theme>;
}

export default function PageHeader({ title, subtitle, icon, actions, sx }: PageHeaderProps) {
  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: 2,
        mb: 2.5,
        flexWrap: 'wrap',
        ...sx,
      }}
    >
      <Stack direction="row" spacing={1.5} alignItems="center">
        {icon && (
          <Box
            sx={{
              width: 40,
              height: 40,
              flexShrink: 0,
              display: 'grid',
              placeItems: 'center',
              borderRadius: 10,
              bgcolor: 'rgba(46,124,246,0.12)',
              color: 'primary.main',
              fontSize: 20,
            }}
          >
            {icon}
          </Box>
        )}
        <Box>
          <Typography variant="h5" sx={{ fontWeight: 700, lineHeight: 1.2 }}>
            {title}
          </Typography>
          {subtitle && (
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.25 }}>
              {subtitle}
            </Typography>
          )}
        </Box>
      </Stack>
      {actions && (
        <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap' }}>{actions}</Box>
      )}
    </Box>
  );
}
