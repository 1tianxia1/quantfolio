// ============================================================
// 格式化工具：金额千分位/百分比/涨跌色/评分色
// 涨跌色唯一来源 shared/constants.js
// ============================================================
import { COLORS } from '@shared/constants';

/** 四舍五入到 n 位（先乘后除规避浮点误差） */
export function round(value: number | null | undefined, n = 2): number | null {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return null;
  const factor = 10 ** n;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

/** 千分位金额（先舍入后分隔） */
export function formatMoney(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
  const rounded = round(value, digits) ?? 0;
  const [intPart, decPart] = Math.abs(rounded).toFixed(digits).split('.');
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const sign = rounded < 0 ? '-' : '';
  return decPart ? `${sign}${grouped}.${decPart}` : `${sign}${grouped}`;
}

/** 带符号金额 */
export function formatSignedMoney(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
  const v = round(value, digits) ?? 0;
  const sign = v > 0 ? '+' : '';
  return `${sign}¥${formatMoney(Math.abs(v), digits)}`;
}

/** 百分比（带符号） */
export function formatPercent(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
  const v = round(value, digits) ?? 0;
  const sign = v > 0 ? '+' : '';
  return `${sign}${v.toFixed(digits)}%`;
}

/** 涨跌色：正红 / 负绿 / 平灰 */
export function colorOf(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return COLORS.FLAT;
  if (value > 0) return COLORS.UP;
  if (value < 0) return COLORS.DOWN;
  return COLORS.FLAT;
}

/** 评分色：≥80 红/强，60-80 橙，<60 灰 */
export function scoreColor(score: number | null | undefined): string {
  if (score === null || score === undefined) return COLORS.FLAT;
  if (score >= 80) return COLORS.UP;
  if (score >= 60) return '#FF8C00';
  return COLORS.FLAT;
}

/** 亿单位市值显示 */
export function formatYi(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
  return `${formatMoney(value, 1)}亿`;
}

/** 万元显示（资金流） */
export function formatWan(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
  return `${formatMoney(value, 0)}万`;
}

/** 数量显示（股/份千分位） */
export function formatQuantity(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
  return formatMoney(value, 0);
}
