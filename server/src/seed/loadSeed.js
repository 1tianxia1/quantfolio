// ============================================================
// 读 data/seed-market.json + 字段清洗
// ============================================================
import fs from 'node:fs';
import env from '../config/env.js';

/**
 * 加载并清洗种子行情数据
 * @returns {{ meta: object, stocks: object[], funds: object[] }}
 */
export function loadSeedData() {
  const raw = fs.readFileSync(env.SEED_DATA_PATH, 'utf-8');
  const data = JSON.parse(raw);
  if (!data.meta || !Array.isArray(data.stocks) || !Array.isArray(data.funds)) {
    throw new Error('seed-market.json 结构不合法：缺少 meta/stocks/funds');
  }

  const cleanNum = (v) => (v === undefined || v === null || Number.isNaN(Number(v)) ? null : Number(v));

  // 清洗单只标的
  function cleanItem(item, type) {
    const out = { ...item };
    out.type = type;
    out.price = cleanNum(item.price);
    out.changePct = cleanNum(item.changePct);
    out.turnoverRate = cleanNum(item.turnoverRate);
    out.circMarketCap = cleanNum(item.circMarketCap);
    out.amount = cleanNum(item.amount);
    out.pe = cleanNum(item.pe);
    out.dividendYield = cleanNum(item.dividendYield);
    out.mainNetInflow = cleanNum(item.mainNetInflow);
    out.isST = !!item.isST;
    out.tags = Array.isArray(item.tags) ? item.tags : [];
    // market: 0=深交所 1=上交所 2=北交所
    out.marketCode = item.market;
    return out;
  }

  return {
    meta: data.meta,
    stocks: data.stocks.map((s) => cleanItem(s, 'stock')),
    funds: data.funds.map((f) => cleanItem(f, 'fund')),
  };
}
