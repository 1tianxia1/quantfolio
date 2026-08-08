// ============================================================
// money_flow 派生（真实 19 只优先，单位万元）+ auction_data 反推
// 真实 mainNetInflow 单位元 -> 入库万元（÷10000）
// ============================================================
import { seededRandom } from '../util/rng.js';
import { round4 } from '../util/money.js';

/**
 * 生成资金流向（股票；基金不参与）
 * @param {import('../db/driver.js').Database} db
 * @param {object[]} items 清洗后的标的（stocks）
 * @param {Map<string, object[]>} barsByCode code -> 250 日 bars
 */
export function seedMoneyFlow(db, items, barsByCode) {
  const tx = db.transaction(() => {
    db.exec('DELETE FROM money_flow');
    for (const item of items) {
      const bars = barsByCode.get(item.code);
      const last = bars ? bars[bars.length - 1] : null;
      const tradeDate = last ? last.trade_date : '2026-08-07';
      const rng = seededRandom(item.code + ':flow');

      // 真实值优先（元 -> 万元）
      let main;
      let origin;
      if (item.mainNetInflow != null) {
        main = item.mainNetInflow / 10000;
        origin = 'real';
      } else {
        // 派生：[-8000, 12000] 万元，正负皆有
        main = rng.range(-8000, 12000);
        origin = 'derived';
      }
      const net3d = main * rng.range(0.5, 1.2);
      const net5d = main * rng.range(0.7, 1.5);

      db.run(
        `INSERT INTO money_flow (code, trade_date, main_net_inflow, net_inflow_3d, net_inflow_5d, data_origin)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [item.code, tradeDate, round4(main), round4(net3d), round4(net5d), origin],
      );
    }
  });
  tx();
}

/**
 * 生成竞价数据（由派生 K 线 open 反推）
 * auction_price = 末根 open；auction_pct = (open/pre_close-1)*100
 * @param {import('../db/driver.js').Database} db
 * @param {object[]} items 清洗后的标的（stocks + funds）
 * @param {Map<string, object[]>} barsByCode code -> 250 日 bars
 */
export function seedAuctionData(db, items, barsByCode) {
  const tx = db.transaction(() => {
    db.exec('DELETE FROM auction_data');
    for (const item of items) {
      const bars = barsByCode.get(item.code);
      if (!bars || bars.length < 2) continue;
      const last = bars[bars.length - 1];
      const prev = bars[bars.length - 2];
      const rng = seededRandom(item.code + ':auction');
      const tags = item.tags || [];

      const auctionPrice = last.open;
      const auctionPct = last.pre_close ? ((last.open / last.pre_close) - 1) * 100 : null;
      // 竞价量 = 当日量 × 1%~5%（模拟）
      const auctionVolume = last.volume * rng.range(0.01, 0.05);
      const auctionAmount = auctionVolume * auctionPrice;
      // 竞价量比（模拟 0.3~3.0，涨停股偏大）
      const auctionVolRatio = tags.includes('涨停') ? rng.range(1.2, 3.5) : rng.range(0.3, 3.0);
      // 首笔量比（≥2 视为爆量，约 40% 命中）
      const firstTradeVolRatio = rng.next() < 0.4 ? rng.range(2.0, 4.5) : rng.range(0.5, 2.0);

      db.run(
        `INSERT INTO auction_data (
           code, trade_date, auction_price, auction_pct, auction_volume, auction_amount,
           auction_vol_ratio, first_trade_vol_ratio, data_origin
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          item.code, last.trade_date,
          round4(auctionPrice), round4(auctionPct), round4(auctionVolume), round4(auctionAmount),
          round4(auctionVolRatio), round4(firstTradeVolRatio), 'derived',
        ],
      );
    }
  });
  tx();
}
