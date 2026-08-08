// ============================================================
// P1 缺陷端到端复现验证脚本
//
// 复现场景（主理人实测口径）：
//   持仓：600519 贵州茅台 100 股 + 现金 50000 + 现金备用 30000
//   目标：asset_class → stock 60% / cash 40%
//   调用：POST /api/portfolio/rebalance  body {threshold:5}
//
// 修复前实际：现金备用 BUY 58000 + 现金 BUY 38000 = 96000（每行各套完整类别目标）
// 修复后期望：现金类别偏离 -3.64pt < 5 → 不产生任何建议
//
// 用法：node scripts/verify-p1-rebalance.mjs [baseUrl]
// ============================================================
const BASE = process.argv[2] || 'http://localhost:3001';
const API = `${BASE}/api`;

/** 统一请求封装：解析后端错误信封 */
async function req(method, path, body, token) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || (json.code !== undefined && json.code !== 0)) {
    throw new Error(`${method} ${path} 失败 [${res.status}] ${JSON.stringify(json)}`);
  }
  return json.data;
}

function money(v) {
  return Number(v).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function main() {
  console.log(`\n=== P1 再平衡分组缺陷 · 端到端复现验证 ===\n基址：${BASE}\n`);

  // 1) 注册一个隔离用户（避免污染既有数据）
  const suffix = Date.now().toString(36);
  const cred = {
    username: `p1verify_${suffix}`,
    email: `p1verify_${suffix}@example.com`,
    password: 'password123',
  };
  const reg = await req('POST', '/auth/register', cred);
  const token = reg.token;
  console.log(`[1] 注册验证用户：${cred.username}`);

  // 2) 构造复现持仓
  // 注：600519 不在种子行情universe内，valuate() 会按成本价估值（无行情降级逻辑），
  //     故 cost_price=1400 → 100 股市值 140000，与主理人实测口径一致。
  await req('POST', '/portfolio/holdings', {
    code: '600519', name: '贵州茅台', asset_class: 'stock', quantity: 100, cost_price: 1400,
  }, token);
  await req('POST', '/portfolio/holdings', {
    name: '现金', asset_class: 'cash', quantity: 50000, cost_price: 1,
  }, token);
  await req('POST', '/portfolio/holdings', {
    name: '现金备用', asset_class: 'cash', quantity: 30000, cost_price: 1,
  }, token);
  console.log('[2] 持仓已建：茅台 100 股 / 现金 50000 / 现金备用 30000');

  // 3) 目标配置 stock 60 / cash 40
  await req('PUT', '/portfolio/targets', {
    dimension: 'asset_class',
    items: [{ target_key: 'stock', target_pct: 60 }, { target_key: 'cash', target_pct: 40 }],
  }, token);
  console.log('[3] 目标配置：stock 60% / cash 40%');

  // 4) 汇总核对
  const summary = await req('GET', '/portfolio/summary?dimension=asset_class', null, token);
  const cashAlloc = summary.allocation.find((a) => a.key === 'cash');
  const stockAlloc = summary.allocation.find((a) => a.key === 'stock');
  console.log(`\n[4] 组合汇总`);
  console.log(`    总资产        : ¥${money(summary.total_asset)}`);
  console.log(`    stock 类别    : ${stockAlloc.current_pct}%  目标 ${stockAlloc.target_pct}%  偏离 ${stockAlloc.deviation_pct}pt`);
  console.log(`    cash  类别    : ${cashAlloc.current_pct}%  目标 ${cashAlloc.target_pct}%  偏离 ${cashAlloc.deviation_pct}pt`);
  console.log(`\n    持仓行分组字段（应与上表一致）：`);
  for (const h of summary.holdings) {
    console.log(
      `      ${(h.name).padEnd(6)} 行占比 ${String(h.current_pct).padStart(6)}%` +
      ` | 类别 ${h.target_key} 占比 ${String(h.group_current_pct).padStart(6)}%` +
      ` 目标 ${h.target_pct}% 偏离 ${h.group_deviation_pct}pt`,
    );
  }

  // 5) 复现调用 threshold=5
  const r5 = await req('POST', '/portfolio/rebalance', { threshold: 5 }, token);
  console.log(`\n[5] POST /api/portfolio/rebalance  {threshold:5}`);
  console.log(`    建议条数      : ${r5.items.length}`);
  console.log(`    买入总额      : ¥${money(r5.summary.buy_total)}`);
  console.log(`    卖出总额      : ¥${money(r5.summary.sell_total)}`);
  for (const it of r5.items) {
    console.log(`      → ${it.name} ${it.action} ¥${money(it.suggest_amount)}`);
  }

  // 6) threshold=1 时展示类别缺口分摊
  const r1 = await req('POST', '/portfolio/rebalance', { threshold: 1 }, token);
  const cashItems = r1.items.filter((i) => i.unit === '元');
  const cashSum = cashItems.reduce((s, i) => s + i.suggest_amount, 0);
  console.log(`\n[6] POST /api/portfolio/rebalance  {threshold:1}（放宽阈值看分摊）`);
  console.log(`    cash 类别缺口 : ¥${money(220000 * 0.4 - 80000)}`);
  for (const it of cashItems) {
    console.log(`      → ${it.name} ${it.action} ¥${money(it.suggest_amount)}  (类别缺口 ¥${money(Math.abs(it.group_diff_value))} 的等比分摊)`);
  }
  console.log(`    现金建议合计  : ¥${money(cashSum)}`);

  // 7) 断言
  console.log(`\n=== 判定 ===`);
  const checks = [
    ['总资产 = 220000', Math.abs(summary.total_asset - 220000) < 1],
    ['cash 类别占比 ≈ 36.36%', Math.abs(cashAlloc.current_pct - 36.36) < 0.05],
    ['cash 类别偏离 ≈ -3.64pt', Math.abs(cashAlloc.deviation_pct + 3.64) < 0.05],
    ['threshold=5 时不产生任何建议', r5.items.length === 0],
    ['不再出现 58000 / 38000 重复建议', !r1.items.some((i) => Math.abs(i.suggest_amount - 58000) < 1 || Math.abs(i.suggest_amount - 38000) < 1)],
    ['现金建议合计 = 类别缺口 8000（而非 96000）', Math.abs(cashSum - 8000) < 1],
  ];
  let allPass = true;
  for (const [label, ok] of checks) {
    console.log(`  ${ok ? '✅' : '❌'} ${label}`);
    if (!ok) allPass = false;
  }

  // 8) 清理验证数据
  const holdings = await req('GET', '/portfolio/holdings', null, token);
  for (const h of holdings.holdings) {
    await req('DELETE', `/portfolio/holdings/${h.id}`, null, token);
  }
  console.log(`\n[7] 已清理验证用持仓数据`);

  console.log(`\n${allPass ? '✅ 全部通过：P1 分组缺陷已修复' : '❌ 存在未通过项'}\n`);
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => {
  console.error('\n❌ 验证脚本执行失败：', e.message);
  process.exit(1);
});
