// ============================================================
// 全市场快照同步脚本
//
// 用途：修复「screener/pipeline 筛不出数据」——根因是 securities.circ_mv
//       等字段只有 77/36697 只有值（日 K 接口不返回市值/换手/量比/行业）。
//
// 执行内容：
//   1) 东财 clist 拉全市场 A 股 → 回填 securities + daily_quotes
//   2) 为新交易日增量重算 tech_indicators（否则 MA 全空，多头排列步骤必挂）
//   3) 为新交易日重算 auction_data（auction_pct 由真实 open/pre_close 计算；
//      量比类字段无真实数据源 → 留 NULL，不再用随机数编造）
//   4) 重算 hot_sectors
//
// 用法：
//   node scripts/sync-market-snapshot.mjs            # 全量
//   node scripts/sync-market-snapshot.mjs --no-derive # 只同步不重算派生表
// ============================================================
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import env from '../src/config/env.js';
import { openDatabase } from '../src/db/driver.js';
import { createMarketSnapshotService } from '../src/services/marketSnapshotService.js';
import { deriveFields } from '../src/seed/derivedFields.js';
import { computeIndicators } from '../src/seed/indicators.js';
import { seedHotSectors } from '../src/seed/hotSectors.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const noDerive = process.argv.includes('--no-derive');

const t0 = Date.now();
const el = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const log = (...a) => console.log(`[${el()}]`, ...a);

const db = await openDatabase(env.DB_PATH);
log(`DB 已打开：${env.DB_PATH}`);

// ---------- 1) 全市场快照 ----------
const svc = createMarketSnapshotService(db);
const stats = await svc.syncAShareSnapshot({ pageSize: 200, maxPages: 60 });
if (!stats.ok) {
  console.error('同步失败：', stats.reason);
  process.exit(1);
}
log('快照同步统计：', JSON.stringify({
  fetched: stats.fetched,
  upstreamTotal: stats.upstreamTotal,
  secWritten: stats.secWritten,
  dqWritten: stats.dqWritten,
  dqSkippedNoPrice: stats.dqSkippedNoPrice,
  tradeDates: stats.tradeDates,
}));

const newDate = Object.keys(stats.tradeDates).sort().pop();
if (!newDate) {
  console.error('未能确定交易日，终止派生重算');
  process.exit(1);
}
log(`本次快照交易日：${newDate}`);

if (noDerive) {
  log('--no-derive：跳过派生表重算');
  process.exit(0);
}

// ---------- 2) 增量重算 tech_indicators（仅新交易日）----------
// 只取本次快照覆盖到的 A 股，避免把 3 万只债券的历史也读进内存
log('载入 K 线历史用于指标重算…');
const codesRows = db.all(
  `SELECT DISTINCT code FROM daily_quotes WHERE trade_date = ?`, [newDate],
);
const codeSet = new Set(codesRows.map((r) => r.code));
log(`需重算 ${codeSet.size} 只标的`);

const barsByCode = new Map();
{
  const rows = db.all(
    `SELECT code, trade_date, open, high, low, close, pre_close, volume, amount,
            pct_chg, turnover_rate, volume_ratio, pe_ttm, pb, total_mv, circ_mv
     FROM daily_quotes ORDER BY code ASC, trade_date ASC`,
  );
  for (const r of rows) {
    if (!codeSet.has(r.code)) continue;
    let arr = barsByCode.get(r.code);
    if (!arr) { arr = []; barsByCode.set(r.code, arr); }
    arr.push(r);
  }
}
log(`载入完成：${barsByCode.size} 只 / ${[...barsByCode.values()].reduce((s, b) => s + b.length, 0)} 根`);

const IND_COLS = [
  'code', 'trade_date', 'ma5', 'ma10', 'ma20', 'ma60',
  'macd_dif', 'macd_dea', 'macd_bar', 'rsi6', 'rsi12', 'rsi24',
  'kdj_k', 'kdj_d', 'kdj_j', 'vol_ma5', 'vol_ratio_5', 'volume_streak',
  'high_60d_distance_pct', 'macd_gold_cross', 'macd_dead_cross', 'macd_positive',
  'macd_hist_turn_positive', 'kdj_gold_cross', 'kdj_dead_cross', 'ma_bullish',
  'ma_bearish', 'ma_above_20', 'ma_cross_above_5', 'indicator_hit', 'data_origin',
];
const indSql = `INSERT INTO tech_indicators (${IND_COLS.join(',')}) VALUES (${IND_COLS.map(() => '?').join(',')})`;

let indWritten = 0;
{
  const stmt = db.prepare(indSql);
  const tx = db.transaction(() => {
    db.run('DELETE FROM tech_indicators WHERE trade_date = ?', [newDate]);
    for (const [code, rawBars] of barsByCode) {
      const bars = deriveFields(rawBars);
      barsByCode.set(code, bars); // 复用给后续 auction / hot_sectors
      const rows = computeIndicators(bars);
      const row = rows.find((r) => r.trade_date === newDate);
      if (!row) continue;
      stmt.run(...IND_COLS.map((c) => {
        const v = row[c];
        if (c === 'data_origin') return 'derived';
        return v === undefined ? null : v;
      }));
      indWritten += 1;
    }
  });
  tx();
}
log(`tech_indicators 新增 ${indWritten} 行（trade_date=${newDate}）`);

// ---------- 3) 重算 auction_data（只用真实可算字段）----------
// auction_price / auction_pct 由真实 open、pre_close 得出；
// auction_vol_ratio / first_trade_vol_ratio 需要分时(1min)数据，
// 当前无真实数据源 → 一律 NULL。原实现用 seededRandom 随机生成这两个字段，
// 违反「不编造任何行情数值」红线，此处不再沿用。
let auctionWritten = 0;
{
  const stmt = db.prepare(
    `INSERT INTO auction_data (
       code, trade_date, auction_price, auction_pct, auction_volume, auction_amount,
       auction_vol_ratio, first_trade_vol_ratio, data_origin
     ) VALUES (?,?,?,?,?,?,?,?,?)`,
  );
  const tx = db.transaction(() => {
    db.run('DELETE FROM auction_data WHERE trade_date = ?', [newDate]);
    for (const [code, bars] of barsByCode) {
      const last = bars[bars.length - 1];
      if (!last || last.trade_date !== newDate) continue;
      if (last.open == null || last.pre_close == null || last.pre_close === 0) continue;
      const auctionPct = ((last.open / last.pre_close) - 1) * 100;
      stmt.run(
        code, newDate,
        Math.round(last.open * 10000) / 10000,
        Math.round(auctionPct * 10000) / 10000,
        null, null, null, null,
        'derived',
      );
      auctionWritten += 1;
    }
  });
  tx();
}
log(`auction_data 新增 ${auctionWritten} 行（真实竞价涨幅；量比类字段无数据源，留空）`);

// ---------- 4) 重算 hot_sectors ----------
try {
  seedHotSectors(db, barsByCode);
  const n = db.get('SELECT COUNT(*) AS n FROM hot_sectors')?.n ?? 0;
  log(`hot_sectors 重算完成，共 ${n} 行`);
} catch (e) {
  console.warn('hot_sectors 重算失败：', e.message);
}

// ---------- 5) 更新最新交易日 ----------
db.run(
  "INSERT INTO meta_kv(k,v) VALUES('trade_date',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v",
  [newDate],
);

log('全部完成');
process.exit(0);
