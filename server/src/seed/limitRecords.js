// ============================================================
// limit_records 导入（21 只真实）+ 补充派生涨停记录
// ============================================================
import { inferBoard } from './securities.js';

/**
 * 写入涨停/连板记录
 * @param {import('../db/driver.js').Database} db
 * @param {object[]} items 清洗后的标的（stocks + funds）
 * @param {Map<string, object[]>} barsByCode code -> 250 日 bars
 */
export function seedLimitRecords(db, items, barsByCode) {
  const tx = db.transaction(() => {
    const codes = items.map((i) => i.code);
    if (codes.length) db.deleteByCodes('limit_records', codes);
    else db.exec('DELETE FROM limit_records');
    let realCount = 0;
    let derivedCount = 0;

    for (const item of items) {
      if (item.type !== 'stock') continue;
      const bars = barsByCode.get(item.code);
      const tradeDate = bars ? bars[bars.length - 1].trade_date : '2026-08-07';
      const { priceLimit } = inferBoard(item);

      // 真实涨停记录
      if (item.limitUp && item.limitUp.days != null) {
        db.run(
          `INSERT INTO limit_records (
             code, trade_date, limit_type, limit_up_streak, pattern, reason,
             seal_amount, first_limit_time, open_times, data_origin
           ) VALUES (?, ?, 'limit_up', ?, ?, ?, ?, ?, ?, 'real')`,
          [
            item.code, tradeDate,
            item.limitUp.days || 1,
            item.limitUp.pattern || null,
            item.limitUp.reason || null,
            item.limitUp.sealAmount ?? null,
            item.limitUp.firstTime ?? null,
            item.limitUp.openTimes ?? null,
          ],
        );
        realCount += 1;
        continue;
      }

      // 补充派生涨停：涨幅 ≥ 涨跌停幅（-0.01 容差）
      if (item.changePct != null && item.changePct >= priceLimit - 0.01) {
        db.run(
          `INSERT INTO limit_records (
             code, trade_date, limit_type, limit_up_streak, pattern, reason,
             seal_amount, first_limit_time, open_times, data_origin
           ) VALUES (?, ?, 'limit_up', 1, '1天1板', NULL, NULL, NULL, NULL, 'derived')`,
          [item.code, tradeDate],
        );
        derivedCount += 1;
      }
    }

    return { realCount, derivedCount };
  });
  return tx();
}
