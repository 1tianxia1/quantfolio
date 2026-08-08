// ============================================================
// SectionCard：带标题/操作槽的统一卡片容器
// 用法：<SectionCard title="持仓明细" action={<Button/>}>{body}</SectionCard>
// 卡片自带描边、圆角、头部分隔线，全站面板统一外观。
// ============================================================
import { Box, Paper, Typography, Stack } from '@mui/material';
import type { ReactNode } from 'react';
import type { SxProps } from '@mui/material';
import type { Theme } from '@mui/material/styles';

interface SectionCardProps {
  title?: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
  children: ReactNode;
  sx?: SxProps<Theme>;
  bodySx?: SxProps<Theme>;
  /** 为 true 时内容区不加内边距（用于表格等需要贴边的内容） */
  noPadding?: boolean;
}

export default function SectionCard({
  title,
  subtitle,
  action,
  icon,
  children,
  sx,
  bodySx,
  noPadding,
}: SectionCardProps) {
  const hasHeader = title || action || icon;
  return (
    <Paper variant="outlined" sx={{ borderRadius: 3, overflow: 'hidden', ...sx }}>
      {hasHeader && (
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 1.5,
            px: 2.5,
            py: 2,
            borderBottom: '1px solid',
            borderColor: 'divider',
          }}
        >
          <Stack direction="row" spacing={1.25} alignItems="center" sx={{ minWidth: 0 }}>
            {icon && (
              <Box sx={{ color: 'primary.main', display: 'flex', fontSize: 18 }}>{icon}</Box>
            )}
            <Box sx={{ minWidth: 0 }}>
              {title && (
                <Typography variant="subtitle1" sx={{ fontWeight: 700, lineHeight: 1.2 }}>
                  {title}
                </Typography>
              )}
              {subtitle && (
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                  {subtitle}
                </Typography>
              )}
            </Box>
          </Stack>
          {action && <Box sx={{ flexShrink: 0 }}>{action}</Box>}
        </Box>
      )}
      <Box sx={{ p: noPadding ? 0 : 2.5, ...bodySx }}>{children}</Box>
    </Paper>
  );
}
