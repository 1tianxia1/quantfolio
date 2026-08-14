// ============================================================
// money_flow 真实历史回填 CLI（增量2）
//
// 用法：
//   cd server
//   node scripts/backfillMoneyFlow.mjs                       # 全量（数千只，分批 + 礼貌限速）
//   node scripts/backfillMoneyFlow.mjs --limit 50           # 前 50 只验证
//   node scripts/backfillMoneyFlow.mjs --sample             # 随机抽样 50 只
//   node scripts/backfillMoneyFlow.mjs --delay 300           # 批间 sleep 300ms
//   node scripts/backfillMoneyFlow.mjs --resume             # 跳过已回填 code，断点续跑
//   node scripts/backfillMoneyFlow.mjs --limit 2 --dry-run  # 只打印计划，不触网不写库
//   node scripts/backfillMoneyFlow.mjs --has-quotes        # 仅回填有日行情的标的（作用域收窄）
//   node scripts/backfillMoneyFlow.mjs --has-quotes=true   # 等价写法
//   node scripts/backfillMoneyFlow.mjs --batch-size 25     # 每批只数（默认 50；解限流建议 20~30）
//   node scripts/backfillMoneyFlow.mjs --relaxed           # 宽松模式：放宽熔断/退避/并发（配代理池解限流用）
//
// 数据源：provider.client.fetchMoneyFlow（东财 fflow，内部已带缓存/三道闸/熔断）。
// 单位红线：fflow 元 ÷ 10000 → money_flow 万元（见 backfillMoneyFlowLib.mjs）。
// ⚠️ 真实全市场回填数千只会触东财风控，仅在生产机、seed 之后、由主理人手动执行。
// ============================================================
import env from '../src/config/env.js';
import { openDatabase } from '../src/db/driver.js';
import { initSchema } from '../src/db/schema.js';
import { createEastmoneyProvider } from '../src/providers/eastmoneyProvider.js';
import { createEmClient } from '../src/providers/emClient.js';
import { getProxyPoolStats } from '../src/util/httpAgent.js';
import { backfillAll } from './backfillMoneyFlowLib.mjs';

/** 解析 CLI 参数（同时支持 `--flag N` 与 `--flag=N` 两种写法） */
function parseArgs(argv) {
  const args = {
    limit: 0,
    sample: false,
    delay: 200,
    resume: false,
    dryRun: false,
    hasQuotes: false,
    batchSize: 50,
    relaxed: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--limit' || a.startsWith('--limit=')) {
      const v = a.startsWith('--limit=') ? a.split('=')[1] : argv[++i];
      args.limit = Number(v) || 0;
    } else if (a === '--delay' || a.startsWith('--delay=')) {
      const v = a.startsWith('--delay=') ? a.split('=')[1] : argv[++i];
      args.delay = Number(v) || 0;
    } else if (a === '--batch-size' || a.startsWith('--batch-size=')) {
      const v = a.startsWith('--batch-size=') ? a.split('=')[1] : argv[++i];
      args.batchSize = Number(v) || 50;
    } else if (a === '--sample') {
      args.sample = true;
    } else if (a === '--resume') {
      args.resume = true;
    } else if (a === '--dry-run') {
      args.dryRun = true;
    } else if (a === '--relaxed') {
      args.relaxed = true;
    } else if (a === '--has-quotes' || a.startsWith('--has-quotes=')) {
      // 支持 `--has-quotes`（裸 flag）与 `--has-quotes=true`（显式写法）。
      // 仅 `--has-quotes=false` 才关闭；其余一律开启，确保生产机默认收窄作用域。
      const v = a.startsWith('--has-quotes=') ? a.split('=')[1] : 'true';
      args.hasQuotes = v !== 'false';
    } else if (a === '--help' || a === '-h') {
      console.log('用法: node scripts/backfillMoneyFlow.mjs [--limit N] [--sample] [--delay MS] [--resume] [--dry-run] [--has-quotes[=true|false]] [--batch-size N] [--relaxed]');
      process.exit(0);
    }
  }
  return args;
}

