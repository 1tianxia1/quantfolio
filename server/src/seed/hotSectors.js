// ============================================================
// hot_sectors 聚合（sector/industry 双维度）
// 成分股成交额加权平均涨幅；真实涨跌幅与 amount
// ============================================================

/**
 * 聚合热点板块
 * @param {import('../db/driver.js').Database} db
 * @param {Map<string, object[]>} barsByCode code -> 250 日 bars
 */
export function seedHotSectors(db, barsByCode) {
  const tx = db.transaction(() => {
    db.exec('DELETE FROM hot_sectors');
    // 取全部证券 + 末根行情
    const securities = db.all('SELECT code, name, sector, industry, type FROM securities');
    const tradeDate = db.get('SELECT MAX(trade_date) AS d FROM daily_quotes')?.d || '2026-08-07';

    // 分组聚合（成交额加权涨幅 + 涨幅最高成分股 + 主力净流入合计）
    const dims = ['sector', 'industry'];
    for (const dim of dims) {
      const groups = {};
      for (const sec of securities) {
        const key = sec[dim];
        if (!key) continue;
        const last = barsByCode.get(sec.code)?.[barsByCode.get(sec.code).length - 1];
        if (!last) continue;
        if (!groups[key]) groups[key] = { name: key, amount: 0, weighted: 0, maxPct: -Infinity, lead: sec.code, count: 0, inflow: 0 };
        const g = groups[key];
        const amount = last.amount || 0;
        const pct = last.pct_chg ?? 0;
        g.amount += amount;
        g.weighted += amount * pct;
        g.count += 1;
        if (pct > g.maxPct) { g.maxPct = pct; g.lead = sec.code; }
      }
      // 主力净流入合计（万元）
      const flows = db.all('SELECT code, main_net_inflow FROM money_flow');
      const flowMap = new Map(flows.map((f) => [f.code, f.main_net_inflow || 0]));
      for (const sec of securities) {
        const key = sec[dim];
        if (!key || !groups[key]) continue;
        groups[key].inflow += flowMap.get(sec.code) || 0;
      }

      const rows = Object.values(groups)
        .map((g) => ({
          ...g,
          pct: g.amount > 0 ? (g.weighted / g.amount) : 0,
        }))
        .sort((a, b) => b.pct - a.pct)
        .map((g, i) => ({ ...g, rank: i + 1 }));

      for (const r of rows) {
        db.run(
          `INSERT INTO hot_sectors (
             dimension, sector_name, trade_date, sector_pct_chg, hot_rank,
             leading_stock, stock_count, total_amount, total_main_inflow, data_origin
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'derived')`,
          [
            dim, r.name, tradeDate,
            Math.round(r.pct * 100) / 100, r.rank,
            r.lead, r.count,
            Math.round((r.amount / 1e8) * 100) / 100, // 元 -> 亿元
            Math.round(r.inflow * 100) / 100,
          ],
        );
      }
    }
  });
  tx();
}
