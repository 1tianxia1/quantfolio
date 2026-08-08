// ============================================================
// RebalancePanel：再平衡建议 + 阈值 + 现金警示
// ============================================================
import { Box, Button, Typography, TextField, Chip, Paper, Divider } from '@mui/material';
import { useState } from 'react';
import { formatMoney, formatQuantity, colorOf, formatSignedMoney } from '../../utils/format';
import { COLORS } from '@shared/constants';
import type { RebalanceResult } from '../../api/portfolio';

interface RebalancePanelProps {
  result: RebalanceResult | null;
  threshold: number;
  loading: boolean;
  onThresholdChange: (v: number) => void;
  onRecalc: () => void;
}

export default function RebalancePanel({ result, threshold, loading, onThresholdChange, onRecalc }: RebalancePanelProps) {
  const [input, setInput] = useState(String(threshold));
  const summary = result?.summary;

  return (
    <Paper variant="outlined" sx={{ p: 2, height: '100%' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
        <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
          ⚠ 再平衡提示
        </Typography>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Typography variant="caption" color="text.secondary">阈值</Typography>
          <TextField
            size="small"
            type="number"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onBlur={() => onThresholdChange(Number(input) || 5)}
            sx={{ width: 70 }}
            inputProps={{ min: 0, max: 50 }}
          />
          <Typography variant="caption">%</Typography>
          <Button size="small" variant="outlined" onClick={onRecalc} disabled={loading}>
            重新计算
          </Button>
        </Box>
      </Box>

      {summary && (
        <Box sx={{ mb: 1.5, p: 1, borderRadius: 1, bgcolor: 'action.hover', fontSize: 13 }}>
          <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
            <span>买入总额 <b style={{ color: COLORS.UP }}>¥{formatMoney(summary.buy_total)}</b></span>
            <span>卖出总额 <b style={{ color: COLORS.DOWN }}>¥{formatMoney(summary.sell_total)}</b></span>
            <span>可用现金 <b>¥{formatMoney(summary.cash_available)}</b></span>
          </Box>
          {!summary.balance_ok && (
            <Typography variant="body2" color="error" sx={{ mt: 0.5 }}>
              ⚠ 所需资金 ¥{formatMoney(summary.need_cash)} 超出可用现金，建议先卖出或补充资金
            </Typography>
          )}
          {summary.balance_ok && (
            <Typography variant="caption" color="success.main" sx={{ mt: 0.5, display: 'block' }}>
              买入/卖出总体平衡 ✓
            </Typography>
          )}
          {/* 取整对账：planned_* 是分摊前的类别缺口，与取整后实际额的差为整手取整残差 */}
          {(!!summary.rounding_residual_buy || !!summary.rounding_residual_sell) && (
            <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, display: 'block' }}>
              类别缺口合计 买 ¥{formatMoney(summary.planned_buy_total ?? 0)} / 卖 ¥{formatMoney(summary.planned_sell_total ?? 0)}，
              整手取整残差 买 ¥{formatMoney(summary.rounding_residual_buy ?? 0)} / 卖 ¥{formatMoney(summary.rounding_residual_sell ?? 0)}
            </Typography>
          )}
        </Box>
      )}

      {!result || result.items.length === 0 ? (
        <Typography variant="body2" color="text.secondary" sx={{ py: 2 }}>
          {loading ? '计算中…' : '当前无超阈值偏离，无需调仓（或先设置目标配置）'}
        </Typography>
      ) : (
        <Box sx={{ maxHeight: 340, overflowY: 'auto' }}>
          {result.items.map((it, i) => (
            <Box key={i} sx={{ mb: 1.5, p: 1.5, borderRadius: 1, border: '1px solid', borderColor: 'divider' }}>
              <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <Typography variant="body2" sx={{ fontWeight: 700 }}>
                  {it.action === 'BUY' ? '买入' : '卖出'} {it.code || (it.is_group_level ? '' : '现金')} {it.name}
                </Typography>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                  {/* code 维度下「目标已配置但尚未持有」的标的：标注建仓，与调仓区分 */}
                  {it.is_new_position && (
                    <Chip label="建仓" size="small" color="warning" variant="outlined" />
                  )}
                  <Chip
                    label={it.action}
                    size="small"
                    color={it.action === 'BUY' ? 'error' : 'success'}
                    variant={it.action === 'BUY' ? 'filled' : 'outlined'}
                  />
                </Box>
              </Box>
              {/*
                偏离一律展示分组（target_key）口径：当前占比取 group_current_pct，
                因为 target_pct 本身就是整个类别的目标，拿单行占比去比会误导用户。
              */}
              <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                {it.target_key ? `[${it.target_key}] ` : ''}
                类别偏离 {it.deviation_pct != null ? `${it.deviation_pct > 0 ? '+' : ''}${it.deviation_pct.toFixed(1)}pt` : '—'}
                （类别当前 {(it.group_current_pct ?? it.current_pct).toFixed(1)}% → 目标 {it.target_pct.toFixed(0)}%）
              </Typography>
              {/* 多行同类别时，标明本行只承担按市值等比分摊后的那一份 */}
              {!it.is_group_level && it.group_diff_value != null && Math.abs(it.group_diff_value - it.diff_value) > 1 && (
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                  本行占类别缺口 ¥{formatMoney(Math.abs(it.group_diff_value))} 中的 ¥{formatMoney(Math.abs(it.diff_value))}（按市值等比分摊）
                </Typography>
              )}
              <Typography variant="body2" sx={{ mt: 0.5 }}>
                建议 {it.is_new_position ? '建仓' : it.unit === '元' ? '调整' : it.action === 'BUY' ? '买入' : '卖出'}{' '}
                <b>{it.unit === '元' ? `¥${formatMoney(it.suggest_amount)}` : `${formatQuantity(it.suggest_shares)} ${it.unit}`}</b>
                {' '}约 ¥{formatMoney(it.suggest_amount)}
                {/* 建仓缺口不足 1 手时后端退回金额口径，明确提示原因，避免用户以为漏了股数 */}
                {it.is_new_position && it.unit === '元' && (
                  <Typography component="span" variant="caption" color="text.secondary">
                    {' '}（缺口不足 1 手，暂无法折算整手股数）
                  </Typography>
                )}
              </Typography>
            </Box>
          ))}
        </Box>
      )}
      <Divider sx={{ my: 1 }} />
      <Typography variant="caption" color="text.secondary">
        * A 股/场内基金按 100 股/份向下取整；场外基金按份保留 2 位；建议仅供参考
      </Typography>
    </Paper>
  );
}
