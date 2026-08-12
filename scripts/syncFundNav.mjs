// ============================================================
// 手动同步场外基金净值（天天基金）→ fund_nav 表
//
// 用法（在项目根目录执行，确保 DB_PATH 指向运行中的库）：
//   DB_PATH=server/data/quantfolio.db node scripts/syncFundNav.mjs
//
// 说明：
//   · 幂等：可重复跑；净值按 (code, nav_date) upsert。
//   · 首次运行会顺带把示例场外基金「华宝中证有色金属ETF发起式联接C(017141)」
//     写入游客(guest)持仓，方便在 /portfolio 直接看到当日盈亏效果。
//   · 场内 ETF（已有 daily_quotes）会被自动跳过，沿用市价口径。
// ============================================================
import { openDatabase } from '../server/src/db/driver.js';
import env from '../server/src/config/env.js';
import { initSchema } from '../server/src/db/schema.js';
import { createFundNavService } from '../server/src/services/fundNavService.js';

const db = await openDatabase(env.DB_PATH);
initSchema(db);

// 顺带确保示例场外基金存在于游客持仓（幂等）
const DEMO_FUND = {
  code: '017141',
  name: '华宝中证有色金属ETF发起式联接C',
  asset_class: 'fund',
  quantity: 4028,
  cost_price: 1.0407,
};
const exists = db.get('SELECT id FROM holdings WHERE user_id IS NULL AND code = ?', [DEMO_FUND.code]);
if (!exists) {
  db.run(
    'INSERT INTO holdings (user_id, code, name, asset_class, quantity, cost_price) VALUES (NULL, ?, ?, ?, ?, ?)',
    [DEMO_FUND.code, DEMO_FUND.name, DEMO_FUND.asset_class, DEMO_FUND.quantity, DEMO_FUND.cost_price],
  );
  console.log(`[syncFundNav] 已写入示例场外基金 ${DEMO_FUND.code} 到游客持仓`);
}

const fn = createFundNavService(db);
const result = await fn.syncFundNav({});
console.log('同步结果：', JSON.stringify(result, null, 2));
if (result.failures.length) {
  console.log('失败明细：', JSON.stringify(result.failures, null, 2));
}
db.close();
