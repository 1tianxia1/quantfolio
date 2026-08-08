// ============================================================
// 从通达信连接器批量灌入真实日行情到本地库（data_origin='real'）
//
// 上游：tdx-bridge/quote_sync.py 把每只股票的日 K 线 + 技术指标
//       导出为 scripts/_tdx_import/quotes.json：
//         [ { code, bars:[{date,open,high,low,close,volume,amount,pct_chg,pre_close}],
//             indicators:[{ma5,ma10,ma20,ma60,macd_dif,...,indicator_hit}] }, ... ]
//
// 用法: node scripts/import-tdx-quotes.mjs [quotesJson]
// 幂等：ON CONFLICT(code,trade_date) DO UPDATE，可重复运行。
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../server/src/db/driver.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const quotesFile = process.argv[2] || path.resolve(__dirname, '_tdx_import', 'quotes.json');
const DB_PATH = process.env.DB_PATH || path.resolve(projectRoot, 'server/data/quantfolio.db');

const DQ_COLS = [
  'code', 'trade_date', 'open', 'high', 'low', 'close', 'pre_close', 'volume', 'amount',
  'pct_chg', 'turnover_rate', 'volume_ratio', 'pe_ttm', 'pb', 'total_mv', 'circ_mv', 'data_origin',
];
const TI_COLS = [
  'code', 'trade_date', 'ma5', 'ma10', 'ma20', 'ma60', 'macd_dif', 'macd_dea', 'macd_bar',
  'rsi6', 'rsi12', 'rsi24', 'kdj_k', 'kdj_d', 'kdj_j', 'vol_ma5', 'vol_ratio_5',
  'volume_streak', 'high_60d_distance_pct', 'macd_gold_cross', 'macd_dead_cross',
  'macd_positive', 'macd_hist_turn_positive', 'kdj_gold_cross', 'kdj_dead_cross',
  'ma_bullish', 'ma_bearish', 'ma_above_20', 'ma_cross_above_5', 'indicator_hit', 'data_origin',
];

function placeholders(cols) {
  return cols.map(() => '?').join(',');
}
function updateSet(cols, skip = ['code', 'trade_date']) {
  return cols.filter((c) => !skip.includes(c)).map((c) => `${c}=excluded.${c}`).join(',');
}

function rowToValues(cols, row) {
  return cols.map((c) => (row[c] === undefined ? null : row[c]));
}

async function main() {
  if (!fs.existsSync(quotesFile)) {
    console.error(`quotes 文件不存在: ${quotesFile}`);
    process.exit(1);
  }
  const records = JSON.parse(fs.readFileSync(quotesFile, 'utf-8'));
  const db = await openDatabase(DB_PATH);

  const dqSql = `INSERT INTO daily_quotes (${DQ_COLS.join(',')}) VALUES (${placeholders(DQ_COLS)}) ` +
    `ON CONFLICT(code,trade_date) DO UPDATE SET ${updateSet(DQ_COLS)}`;
  const tiSql = `INSERT INTO tech_indicators (${TI_COLS.join(',')}) VALUES (${placeholders(TI_COLS)}) ` +
    `ON CONFLICT(code,trade_date) DO UPDATE SET ${updateSet(TI_COLS)}`;

  const dqStmt = db.prepare(dqSql);
  const tiStmt = db.prepare(tiSql);

  let nCodes = 0;
  let nDq = 0;
  let nTi = 0;
  const tx = db.transaction(() => {
    for (const rec of records) {
      const bars = rec.bars || [];
      const indicators = rec.indicators || [];
      if (!bars.length) continue;
      nCodes++;
      for (let i = 0; i < bars.length; i++) {
        const b = bars[i];
        const dqRow = {
          code: String(rec.code),
          trade_date: String(b.date).slice(0, 10),
          open: b.open ?? null,
          high: b.high ?? null,
          low: b.low ?? null,
          close: b.close ?? null,
          pre_close: b.pre_close ?? null,
          volume: b.volume ?? null,
          amount: b.amount ?? null,
          pct_chg: b.pct_chg ?? null,
          turnover_rate: b.turnover_rate ?? null,
          volume_ratio: b.volume_ratio ?? null,
          pe_ttm: b.pe_ttm ?? null,
          pb: b.pb ?? null,
          total_mv: b.total_mv ?? null,
          circ_mv: b.circ_mv ?? null,
          data_origin: 'real',
        };
        dqStmt.run(...rowToValues(DQ_COLS, dqRow));
        nDq++;

        const ind = indicators[i] || {};
        const tiRow = {
          code: String(rec.code),
          trade_date: String(b.date).slice(0, 10),
          ma5: ind.ma5 ?? null, ma10: ind.ma10 ?? null, ma20: ind.ma20 ?? null, ma60: ind.ma60 ?? null,
          macd_dif: ind.macd_dif ?? null, macd_dea: ind.macd_dea ?? null, macd_bar: ind.macd_bar ?? null,
          rsi6: ind.rsi6 ?? null, rsi12: ind.rsi12 ?? null, rsi24: ind.rsi24 ?? null,
          kdj_k: ind.kdj_k ?? null, kdj_d: ind.kdj_d ?? null, kdj_j: ind.kdj_j ?? null,
          vol_ma5: ind.vol_ma5 ?? null, vol_ratio_5: ind.vol_ratio_5 ?? null,
          volume_streak: ind.volume_streak ?? 0, high_60d_distance_pct: ind.high_60d_distance_pct ?? null,
          macd_gold_cross: ind.macd_gold_cross ?? 0, macd_dead_cross: ind.macd_dead_cross ?? 0,
          macd_positive: ind.macd_positive ?? 0, macd_hist_turn_positive: ind.macd_hist_turn_positive ?? 0,
          kdj_gold_cross: ind.kdj_gold_cross ?? 0, kdj_dead_cross: ind.kdj_dead_cross ?? 0,
          ma_bullish: ind.ma_bullish ?? 0, ma_bearish: ind.ma_bearish ?? 0,
          ma_above_20: ind.ma_above_20 ?? 0, ma_cross_above_5: ind.ma_cross_above_5 ?? 0,
          indicator_hit: ind.indicator_hit ?? '[]',
          data_origin: 'real',
        };
        tiStmt.run(...rowToValues(TI_COLS, tiRow));
        nTi++;
      }
    }
  });
  tx();

  db.close();

  console.log(`灌库完成: ${nCodes} 只证券, daily_quotes ${nDq} 行, tech_indicators ${nTi} 行`);
}

main().catch((e) => {
  console.error('灌库异常:', e);
  process.exit(1);
});
