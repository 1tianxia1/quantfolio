// ============================================================
// `npm run seed` CLI 入口：清库 -> 建表 -> 导入 -> 派生 -> 验证 -> 写 meta
// 幂等可重跑
// ============================================================
import env from '../config/env.js';
import { openDatabase, getDriverName } from '../db/driver.js';
import { initSchema } from '../db/schema.js';
import { loadSeedData } from './loadSeed.js';
import { seedSecurities } from './securities.js';
import { generateKline } from './klineGenerator.js';
import { deriveFields } from './derivedFields.js';
import { seedIndicators } from './indicators.js';
import { seedMoneyFlow, seedAuctionData } from './moneyFlow.js';
import { seedLimitRecords } from './limitRecords.js';
import { seedHotSectors } from './hotSectors.js';
import { seedDemoPortfolio } from './demoPortfolio.js';
import { seedMeta } from './meta.js';
import { verifySeed } from './verify.js';

async function main() {
  console.log('============================================================');
  console.log(' QuantFolio 种子数据导入（2026-08-07 通达信真实快照）');
  console.log('============================================================');

  // 1) 加载种子
  console.log('[1/9] 加载 seed-market.json ...');
  const data = loadSeedData();
  const items = [...data.stocks, ...data.funds];
  console.log(`     股票 ${data.stocks.length} 只 + 基金 ${data.funds.length} 只 = ${items.length} 只`);

  // 2) 打开数据库 + 建表
  console.log(`[2/9] 打开数据库（驱动: ${getDriverName()}）...`);
  const db = await openDatabase(env.DB_PATH);
  initSchema(db);

  // 3) 证券主表 + 标签
  console.log('[3/9] 写入 securities + security_tags ...');
  seedSecurities(db, data);

  // 4) 生成 250 日派生 K 线 + 写入 daily_quotes
  console.log('[4/9] 生成 250 日派生 K 线（末根真实锚定）...');
  const barsByCode = new Map();
  const txQuotes = db.transaction(() => {
    db.exec('DELETE FROM daily_quotes');
    for (const item of items) {
      const rawBars = generateKline(item);
      const bars = deriveFields(rawBars);
      barsByCode.set(item.code, bars);
      for (const b of bars) {
        db.run(
          `INSERT INTO daily_quotes (
             code, trade_date, open, high, low, close, pre_close, volume, amount,
             pct_chg, turnover_rate, volume_ratio, pe_ttm, pb, total_mv, circ_mv, data_origin
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            b.code, b.trade_date, b.open, b.high, b.low, b.close, b.pre_close,
            b.volume, b.amount, b.pct_chg, b.turnover_rate, b.volume_ratio,
            null, null, null, null, b.data_origin,
          ],
        );
      }
    }
  });
  txQuotes();
  console.log(`     daily_quotes 共 ${db.get('SELECT COUNT(*) AS n FROM daily_quotes').n} 行`);

  // 5) 技术指标（250 日全量 + indicator_hit）
  console.log('[5/9] 计算并写入 tech_indicators ...');
  seedIndicators(db, barsByCode);

  // 6) 资金流 + 竞价
  console.log('[6/9] 派生 money_flow + auction_data ...');
  seedMoneyFlow(db, data.stocks, barsByCode);
  seedAuctionData(db, items, barsByCode);

  // 7) 涨停记录 + 热点板块
  console.log('[7/9] 导入 limit_records + 聚合 hot_sectors ...');
  const limitStat = seedLimitRecords(db, items, barsByCode);
  seedHotSectors(db, barsByCode);
  console.log(`     真实涨停 ${limitStat.realCount} 条 + 派生涨停 ${limitStat.derivedCount} 条`);

  // 8) demo 持仓 + 预置策略 + meta
  console.log('[8/9] 写入 demo 持仓 / 目标 / 预置策略 / meta_kv ...');
  seedDemoPortfolio(db);
  seedMeta(db, { stockCount: data.stocks.length, fundCount: data.funds.length, tradeDate: data.meta.tradeDate });

  // 9) 校验
  console.log('[9/9] 运行种子校验 ...');
  const report = verifySeed(db, data);
  console.log('');
  console.log('------------------ 校验报告 ------------------');
  for (const c of report.checks) {
    console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `（${c.detail}）` : ''}`);
  }
  if (report.tagHitRate && Object.keys(report.tagHitRate).length) {
    console.log('  指标命中率（真实 tags vs 计算值，双通道）：');
    for (const [tag, v] of Object.entries(report.tagHitRate)) {
      console.log(`    - ${tag}: ${v.computedHit}/${v.tagged} = ${v.hitRate}`);
    }
  }
  if (report.warnings.length) {
    console.log('  警告：');
    for (const w of report.warnings) console.log(`    ⚠ ${w}`);
  }
  console.log('-----------------------------------------------');
  if (report.errors.length) {
    console.error(`❌ 校验失败 ${report.errors.length} 项：`);
    for (const e of report.errors) console.error(`   - ${e}`);
    process.exit(1);
  }
  console.log('✅ 种子数据导入完成，全部校验通过');
  db.close();
}

main().catch((e) => {
  console.error('❌ 种子导入失败:', e);
  process.exit(1);
});
