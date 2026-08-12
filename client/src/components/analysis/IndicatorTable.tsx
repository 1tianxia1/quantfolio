// ============================================================
// IndicatorTable：规则命中明细表（模块 B）
// 方向色：利多=UP 色、利空=DOWN 色、中性=FLAT 色（唯一来源 @shared/constants COLORS）
// ============================================================
import { Table, TableBody, TableCell, TableHead, TableRow, Typography } from '@mui/material';
import type { RuleHit } from '../../api/analysis';
import { COLORS } from '@shared/constants';

function dirMeta(direction: string) {
  if (direction === 'bullish') return { label: '利多', color: COLORS.UP };
  if (direction === 'bearish') return { label: '利空', color: COLORS.DOWN };
  return { label: '中性', color: COLORS.FLAT };
}

export default function IndicatorTable({ rules }: { rules: RuleHit[] }) {
  if (!rules.length) {
    return (
      <Typography variant="body2" color="text.secondary">
        暂无命中规则。
      </Typography>
    );
  }
  return (
    <Table size="small">
      <TableHead>
        <TableRow>
          <TableCell sx={{ width: '30%' }}>指标</TableCell>
          <TableCell sx={{ width: '12%' }}>方向</TableCell>
          <TableCell sx={{ width: '12%' }}>权重</TableCell>
          <TableCell>说明</TableCell>
        </TableRow>
      </TableHead>
      <TableBody>
        {rules.map((r) => {
          const m = dirMeta(r.direction);
          return (
            <TableRow key={r.id} hover>
              <TableCell>
                <Typography variant="body2" sx={{ fontWeight: 600 }}>{r.label}</Typography>
              </TableCell>
              <TableCell>
                <Typography variant="body2" sx={{ color: m.color, fontWeight: 700 }}>{m.label}</Typography>
              </TableCell>
              <TableCell>
                <Typography variant="body2">{r.weight}</Typography>
              </TableCell>
              <TableCell>
                <Typography variant="caption" color="text.secondary">{r.detail || '—'}</Typography>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
