// ============================================================
// AllocationPanel：当前 vs 目标配置对比（缺口子弹条 + 维度切换）
// 设计目标：一眼看清「现在多少 / 目标多少 / 差多少 / 差多少钱」
//   · 蓝色实体 = 当前占比（与目标重叠的部分）
//   · 黄色竖线 = 目标位置
//   · 红色块   = 超配（当前 > 目标）
//   · 绿色虚框 = 欠配缺口（当前 < 目标）
// 配色唯一来源 shared/constants.js 的 COLORS（红涨绿跌）
// ============================================================
import { useMemo, useState } from 'react';
import { Box, Button, Chip, ToggleButton, ToggleButtonGroup, Tooltip, Typography } from '@mui/material';
import { alpha } from '@mui/material/styles';
import { ASSET_CLASS_LABEL, COLORS } from '@shared/constants';
import { formatMoney } from '../../utils/format';
import type { AllocationItem } from '../../api/portfolio';

const DIMENSIONS: { key: string; label: string }[] = [
  { key: 'asset_class', label: '资产类别' },
  { key: 'industry', label: '行业' },
  { key: 'code', label: '个股' },
];

/** 目标标记色（黄/橙），与红涨绿跌语义色区分开 */
const TARGET_COLOR = '#FFB020';
/** 默认展示行数，超出折叠 */
const DEFAULT_VISIBLE_ROWS = 8;
/** 视为「已达标」的偏离阈值（个百分点） */
const DEVIATION_EPS = 0.05;
/** 目标合计与 100% 的允许误差 */
const TARGET_SUM_TOLERANCE = 0.5;
/** 轨道高度（px） */
const TRACK_HEIGHT = 16;

/** 单行渲染所需的规范化数据 */
interface AllocationRow {
  /** 分组键（原始值，用作 React key） */
  key: string;
  /** 展示名（asset_class 维度翻译为中文） */
  label: string;
  /** 当前占比 0~100 */
  currentPct: number;
  /** 目标占比 0~100，未设置为 null */
  targetPct: number | null;
  /** 偏离 = 当前 − 目标（个百分点），无目标为 null */
  deviationPct: number | null;
  /** 该分组市值合计，缺失为 null */
  marketValue: number | null;
}

export interface AllocationPanelProps {
  dimension: string;
  allocation: AllocationItem[];
  onDimensionChange: (dim: string) => void;
  /** 可选：点击「设置目标」时回调（未传则不渲染按钮，保持既有调用方无需改动） */
  onOpenTarget?: () => void;
}

