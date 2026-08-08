// ============================================================
// DataOriginBadge：「真实行情/派生数据」来源徽章
// ============================================================
import Tooltip from '@mui/material/Tooltip';
import Chip from '@mui/material/Chip';
import { DATA_ORIGIN_LABEL } from '@shared/constants';

interface DataOriginBadgeProps {
  origin?: string | null;
}

/** 数据来源徽章：real=真实 / derived=派生 / mixed=混合 */
export default function DataOriginBadge({ origin }: DataOriginBadgeProps) {
  const o = origin || 'real';
  const label = DATA_ORIGIN_LABEL[o] || o;
  const color = o === 'real' ? 'success' : o === 'mixed' ? 'warning' : 'default';
  return (
    <Tooltip title="行情截至 2026-08-07 收盘，历史 K 线为模拟数据，最新价为真实行情">
      <Chip label={label} color={color} size="small" variant="outlined" sx={{ height: 18, fontSize: 10 }} />
    </Tooltip>
  );
}
