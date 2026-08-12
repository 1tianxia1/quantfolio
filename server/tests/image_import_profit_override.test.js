// ============================================================
// 图片导入「截图盈亏」落地与估值优先回归护栏
//
// 守护的 Bug：图片导入持仓后，系统显示的累计盈亏/盈亏率/当日盈亏与券商 App 截图对不上。
//   根因：OCR 已识别出 profit / profit_rate / day_profit / day_profit_rate，
//   但全链路未把它们落库，valuate 只能重新计算（与截图展示值存在舍入/口径差异）。
//
// 本测试用干净内存库，验证 upsertHolding 携带这些截图表后：
//   - valuate 优先用 OCR 值展示（override 重算值）
//   - 未传时回退到重新计算（护栏）
// 改坏必须在 CI 变红。
// ============================================================
import { describe, it, expect, beforeEach } from 'vitest';
import { openMemoryDatabase } from '../src/db/driver.js';
import { initSchema } from '../src/db/schema.js';
import { createPortfolioService } from '../src/services/portfolioService.js';

let db;
let portfolio;

beforeEach(async () => {
  db = await openMemoryDatabase();
  initSchema(db);
  portfolio = createPortfolioService(db);
});

/** 从 buildSummary 结果里取某 code 的估值行（user_id=NULL，与 app 游客态一致） */
function valuedRow(code) {
  const summary = portfolio.buildSummary(null, 'asset_class');
  return summary.holdings.find((h) => h.code === code);
}

describe('图片导入 OCR 盈亏 → 估值优先展示截图表', () => {
  it('OCR 盈亏/盈亏率/当日盈亏均优先于重算值（用差异明显的截图表证明 override 生效）', () => {
    portfolio.upsertHolding(null, {
      code: '518880',
      name: '黄金ETF华安',
      asset_class: 'stock',
      quantity: 600,
      cost_price: 9.1733,
      current_price: 9.005,
      profit: -123.45, // 故意与重算值(-100.98)不同，验证 override
      profit_rate: -0.05, // 故意与重算率(-0.0183)不同
      day_profit: -7.0, // 无行情时重算当日盈亏为 0，这里强制截图值
      day_profit_rate: -0.0013,
    });

    const row = valuedRow('518880');
    // 市值仍由 current_price 计算（与截图现价一致）
    expect(row.market_value).toBeCloseTo(600 * 9.005, 2);
    // 盈亏/盈亏率/当日盈亏必须取 OCR 值，而非重算
    expect(row.profit).toBeCloseTo(-123.45, 2);
    expect(row.profit_rate).toBeCloseTo(-0.05, 4);
    expect(row.day_profit).toBeCloseTo(-7.0, 2);
    expect(row.day_profit_rate).toBeCloseTo(-0.0013, 4);
  });

  it('未传 OCR 盈亏时，回退到重新计算（护栏：证明是新字段改变了行为）', () => {
    portfolio.upsertHolding(null, {
      code: '518880',
      name: '黄金ETF华安',
      asset_class: 'stock',
      quantity: 600,
      cost_price: 9.1733,
      current_price: 9.005,
      // 不传 profit / profit_rate / day_profit
    });

    const row = valuedRow('518880');
    // 重算：市值 5403，盈亏 = 5403 - 600*9.1733 = -100.98
    expect(row.market_value).toBeCloseTo(5403.0, 2);
    expect(row.profit).toBeCloseTo(-100.98, 2);
    // 无行情 → 当日盈亏回退为 0
    expect(row.day_profit).toBeCloseTo(0, 2);
  });

  it('同码合并时保留最新一次导入的截图表', () => {
    portfolio.upsertHolding(null, {
      code: '518880', name: '黄金ETF华安', asset_class: 'stock',
      quantity: 600, cost_price: 9.1733, current_price: 9.005, profit: -100,
    });
    portfolio.upsertHolding(null, {
      code: '518880', name: '黄金ETF华安', asset_class: 'stock',
      quantity: 0, cost_price: 9.1733, current_price: 9.005, profit: -200,
    });
    const row = valuedRow('518880');
    expect(row.profit).toBeCloseTo(-200, 2);
  });
});