/** 限幅到 0~100 */
function clampPct(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

/** 分组键 → 展示名：资产类别维度翻译为中文，其余维度原样展示 */
function toLabel(dimension: string, key: string): string {
  if (!key) return '未分类';
  if (dimension === 'asset_class') return ASSET_CLASS_LABEL[key] || key;
  return key;
}

/** 把接口数据规范化为渲染行，并按「当前/目标的较大者」降序排列 */
function buildRows(dimension: string, allocation: AllocationItem[]): AllocationRow[] {
  return allocation
    .filter((a) => a.current_pct > 0 || (a.target_pct != null && a.target_pct > 0))
    .map((a) => {
      const currentPct: number = Number.isFinite(a.current_pct) ? a.current_pct : 0;
      const targetPct: number | null =
        a.target_pct != null && Number.isFinite(a.target_pct) ? a.target_pct : null;
      // 偏离优先取后端下发值（与再平衡同源），缺失时再按 当前−目标 兜底
      const deviationPct: number | null =
        a.deviation_pct != null && Number.isFinite(a.deviation_pct)
          ? a.deviation_pct
          : targetPct != null
            ? currentPct - targetPct
            : null;
      const marketValue: number | null =
        a.market_value != null && Number.isFinite(a.market_value) ? a.market_value : null;
      return { key: a.key, label: toLabel(dimension, a.key), currentPct, targetPct, deviationPct, marketValue };
    })
    .sort((x, y) => Math.max(y.currentPct, y.targetPct ?? 0) - Math.max(x.currentPct, x.targetPct ?? 0));
}

/**
 * 轨道满刻度：按最大值向上取整到 10 的倍数（下限 20%、上限 100%）。
 * 个股维度下单只占比很小，固定 0~100 会让所有条都挤成一条线。
 */
function computeAxisMax(rows: AllocationRow[]): number {
  const rawMax = rows.reduce((m, r) => Math.max(m, r.currentPct, r.targetPct ?? 0), 0);
  if (rawMax <= 0) return 100;
  return Math.min(100, Math.max(20, Math.ceil(rawMax / 10) * 10));
}

/** 偏离文案：+8.0pt / −5.0pt（pt = 百分点） */
function formatDeviation(dev: number): string {
  const sign = dev > 0 ? '+' : '';
  return `${sign}${dev.toFixed(1)}pt`;
}

/** 偏离取色：超配红 / 欠配绿 / 达标灰（沿用 A 股红涨绿跌语义） */
function deviationColor(dev: number | null): string {
  if (dev == null) return COLORS.FLAT;
  if (dev > DEVIATION_EPS) return COLORS.UP;
  if (dev < -DEVIATION_EPS) return COLORS.DOWN;
  return COLORS.FLAT;
}

/** 偏离状态文案 */
function deviationLabel(dev: number | null): string {
  if (dev == null) return '未设目标';
  if (dev > DEVIATION_EPS) return '超配';
  if (dev < -DEVIATION_EPS) return '欠配';
  return '达标';
}

/** 图例色块 */
function LegendSwatch({ color, label, shape = 'block' }: { color: string; label: string; shape?: 'block' | 'line' }) {
  return (
    <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
      <Box
        sx={{
          width: shape === 'line' ? 3 : 12,
          height: shape === 'line' ? 12 : 10,
          borderRadius: 0.5,
          bgcolor: color,
          flexShrink: 0,
        }}
      />
      <Typography variant="caption" color="text.secondary">
        {label}
      </Typography>
    </Box>
  );
}

export default function AllocationPanel({
  dimension,
  allocation,
  onDimensionChange,
  onOpenTarget,
}: AllocationPanelProps) {
  // 记录「在哪个维度下展开了全部」，切换维度自动收起，无需 useEffect
  const [expandedDim, setExpandedDim] = useState<string | null>(null);
  const expanded: boolean = expandedDim === dimension;

  const rows: AllocationRow[] = useMemo(() => buildRows(dimension, allocation), [dimension, allocation]);
  const axisMax: number = useMemo(() => computeAxisMax(rows), [rows]);

  const targetRows: AllocationRow[] = rows.filter((r) => r.targetPct != null);
  // 全部为 null 或 0 视为「未设置目标」（与需求口径一致）
  const hasTarget: boolean = rows.some((r) => r.targetPct != null && r.targetPct > 0);
  const targetSum: number = targetRows.reduce((s, r) => s + (r.targetPct ?? 0), 0);
  const currentSum: number = rows.reduce((s, r) => s + r.currentPct, 0);
  const totalValue: number = rows.reduce((s, r) => s + (r.marketValue ?? 0), 0);

  // 偏离最大的一行（用于顶部摘要，绝对值口径）
  const worstRow: AllocationRow | null = targetRows.reduce<AllocationRow | null>((worst, r) => {
    if (r.deviationPct == null) return worst;
    if (worst == null || worst.deviationPct == null) return r;
    return Math.abs(r.deviationPct) > Math.abs(worst.deviationPct) ? r : worst;
  }, null);

  const visibleRows: AllocationRow[] = expanded ? rows : rows.slice(0, DEFAULT_VISIBLE_ROWS);
  const hiddenCount: number = rows.length - visibleRows.length;

  /** 数值 → 轨道内百分比宽度（相对满刻度 axisMax） */
  const toTrackPct = (value: number): string => `${Math.min(100, (clampPct(value) / axisMax) * 100)}%`;

  return (
    <Box>
      {/* 头部：标题 + 维度切换 */}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: 1,
          mb: 1,
        }}
      >
        <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
          资产配置对比
        </Typography>
        <ToggleButtonGroup
          size="small"
          exclusive
          value={dimension}
          onChange={(_e, v: string | null) => v && onDimensionChange(v)}
        >
          {DIMENSIONS.map((d) => (
            <ToggleButton key={d.key} value={d.key}>
              {d.label}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
      </Box>

      {rows.length === 0 ? (
        <Typography variant="body2" color="text.secondary" sx={{ py: 3, textAlign: 'center' }}>
          暂无持仓数据，请先「添加持仓」或「导入CSV」
        </Typography>
      ) : (
        <>
          {/* 未设目标：顶部醒目引导 */}
          {!hasTarget && (
            <Box
              sx={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                flexWrap: 'wrap',
                gap: 1,
                mb: 1.25,
                px: 1.25,
                py: 1,
                borderRadius: 1,
                border: '1px solid',
                borderColor: alpha(TARGET_COLOR, 0.45),
                bgcolor: alpha(TARGET_COLOR, 0.1),
              }}
            >
              <Typography variant="body2" sx={{ color: 'text.primary' }}>
                未设置目标配置，点击右上角「目标配置」按钮进行设置，设置后即可看到偏离与再平衡建议
              </Typography>
              {onOpenTarget && (
                <Button size="small" variant="outlined" color="warning" onClick={onOpenTarget}>
                  设置目标
                </Button>
              )}
            </Box>
          )}

          {/* 已设目标：摘要指标 */}
          {hasTarget && (
            <Box sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 1, mb: 1.25 }}>
              <Chip size="small" variant="outlined" label={`已设目标 ${targetRows.length}/${rows.length} 项`} />
              <Chip
                size="small"
                variant="outlined"
                color={Math.abs(targetSum - 100) > TARGET_SUM_TOLERANCE ? 'warning' : 'default'}
                label={`目标合计 ${targetSum.toFixed(1)}%`}
              />
              {worstRow && worstRow.deviationPct != null && (
                <Chip
                  size="small"
                  variant="outlined"
                  label={`最大偏离 ${worstRow.label} ${formatDeviation(worstRow.deviationPct)}`}
                  sx={{ color: deviationColor(worstRow.deviationPct), borderColor: alpha(deviationColor(worstRow.deviationPct), 0.5) }}
                />
              )}
            </Box>
          )}

          {/* 图例 */}
          <Box sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 1.5, mb: 1.25 }}>
            <LegendSwatch color={COLORS.PRIMARY} label="当前占比" />
            <LegendSwatch color={TARGET_COLOR} label="目标位置" shape="line" />
            <LegendSwatch color={alpha(COLORS.UP, 0.55)} label="超配" />
            <LegendSwatch color={alpha(COLORS.DOWN, 0.28)} label="欠配缺口" />
          </Box>

          {/* 逐行子弹条：一行一个分组，天然单列，xs 下自动堆叠 */}
          <Box>
            {visibleRows.map((row) => {
              const cur: number = clampPct(row.currentPct);
              const tgt: number | null = row.targetPct != null ? clampPct(row.targetPct) : null;
              const base: number = tgt == null ? cur : Math.min(cur, tgt);
              const overPct: number = tgt != null && cur > tgt ? cur - tgt : 0;
              const gapPct: number = tgt != null && cur < tgt ? tgt - cur : 0;
              const devColor: string = deviationColor(row.deviationPct);
              const isEmptyPosition: boolean = cur <= 0 && tgt != null && tgt > 0;

              return (
                <Box key={row.key} sx={{ mb: 1.5 }}>
                  {/* 第一行：名称 + 当前/目标/偏离/市值 */}
                  <Box
                    sx={{
                      display: 'flex',
                      alignItems: 'baseline',
                      justifyContent: 'space-between',
                      flexWrap: 'wrap',
                      gap: 0.75,
                    }}
                  >
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, minWidth: 0 }}>
                      <Typography
                        variant="body2"
                        sx={{
                          fontWeight: 600,
                          maxWidth: { xs: 160, sm: 220 },
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                        title={row.label}
                      >
                        {row.label}
                      </Typography>
                      {isEmptyPosition && <Chip size="small" variant="outlined" color="warning" label="未持有" />}
                    </Box>

                    <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1, flexWrap: 'wrap' }}>
                      <Typography
                        component="span"
                        variant="body2"
                        sx={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}
                      >
                        {row.currentPct.toFixed(1)}%
                      </Typography>
                      <Typography component="span" variant="caption" color="text.secondary">
                        目标 {row.targetPct != null ? `${row.targetPct.toFixed(1)}%` : '—'}
                      </Typography>
                      <Typography
                        component="span"
                        variant="caption"
                        sx={{ color: devColor, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}
                      >
                        {row.deviationPct != null
                          ? `${deviationLabel(row.deviationPct)} ${formatDeviation(row.deviationPct)}`
                          : '未设目标'}
                      </Typography>
                      {row.marketValue != null && (
                        <Typography
                          component="span"
                          variant="caption"
                          color="text.secondary"
                          sx={{ fontVariantNumeric: 'tabular-nums' }}
                        >
                          ¥{formatMoney(row.marketValue, 0)}
                        </Typography>
                      )}
                    </Box>
                  </Box>

                  {/* 第二行：轨道 */}
                  <Tooltip
                    arrow
                    placement="top"
                    title={
                      <Box sx={{ fontSize: 12, lineHeight: 1.7 }}>
                        <div>{row.label}</div>
                        <div>
                          当前 {row.currentPct.toFixed(2)}%
                          {row.marketValue != null ? `（¥${formatMoney(row.marketValue, 2)}）` : ''}
                        </div>
                        <div>目标 {row.targetPct != null ? `${row.targetPct.toFixed(2)}%` : '未设置'}</div>
                        <div>
                          偏离{' '}
                          {row.deviationPct != null
                            ? `${formatDeviation(row.deviationPct)}（${deviationLabel(row.deviationPct)}）`
                            : '—'}
                        </div>
                      </Box>
                    }
                  >
                    <Box
                      sx={{
                        position: 'relative',
                        height: TRACK_HEIGHT,
                        mt: 0.5,
                        borderRadius: 1,
                        bgcolor: 'action.hover',
                      }}
                    >
                      {/* 1/4 刻度线 */}
                      {[25, 50, 75].map((t) => (
                        <Box
                          key={t}
                          sx={{
                            position: 'absolute',
                            left: `${t}%`,
                            top: 2,
                            bottom: 2,
                            width: '1px',
                            bgcolor: 'divider',
                            opacity: 0.6,
                          }}
                        />
                      ))}

                      {/* 当前占比（与目标重叠部分） */}
                      <Box
                        sx={{
                          position: 'absolute',
                          left: 0,
                          top: 0,
                          bottom: 0,
                          width: toTrackPct(base),
                          borderRadius: 1,
                          bgcolor: COLORS.PRIMARY,
                        }}
                      />

                      {/* 超配区：目标 → 当前 */}
                      {overPct > 0 && tgt != null && (
                        <Box
                          sx={{
                            position: 'absolute',
                            left: toTrackPct(tgt),
                            top: 0,
                            bottom: 0,
                            width: toTrackPct(overPct),
                            borderRadius: 1,
                            bgcolor: alpha(COLORS.UP, 0.55),
                          }}
                        />
                      )}

                      {/* 欠配缺口：当前 → 目标 */}
                      {gapPct > 0 && (
                        <Box
                          sx={{
                            position: 'absolute',
                            left: toTrackPct(cur),
                            top: 0,
                            bottom: 0,
                            width: toTrackPct(gapPct),
                            borderRadius: 1,
                            boxSizing: 'border-box',
                            bgcolor: alpha(COLORS.DOWN, 0.18),
                            border: `1px dashed ${alpha(COLORS.DOWN, 0.7)}`,
                          }}
                        />
                      )}

                      {/* 目标标记线 */}
                      {tgt != null && (
                        <Box
                          sx={{
                            position: 'absolute',
                            left: toTrackPct(tgt),
                            top: -3,
                            bottom: -3,
                            ml: '-1.5px',
                            width: 3,
                            borderRadius: 0.5,
                            bgcolor: TARGET_COLOR,
                          }}
                        />
                      )}
                    </Box>
                  </Tooltip>
                </Box>
              );
            })}
          </Box>

          {/* 折叠/展开 */}
          {(hiddenCount > 0 || expanded) && (
            <Box sx={{ textAlign: 'center', mt: 0.5 }}>
              <Button size="small" onClick={() => setExpandedDim(expanded ? null : dimension)}>
                {expanded ? '收起' : `展开全部 ${rows.length} 项`}
              </Button>
            </Box>
          )}

          {/* 底部口径说明 */}
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
            轨道满刻度 {axisMax}%（浅色为 1/4 刻度线）· 当前合计 {currentSum.toFixed(1)}%
            {hasTarget ? ` · 目标合计 ${targetSum.toFixed(1)}%` : ''}
            {totalValue > 0 ? ` · 总市值 ¥${formatMoney(totalValue, 0)}` : ''}
            · pt = 百分点，偏离 = 当前 − 目标
          </Typography>
          {hasTarget && Math.abs(targetSum - 100) > TARGET_SUM_TOLERANCE && (
            <Typography variant="caption" color="warning.main" sx={{ display: 'block', mt: 0.25 }}>
              ⚠ 目标合计为 {targetSum.toFixed(1)}%，不等于 100%，再平衡结果可能失真，建议调整目标配置
            </Typography>
          )}
        </>
      )}
    </Box>
  );
}
