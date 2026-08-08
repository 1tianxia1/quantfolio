// ============================================================
// 种子数据校验：K线末根锚定、指标无NaN、tags命中率、数量
// 输出数据一致性 / 派生幂等 / 指标命中率报告
// ============================================================
import { generateKline } from './klineGenerator.js';
import { loadSeedData } from './loadSeed.js';

/**
 * 运行种子校验
 * @param {import('../db/driver.js').Database} db
 * @param {object} data loadSeedData() 结果（含清洗后标的）
 * @returns {object} 校验报告
 */
export function verifySeed(db, data) {
  const report = { checks: [], errors: [], warnings: [] };
  const items = [...data.stocks, ...data.funds];

  function check(name, ok, detail = '') {
    report.checks.push({ name, ok, detail });
    if (!ok) report.errors.push(`${name}: ${detail}`);
  }

  // 1) 数量
  const secCount = db.get('SELECT COUNT(*) AS n FROM securities').n;
  check('securities 数量 = 97', secCount === 97, `实际 ${secCount}`);
  const stockCount = db.get("SELECT COUNT(*) AS n FROM securities WHERE type='stock'").n;
  const fundCount = db.get("SELECT COUNT(*) AS n FROM securities WHERE type='fund'").n;
  check('股票 77 + 基金 20', stockCount === 77 && fundCount === 20, `股票 ${stockCount} / 基金 ${fundCount}`);

  // 2) daily_quotes = 97×250
  const dqCount = db.get('SELECT COUNT(*) AS n FROM daily_quotes').n;
  check('daily_quotes = 97×250', dqCount === secCount * 250, `实际 ${dqCount}`);
  const distinctCodes = db.get('SELECT COUNT(DISTINCT code) AS n FROM daily_quotes').n;
  check('daily_quotes 覆盖全部证券', distinctCodes === secCount, `实际 ${distinctCodes}`);

  // 3) 末根锚定（close=price 且 pct_chg=changePct）
  let anchorOk = 0;
  let anchorFail = 0;
  for (const item of items) {
    const last = db.get(
      `SELECT * FROM daily_quotes WHERE code = ? ORDER BY trade_date DESC LIMIT 1`,
      [item.code],
    );
    const priceOk = last && Math.abs(last.close - item.price) < 1e-4;
    const pctOk = last && Math.abs(last.pct_chg - item.changePct) < 1e-4;
    const prevOk = last && Math.abs(last.pre_close - item.price / (1 + item.changePct / 100)) < 1e-4;
    if (priceOk && pctOk && prevOk) anchorOk += 1;
    else { anchorFail += 1; report.errors.push(`末根未锚定: ${item.code}`); }
  }
  check('K线末根锚定（close/pct_chg/pre_close）', anchorFail === 0, `${anchorOk}/${items.length} 通过`);

  // 4) 指标无 NaN / 最新交易日指标齐全（前 60 根均线预热期允许 NULL）
  const latestTiDate = db.get('SELECT MAX(trade_date) AS d FROM tech_indicators')?.d;
  const nanCount = db.get(
    `SELECT COUNT(*) AS n FROM tech_indicators WHERE trade_date = ? AND
       (ma5 IS NULL OR ma10 IS NULL OR ma20 IS NULL OR ma60 IS NULL OR
        macd_dif IS NULL OR macd_dea IS NULL OR macd_bar IS NULL OR
        rsi6 IS NULL OR rsi12 IS NULL OR rsi24 IS NULL OR
        kdj_k IS NULL OR kdj_d IS NULL OR kdj_j IS NULL)`,
    [latestTiDate],
  ).n;
  check('tech_indicators 无 NULL 指标（最新日）', nanCount === 0, `最新日 ${latestTiDate} NULL 行数 ${nanCount}`);
  const nanTotal = db.get(
    `SELECT COUNT(*) AS n FROM tech_indicators WHERE
       indicator_hit IS NULL OR volume_streak IS NULL`,
  ).n;
  check('tech_indicators 无空 JSON / streak', nanTotal === 0, `异常行数 ${nanTotal}`);

  // 5) money_flow 真实 19 只优先
  const realFlow = db.get("SELECT COUNT(*) AS n FROM money_flow WHERE data_origin='real'").n;
  const totalFlow = db.get('SELECT COUNT(*) AS n FROM money_flow').n;
  check('money_flow 真实记录数（种子 mainNetInflow 标的）', realFlow >= 19, `真实 ${realFlow} / 共 ${totalFlow}`);

  // 6) auction_data 覆盖
  const auctionCount = db.get('SELECT COUNT(*) AS n FROM auction_data').n;
  check('auction_data 覆盖全部证券', auctionCount === secCount, `实际 ${auctionCount}`);

  // 7) 派生幂等：同 code 两次生成结果一致
  const sample = items[0];
  const gen1 = generateKline(sample);
  const gen2 = generateKline(sample);
  let same = gen1.length === gen2.length;
  if (same) {
    for (let i = 0; i < gen1.length; i++) {
      if (gen1[i].close !== gen2[i].close || gen1[i].open !== gen2[i].open || gen1[i].volume !== gen2[i].volume) {
        same = false; break;
      }
    }
  }
  check(`派生幂等（${sample.code} 两次生成一致）`, same, '');

  // 8) tags 命中率报告（双通道：真实标签 vs 计算值命中率）
  const tagReport = {};
  const focusTags = ['MACD金叉', '多头排列', 'KDJ金叉', 'MACD死叉'];
  const tagKeyword = {
    'MACD金叉': 'MACD金叉',
    '多头排列': 'MA多头',
    'KDJ金叉': 'KDJ金叉',
    'MACD死叉': 'MACD死叉',
  };
  for (const tag of focusTags) {
    const hasTag = db.get('SELECT COUNT(*) AS n FROM security_tags WHERE tag = ?', [tag]).n;
    if (hasTag === 0) continue;
    const codesWithTag = db.all('SELECT code FROM security_tags WHERE tag = ?', [tag]).map((r) => r.code);
    const keyword = tagKeyword[tag];
    let hitCount = 0;
    for (const c of codesWithTag) {
      const latest = db.get(
        `SELECT indicator_hit FROM tech_indicators WHERE code = ? ORDER BY trade_date DESC LIMIT 1`,
        [c],
      );
      if (latest && (latest.indicator_hit || '').includes(keyword)) hitCount += 1;
    }
    const rate = hasTag ? Math.round((hitCount / hasTag) * 100) : 0;
    tagReport[tag] = { tagged: hasTag, computedHit: hitCount, hitRate: `${rate}%` };
    if (rate < 30) report.warnings.push(`标签「${tag}」计算命中率偏低（${rate}%），属已知限制（U4 双通道 OR 语义兜底）`);
  }
  report.tagHitRate = tagReport;

  return report;
}
