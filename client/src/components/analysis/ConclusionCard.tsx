// ============================================================
// ConclusionCard：模块 A 量化分析结论卡片
// 买卖建议徽标 + view 徽标（乐观/中性/谨慎）+ 置信度 + 核心要点 + 风险 + degraded 警示
// 颜色：乐观=UP 色、谨慎=DOWN 色、中性=FLAT 色（唯一来源 COLORS）
// ============================================================
import { Alert, Box, Chip, LinearProgress, Typography, Stack } from '@mui/material';
import type { Conclusion } from '../../api/analysis';
import { COLORS } from '@shared/constants';

const VIEW_MAP: Record<string, { color: string; label: string }> = {
  乐观: { color: COLORS.UP, label: '乐观' },
  谨慎: { color: COLORS.DOWN, label: '谨慎' },
  中性: { color: COLORS.FLAT, label: '中性' },
};

/** 模块 A 买卖建议徽标 */
const ACTION_MAP: Record<string, { color: string; label: string; desc: string }> = {
  BUY: { color: COLORS.UP, label: '建议买入', desc: '综合基本面与消息面，当前偏积极' },
  SELL: { color: COLORS.DOWN, label: '建议卖出', desc: '综合风险与走弱信号，建议规避' },
  HOLD: { color: COLORS.FLAT, label: '建议持有观望', desc: '暂无明显方向，可继续持有观察' },
  WATCH: { color: '#ED6C02', label: '纳入观察', desc: '暂不操作，放入观察池等待信号' },
};

export default function ConclusionCard({ conclusion, degraded }: { conclusion: Conclusion; degraded: boolean }) {
  const view = VIEW_MAP[conclusion.view] || VIEW_MAP['中性'];
  const action = ACTION_MAP[conclusion.action] || ACTION_MAP['HOLD'];

  return (
    <Box>
      {degraded && (
        <Alert severity="warning" sx={{ mb: 1.5 }}>
          本次结论为降级规则版（AI 服务暂不可用或未能生成结构化结论），仅供参考。
        </Alert>
      )}

      {/* 买卖建议横幅：醒目、置顶 */}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1.5,
          flexWrap: 'wrap',
          bgcolor: action.color,
          color: '#fff',
          borderRadius: 2,
          px: 2,
          py: 1.25,
          mb: 1.5,
        }}
      >
        <Typography variant="subtitle1" sx={{ fontWeight: 800 }}>
          {action.label}
        </Typography>
        <Typography variant="caption" sx={{ opacity: 0.92 }}>
          {action.desc}
        </Typography>
        {conclusion.target_price && (
          <Chip size="small" sx={{ bgcolor: 'rgba(255,255,255,0.22)', color: '#fff', fontWeight: 700 }} label={`目标价 ${conclusion.target_price}`} />
        )}
        {conclusion.stop_loss && (
          <Chip size="small" sx={{ bgcolor: 'rgba(255,255,255,0.22)', color: '#fff', fontWeight: 700 }} label={`止损 ${conclusion.stop_loss}`} />
        )}
      </Box>

      <Stack direction="row" spacing={1.5} alignItems="center" sx={{ mb: 1.5, flexWrap: 'wrap' }}>
        <Chip label={view.label} sx={{ bgcolor: view.color, color: '#fff', fontWeight: 700 }} />
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 160 }}>
          <Typography variant="caption" color="text.secondary">置信度</Typography>
          <LinearProgress
            variant="determinate"
            value={conclusion.confidence}
            sx={{ flex: 1, '& .MuiLinearProgress-bar': { bgcolor: view.color } }}
          />
          <Typography variant="caption">{conclusion.confidence}%</Typography>
        </Box>
      </Stack>

      <Typography variant="body1" sx={{ fontWeight: 600, mb: 1.5 }}>
        {conclusion.summary}
      </Typography>

      {conclusion.key_points.length > 0 && (
        <Box sx={{ mb: 1.5 }}>
          <Typography variant="subtitle2" sx={{ mb: 0.5 }}>核心要点</Typography>
          <Stack spacing={0.5}>
            {conclusion.key_points.map((p, i) => (
              <Typography key={i} variant="body2" color="text.secondary">
                · {p}
              </Typography>
            ))}
          </Stack>
        </Box>
      )}

      {conclusion.risks.length > 0 && (
        <Box>
          <Typography variant="subtitle2" sx={{ mb: 0.5 }}>风险提示</Typography>
          <Stack spacing={0.5}>
            {conclusion.risks.map((p, i) => (
              <Typography key={i} variant="body2" sx={{ color: COLORS.DOWN }}>
                · {p}
              </Typography>
            ))}
          </Stack>
        </Box>
      )}
    </Box>
  );
}
