// ============================================================
// PipelineFunnel：漏斗可视化（每步剩余数量+淘汰原因 Top3）
// 新增：点击任意阶段条形 → 弹窗查看该阶段存活标的明细表格
// ============================================================
import { useState } from 'react';
import {
  Box, Typography, Tooltip, Dialog, DialogTitle, DialogContent, IconButton,
  Table, TableHead, TableRow, TableCell, TableBody, TableContainer, useTheme,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import type { PipelineFunnelStep, FunnelRow } from '../../api/screener';
import { COLORS } from '@shared/constants';

interface PipelineFunnelProps {
  funnel: PipelineFunnelStep[];
  totalStart?: number;
}

/** 数值格式化（null → 破折号，保留 2 位） */
function fmt(v: number | null) {
  if (v == null || Number.isNaN(v)) return '—';
  return (Math.round(v * 100) / 100).toString();
}

/** A 股红涨绿跌配色 */
function pctColor(v: number | null, theme: any) {
  if (v == null) return undefined;
  if (v > 0) return theme.palette.error.main;
  if (v < 0) return theme.palette.success.main;
  return undefined;
}

export default function PipelineFunnel({ funnel, totalStart }: PipelineFunnelProps) {
  const theme = useTheme();
  const [selected, setSelected] = useState<PipelineFunnelStep | null>(null);
  if (!funnel.length) return null;
  const maxSurvivors = Math.max(totalStart ?? 0, ...funnel.map((f) => f.survivors)) || 1;

  return (
    <Box sx={{ mb: 2 }}>
      <Typography variant="subtitle2" sx={{ mb: 1, fontWeight: 700 }}>
        漏斗管线（全市场 {funnel[0]?.survivors ?? totalStart} 只 → 最终 {funnel[funnel.length - 1].survivors} 只，点击任意阶段看明细）
      </Typography>
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}>
        {funnel.map((step, i) => {
          const widthPct = Math.max(4, (step.survivors / maxSurvivors) * 100);
          const isFinal = i === funnel.length - 1;
          const hasRows = Array.isArray(step.rows) && step.rows.length > 0;
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
                  {hasRows && <Typography variant="caption" display="block" sx={{ mt: 0.5, fontWeight: 700 }}>点击查看本阶段明细表格</Typography>}
                </Box>
              }
              placement="right"
            >
              <Box
                onClick={() => hasRows && setSelected(step)}
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 1,
                  cursor: hasRows ? 'pointer' : 'default',
                  opacity: hasRows ? 1 : 0.6,
                  borderRadius: 1,
                  '&:hover': hasRows ? { filter: 'brightness(1.06)', bgcolor: 'action.selected' } : {},
                }}
              >
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
                    {step.survivors} 只{hasRows ? ' · 点击看明细' : ''}
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

      <Dialog open={!!selected} onClose={() => setSelected(null)} maxWidth="md" fullWidth>
        <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', pr: 1 }}>
          <span>
            {selected?.label} · 存活 {selected?.survivors} 只
            {selected?.rows_truncated && (
              <Typography component="span" variant="caption" sx={{ ml: 1, color: 'text.secondary' }}>
                （仅显示前 {selected.rows?.length} / 共 {selected.rows_total} 只）
              </Typography>
            )}
          </span>
          <IconButton size="small" onClick={() => setSelected(null)} aria-label="关闭">
            <CloseIcon fontSize="small" />
          </IconButton>
        </DialogTitle>
        <DialogContent dividers sx={{ p: 0 }}>
          <TableContainer sx={{ maxHeight: '62vh' }}>
            <Table size="small" stickyHeader>
              <TableHead>
                <TableRow>
                  <TableCell>代码</TableCell>
                  <TableCell>名称</TableCell>
                  <TableCell align="right">现价</TableCell>
                  <TableCell align="right">涨跌幅%</TableCell>
                  <TableCell align="right">换手率%</TableCell>
                  <TableCell align="right">量比</TableCell>
                  <TableCell align="right">5日均量比</TableCell>
                  <TableCell align="right">连续放量(日)</TableCell>
                  <TableCell align="right">流通市值(亿)</TableCell>
                  <TableCell align="center">多头</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {(selected?.rows || []).map((r: FunnelRow) => (
                  <TableRow key={r.code} hover>
                    <TableCell>{r.code}</TableCell>
                    <TableCell>{r.name}</TableCell>
                    <TableCell align="right">{fmt(r.price)}</TableCell>
                    <TableCell align="right" sx={{ color: pctColor(r.pct_chg, theme) }}>{fmt(r.pct_chg)}</TableCell>
                    <TableCell align="right">{fmt(r.turnover_rate)}</TableCell>
                    <TableCell align="right">{fmt(r.volume_ratio)}</TableCell>
                    <TableCell align="right">{fmt(r.vol_ratio_5)}</TableCell>
                    <TableCell align="right">{fmt(r.volume_streak)}</TableCell>
                    <TableCell align="right">{fmt(r.circ_mv)}</TableCell>
                    <TableCell align="center">{r.ma_bullish ? '✓' : '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        </DialogContent>
      </Dialog>
    </Box>
  );
}
