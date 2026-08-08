// ============================================================
// 金额 / 百分比精度工具
// 约定：存储 round4、展示 round2；股数 A股 100 股一手向下取整（基金按份取整）
// 先求和后舍入，禁止逐项舍入再求和
// ============================================================

/** 四舍五入到 n 位小数（规避浮点误差：先乘 10^n 再除） */
export function round(value, n = 2) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return null;
  const factor = 10 ** n;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

/** 展示精度：round2 */
export function round2(value) {
  return round(value, 2);
}

/** 存储精度：round4 */
export function round4(value) {
  return round(value, 4);
}

/**
 * 股数取整规则：
 * - A 股 / 场内基金（ETF）：向下取整到 100 股/份
 * - 场外基金（offshore）：保留 2 位份
 * - 现金：不取整
 * @param {number} quantity 理论数量
 * @param {string} assetClass 资产类别
 * @param {boolean} isEtf 是否场内基金
 * @param {boolean} allowBreakLot 是否允许破整（清仓时 true）
 */
export function roundShares(quantity, assetClass = 'stock', isEtf = false, allowBreakLot = false) {
  if (quantity === null || quantity === undefined || Number.isNaN(Number(quantity))) return 0;
  const q = Math.max(0, Number(quantity));
  if (assetClass === 'cash') return round2(q);
  if (assetClass === 'fund' && !isEtf) return round2(q); // 场外基金按份保留 2 位
  if (allowBreakLot) return Math.floor(q);               // 清仓可破整（但仍为整数股）
  return Math.floor(q / 100) * 100;                      // A股/场内基金：100 向下取整
}

/**
 * 千分位格式化（金额展示）
 * @param {number} value
 * @param {number} digits 小数位（默认 2）
 */
export function formatThousands(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
  const rounded = round2(value);
  const [intPart, decPart] = Math.abs(rounded).toFixed(digits).split('.');
  const sign = rounded < 0 ? '-' : '';
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return decPart ? `${sign}${grouped}.${decPart}` : `${sign}${grouped}`;
}

/** 带符号百分比格式化（如 +12.69% / -3.20%） */
export function formatPercent(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
  const v = round2(value);
  const sign = v > 0 ? '+' : '';
  return `${sign}${v.toFixed(digits)}%`;
}

/** 带符号金额格式化（如 +¥96,420） */
export function formatSignedMoney(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
  const v = round2(value);
  const sign = v > 0 ? '+' : '';
  return `${sign}¥${formatThousands(Math.abs(v), digits)}`;
}
