// ============================================================
// QA 第 4 轮最终签章验证（严过关 / Yan）
//
// 目的：只验「工程师本轮自主扩大的改动面」，不重做完整回归。
//   A. need_cash / balance_ok 口径变更 —— 是修正还是掩盖？
//      A1 qa_extra 现金不足场景精确数值（balance_ok=false / need_cash=900）
//      A2 全新构造的证券侧净买入超现金场景，告警必须仍然响
//      A3 ★ 反掩盖差分扫描：用 items 自身重放现金流台账求「真实可执行性」，
//         与 balance_ok 逐场景比对；同时算出旧口径，定位二者分歧的性质
//   B. R3-#1 的 '未分类' 兜底 —— 脏数据进 allocation、不进 rebalance、守恒律成立
//   C. R3-#3 建仓价格同源性 —— resolveNewPosition 与 valuate 是否同一 trade_date 快照
//
// 断言写「PRD/DESIGN 认为正确的行为」，不迁就实现。
// ============================================================
import { openMemoryDatabase } from '../server/src/db/driver.js';
import { initSchema } from '../server/src/db/schema.js';
import { createPortfolioService } from '../server/src/services/portfolioService.js';
import { createRebalanceService } from '../server/src/services/rebalanceService.js';
import { createUserModel } from '../server/src/models/userModel.js';

const db = await openMemoryDatabase();
initSchema(db);
const portfolio = createPortfolioService(db);
const rebalance = createRebalanceService(db);
const users = createUserModel(db);

let pass = 0;
let fail = 0;
const failures = [];
const notes = [];

