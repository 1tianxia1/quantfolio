// ============================================================
// 交易日历生成：跳过周六日 + 固定节假日表
// 派生 K 线 250 根 ≈ 350 自然日
// ============================================================

/** 固定节假日（2025-2027 中国 A 股休市日，YYYY-MM-DD） */
const HOLIDAYS = new Set([
  // 2025 元旦/春节/清明/劳动/端午/中秋/国庆
  '2025-01-01',
  '2025-01-28', '2025-01-29', '2025-01-30', '2025-01-31', '2025-02-03', '2025-02-04',
  '2025-04-04',
  '2025-05-01', '2025-05-02', '2025-05-05',
  '2025-05-31', '2025-06-02',
  '2025-10-01', '2025-10-02', '2025-10-03', '2025-10-06', '2025-10-07', '2025-10-08',
  // 2026 元旦/春节/清明/劳动/端午/中秋/国庆（按国务院公布的近似值）
  '2026-01-01', '2026-01-02',
  '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20', '2026-02-23', '2026-02-24',
  '2026-04-06',
  '2026-05-01',
  '2026-06-19',
  '2026-09-25',
  '2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09',
  // 2027 元旦/春节（部分）
  '2027-01-01',
  '2027-02-08', '2027-02-09', '2027-02-10', '2027-02-11', '2027-02-12', '2027-02-15', '2027-02-16',
]);

/** 是否为交易日（周一~周五且非节假日） */
export function isTradingDay(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const day = d.getUTCDay();
  if (day === 0 || day === 6) return false;
  return !HOLIDAYS.has(dateStr);
}

/** 日期字符串 + 偏移自然日 -> 日期字符串（YYYY-MM-DD） */
function addDays(dateStr, delta) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/**
 * 生成截至 endDate 的最近 n 个交易日（含 endDate，若 endDate 非交易日则向前取）
 * @param {string} endDate YYYY-MM-DD
 * @param {number} n 交易日数量
 * @returns {string[]} 升序交易日数组
 */
export function lastNTradingDays(endDate, n) {
  const out = [];
  let cur = endDate;
  let guard = 0;
  while (out.length < n && guard < n * 5 + 60) {
    if (isTradingDay(cur)) out.push(cur);
    cur = addDays(cur, -1);
    guard += 1;
  }
  return out.reverse();
}

/**
 * 生成截至 endDate 的最近 n 个交易日（从旧到新）
 * 与 lastNTradingDays 相同，语义别名更清晰
 */
export function generateTradingDates(endDate, n) {
  return lastNTradingDays(endDate, n);
}
