// ============================================================
// 清洗 daily_quotes / tech_indicators 中的脏行
//
// 背景：指数品种（399xxx 等）此前误用 get_security_bars 抓取，
// pytdx 解析出乱码 bar —— 表现为非法 trade_date（如 "296956-72-"、
// "0-00-00 15"）与负收盘价。由于全站查询依赖
// `trade_date = (SELECT MAX(trade_date) ...)`，一条 "9999-71-91"
// 就会把"最新交易日"劫持掉，导致所有页面查不到数据。
//
// 用法：
//   node scripts/clean-bad-quotes.mjs           # 预演，只报告不删除
//   node scripts/clean-bad-quotes.mjs --apply   # 实际删除
// ============================================================
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../server/src/db/driver.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'server', 'data', 'quantfolio.db');
const APPLY = process.argv.includes('--apply');

// 合法交易日：严格 YYYY-MM-DD 且落在合理区间
const VALID_DATE = `trade_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'
                    AND trade_date BETWEEN '1990-01-01' AND '2100-01-01'`;

// 脏行判定：日期非法，或价格非正（乱码解析的典型特征）
const BAD_DQ = `NOT (${VALID_DATE}) OR close IS NULL OR close <= 0`;
const BAD_TI = `NOT (${VALID_DATE})`;

async function main() {
  const db = await openDatabase(DB_PATH);
  console.log(`DB: ${DB_PATH}`);
  console.log(`模式: ${APPLY ? '实际删除 (--apply)' : '预演 (dry-run)'}\n`);

  const dqTotal = db.get('SELECT COUNT(*) AS n FROM daily_quotes').n;
  const tiTotal = db.get('SELECT COUNT(*) AS n FROM tech_indicators').n;
  const dqBad = db.get(`SELECT COUNT(*) AS n FROM daily_quotes WHERE ${BAD_DQ}`).n;
  const tiBad = db.get(`SELECT COUNT(*) AS n FROM tech_indicators WHERE ${BAD_TI}`).n;
  const badCodes = db.all(
    `SELECT code, COUNT(*) AS n FROM daily_quotes WHERE ${BAD_DQ}
     GROUP BY code ORDER BY n DESC`,
  );

  console.log(`daily_quotes    : ${dqTotal} 行, 脏 ${dqBad} 行`);
  console.log(`tech_indicators : ${tiTotal} 行, 脏 ${tiBad} 行`);
  console.log(`受污染证券      : ${badCodes.length} 只`);
  if (badCodes.length) {
    console.log(`  样例: ${badCodes.slice(0, 10).map((r) => `${r.code}(${r.n})`).join(', ')}`);
  }

  if (!APPLY) {
    console.log('\n预演结束。确认无误后加 --apply 实际执行。');
    db.close();
    return;
  }

  const tx = db.transaction(() => {
    db.run(`DELETE FROM daily_quotes WHERE ${BAD_DQ}`);
    db.run(`DELETE FROM tech_indicators WHERE ${BAD_TI}`);
  });
  tx();

  const dqAfter = db.get('SELECT COUNT(*) AS n FROM daily_quotes').n;
  const tiAfter = db.get('SELECT COUNT(*) AS n FROM tech_indicators').n;
  const latest = db.get('SELECT MAX(trade_date) AS d FROM daily_quotes').d;

  console.log(`\n清洗完成:`);
  console.log(`  daily_quotes    ${dqTotal} -> ${dqAfter} (删除 ${dqTotal - dqAfter})`);
  console.log(`  tech_indicators ${tiTotal} -> ${tiAfter} (删除 ${tiTotal - tiAfter})`);
  console.log(`  最新交易日      ${latest}`);
  db.close();
}

main().catch((e) => {
  console.error('清洗异常:', e);
  process.exit(1);
});
