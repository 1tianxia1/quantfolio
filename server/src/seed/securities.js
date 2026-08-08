// ============================================================
// 写 securities + security_tags + 派生 list_date/float_share/
// total_share/pe/pb/dividend_yield（真实值优先，其余确定性派生）
// ============================================================
import { seededRandom } from '../util/rng.js';
import { round4 } from '../util/money.js';

/** 市场代码映射：0=深 1=沪 2=北 */
export function marketCodeToLabel(code) {
  if (code === 0) return 'SZ';
  if (code === 1) return 'SH';
  if (code === 2) return 'BJ';
  return 'SH';
}

/** 板块与涨跌停幅推断 */
export function inferBoard(item) {
  const code = item.code;
  const name = item.name || '';
  const isST = item.isST || /^ST/i.test(name) || /ST$/.test(name);
  if (item.type === 'fund') return { board: 'ETF', priceLimit: 10, isST: false };
  let board = 'SZ-Main10';
  let priceLimit = 10;
  if (/^688/.test(code) || /^689/.test(code)) { board = 'STAR20'; priceLimit = 20; }
  else if (/^300/.test(code) || /^301/.test(code)) { board = 'ChiNext20'; priceLimit = 20; }
  else if (/^8/.test(code) || /^4/.test(code) || /^920/.test(code)) { board = 'BSE30'; priceLimit = 30; }
  else if (/^60/.test(code)) { board = 'SH-Main10'; priceLimit = 10; }
  else if (/^000/.test(code) || /^001/.test(code) || /^002/.test(code) || /^003/.test(code)) { board = 'SZ-Main10'; priceLimit = 10; }
  if (isST) priceLimit = 5;
  return { board, priceLimit, isST };
}

/** 行业 PE 派生带（确定性） */
const INDUSTRY_PE_BANDS = {
  银行: [4, 7], 保险: [6, 12], 非银金融: [8, 18], 食品饮料: [15, 35],
  医药生物: [18, 45], 电子: [25, 60], 电子元件: [25, 60], 半导体: [40, 90],
  通信设备: [25, 60], 有色金属: [15, 40], 基础化工: [12, 35], 建筑材料: [10, 28],
  电力设备: [20, 50], 机械设备: [15, 40], 国防军工: [30, 70], 汽车: [12, 30],
  家用电器: [10, 25], 交通运输: [10, 25], 公用事业: [10, 25], 传媒: [15, 40],
  建筑装饰: [6, 15], 其他: [10, 40],
};

/**
 * 写入证券主表与标签表
 * @param {import('../db/driver.js').Database} db
 * @param {object} data loadSeedData() 结果
 * @returns {{ stocks: object[], funds: object[] }} 返回清洗后的标的（供后续管线使用）
 */
export function seedSecurities(db, data) {
  const items = [...data.stocks, ...data.funds];
  // 重跑时先关外键，避免子表旧数据引用旧 securities 导致删除失败
  db.exec('PRAGMA foreign_keys=OFF');
  const tx = db.transaction(() => {
    // 子表优先删除（保持可重跑）
    db.exec(`DELETE FROM security_tags; DELETE FROM daily_quotes; DELETE FROM tech_indicators;
             DELETE FROM money_flow; DELETE FROM auction_data; DELETE FROM limit_records;
             DELETE FROM hot_sectors; DELETE FROM holdings; DELETE FROM target_allocations;
             DELETE FROM user_settings; DELETE FROM strategies; DELETE FROM ai_reports;
             DELETE FROM watchlist; DELETE FROM meta_kv;
             DELETE FROM securities;
             DELETE FROM sqlite_sequence WHERE name IN ('securities','security_tags','limit_records','hot_sectors','holdings','target_allocations','strategies','ai_reports','watchlist')`);
    for (const item of items) {
      const { board, priceLimit, isST } = inferBoard(item);
      const rng = seededRandom(item.code);
      const isFund = item.type === 'fund';
      const realPe = item.pe != null && !Number.isNaN(Number(item.pe));
      const realDiv = item.dividendYield != null && !Number.isNaN(Number(item.dividendYield));

      // ---- 派生字段 ----
      // 上市天数：次新股 → 20~200 日，否则 400~7000 日
      let listDays;
      if (item.tags.includes('次新股')) listDays = rng.int(20, 200);
      else listDays = rng.int(400, 7000);
      const listDate = calcListDate(listDays);

      // 流通市值（亿元）
      const circMvYi = item.circMarketCap != null ? item.circMarketCap / 1e8 : null;
      // 流通股 = 流通市值(元) / 价格
      const floatShare = item.circMarketCap != null && item.price ? item.circMarketCap / item.price : null;
      // 流通比例（股票 0.5~1.0，基金 1.0）
      const floatRatio = isFund ? 1.0 : rng.range(0.5, 1.0);
      const totalShare = floatShare != null ? floatShare / floatRatio : null;
      const totalMvYi = circMvYi != null ? circMvYi / floatRatio : null;

      // PE：真实优先，否则行业带派生
      let pe = null;
      if (realPe) pe = item.pe;
      else if (item.industry && INDUSTRY_PE_BANDS[item.industry]) {
        const [lo, hi] = INDUSTRY_PE_BANDS[item.industry];
        pe = round4(rng.range(lo, hi));
      } else {
        pe = round4(rng.range(10, 40));
      }

      // PB：由 PE 与 ROE 假设派生（pb ≈ pe × roe）
      const roe = rng.range(0.06, 0.22);
      const pb = pe != null ? round4(pe * roe) : round4(rng.range(1, 8));

      // 股息率：真实值小数 ×100 变百分比；否则派生
      const dividendYield = realDiv ? round4(item.dividendYield * 100) : round4(rng.range(0, 4));

      // 指数成分
      const isIndexMember = item.index ? 1 : 0;

      // 数据来源
      const dataOrigin = isFund ? 'real' : (realPe || realDiv ? 'mixed' : 'mixed');

      db.run(
        `INSERT INTO securities (
           code, name, market, type, board, price_limit_pct, industry, sector,
           list_date, is_st, is_index_member, index_name,
           float_share, total_share, circ_mv, total_mv,
           pe_ttm, pb, dividend_yield, fund_category, fund_track, data_origin
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          item.code, item.name, marketCodeToLabel(item.marketCode), item.type, board, priceLimit,
          item.industry || null, item.sector || null,
          listDate, isST ? 1 : 0, isIndexMember, item.index || null,
          round4(floatShare), round4(totalShare), round4(circMvYi), round4(totalMvYi),
          round4(pe), round4(pb), dividendYield,
          isFund ? (item.category || null) : null,
          isFund ? (item.track || null) : null,
          dataOrigin,
        ],
      );

      // 真实形态标签（双通道之一）
      for (const tag of item.tags) {
        db.run('INSERT OR IGNORE INTO security_tags (code, tag, data_origin) VALUES (?, ?, ?)', [item.code, tag, 'real']);
      }
    }
  });
  tx();
  db.exec('PRAGMA foreign_keys=ON');

  return {
    stocks: data.stocks,
    funds: data.funds,
  };
}

/** 由上市天数反推上市日期（相对 2026-08-07） */
function calcListDate(listDays) {
  const d = new Date('2026-08-07T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - listDays);
  return d.toISOString().slice(0, 10);
}
