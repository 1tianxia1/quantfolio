// ============================================================
// 回归验证：000539 成本价精度 & 盈亏口径与券商对齐
//
// ★ 断言策略（重要）
//   只有 cost_price 是「本次修复的产物」，属于恒定事实，硬断言。
//   profit / profit_rate / current_price 都是行情驱动的派生值，
//   行情一更新就会变。因此不硬编码，而是用接口返回的 current_price
//   实时推导期望值再比对 —— 这样脚本只在「精度真的错了」时变红，
//   不会因为换了一天行情就产生假失败。
//
// 用法
//   node scripts/verify-holding-cost-precision.mjs      # 退出码 0 = 通过
// ============================================================
import jwt from 'jsonwebtoken';
import env from '../src/config/env.js';

const BASE = `http://127.0.0.1:${env.PORT || 3001}`;
const CODE = '000539';

/** 唯一的硬断言：真实成本价（由「同花顺盈亏 4.38 / 现价 6.01 / 100 股」反解得出） */
const EXPECT_COST_PRICE = 5.9662;

/** 券商展示精度：同花顺成本价列显示 3 位小数 */
const BROKER_COST_DECIMALS = 3;

/** 四舍五入到 n 位（与 server/src/util/money.js 的 round 一致） */
function round(value, n = 4) {
  const factor = 10 ** n;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

/**
 * 拉取某个身份下的 000539 持仓行
 * @param {string} label 身份说明
 * @param {string|null} token JWT（null = 游客）
 * @returns {Promise<{label: string, row: object|undefined}>}
 */
async function fetchRow(label, token) {
  const res = await fetch(`${BASE}/api/portfolio/holdings`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  const json = await res.json();
  if (!json.success) throw new Error(`${label}: API 失败 ${JSON.stringify(json)}`);
  return { label, row: (json.data.holdings || []).find((h) => h.code === CODE) };
}

const targets = [
  await fetchRow('游客桶 (user_id IS NULL)', null),
  await fetchRow(
    '真实用户 751530442 (user_id=43)',
    jwt.sign({ id: 43, username: '751530442' }, env.JWT_SECRET, { expiresIn: '5m' }),
  ),
  await fetchRow(
    'testuser (user_id=1)',
    jwt.sign({ id: 1, username: 'testuser' }, env.JWT_SECRET, { expiresIn: '5m' }),
  ),
];

let allPass = true;

for (const { label, row } of targets) {
  if (!row) {
    console.log(`\n❌ ${label}: 未找到 ${CODE}`);
    allPass = false;
    continue;
  }

  // 行情驱动值：从接口实时取，不硬编码
  const price = Number(row.current_price);
  const qty = Number(row.quantity);
  const costAmount = EXPECT_COST_PRICE * qty;
  const expectProfit = round((price - EXPECT_COST_PRICE) * qty, 4);
  const expectRate = round(((price - EXPECT_COST_PRICE) / EXPECT_COST_PRICE) * 100, 4);

  const checks = [
    // ① 恒定事实：成本价必须是高精度真值，不能退化成券商展示值
    { field: 'cost_price', actual: row.cost_price, expect: EXPECT_COST_PRICE, note: '硬断言（本次修复产物）' },
    // ② 派生值：按实时现价推导，行情变动不会造成假失败
    { field: 'profit', actual: row.profit, expect: expectProfit, note: `由现价 ${price} 推导` },
    { field: 'profit_rate', actual: row.profit_rate, expect: expectRate, note: `由现价 ${price} 推导` },
    { field: 'cost_amount', actual: row.cost_amount, expect: round(costAmount, 4), note: '成本额一致性' },
  ].map((c) => ({ ...c, pass: Math.abs(Number(c.actual) - Number(c.expect)) < 1e-9 }));

  // ③ 精度退化探针：若成本价被写成券商展示值（5.966），盈亏会偏 0.02
  const degraded = round(Number(EXPECT_COST_PRICE.toFixed(BROKER_COST_DECIMALS)), 4);
  const degradedProfit = round((price - degraded) * qty, 4);
  const precisionHeld = Math.abs(Number(row.profit) - degradedProfit) > 1e-9;
  checks.push({
    field: '精度未退化',
    actual: row.profit,
    expect: `≠ ${degradedProfit}（退化值）`,
    note: `若成本价退化为 ${degraded} 则盈亏会变成 ${degradedProfit}`,
    pass: precisionHeld,
  });

  const pass = checks.every((c) => c.pass);
  allPass = allPass && pass;

  console.log(`\n${pass ? '✅' : '❌'} ${label}  [${row.name}] qty=${qty} 现价=${price} (${row.quote_date})`);
  for (const c of checks) {
    console.log(
      `   ${c.pass ? '✓' : '✗'} ${String(c.field).padEnd(14)} 实际=${c.actual}  期望=${c.expect}   ${c.note}`,
    );
  }
  console.log(
    `   · 券商展示口径: 成本/现价 ${Number(row.cost_price).toFixed(BROKER_COST_DECIMALS)} / ${price}` +
      `, 盈亏 ${row.profit}, 盈亏率 ${Number(row.profit_rate).toFixed(3)}%`,
  );
}

console.log(`\n${allPass ? '✅ 全部通过' : '❌ 存在不一致'}`);
process.exit(allPass ? 0 : 1);
