// ============================================================
// SignalBadge：买卖信号徽标（红涨绿跌：买入=UP 色，卖出=DOWN 色，观望=FLAT 色）
// ============================================================
import { Chip } from '@mui/material';
import { COLORS } from '@shared/constants';

const MAP: Record<string, { label: string; color: string }> = {
  buy: { label: '买入信号', color: COLORS.UP },
  sell: { label: '卖出信号', color: COLORS.DOWN },
  hold: { label: '观望', color: COLORS.FLAT },
};

export default function SignalBadge({ action, strength }: { action: string; strength: number }) {
  const m = MAP[action] || MAP.hold;
  return (
    <Chip
      label={`${m.label} · 强度 ${Math.round(strength)}`}
      sx={{ bgcolor: m.color, color: '#fff', fontWeight: 700, fontSize: 13, height: 28 }}
    />
  );
}
