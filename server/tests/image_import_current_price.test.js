// ============================================================
// 图片导入现价（current_price）落地与估值回归护栏
//
// 守护的 Bug：券商 App 截图导入持仓后，系统显示的现价/市值与截图对不上。
//   根因：视觉模型已识别出现价，但全链路未把它落库 ——
//   - 前端 handleImportImage 映射时丢弃 current_price
//   - mergeIncomingRows 未合并 current_price
//   - batch-upsert 调 upsertHolding 时未传 current_price
//   导致本地行情库未覆盖的标的（如黄金ETF华安 518880）在 valuate 中回退到
//   quote?.close ?? cost_price，市值/盈亏失真。
//
// 本测试用「无 daily_quotes / 无 fund_nav / 无 securities 行」的干净内存库，
// 直接验证 upsertHolding 携带 current_price 后，valuate 优先用截现价，
// 而不回退成本价。改坏必须在 CI 变红。
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

/** 从 buildSummary 结果里取某 code 的估值行（用游客/演示态 user_id=NULL，与 app 一致） */
function valuedRow(code) {
  const summary = portfolio.buildSummary(null, 'asset_class');
  return summary.holdings.find((h) => h.code === code);
}

describe('图片导入 current_price → 估值优先使用截现价', () => {
  it('股票（本地无行情）：用截现价 9.005 而非成本价 9.173（黄金ETF华安 518880 场景）', () => {
    const uid = null;
    portfolio.upsertHolding(uid, {
      code: '518880',
      name: '黄金ETF华安',
      asset_class: 'stock',
      quantity: 600,
      cost_price: 9.173,
      current_price: 9.005,
    });

    const row = valuedRow('518880');
    expect(row).toBeTruthy();
    // ★ 关键断言：估值用的是截现价，不是成本价
    expect(row.current_price).toBeCloseTo(9.005, 6);
    // 市值 = 600 × 9.005 = 5403.00
    expect(row.market_value).toBeCloseTo(5403.0, 4);
    // 盈亏 = 600 × (9.005 − 9.173) = −100.8
    expect(row.profit).toBeCloseTo(-100.8, 4);
    // 若回退到成本价，市值会是 600 × 9.173 = 5503.8 —— 这里必须不是
    expect(row.market_value).not.toBeCloseTo(5503.8, 2);
  });

  it('场外基金兜底（无 fund_nav / 无 daily_quotes）：用截现价而非金额模型(1)', () => {
    const uid = null;
    portfolio.upsertHolding(uid, {
      code: '017141',
      name: '某联接基金C',
      asset_class: 'fund',
      quantity: 4028,
      cost_price: 1.0,
      current_price: 0.987,
    });

    const row = valuedRow('017141');
    expect(row).toBeTruthy();
    expect(row.current_price).toBeCloseTo(0.987, 6);
    // 市值 = 4028 × 0.987 = 3975.636
    expect(row.market_value).toBeCloseTo(4028 * 0.987, 4);
  });

  it('合并/更新时保留最新截现价（新导入优先于旧值）', () => {
    const uid = null;
    portfolio.upsertHolding(uid, {
      code: '000539',
      name: '粤电力A',
      asset_class: 'stock',
      quantity: 100,
      cost_price: 5.96,
      current_price: 6.00,
    });
    // 同 code 再次 upsert，截现价更新为 6.10
    portfolio.upsertHolding(uid, {
      code: '000539',
      name: '粤电力A',
      asset_class: 'stock',
      quantity: 0, // 数量相加仍为 100
      cost_price: 5.96,
      current_price: 6.10,
    });

    const row = valuedRow('000539');
    expect(row.current_price).toBeCloseTo(6.10, 6);
  });

  it('回归护栏：未传 current_price 时回退成本价（证明是新字段改变了行为）', () => {
    const uid = null;
    portfolio.upsertHolding(uid, {
      code: '518880',
      name: '黄金ETF华安',
      asset_class: 'stock',
      quantity: 600,
      cost_price: 9.173,
      // 不传 current_price
    });

    const row = valuedRow('518880');
    expect(row.current_price).toBeCloseTo(9.173, 6);
    expect(row.market_value).toBeCloseTo(5503.8, 4);
  });
});
