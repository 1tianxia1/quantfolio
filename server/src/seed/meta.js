// ============================================================
// meta_kv 数据来源/版本/合规信息
// ============================================================
import { SCHEMA_VERSION } from '../db/schema.js';

/**
 * 写入 meta_kv
 * @param {import('../db/driver.js').Database} db
 * @param {object} ctx { stockCount, fundCount, tradeDate }
 */
export function seedMeta(db, ctx) {
  const lineage = {
    securities: 'real+mixed（代码/名称/价格真实；PE/股息率部分真实、部分行业带派生）',
    daily_quotes: 'real(末根真实锚定)+derived(前249根确定性派生)',
    tech_indicators: 'derived（由派生K线计算）',
    money_flow: 'real(19只主力净流入真实)+derived(其余派生)',
    auction_data: 'derived（由派生K线open反推）',
    limit_records: 'real(21只真实涨停)+derived(涨幅达标补充)',
    hot_sectors: 'derived（按真实涨跌幅与成交额聚合）',
    holdings: 'demo（内置演示持仓，user_id=NULL）',
  };
  const kv = {
    seed_version: SCHEMA_VERSION,
    trade_date: ctx.tradeDate || '2026-08-07',
    stock_count: String(ctx.stockCount || 0),
    fund_count: String(ctx.fundCount || 0),
    lineage_json: JSON.stringify(lineage),
    compliance: '行情截至 2026-08-07 收盘，历史 K 线为模拟数据，最新价为真实行情',
  };
  db.exec('DELETE FROM meta_kv');
  for (const [k, v] of Object.entries(kv)) {
    db.run('INSERT OR REPLACE INTO meta_kv (k, v) VALUES (?, ?)', [k, v]);
  }
}
