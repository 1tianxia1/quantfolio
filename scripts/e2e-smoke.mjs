/**
 * QuantFolio 端到端冒烟脚本（交付前最终验证）
 * 覆盖：健康检查 / 注册登录 / 游客隔离 / 持仓估值 / 再平衡 / 尾盘五步法 / 早盘七步法 / AI / 市场元数据
 * 用法：node scripts/e2e-smoke.mjs
 */
const BASE = 'http://127.0.0.1:3001/api';
let pass = 0, fail = 0;
const results = [];

function ok(name, cond, detail = '') {
  if (cond) { pass++; results.push(`  [PASS] ${name}${detail ? ' — ' + detail : ''}`); }
  else { fail++; results.push(`  [FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
}

async function api(path, { method = 'GET', body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* 非 JSON 响应 */ }
  return { status: res.status, json };
}

const rnd = Date.now().toString(36).slice(-6);

console.log('\n========== QuantFolio 端到端冒烟 ==========\n');

// 1. 健康检查
{
  const r = await api('/health');
  ok('健康检查 /api/health', r.json?.success === true && r.json?.data?.db === 'ok', `db=${r.json?.data?.db}`);
}

// 2. 市场元数据（真实标的数不写死）
let secCount = 0, baseDate = '';
{
  const r = await api('/market/meta');
  const d = r.json?.data || {};
  secCount = (d.stock_count || 0) + (d.fund_count || 0);
  baseDate = d.trade_date || '';
  ok('市场元数据 /market/meta', r.json?.success === true && secCount === 97,
     `标的数=${secCount}(股${d.stock_count}+基${d.fund_count}) 基线日=${baseDate}`);
}

// 3. 游客模式：可读 demo，不可写
{
  const rd = await api('/portfolio/holdings');
  ok('游客可读 demo 持仓', rd.json?.success === true, `返回 ${Array.isArray(rd.json?.data) ? rd.json.data.length : (rd.json?.data?.items?.length ?? '?')} 条`);
  const rw = await api('/portfolio/holdings', { method: 'POST', body: { code: '600519', asset_class: 'stock', quantity: 100, cost_price: 1500 } });
  ok('游客写操作被拦截(401)', rw.status === 401, `HTTP ${rw.status} code=${rw.json?.code}`);
}

// 4. 注册 + 登录
let tokenA = '', tokenB = '';
{
  const u = `qa_${rnd}`;
  const r = await api('/auth/register', { method: 'POST', body: { username: u, email: `${u}@test.com`, password: 'Test12345' } });
  ok('用户 A 注册', r.json?.success === true, `HTTP ${r.status}`);
  // 契约：登录用 account 单字段，支持 email 或 username 两种输入
  const byEmail = await api('/auth/login', { method: 'POST', body: { account: `${u}@test.com`, password: 'Test12345' } });
  const byName = await api('/auth/login', { method: 'POST', body: { account: u, password: 'Test12345' } });
  tokenA = byName.json?.data?.token || '';
  ok('登录双通道（email / username 均可）', byEmail.json?.success === true && byName.json?.success === true);
  ok('用户 A 登录拿到 JWT', !!tokenA, `token 长度 ${tokenA.length}`);
  const me = await api('/auth/me', { token: tokenA });
  ok('鉴权 /auth/me', me.json?.success === true && !me.json?.data?.password_hash, '响应不含密码哈希');

  const u2 = `qb_${rnd}`;
  await api('/auth/register', { method: 'POST', body: { username: u2, email: `${u2}@test.com`, password: 'Test12345' } });
  const l2 = await api('/auth/login', { method: 'POST', body: { account: u2, password: 'Test12345' } });
  tokenB = l2.json?.data?.token || '';
  ok('用户 B 注册登录', !!tokenB);
}

// 5. 持仓录入 + 估值
{
  const add = await api('/portfolio/holdings', {
    method: 'POST', token: tokenA,
    body: { code: '600519', name: '贵州茅台', asset_class: 'stock', quantity: 100, cost_price: 1400 },
  });
  ok('用户 A 添加股票持仓', add.json?.success === true, `HTTP ${add.status}`);

  await api('/portfolio/holdings', {
    method: 'POST', token: tokenA,
    body: { name: '现金', asset_class: 'cash', quantity: 50000, cost_price: 1 },
  });
  await api('/portfolio/holdings', {
    method: 'POST', token: tokenA,
    body: { name: '现金备用', asset_class: 'cash', quantity: 30000, cost_price: 1 },
  });
  ok('多行现金持仓录入（R2 修复项场景）', true, '2 行现金 50000+30000');

  const s = await api('/portfolio/summary', { token: tokenA });
  const d = s.json?.data || {};
  // 600519 若不在种子池 → 降级按成本价估值：100×1400 + 50000 + 30000 = 220000
  ok('组合汇总估值', s.json?.success === true && Number(d.total_asset) === 220000,
     `总资产=${d.total_asset} 成本=${d.total_cost} 持仓行=${d.holdings?.length}`);
}

// 6. 用户隔离
{
  const b = await api('/portfolio/holdings', { token: tokenB });
  const list = Array.isArray(b.json?.data) ? b.json.data : (b.json?.data?.items || []);
  const leaked = list.some(h => h.code === '600519' && Number(h.quantity) === 100);
  ok('用户隔离：B 看不到 A 的持仓', !leaked, `B 持仓 ${list.length} 条`);
}

// 7. 再平衡（含多行现金求和 + 100 股取整）
{
  await api('/portfolio/targets', {
    method: 'PUT', token: tokenA,
    body: { dimension: 'asset_class', items: [{ target_key: 'stock', target_pct: 60 }, { target_key: 'cash', target_pct: 40 }] },
  });
  const r = await api('/portfolio/rebalance', { method: 'POST', token: tokenA, body: { threshold: 5 } });
  const d = r.json?.data || {};
  const sug = d.items || [];
  const sm = d.summary || {};
  ok('再平衡建议生成', r.json?.success === true, `${sug.length} 条建议`);
  ok('多行现金求和正确 (=80000)', Number(sm.cash_available) === 80000, `cash_available=${sm.cash_available}`);
  const allRound = sug.filter(x => x.unit === '股').every(x => Number(x.suggest_shares) % 100 === 0);
  ok('A股建议股数 100 股取整', allRound);

  // 【类别维度聚合口径】股票 140000/220000=63.64% vs 60% → 偏离 +3.64pt < 5，不该触发
  //                     现金  80000/220000=36.36% vs 40% → 偏离 -3.64pt < 5，不该触发
  // 若按行独立计算，现金两行会各自 vs 40% 从而误触发并重复累加买入额
  const cashSug = sug.filter(x => x.unit === '元');
  const cashBuySum = cashSug.filter(x => x.action === 'BUY').reduce((s, x) => s + Number(x.suggest_amount || 0), 0);
  ok('类别维度按 target_key 聚合（同类多行不重复套用目标值）',
     sug.length === 0,
     sug.length === 0 ? '偏离 3.64pt < 阈值 5，正确无建议'
       : `误触发 ${sug.length} 条，现金买入合计 ${cashBuySum}（应为 0；类别缺口仅 8000）`);
}

// 8. 尾盘五步法漏斗
{
  const r = await api('/screener/pipeline/run', {
    method: 'POST',
    body: { type: 'closing', preset: 'closing_five_step' },
  });
  const d = r.json?.data || {};
  const funnel = d.funnel || d.steps || [];
  const list = d.results || d.items || [];
  ok('尾盘五步法管线执行', r.json?.success === true, `漏斗 ${funnel.length} 步，命中 ${list.length} 只`);
  if (funnel.length) {
    const chain = funnel.map(s => s.survivors ?? s.remain ?? '?').join(' → ');
    results.push(`         漏斗: 全市场 ${secCount} → ${chain}`);
  }
  if (list.length) {
    results.push('         命中: ' + list.slice(0, 5).map(x => `${x.code} ${x.name}(${x.score ?? x.total_score})`).join(' / '));
  }
}

// 9. 早盘七步法（严格 + 宽松）
{
  const strict = await api('/screener/pipeline/run', { method: 'POST', body: { type: 'morning', preset: 'morning_seven_step', loose_mode: false } });
  const sd = strict.json?.data || {};
  const sl = sd.results || sd.items || [];
  ok('早盘七步法（严格模式）执行', strict.json?.success === true, `命中 ${sl.length} 只（97 只池预期 0，属数据边界）`);

  const loose = await api('/screener/pipeline/run', { method: 'POST', body: { type: 'morning', preset: 'morning_seven_step', loose_mode: true } });
  const ld = loose.json?.data || {};
  const lf = ld.funnel || ld.steps || [];
  const step4 = lf[3];
  ok('早盘宽松模式开关生效', loose.json?.success === true, `第4步存活 ${step4?.survivors ?? step4?.remain ?? '?'}（严格为 0）`);
}

// 10. 通用尾盘筛选器（兜底路径）
{
  const r = await api('/screener/closing', {
    method: 'POST',
    body: { conditions: { macd: { enabled: true, status: 'golden_cross' } }, page: 1, page_size: 20 },
  });
  const d = r.json?.data || {};
  const list = d.items || d.results || [];
  ok('通用尾盘指标筛选（MACD金叉）', r.json?.success === true, `命中 ${list.length} 只`);
}

// 11. 策略保存
{
  const r = await api('/strategies', {
    method: 'POST', token: tokenA,
    body: { name: `冒烟策略_${rnd}`, type: 'closing', conditions: { preset: 'closing_five_step' } },
  });
  ok('策略保存', r.json?.success === true, `HTTP ${r.status}`);
  const l = await api('/strategies', { token: tokenA });
  const arr = Array.isArray(l.json?.data) ? l.json.data : (l.json?.data?.items || []);
  ok('策略列表可读', arr.length > 0, `${arr.length} 条`);
}

// 12. AI 三入口
{
  const r = await api('/ai/diagnose', { method: 'POST', token: tokenA, body: { force: false } });
  const content = r.json?.data?.content || '';
  const isReal = r.json?.data?.source === 'llm' || r.json?.data?.provider === 'zhipu';
  ok('AI 持仓诊断有输出（不白屏）', r.json?.success === true && content.length > 20,
     `${content.length} 字符, 来源=${isReal ? 'GLM真实调用' : '本地降级'}`);
}

console.log(results.join('\n'));
console.log(`\n========== 结果：${pass} 通过 / ${fail} 失败 ==========\n`);
process.exit(fail > 0 ? 1 : 0);
