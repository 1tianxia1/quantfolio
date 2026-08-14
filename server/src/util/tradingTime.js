// ============================================================
// 交易时间公共模块（北京时间口径）
//
// 背景：此前交易时段判断散落在 intradayPoller / 前端 realtimeStore 等处，
//   且只认 9:30–11:30 / 13:00–15:00，集合竞价（9:15–9:25）完全没有概念，
//   导致竞价时段拿不到任何行情。本模块统一提供：
//     · isMarketOpen()      连续竞价时段（9:30–11:30 / 13:00–15:00）
//     · isAuctionWindow()   集合竞价时段（9:15–9:25，含 9:25 定格点前）
//     · isPostAuction()     9:25 定格后 ~ 9:30 开盘前（竞价结果已出）
//     · beijingToday()      北京时间 yyyy-MM-dd
//
// 限制：与旧实现一致，仅排除周末，不感知法定节假日（节假日轮询会自然
//   拿到前一交易日数据，无害；如需精确可后续接入交易日历表）。
// ============================================================

const BEIJING_OFFSET_MS = 8 * 3600000;

/**
 * 当前北京时间信息
 * @param {Date} [now] 可注入时钟（单测用）
 * @returns {{ day: number, minutes: number, dateStr: string }}
 *   day: 0=周日 … 6=周六；minutes: 当日分钟数（如 9:30 → 570）；dateStr: yyyy-MM-dd
 */
export function beijingInfo(now = new Date()) {
  const beijing = new Date(now.getTime() + BEIJING_OFFSET_MS);
  return {
    day: beijing.getUTCDay(),
    minutes: beijing.getUTCHours() * 60 + beijing.getUTCMinutes(),
    dateStr: beijing.toISOString().slice(0, 10),
  };
}

/** 北京时间 yyyy-MM-dd 字符串 */
export function beijingToday(now = new Date()) {
  return beijingInfo(now).dateStr;
}

/** 是否周末（北京时间） */
function isWeekend(now) {
  const day = beijingInfo(now).day;
  return day === 0 || day === 6;
}

/**
 * 是否在 A 股连续竞价时段（北京时间周一~周五 09:30–11:30 / 13:00–15:00）
 * @param {Date} [now]
 * @returns {boolean}
 */
export function isMarketOpen(now = new Date()) {
  if (isWeekend(now)) return false;
  const t = beijingInfo(now).minutes;
  return (t >= 9 * 60 + 30 && t <= 11 * 60 + 30) || (t >= 13 * 60 && t <= 15 * 60);
}

/**
 * 是否在集合竞价时段（北京时间周一~周五 09:15–09:25）
 * 此时段东财/腾讯实时源已能返回竞价匹配价（虚拟成交），延迟镜像源拿不到。
 * @param {Date} [now]
 * @returns {boolean}
 */
export function isAuctionWindow(now = new Date()) {
  if (isWeekend(now)) return false;
  const t = beijingInfo(now).minutes;
  return t >= 9 * 60 + 15 && t < 9 * 60 + 25;
}

/**
 * 是否在竞价定格后、开盘前（09:25–09:30）
 * 开盘价/竞价量已确定，是采集最终竞价结果的窗口。
 * @param {Date} [now]
 * @returns {boolean}
 */
export function isPostAuction(now = new Date()) {
  if (isWeekend(now)) return false;
  const t = beijingInfo(now).minutes;
  return t >= 9 * 60 + 25 && t < 9 * 60 + 30;
}

/** 是否交易日（当前实现仅排除周末，见文件头说明） */
export function isTradingDay(now = new Date()) {
  return !isWeekend(now);
}