const t0 = Date.now();
const el = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const log = (...a) => console.log(`[${el()}]`, ...a);

const args = parseArgs(process.argv.slice(2));
log('money_flow 真实历史回填启动', { ...args, dbPath: env.DB_PATH });

const db = await openDatabase(env.DB_PATH);
initSchema(db); // 幂等建表，脚本独立可跑（避免存量库缺表）
log(`DB 已打开：${env.DB_PATH}`);

// 作用域：默认全量股票；--has-quotes 时收窄为「有日行情（daily_quotes 中存在）」的标的。
const codesSql = args.hasQuotes
  ? "SELECT code FROM securities WHERE type = 'stock' AND code IN (SELECT DISTINCT code FROM daily_quotes) ORDER BY code"
  : "SELECT code FROM securities WHERE type = 'stock' ORDER BY code";
let codes = db.all(codesSql).map((r) => r.code);
log(`securities 中股票数：${codes.length}${args.hasQuotes ? '（--has-quotes 作用域：仅含日行情标的）' : ''}`);

if (args.limit > 0) codes = codes.slice(0, args.limit);
if (args.sample) {
  const k = Math.min(50, codes.length);
  const shuffled = [...codes].sort(() => Math.random() - 0.5);
  codes = shuffled.slice(0, k);
}
log(`本次回填目标：${codes.length} 只${args.sample ? '（随机抽样）' : ''}${args.limit > 0 ? '（--limit 裁剪）' : ''}`);

if (codes.length === 0) {
  log('无可回填标的（securities 为空？请先 npm run seed）');
  process.exit(0);
}

const provider = (() => {
  // 宽松模式（--relaxed）：放宽熔断阈值/退避/并发，配代理池时减少瞬时抖动误触熔断
  if (args.relaxed) {
    const client = createEmClient({
      breakerThreshold: 20,
      breakerCooldownMs: 60000,
      retries: 3,
      retryBaseMs: 1500,
      maxConcurrency: 2,
      endpointQps: 1,
      qps: 2,
    });
    return createEastmoneyProvider(db, { client });
  }
  return createEastmoneyProvider(db);
})();
if (args.relaxed) {
  log('宽松模式已启用：breakerThreshold=20, cooldown=60s, retries=3, retryBase=1.5s, maxConcurrency=2');
}
const poolStats = getProxyPoolStats();
if (poolStats.enabled) {
  log('代理池已配置', { quota: poolStats.quota, failThreshold: poolStats.failThreshold, proxies: poolStats.urls.map((u) => u.url) });
} else if (String(env.EM_USE_PROXY || '') === 'true') {
  log('代理池未配置（EM_PROXY_LIST 为空），本次回填走直连');
}

const summary = await backfillAll(db, provider, codes, {
  batchSize: args.batchSize,
  delayMs: args.delay,
  resume: args.resume,
  dryRun: args.dryRun,
  onProgress: (info) => {
    log(`进度 ${info.done}/${info.total} (${info.percent}%) 本批 ${info.batchCostMs}ms 累计 ${info.accCostMs}ms`);
  },
});

log('回填完成', summary);

// 回填后打印 emClient 统计 + 代理池状态（监控熔断 trips 是否归零 / 各出口使用量）
try {
  const stats = provider.client.getStats();
  log('emClient 统计', {
    requests: stats.requests,
    ok: stats.ok,
    failed: stats.failed,
    shortCircuited: stats.shortCircuited,
    breakerTrips: stats.breaker.trips,
    breakerOpen: stats.breaker.open,
    lastError: stats.lastError,
  });
  const ps = getProxyPoolStats();
  if (ps.enabled) {
    log('代理池出口使用', ps.urls.map((u) => `${u.url}: req=${u.requests} fail=${u.failures} cooling=${u.cooling}`));
  }
} catch (_) { /* 统计打印失败不影响主流程 */ }

db.close();
process.exit(0);
