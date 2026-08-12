// ============================================================
// 数据待补横幅：早盘模型（faithful=false）红色警示
// ============================================================
import { Alert, Box } from '@mui/material';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';

interface Props {
  /** 是否显示（早盘模型为 true） */
  show: boolean;
  /** 提示文案（可选，默认给出标准文案） */
  text?: string;
}

export default function DataCaveatBanner({ show, text }: Props) {
  if (!show) return null;
  const msg = text || '早盘辅助历史数据（资金流/竞价/涨停/板块）近乎缺失，回测结果仅供参考，不代表真实选股表现。';
  return (
    <Box sx={{ mb: 2 }}>
      <Alert
        severity="error"
        icon={<WarningAmberIcon />}
        sx={{
          bgcolor: 'rgba(229,57,53,0.10)',
          border: '1px solid',
          borderColor: 'error.main',
          color: 'error.main',
          '& .MuiAlert-icon': { color: 'error.main' },
          fontWeight: 600,
        }}
      >
        {msg}
      </Alert>
    </Box>
  );
}
