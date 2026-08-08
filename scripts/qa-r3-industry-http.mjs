// ============================================================
// QA R3 端到端补充验证（严过关 / Yan）
//   A. dimension='industry' 维度的真实 HTTP 再平衡链路（verify-p1 / e2e-smoke 均未覆盖）
//   B. GET /api/portfolio/summary 不带 dimension 参数时的跨维度目标污染（R3 新发现 P2）
// 用法：node scripts/qa-r3-industry-http.mjs [baseUrl]
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

async function main() {
  console.log('\n=== QA R3 · industry 维度 + 跨维度污染 端到端验证 ===\n');
  const sfx = Date.now().toString(36);
  const reg = await req('POST', '/auth/register', {
    username: `r3http_${sfx}`, email: `r3http_${sfx}@example.com`, password: 'password123',
  });
  const token = reg.token;

  // ---------- A. industry 维度 ----------
  // 从种子库只读取「行业 → 标的」映射（无对应 HTTP 接口），行情价改用 /market/kline 复核
  const { DatabaseSync } = await import('node:sqlite');
  const sdb = new DatabaseSync(new URL('../server/data/quantfolio.db', import.meta.url).pathname.replace(/^\//, ''), { readOnly: true });
  const rows = sdb.prepare(
    `SELECT s.code, s.name, s.industry, q.close
       FROM securities s
       JOIN daily_quotes q ON q.code = s.code AND q.trade_date = (SELECT MAX(trade_date) FROM daily_quotes)
      WHERE s.type='stock' AND s.industry IS NOT NULL AND q.close > 0
      ORDER BY s.industry, s.code`,
  ).all();
  const byIndustry = new Map();
  for (const s of rows) {
    if (!byIndustry.has(s.industry)) byIndustry.set(s.industry, []);
    byIndustry.get(s.industry).push(s);
  }
  // 找一个至少有 2 只标的的行业（构造「一个 target_key 多行持仓」）
  const multi = [...byIndustry.entries()].find(([, v]) => v.length >= 2);
  const otherEntry = [...byIndustry.entries()].find(([k, v]) => k !== multi[0] && v.length >= 1);
  const [indA, stocksA] = multi;
  const [indB, stocksB] = otherEntry;
  console.log(`[1] 选定行业：${indA}（${stocksA[0].code}/${stocksA[1].code}，多行同类别） + ${indB}（${stocksB[0].code}）`);

  const priceOf = (code) => Number(rows.find((q) => q.code === code).close);
  const pA1 = priceOf(stocksA[0].code);
  const pA2 = priceOf(stocksA[1].code);
  const pB = priceOf(stocksB[0].code);
  // 用 HTTP /market/kline 复核价格来源，确认与后端估值同源
  const k = await req('GET', `/market/kline?code=${stocksA[0].code}&days=10`, null, token);
  const lastClose = k.bars[k.bars.length - 1].close;
  ok('取到三只标的的真实收盘价（DB 与 /market/kline 一致）',
     [pA1, pA2, pB].every((p) => p > 0) && Math.abs(lastClose - pA1) < 0.001,
     `${pA1} / ${pA2} / ${pB}`);

  // 各买 1000 股，现金 若干
  const qty = 1000;
  for (const [code, name] of [[stocksA[0].code, stocksA[0].name], [stocksA[1].code, stocksA[1].name], [stocksB[0].code, stocksB[0].name]]) {
    await req('POST', '/portfolio/holdings', {
      code, name, asset_class: 'stock', quantity: qty, cost_price: priceOf(code),
    }, token);
  }
  const mvA = (pA1 + pA2) * qty;
  const mvB = pB * qty;
  const cashAmt = Math.round((mvA + mvB) * 0.25);
  await req('POST', '/portfolio/holdings', { name: '现金', asset_class: 'cash', quantity: cashAmt, cost_price: 1 }, token);

  const total = mvA + mvB + cashAmt;
  const pctA = (mvA / total) * 100;
  const pctB = (mvB / total) * 100;
  const pctCash = (cashAmt / total) * 100;
  console.log(`[2] 持仓建立：${indA} ¥${mvA.toFixed(2)}(${pctA.toFixed(2)}%) / ${indB} ¥${mvB.toFixed(2)}(${pctB.toFixed(2)}%) / 现金 ¥${cashAmt}(${pctCash.toFixed(2)}%)`);

  // 目标：让 indA 明显超配（目标压低 15pt），其余补齐到 100
  const tgtA = Math.max(1, Math.round(pctA - 15));
  const tgtCash = Math.round(pctCash);
  const tgtB = 100 - tgtA - tgtCash;
  await req('PUT', '/portfolio/targets', {
    dimension: 'industry',
    items: [
      { target_key: indA, target_pct: tgtA },
      { target_key: indB, target_pct: tgtB },
      { target_key: '现金', target_pct: tgtCash },
    ],
  }, token);
  console.log(`[3] industry 目标：${indA} ${tgtA}% / ${indB} ${tgtB}% / 现金 ${tgtCash}%`);

  const sum = await req('GET', '/portfolio/summary?dimension=industry', null, token);
  const allocA = sum.allocation.find((a) => a.key === indA);
  ok(`industry 分组占比 = 两行市值之和 / 总资产`, Math.abs(allocA.current_pct - pctA) < 0.05,
     `实际 ${allocA.current_pct}% 期望 ${pctA.toFixed(2)}%`);
  ok(`industry 分组市值 = 两行之和`, Math.abs(allocA.market_value - mvA) < 1,
     `¥${allocA.market_value} vs ¥${mvA.toFixed(2)}`);

  const rowsA = sum.holdings.filter((h) => h.target_key === indA);
  ok(`${indA} 下确有 2 行持仓（多对一映射成立）`, rowsA.length === 2, `${rowsA.length} 行`);
  ok('同组两行的 group_deviation_pct 完全相同',
     rowsA.length === 2 && rowsA[0].group_deviation_pct === rowsA[1].group_deviation_pct,
     `${rowsA.map((r) => r.group_deviation_pct).join(' / ')}`);
  ok('行级偏离与分组偏离已分离（row_deviation_pct 存在且不等于 deviation_pct）',
     rowsA.every((r) => r.row_deviation_pct != null) &&
     rowsA.some((r) => r.row_deviation_pct !== r.deviation_pct),
     `row=${rowsA.map((r) => r.row_deviation_pct).join('/')} group=${rowsA.map((r) => r.deviation_pct).join('/')}`);
  ok('持仓行 deviation_pct 与 allocation deviation_pct 同源',
     rowsA.every((r) => r.deviation_pct === allocA.deviation_pct),
     `${allocA.deviation_pct}pt`);

  const reb = await req('POST', '/portfolio/rebalance', { threshold: 5, dimension: 'industry' }, token);
  const itemsA = reb.items.filter((i) => i.target_key === indA);
  const groupGapA = Math.abs(total * (tgtA / 100) - mvA);
  const sumA = itemsA.reduce((s, i) => s + i.suggest_amount, 0);
  console.log(`[4] industry 再平衡：${indA} 类别缺口 ¥${groupGapA.toFixed(2)}，建议 ${itemsA.length} 条合计 ¥${sumA.toFixed(2)}`);
  for (const i of itemsA) console.log(`      → ${i.code} ${i.name} ${i.action} ${i.suggest_shares} 股 ¥${i.suggest_amount}`);

  ok(`${indA} 建议为 SELL 且不超过 2 条`, itemsA.length > 0 && itemsA.length <= 2 && itemsA.every((i) => i.action === 'SELL'));
  ok(`${indA} 建议合计 ≤ 类别缺口（未重复套用类别目标）`, sumA <= groupGapA + 1,
     `¥${sumA.toFixed(2)} ≤ ¥${(groupGapA + 1).toFixed(2)}`);
  ok(`${indA} 合计 ≠ 逐行套用口径（旧口径 ≈ 2 倍缺口）`, sumA < groupGapA * 1.5);
  ok('同一 target_key 下 action 唯一（无自相矛盾）',
     [...new Set(reb.items.map((i) => `${i.target_key}|${i.action}`))].length ===
     [...new Set(reb.items.map((i) => i.target_key))].length);
  ok('每条建议的 group_deviation_pct 均已超阈值 5',
     reb.items.every((i) => Math.abs(i.group_deviation_pct) >= 5),
     reb.items.map((i) => `${i.target_key}:${i.group_deviation_pct}`).join(' '));
  ok('取整对账：residual = planned − 实际，且非负',
     Math.abs((reb.summary.planned_sell_total - reb.summary.sell_total) - reb.summary.rounding_residual_sell) < 0.05 &&
     reb.summary.rounding_residual_sell >= -0.01,
     `planned=${reb.summary.planned_sell_total} actual=${reb.summary.sell_total} residual=${reb.summary.rounding_residual_sell}`);

  // ---------- B. 跨维度目标污染 ----------
  console.log('\n[5] 跨维度目标污染检查（R3 新发现）');
  await req('PUT', '/portfolio/targets', {
    dimension: 'code',
    items: [{ target_key: stocksA[0].code, target_pct: 70 }, { target_key: stocksA[1].code, target_pct: 30 }],
  }, token);
  const noDim = await req('GET', '/portfolio/summary', null, token);
  const foreign = noDim.allocation.filter((a) => /^\d{6}$/.test(String(a.key)));
  console.log(`    active_dimension=${noDim.active_dimension}，allocation keys = ${noDim.allocation.map((a) => a.key).join(', ')}`);
  ok('GET /portfolio/summary（无 dimension 参数）不混入 code 维度的 target_key',
     foreign.length === 0,
     foreign.length ? `混入了 ${foreign.map((f) => `${f.key}(目标${f.target_pct}% 偏离${f.deviation_pct}pt)`).join('、')}` : '');

  const withDim = await req('GET', '/portfolio/summary?dimension=industry', null, token);
  ok('显式传 dimension 时不受影响（对照组）',
     withDim.allocation.every((a) => !/^\d{6}$/.test(String(a.key))));

  // ---------- 清理 ----------
  const hs = await req('GET', '/portfolio/holdings', null, token);
  for (const h of hs.holdings) await req('DELETE', `/portfolio/holdings/${h.id}`, null, token);
  console.log('\n[6] 已清理验证持仓');

  console.log(`\n========== 结果：${pass} 通过 / ${fail} 失败 ==========\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('\n❌ 脚本执行失败：', e.message); process.exit(1); });
