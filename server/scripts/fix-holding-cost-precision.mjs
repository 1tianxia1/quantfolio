// ============================================================
// 修复：券商截图导入导致的「成本价精度丢失」
//
// 背景
//   同花顺等券商 App 的「成本/现价」列只展示 3 位小数（如 5.966），
//   但其内部成本价是更高精度的值（5.9662）。图片 OCR 导入把展示值
//   原样写入 holdings.cost_price 后，累计盈亏就会和券商对不上：
//     (6.01 - 5.966 ) × 100 = 4.40   ← 我们（错）
//     (6.01 - 5.9662) × 100 = 4.38   ← 券商（对）
//
// 原理
//   截图里的「盈亏」是券商用高精度成本算出来的，精度没有丢，
//   因此可以反解出真实成本价：
//     cost_price = current_price - profit / quantity
//
// 用法
//   node scripts/fix-holding-cost-precision.mjs                 # 预演（dry-run，不写库）
//   node scripts/fix-holding-cost-precision.mjs --apply         # 实际写库
//
// 特性
//   - 幂等：已经是目标值的行会被跳过
//   - 只 UPDATE cost_price，不删除、不新增任何数据
//   - 覆盖所有用户桶（含游客桶 user_id IS NULL），避免「只修了一个桶」
// ============================================================
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, '../data/quantfolio.db');

/**
 * 待修复清单：以「券商截图上的盈亏」为事实来源反解精确成本价。
 * 新增条目时照抄这个结构即可，脚本会自动算出 cost_price。
 * @type {Array<{code: string, name: string, current_price: number, profit: number, quantity: number, source: string}>}
 */
const REPAIRS = [
  {
    code: '000539',
    name: '粤电力A',
    current_price: 6.01, // 截图现价
    profit: 4.38,        // 截图累计盈亏（高精度口径）
    quantity: 100,       // 截图持仓数量
    source: '同花顺持仓截图 2026-08-08',
  },
];

/** 四舍五入到 n 位（与 server/src/util/money.js 的 round 保持一致） */
function round(value, n = 4) {
  const factor = 10 ** n;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

/**
 * 打开数据库（与 server/src/db/driver.js 的降级链一致：better-sqlite3 → node:sqlite）
 * @param {boolean} readonly
 */
function openDb(readonly) {
  try {
    const BetterSqlite3 = require('better-sqlite3');
    const db = new BetterSqlite3(DB_PATH, { readonly });
    return {
      name: 'better-sqlite3',
      all: (sql, p = []) => db.prepare(sql).all(...p),
      run: (sql, p = []) => db.prepare(sql).run(...p),
      close: () => db.close(),
    };
  } catch {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(DB_PATH, { readOnly: readonly });
    return {
      name: 'node:sqlite',
      all: (sql, p = []) => db.prepare(sql).all(...p),
      run: (sql, p = []) => db.prepare(sql).run(...p),
      close: () => db.close(),
    };
  }
}

function main() {
  const apply = process.argv.includes('--apply');
  const db = openDb(!apply);

  console.log(`DB     = ${DB_PATH}`);
  console.log(`driver = ${db.name}`);
  console.log(`mode   = ${apply ? 'APPLY（写库）' : 'DRY-RUN（预演，加 --apply 才写库）'}`);

  let changed = 0;
  let skipped = 0;

  for (const r of REPAIRS) {
    // 反解精确成本价：cost = 现价 − 盈亏/数量
    const targetCost = round(r.current_price - r.profit / r.quantity, 4);
    console.log(`\n── ${r.code} ${r.name} ──`);
    console.log(`   来源      : ${r.source}`);
    console.log(`   反解成本价: ${r.current_price} - ${r.profit}/${r.quantity} = ${targetCost}`);

    const rows = db.all(
      'SELECT id, user_id, name, quantity, cost_price FROM holdings WHERE code = ? ORDER BY id',
      [r.code],
    );
    if (rows.length === 0) {
      console.log('   ⚠ 未找到任何持仓行');
      continue;
    }

    for (const row of rows) {
      const bucket = row.user_id === null ? 'guest(NULL)' : `user_id=${row.user_id}`;
      if (round(row.cost_price, 4) === targetCost) {
        console.log(`   ✓ id=${row.id} ${bucket} 已是 ${targetCost}，跳过`);
        skipped += 1;
        continue;
      }
      const profitBefore = round((r.current_price - row.cost_price) * row.quantity, 4);
      const profitAfter = round((r.current_price - targetCost) * row.quantity, 4);
      console.log(
        `   ${apply ? '→' : '·'} id=${row.id} ${bucket} cost_price ${row.cost_price} → ${targetCost}` +
          `（盈亏 ${profitBefore} → ${profitAfter}）`,
      );
      if (apply) {
        db.run("UPDATE holdings SET cost_price = ?, updated_at = datetime('now') WHERE id = ?", [
          targetCost,
          row.id,
        ]);
      }
      changed += 1;
    }
  }

  console.log(`\n合计：${apply ? '已更新' : '待更新'} ${changed} 行，跳过 ${skipped} 行`);
  db.close();
}

main();
