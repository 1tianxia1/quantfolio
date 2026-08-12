// ============================================================
// 回填真实行情 + 重算派生表 —— CLI 入口
//
// 用法：
//   node scripts/refreshRealData.mjs                    # 全量（约 4.7 万只，耗时很长）
//   node scripts/refreshRealData.mjs --max 10           # 只回填前 10 只（小步验证）
//   node scripts/refreshRealData.mjs --max 200 --limit 60
//   DB_PATH=/tmp/copy.db node scripts/refreshRealData.mjs --max 10   # 指定库（演练用）
//
// 参数：
//   --max   N   最多回填多少只标的，0 或省略 = 全量
//   --limit N   每只标的拉取的日 K 根数，默认 250
//
// 注意：--max 只限制「回填」范围；派生表按语义必须整表重建，
//       因此重算阶段始终覆盖库内全部有行情的标的。
// ============================================================
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import env from '../server/src/config/env.js';
import { openDatabase, getDriverName } from '../server/src/db/driver.js';
import { initSchema } from '../server/src/db/schema.js';
import { refreshRealData } from '../server/src/services/realDataRefresher.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

/**
 * 解析形如 `--max 10` / `--max=10` 的命名参数
 * @param {string[]} argv 参数数组
 * @param {string} name 参数名（不含 --）
 * @param {number} fallback 缺省值
 * @returns {number} 解析结果
 */
function argNum(argv, name, fallback) {
  const flag = `--${name}`;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === flag) {
      const n = Number(argv[i + 1]);
      return Number.isFinite(n) ? n : fallback;
    }
    if (a.startsWith(`${flag}=`)) {
      const n = Number(a.slice(flag.length + 1));
      return Number.isFinite(n) ? n : fallback;
    }
  }
  return fallback;
}

/**
 * 解析数据库路径
 *
 * env.DB_PATH 默认值 `./data/quantfolio.db` 是**相对路径**，服务进程的 CWD 是
 * server/，而本脚本通常从项目根执行 —— 直接用相对路径会指到 `<root>/data/`
 * 这个空库上。因此相对路径一律按 server/ 解析，与服务进程保持同一个库。
 *
 * @returns {string} 绝对路径
 */
function resolveDbPath() {
  const p = env.DB_PATH;
  if (path.isAbsolute(p)) return p;
  return path.resolve(projectRoot, 'server', p);
}

async function main() {
  const max = argNum(process.argv, 'max', 0);
  const limit = argNum(process.argv, 'limit', 250);
  const dbPath = resolveDbPath();

  console.log('============================================================');
  console.log(' QuantFolio 真实行情回填 + 派生表重算');
  console.log('============================================================');
  console.log(`  数据源     : ${env.DATA_PROVIDER}`);
  console.log(`  数据库     : ${dbPath}`);
  console.log(`  回填范围   : ${max > 0 ? `前 ${max} 只` : '全量'}，每只 ${limit} 根日 K`);
  console.log('');

  const db = await openDatabase(dbPath);
  console.log(`  SQLite 驱动: ${getDriverName()}`);
  initSchema(db);

  try {
    const r = await refreshRealData(db, { max, limit });
    console.log('');
    console.log('------------------ 执行结果 ------------------');
    console.log(JSON.stringify(r, null, 2));
    console.log('-----------------------------------------------');
  } finally {
    db.close();
  }
}

main().catch((e) => {
  console.error('❌ 刷新失败:', e);
  process.exit(1);
});
