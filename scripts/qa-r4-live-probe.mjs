// ============================================================
// QA R4 线上实例探针（严过关 / Yan）
// 目的：确认「正在给用户演示的 3001 实例」确实跑的是 R3-#1/#2/#3 修复后的代码，
//       而不是修复前的旧进程。只读 + 自建临时账号 + 用后即清，不动演示数据。
// 用法：node scripts/qa-r4-live-probe.mjs [baseUrl]
// ============================================================
const BASE = process.argv[2] || 'http://127.0.0.1:3001';
const API = `${BASE}/api`;

let pass = 0;
let fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}${detail ? ' — ' + detail : ''}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
}
async function req(method, path, body, token) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || (json.code !== undefined && json.code !== 0)) {
    throw new Error(`${method} ${path} [${res.status}] ${JSON.stringify(json)}`);
  }
  return json.data;
}

const sfx = Date.now().toString(36);
console.log(`\n=== QA R4 线上实例探针 @ ${BASE} ===\n`);

const reg = await req('POST', '/auth/register', {
  username: `r4live_${sfx}`, email: `r4live_${sfx}@example.com`, password: 'password123',
});
const token = reg.token;

// 取一只有行情的真实标的
const { DatabaseSync } = await import('node:sqlite');
const sdb = new DatabaseSync(
  new URL('../server/data/quantfolio.db', import.meta.url).pathname.replace(/^\//, ''),
  { readOnly: true },
);
const [secA, secB] = sdb.prepare(
  `SELECT s.code, s.name, q.close
     FROM securities s
     JOIN daily_quotes q ON q.code = s.code AND q.trade_date = (SELECT MAX(trade_date) FROM daily_quotes)
    WHERE s.type='stock' AND q.close > 0 AND q.close < 50
    ORDER BY s.code LIMIT 2`,
).all();
console.log(`[1] 选定标的：${secA.code} ${secA.name} @${secA.close} / ${secB.code} ${secB.name} @${secB.close}\n`);

// 建仓：只买 A，留一笔现金；B 一股不持有（用于验证 R3-#3 建仓建议）
const qtyA = 1000;
const mvA = qtyA * secA.close;
const cash = Math.round(mvA / 4); // 现金约占 20%
await req('POST', '/portfolio/holdings', { code: secA.code, name: secA.name, asset_class: 'stock', quantity: qtyA, cost_price: secA.close }, token);
await req('POST', '/portfolio/holdings', { name: '现金', asset_class: 'cash', quantity: cash, cost_price: 1 }, token);

// code 维度目标：A 40% / B 50% / cash 10%
await req('PUT', '/portfolio/targets', {
  dimension: 'code',
  items: [
    { target_key: secA.code, target_pct: 40 },
    { target_key: secB.code, target_pct: 50 },
    { target_key: 'cash', target_pct: 10 },
  ],
}, token);

console.log('[2] R3-#1 线上验证：code 维度下现金不再进「分组黑洞」');
const s = await req('GET', '/portfolio/summary?dimension=code', null, token);
const allocSum = s.allocation.reduce((acc, a) => acc + a.market_value, 0);
const cashAlloc = s.allocation.find((a) => a.key === 'cash');
ok('allocation 中存在 cash 分组（旧代码此处为 undefined）', !!cashAlloc);
ok('cash 分组市值 = 真实现金（不是 0）', cashAlloc && Math.abs(cashAlloc.market_value - cash) < 1, `¥${cashAlloc?.market_value}`);
ok('★ 守恒律：Σ(allocation 市值) === 总资产', Math.abs(allocSum - s.total_asset) < 1, `${allocSum.toFixed(2)} vs ${s.total_asset.toFixed(2)}`);
const cashRow = s.holdings.find((h) => h.asset_class === 'cash');
ok('现金持仓行 target_key = cash（旧代码为 null）', cashRow?.target_key === 'cash', String(cashRow?.target_key));

console.log('\n[3] R3-#2 线上验证：不带 dimension 时不混入其它维度 target_key');
await req('PUT', '/portfolio/targets', {
  dimension: 'asset_class',
  items: [{ target_key: 'stock', target_pct: 80 }, { target_key: 'cash', target_pct: 20 }],
}, token);
const sNoDim = await req('GET', '/portfolio/summary', null, token);
const keys = sNoDim.allocation.map((a) => a.key);
ok('active_dimension = asset_class', sNoDim.active_dimension === 'asset_class', sNoDim.active_dimension);
ok('allocation 不含 code 维度的证券代码（无幻影分组）',
  !keys.includes(secA.code) && !keys.includes(secB.code), `keys = ${keys.join(', ')}`);

console.log('\n[4] R3-#3 线上验证：未持有标的给出可执行建仓建议');
const r = await req('POST', '/portfolio/rebalance', { dimension: 'code', threshold: 5 }, token);
const newPos = r.items.find((it) => it.target_key === secB.code);
ok('未持有的 B 产出建仓建议', !!newPos);
ok('建仓建议回填 code（前端可跳转）', newPos?.code === secB.code, String(newPos?.code));
ok('文案含「建仓」而非「类别整体」', !!newPos && newPos.name.includes('建仓') && !newPos.name.includes('类别整体'), newPos?.name);
ok('is_new_position = true', newPos?.is_new_position === true);
if (newPos?.suggest_shares > 0) {
  ok('股数为 100 整数倍', newPos.suggest_shares % 100 === 0, `${newPos.suggest_shares} 股`);
  const implied = newPos.suggest_amount / newPos.suggest_shares;
  ok('★ 建仓折股价 === 行情快照收盘价（价格同源）', Math.abs(implied - secB.close) < 0.01, `${implied} vs ${secB.close}`);
}

console.log('\n[5] 资金校验口径线上体检');
const assetBuy = r.items.filter((it) => it.target_key !== 'cash' && it.action === 'BUY').reduce((a, it) => a + it.suggest_amount, 0);
const assetSell = r.items.filter((it) => it.target_key !== 'cash' && it.action === 'SELL').reduce((a, it) => a + it.suggest_amount, 0);
const endCash = r.summary.cash_available + assetSell - assetBuy;
ok('balance_ok 与独立台账重放一致', r.summary.balance_ok === (endCash >= -1),
  `balance_ok=${r.summary.balance_ok} 期末现金=¥${endCash.toFixed(2)}`);
ok('need_cash 非负且有限', Number.isFinite(r.summary.need_cash) && r.summary.need_cash >= 0, `¥${r.summary.need_cash}`);

// ---------- 清理 ----------
const hs = await req('GET', '/portfolio/holdings', null, token);
for (const h of hs.holdings) await req('DELETE', `/portfolio/holdings/${h.id}`, null, token);
console.log('\n[6] 已清理探针持仓（演示数据未受影响）');

console.log(`\n========== 结果：${pass} 通过 / ${fail} 失败 ==========\n`);
process.exit(fail === 0 ? 0 : 1);
