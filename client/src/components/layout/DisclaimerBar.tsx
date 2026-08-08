// ============================================================
// 底部合规免责声明
// ============================================================
import { Box, Typography } from '@mui/material';
import { SCREENER_DISCLAIMER } from '@shared/constants';

export default function DisclaimerBar() {
  return (
    <Box
      component="footer"
      sx={{
        py: 1.5,
        px: 2,
        borderTop: '1px solid',
        borderColor: 'divider',
        textAlign: 'center',
        bgcolor: 'background.paper',
      }}
    >
      <Typography variant="caption" color="text.secondary">
        {SCREENER_DISCLAIMER} · 数据来源：2026-08-07 通达信真实快照 + 确定性派生
      </Typography>
    </Box>
  );
}
