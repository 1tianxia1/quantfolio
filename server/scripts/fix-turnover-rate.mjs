// ============================================================
// 补全 daily_quotes.turnover_rate 脚本
//
// 根因：日 K 接口（腾讯/东财 f168）不返回换手率，导致历史 K 线落库时 turnover_rate=null。
//       实时快照接口（东财 quote）返回 f168=turnover_rate，但如果不跑盘中/收盘快照同步，
//       本地库就缺失该字段，选股器表格「换手」列会显示「—」。
//
// 用法：
//   cd server && node scripts/fix-turnover-rate.mjs          # 全量 A 股
//   node scripts/fix-turnover-rate.mjs --max=100             # 先跑 100 只验证
// ============================================================
import env from '../src/config/env.js';
import { openDatabase } from '../src/db/driver.js';
import { createQuoteSyncService } from '../src/services/quoteSyncService.js';

const max = Number(process.argv.find((a) => a.startsWith('--max='))?.split('=')[1]) || 0;

const t0 = Date.now();
const el = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const log = (...a) => console.log(`[${el()}]`, ...a);

const db = await openDatabase(env.DB_PATH);
log(`DB 已打开：${env.DB_PATH}`);

const rows = db.all("SELECT code FROM securities WHERE type = 'stock' ORDER BY code");
let codes = rows.map((r) => r.code);
if (max > 0) codes = codes.slice(0, max);
log(`准备为 ${codes.length} 只股票同步实时快照以补 turnover_rate`);

const maxTradeDate = db.prepare('SELECT MAX(trade_date) d FROM daily_quotes').get().d;
const before = db.prepare('SELECT COUNT(*) total, COUNT(turnover_rate) filled FROM daily_quotes WHERE trade_date = ?').get(maxTradeDate);
log(`补全前：最新交易日 ${maxTradeDate} 有 ${before.total} 行，turnover_rate 有值 ${before.filled} 行`);

const svc = createQuoteSyncService(db);
const result = await svc.syncLatestQuotes(codes);
log(`同步完成：写入 ${result.written} 行，跳过 ${result.skipped}，未取到 ${result.missing.length} 只`);

const newMaxDate = db.prepare('SELECT MAX(trade_date) d FROM daily_quotes').get().d;
const after = db.prepare('SELECT COUNT(*) total, COUNT(turnover_rate) filled FROM daily_quotes WHERE trade_date = ?').get(newMaxDate);
log(`补全后：最新交易日 ${newMaxDate} 有 ${after.total} 行，turnover_rate 有值 ${after.filled} 行（新增 ${Math.max(0, after.filled - before.filled)}）`);

process.exit(0);
