// ============================================================
// PipelineFunnel：漏斗可视化（每步剩余数量+淘汰原因 Top3）
// ============================================================
import { Box, Typography, Tooltip } from '@mui/material';
import type { PipelineFunnelStep } from '../../api/screener';
import { COLORS } from '@shared/constants';

interface PipelineFunnelProps {
  funnel: PipelineFunnelStep[];
  totalStart: number;
}

/** 漏斗条形图：从全市场 N 只逐步收缩 */
export default function PipelineFunnel({ funnel, totalStart }: PipelineFunnelProps) {
  if (!funnel.length) return null;
  const maxSurvivors = Math.max(totalStart, ...funnel.map((f) => f.survivors)) || 1;

  return (
    <Box sx={{ mb: 2 }}>
      <Typography variant="subtitle2" sx={{ mb: 1, fontWeight: 700 }}>
        漏斗管线（全市场 {totalStart} 只 → 最终 {funnel[funnel.length - 1].survivors} 只）
      </Typography>
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}>
        {/* 起点 */}
        <FunnelBar label="全市场" count={totalStart} widthPct={100} color={COLORS.FLAT} />
        {funnel.map((step, i) => {
          const widthPct = Math.max(4, (step.survivors / maxSurvivors) * 100);
          const isFinal = i === funnel.length - 1;
          return (
            <Tooltip
              key={step.step_id}
              title={
                <Box>
                  <Typography variant="caption" display="block">淘汰 {step.eliminated} 只</Typography>
                  {(step.top_reasons || []).map((r) => (
                    <Typography key={r.reason} variant="caption" display="block">
                      · {r.reason}（{r.count}）
                    </Typography>
                  ))}
                  {step.top_reasons.length === 0 && <Typography variant="caption">无淘汰</Typography>}
                </Box>
              }
              placement="right"
            >
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                <Typography variant="caption" sx={{ width: 150, flexShrink: 0, textAlign: 'right', color: 'text.secondary', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {i + 1}. {step.label}
                </Typography>
                <Box sx={{ flex: 1, position: 'relative', height: 24, bgcolor: 'action.hover', borderRadius: 1, overflow: 'hidden' }}>
                  <Box
                    sx={{
                      height: '100%',
                      width: `${widthPct}%`,
                      borderRadius: 1,
                      bgcolor: isFinal ? COLORS.UP : COLORS.PRIMARY,
                      opacity: isFinal ? 0.9 : 0.65,
                      transition: 'width 0.3s',
                    }}
                  />
                  <Typography variant="caption" sx={{ position: 'absolute', left: 8, top: 4, color: '#fff', fontWeight: 700, textShadow: '0 1px 2px rgba(0,0,0,0.5)' }}>
                    {step.survivors} 只
                  </Typography>
                </Box>
                <Typography variant="caption" sx={{ width: 80, flexShrink: 0, color: step.eliminated > 0 ? COLORS.UP : COLORS.FLAT }}>
                  {step.eliminated > 0 ? `-${step.eliminated}` : ''}
                </Typography>
              </Box>
            </Tooltip>
          );
        })}
      </Box>
    </Box>
  );
}

function FunnelBar({ label, count, widthPct, color }: { label: string; count: number; widthPct: number; color: string }) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
      <Typography variant="caption" sx={{ width: 150, flexShrink: 0, textAlign: 'right', color: 'text.secondary' }}>
        {label}
      </Typography>
      <Box sx={{ flex: 1, position: 'relative', height: 22, bgcolor: 'action.hover', borderRadius: 1, overflow: 'hidden' }}>
        <Box sx={{ height: '100%', width: `${widthPct}%`, borderRadius: 1, bgcolor: color, opacity: 0.5 }} />
        <Typography variant="caption" sx={{ position: 'absolute', left: 8, top: 4, color: '#fff', fontWeight: 700, textShadow: '0 1px 2px rgba(0,0,0,0.5)' }}>
          {count} 只
        </Typography>
      </Box>
      <Box sx={{ width: 80, flexShrink: 0 }} />
    </Box>
  );
}