function ok(cond, label, detail = '') {
  if (cond) {
    pass += 1;
    console.log(`  ✅ ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    fail += 1;
    failures.push(label);
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}
function note(s) {
  notes.push(s);
  console.log(`  ℹ️  ${s}`);
}
const near = (a, b, eps = 0.01) => Math.abs(Number(a) - Number(b)) <= eps;
const money = (v) => `¥${Number(v).toFixed(2)}`;

const GLOBAL_MAX_DATE = '2026-08-07';

function insertSecurity(code, name, price, industry = '测试', tradeDate = GLOBAL_MAX_DATE, type = 'stock') {
  db.run(
    `INSERT INTO securities (code, name, market, type, board, price_limit_pct, industry, sector, circ_mv, data_origin)
     VALUES (?,?,'SH',?,'SH-Main10',10,?,?,200,'real')`,
    [code, name, type, industry, industry],
  );
  db.run(
    `INSERT INTO daily_quotes (code, trade_date, open, high, low, close, pre_close, volume, amount, pct_chg, turnover_rate, volume_ratio, data_origin)
     VALUES (?,?,?,?,?,?,?,1000,10000,5,5,1.5,'real')`,
    [code, tradeDate, price, price * 1.01, price * 0.99, price, price / 1.05],
  );
}
function addHolding(uid, code, name, assetClass, quantity, costPrice) {
  db.run(
    `INSERT INTO holdings (user_id, code, name, asset_class, quantity, cost_price) VALUES (?,?,?,?,?,?)`,
    [uid, code, name, assetClass, quantity, costPrice],
  );
}
function addTargets(uid, dimension, pairs) {
  for (const [key, pct] of pairs) {
    db.run(
      `INSERT INTO target_allocations (user_id, dimension, target_key, target_pct) VALUES (?,?,?,?)`,
      [uid, dimension, key, pct],
    );
  }
}
let seq = 0;
const newUser = (tag) => users.create({ username: `r4_${tag}_${seq++}`, email: `r4_${tag}_${seq}@example.com`, password: 'password123' }).id;

/** 与 rebalanceService.isCashBucket 等价的独立实现（QA 侧不复用被测代码） */
function isCashBucketQA(key, dimension) {
  return dimension === 'industry' ? key === '现金' : key === 'cash';
}

/**
 * ★ 真实可执行性的独立判定：不看 summary，直接用 items 重放一遍现金台账。
 * 起始现金 = cash_available；卖证券 +，买证券 −；期末不得为负。
 * 现金桶自身的建议是记账的另一半，不进台账（否则双算）。
 */
function replayLedger(r, dimension) {
  let assetBuy = 0;
  let assetSell = 0;
  let cashBucketBuy = 0;
  let cashBucketSell = 0;
  for (const it of r.items) {
    const amt = Number(it.suggest_amount) || 0;
    if (isCashBucketQA(it.target_key, dimension)) {
      if (it.action === 'BUY') cashBucketBuy += amt; else cashBucketSell += amt;
    } else if (it.action === 'BUY') assetBuy += amt; else assetSell += amt;
  }
  const cash0 = Number(r.summary.cash_available) || 0;
  const endCash = cash0 + assetSell - assetBuy;
  return {
    assetBuy, assetSell, cashBucketBuy, cashBucketSell, cash0, endCash,
    feasible: endCash >= -1, // 允许 1 元浮点/取整误差，与实现同容差
    // 旧口径（改动前）：把现金桶的买卖也算进现金流
    oldBalanceOk: r.summary.buy_total <= r.summary.sell_total + cash0 + 1,
    oldNeedCash: Math.max(0, Number((r.summary.buy_total - cash0).toFixed(2))),
  };
}

console.log('\n============================================================');
console.log('  QA R4 最终签章验证 —— 严过关');
console.log('============================================================');

// ------------------------------------------------------------
console.log('\n[A] need_cash / balance_ok 口径变更：修正 or 掩盖？');
// ------------------------------------------------------------

console.log('\n  A1 复现 qa_extra「现金不足」场景（工程师声称仍告警）');
{
  insertSecurity('600001', '重仓A', 10);
  insertSecurity('600002', '轻仓B', 10);
  const uid = newUser('extra_short');
  addHolding(uid, '600001', '重仓A', 'stock', 100, 10); // 1000
  addHolding(uid, '600002', '轻仓B', 'stock', 100, 10); // 1000
  addHolding(uid, null, '现金', 'cash', 100, 1);        // 100 → 总资产 2100
  addTargets(uid, 'code', [['600001', 99.9], ['600002', 0.05], ['cash', 0.05]]);
  const r = rebalance.suggest(uid, { threshold: 1, dimension: 'code' });
  const led = replayLedger(r, 'code');

  ok(r.summary.balance_ok === false, 'balance_ok 仍为 false（现金不足告警未丢失）');
  ok(near(r.summary.need_cash, 900), 'need_cash 精确等于 900', money(r.summary.need_cash));
  ok(r.summary.need_cash > 0, 'need_cash > 0');
  ok(led.feasible === false, '独立台账重放同样判定为「不可执行」', `期末现金 ${money(led.endCash)}`);
  ok(led.oldBalanceOk === false, '旧口径在此场景也告警 → 本次改动未削弱该场景');
  note(`证券买 ${money(led.assetBuy)} / 证券卖 ${money(led.assetSell)} / 现金桶卖 ${money(led.cashBucketSell)} / 手持现金 ${money(led.cash0)}`);
}

console.log('\n  A2 全新构造：证券侧净买入远超可用现金（两只标的都被误配 100% → Σ=200 脏数据）');
{
  insertSecurity('600003', '待加仓C', 10);
  insertSecurity('600004', '未持有D', 10);
  const uid = newUser('newshort');
  addHolding(uid, '600003', '待加仓C', 'stock', 1000, 10); // 10000
  addHolding(uid, null, '现金', 'cash', 100, 1);           // 100 → 总资产 10100
  // 每项均 ≤100 通过 CHECK，但 Σ=200 → 证券侧凭空放大出巨额买入需求
  addTargets(uid, 'code', [['600003', 100], ['600004', 100]]);
  const r = rebalance.suggest(uid, { threshold: 1, dimension: 'code' });
  const led = replayLedger(r, 'code');

  ok(led.assetBuy > led.cash0, '场景确实构造成功：证券买入 > 可用现金',
    `${money(led.assetBuy)} > ${money(led.cash0)}`);
  ok(led.assetSell === 0, '证券侧无任何卖出回款（无内部腾挪空间）');
  ok(r.summary.balance_ok === false, '★ balance_ok=false（新口径仍然告警）');
  ok(r.summary.need_cash > 0, '★ need_cash > 0', money(r.summary.need_cash));
  ok(near(r.summary.need_cash, led.assetBuy - led.cash0),
    'need_cash 数值 = 证券买入 − 可用现金', money(r.summary.need_cash));
  ok(led.feasible === false, '独立台账重放同样判定为「不可执行」', `期末现金 ${money(led.endCash)}`);
}

console.log('\n  A3 ★ 反掩盖差分扫描：balance_ok 是否等价于「台账重放的真实可执行性」');
{
  const scenarios = [];

  // S1 纯内部腾挪（R3-7 原型）：卖证券换现金，不需外部资金
  {
    insertSecurity('600036', '招商银行', 40, '银行');
    const uid = newUser('s1');
    addHolding(uid, '600036', '招商银行', 'stock', 2000, 35); // 80000
    addHolding(uid, null, '现金', 'cash', 20000, 1);          // 20000
    addTargets(uid, 'code', [['600036', 50], ['cash', 50]]);
    scenarios.push({ name: 'S1 卖证券补现金（纯内部腾挪）', dim: 'code', r: rebalance.suggest(uid, { threshold: 5, dimension: 'code' }) });
  }
  // S2 动用现金买证券，现金刚好够
  {
    insertSecurity('601398', '工商银行', 5, '银行');
    const uid = newUser('s2');
    addHolding(uid, '601398', '工商银行', 'stock', 4000, 4); // 20000
    addHolding(uid, null, '现金', 'cash', 80000, 1);         // 80000
    addTargets(uid, 'code', [['601398', 60], ['cash', 40]]);
    scenarios.push({ name: 'S2 动用现金买证券（现金充足）', dim: 'code', r: rebalance.suggest(uid, { threshold: 5, dimension: 'code' }) });
  }
  // S3 建仓 + 卖出并存（G-6 原型）
  {
    const uid = newUser('s3');
    addHolding(uid, '600036', '招商银行', 'stock', 2000, 35); // 80000
    addHolding(uid, null, '现金', 'cash', 20000, 1);          // 20000
    addTargets(uid, 'code', [['600036', 40], ['601398', 60]]);
    scenarios.push({ name: 'S3 一边建仓一边减仓', dim: 'code', r: rebalance.suggest(uid, { threshold: 5, dimension: 'code' }) });
  }
  // S4 industry 维度（现金键为 '现金'，验证 isCashBucket 的另一分支）
  {
    const uid = newUser('s4');
    addHolding(uid, '600036', '招商银行', 'stock', 1000, 35); // 40000
    addHolding(uid, '601398', '工商银行', 'stock', 4000, 4);  // 20000
    addHolding(uid, null, '现金', 'cash', 40000, 1);          // 40000 → 100000
    addTargets(uid, 'industry', [['银行', 90], ['现金', 10]]);
    scenarios.push({ name: 'S4 industry 维度动用现金加仓', dim: 'industry', r: rebalance.suggest(uid, { threshold: 5, dimension: 'industry' }) });
  }
  // S5 零现金 + 纯换股（卖 A 买 B，无现金缓冲）
  {
    const uid = newUser('s5');
    addHolding(uid, '600036', '招商银行', 'stock', 1250, 35); // 50000
    addHolding(uid, '601398', '工商银行', 'stock', 10000, 4); // 50000
    addTargets(uid, 'code', [['600036', 90], ['601398', 10]]);
    scenarios.push({ name: 'S5 零现金纯换股', dim: 'code', r: rebalance.suggest(uid, { threshold: 5, dimension: 'code' }) });
  }
  // S6 bond 类别整体建议（非 code 维度的零持仓组）
  {
    const uid = newUser('s6');
    addHolding(uid, '600036', '招商银行', 'stock', 2000, 35); // 80000
    addHolding(uid, null, '现金', 'cash', 20000, 1);          // 20000
    addTargets(uid, 'asset_class', [['stock', 60], ['cash', 20], ['bond', 20]]);
    scenarios.push({ name: 'S6 bond 零持仓类别整体买入', dim: 'asset_class', r: rebalance.suggest(uid, { threshold: 5, dimension: 'asset_class' }) });
  }
  // S7 Σtarget=100 且真实可执行，但现金桶偏离被阈值过滤 → 探针：need_cash 与 balance_ok 的语义分歧
  {
    insertSecurity('600005', '低配E', 10);
    insertSecurity('600006', '超配F', 10);
    const uid = newUser('s7');
    addHolding(uid, '600005', '低配E', 'stock', 2000, 10);  // 20000 (20%)
    addHolding(uid, '600006', '超配F', 'stock', 7800, 10);  // 78000 (78%)
    addHolding(uid, null, '现金', 'cash', 2000, 1);         // 2000  (2%) → 100000
    // 目标 E26 / F69 / cash5：cash 偏离 -3pt < 阈值 5 被过滤，证券侧买 6000 卖 9000
    addTargets(uid, 'code', [['600005', 26], ['600006', 69], ['cash', 5]]);
    scenarios.push({ name: 'S7 卖 9000 买 6000（现金桶被阈值过滤）', dim: 'code', r: rebalance.suggest(uid, { threshold: 5, dimension: 'code' }) });
  }

  let divergeOldNew = 0;
  for (const s of scenarios) {
    const led = replayLedger(s.r, s.dim);
    const bo = s.r.summary.balance_ok;
    const agree = bo === led.feasible;
    ok(agree, `${s.name}：balance_ok 与台账重放一致`,
      `balance_ok=${bo} / 期末现金=${money(led.endCash)}`);
    // 掩盖的定义：真实不可执行，却报 balance_ok=true
    ok(!(bo === true && led.feasible === false), `${s.name}：未出现「不可执行却报平衡」的掩盖`);
    if (led.oldBalanceOk !== bo) {
      divergeOldNew += 1;
      const kind = led.feasible ? '旧口径误报（新口径消除了假警报）' : '★新口径漏报（真掩盖）';
      note(`${s.name}：新旧口径分歧 → ${kind}（旧=${led.oldBalanceOk} 新=${bo} 真实可执行=${led.feasible}）`);
      ok(led.feasible === true, `${s.name}：新旧分歧属于「消除假警报」而非「掩盖真问题」`);
    }
  }
  note(`共 ${scenarios.length} 个场景，新旧口径分歧 ${divergeOldNew} 处`);

  // need_cash 与 balance_ok 的语义一致性（此处只观察，不作为放行条件）
  for (const s of scenarios) {
    const nc = s.r.summary.need_cash;
    const bo = s.r.summary.balance_ok;
    if (nc > 1 && bo === true) {
      note(`【语义观察】${s.name}：need_cash=${money(nc)} > 0 但 balance_ok=true（need_cash 为「卖出未到账前的毛头寸」口径，非「外部还需注资额」）`);
    }
  }
}

// ------------------------------------------------------------
console.log('\n[B] R3-#1 的 \'未分类\' 兜底：脏数据行的归属');
// ------------------------------------------------------------
{
  const uid = newUser('unclassified');
  addHolding(uid, '600036', '招商银行', 'stock', 1000, 35);   // 40000
  addHolding(uid, null, '脏数据股', 'stock', 500, 20);        // ★ stock 但 code=NULL → 按成本价 20 估值 = 10000
  addHolding(uid, null, '现金', 'cash', 50000, 1);            // 50000 → 总资产 100000
  addTargets(uid, 'code', [['600036', 60], ['cash', 40]]);

  const s = portfolio.buildSummary(uid, 'code');
  const dirty = s.holdings.find((h) => h.name === '脏数据股');
  const alloc = s.allocation.find((a) => a.key === '未分类');

  ok(dirty.target_key === '未分类', '脏数据行 target_key = \'未分类\'（不再是 null）', String(dirty.target_key));
  ok(alloc !== undefined, '「未分类」如实出现在 allocation 中');
  ok(alloc && near(alloc.market_value, 10000), '「未分类」市值 = 10000（钱没消失）', money(alloc?.market_value ?? NaN));
  ok(alloc && near(alloc.current_pct, 10), '「未分类」占比 = 10%', `${alloc?.current_pct}%`);
  ok(alloc && alloc.target_pct === null, '「未分类」target_pct 恒为 null');
  ok(alloc && alloc.deviation_pct === null, '「未分类」deviation_pct 为 null（不谎报偏离）');

  // ★ 守恒律
  const allocSum = s.allocation.reduce((acc, a) => acc + a.market_value, 0);
  ok(near(allocSum, s.total_asset), '★ 守恒律：Σ(allocation 市值) === 总资产',
    `${money(allocSum)} vs ${money(s.total_asset)}`);

  const r = rebalance.suggest(uid, { threshold: 1, dimension: 'code' });
  ok(!r.items.some((it) => it.target_key === '未分类'), '★ 「未分类」不产生任何再平衡建议');
  ok(!r.items.some((it) => it.name === '脏数据股'), '脏数据行本身不出现在建议列表');
  for (const it of r.items) {
    ok(Number.isFinite(it.suggest_amount) && !Number.isNaN(it.suggest_amount),
      `建议 ${it.target_key} 金额有限且非 NaN`, money(it.suggest_amount));
  }

  // 现金行在 code 维度仍走 cash 兜底，不被吞进「未分类」
  const cashRow = s.holdings.find((h) => h.asset_class === 'cash');
  ok(cashRow.target_key === 'cash', '现金行仍兜底为 \'cash\' 键，未被「未分类」吞并');

  note('「未分类」为兜底保留字：若用户把 target_key 真的命名为「未分类」会与脏数据同组（概率极低，登记为技术债）');
}

// ------------------------------------------------------------
console.log('\n[C] R3-#3 建仓价格同源性：resolveNewPosition vs valuate');
// ------------------------------------------------------------

console.log('\n  C1 正常路径：同一 MAX(trade_date) 快照');
{
  // 招商银行 40 元，行情落在全局 MAX(trade_date)=2026-08-07
  const holder = newUser('price_holder');
  addHolding(holder, '600036', '招商银行', 'stock', 100, 35);
  const vs = portfolio.buildSummary(holder, 'code');
  const valuatePrice = vs.holdings.find((h) => h.code === '600036').current_price;
  const quoteDate = vs.holdings.find((h) => h.code === '600036').quote_date;

  // 另一个用户：未持有招商，靠目标触发建仓
  const buyer = newUser('price_buyer');
  addHolding(buyer, '601398', '工商银行', 'stock', 5000, 4); // 20000 → 总资产 20000
  addTargets(buyer, 'code', [['601398', 50], ['600036', 50]]);
  const r = rebalance.suggest(buyer, { threshold: 5, dimension: 'code' });
  const newPos = r.items.find((it) => it.target_key === '600036');

  ok(newPos !== undefined && newPos.is_new_position === true, '未持有标的产出 is_new_position 建仓建议');
  ok(newPos.code === '600036', '建仓建议回填 code');
  const impliedPrice = newPos.suggest_amount / newPos.suggest_shares;
  ok(near(impliedPrice, valuatePrice), '★ 建仓折股价 === valuate 估值价',
    `建仓 ${impliedPrice} vs 估值 ${valuatePrice}`);
  ok(near(newPos.current_price, valuatePrice), '建仓 item 上的 current_price 与估值价一致',
    `${newPos.current_price} vs ${valuatePrice}`);
  ok(quoteDate === GLOBAL_MAX_DATE, '估值取的是全局 MAX(trade_date) 快照', String(quoteDate));
  ok(near(newPos.suggest_amount, newPos.suggest_shares * valuatePrice),
    'suggest_amount === suggest_shares × 同源价格', money(newPos.suggest_amount));
}

console.log('\n  C2 边界路径：标的在全局 MAX(trade_date) 无行情（停牌/数据缺口）');
{
  // 该股最新行情停留在 2026-08-01，早于全局 MAX 的 2026-08-07
  insertSecurity('600777', '停牌股', 88, '测试', '2026-08-01');

  // (a) 持有它时 valuate 怎么估？
  const holder = newUser('stale_holder');
  addHolding(holder, '600777', '停牌股', 'stock', 100, 30); // 成本价 30
  const vs = portfolio.listHoldings(holder);
  const row = vs.holdings.find((h) => h.code === '600777');
  note(`valuate 对停牌股取价 = ${row.current_price}（成本价 30 / 快照价 88），quote_date=${row.quote_date}`);
  ok(near(row.current_price, 30), 'valuate 落到「无行情按成本价估值」分支', String(row.current_price));

  // (b) 未持有它、靠目标触发建仓时 resolveNewPosition 怎么取价？
  const buyer = newUser('stale_buyer');
  addHolding(buyer, '601398', '工商银行', 'stock', 5000, 4); // 20000
  addTargets(buyer, 'code', [['601398', 50], ['600777', 50]]);
  const r = rebalance.suggest(buyer, { threshold: 5, dimension: 'code' });
  const stale = r.items.find((it) => it.target_key === '600777');

  if (stale && stale.suggest_shares > 0) {
    const implied = stale.suggest_amount / stale.suggest_shares;
    note(`resolveNewPosition 对停牌股取价 = ${implied}（来自 getLatestQuote 的 2026-08-01 陈旧快照）`);
    ok(near(implied, 88), '确认走了 getLatestQuote 回退分支（拿到 2026-08-01 的 88 元）', String(implied));
    note('【P3 技术债】resolveNewPosition 的 `|| getLatestQuote(code)` 回退是「按标的取最新」，与 valuate 的「全局 MAX(trade_date) 快照」不同源；'
      + '停牌/数据缺口标的会用陈旧价折股，且 item 上无 quote_date / is_stale 标记，前端无法提示。');
    ok(stale.current_price !== undefined, '建仓 item 至少带出 current_price 供人工核对', String(stale.current_price));
  } else {
    note('停牌股未产生带股数的建仓建议（退回金额口径）');
  }

  // 无论如何都不能出 NaN / 负数 / Infinity
  for (const it of r.items) {
    ok(Number.isFinite(it.suggest_amount) && it.suggest_amount >= 0,
      `停牌场景建议 ${it.target_key} 金额有限且非负`, money(it.suggest_amount));
  }
}

// ------------------------------------------------------------
console.log('\n============================================================');
console.log(`  结果：${pass} 通过 / ${fail} 失败`);
if (failures.length) {
  console.log('  失败项：');
  for (const f of failures) console.log(`    - ${f}`);
}
console.log('============================================================\n');
process.exit(fail === 0 ? 0 : 1);
