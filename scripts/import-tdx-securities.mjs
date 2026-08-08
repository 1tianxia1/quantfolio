// ============================================================
// 从通达信连接器批量灌入真实证券到本地 securities 表（data_origin='real'）
//
// 数据准备（在 WorkBuddy 侧用 tdx_screener / tdx_lookup_stock 取数，
// 把每页的 data 数组原样保存为 scripts/_tdx_import/<类型>_p<页>.json）：
//   A 股 : tdx_screener(message="全部A股", rang="AG", pageSize=500, pageNo=N)  -> 文件名 ag_pN.json
//   基金 : tdx_screener(message="全部ETF",  rang="JJ", pageSize=500, pageNo=N)  -> 文件名 jj_pN.json
//   指数 : tdx_screener(message="全部指数",  rang="ZS", pageSize=500, pageNo=N)  -> 文件名 zs_pN.json
//   单只 : tdx_lookup_stock(query="600519") 的 retrieved_entities -> 文件名 lookup_pN.json
//
// 用法: node scripts/import-tdx-securities.mjs [importDir]
// 幂等：冲突代码 DO NOTHING，可重复运行。
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../server/src/db/driver.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const importDir = process.argv[2] || path.resolve(__dirname, '_tdx_import');
const DB_PATH = process.env.DB_PATH || path.resolve(projectRoot, 'server/data/quantfolio.db');

/** 由文件名前缀判定默认类型（lookup_ 由 entity_type 推断） */
function typeFromFilename(name) {
  if (/^ag_/i.test(name)) return 'stock';
  if (/^jj_/i.test(name)) return 'fund';
  if (/^zs_/i.test(name)) return 'index';
  return null;
}

/** 由代码前缀推断市场（SH/SZ/BJ），与 seed 约定一致 */
function marketFromCode(code, type) {
  if (type === 'index') return /^000/.test(code) ? 'SH' : 'SZ';
  if (/^[569]/.test(code) || /^900/.test(code) || /^688|^601|^603|^600|^604|^605|^689/.test(code)) return 'SH';
  if (/^[84]/.test(code) || /^920/.test(code)) return 'BJ';
  return 'SZ';
}

/** 由代码前缀推断板块与涨跌停幅度 */
function boardPrice(code, type, name) {
  if (type === 'fund') return { board: 'ETF', price_limit_pct: 10 };
  if (type === 'index') return { board: 'IDX', price_limit_pct: 10 };
  const isST = /ST/i.test(name || '');
  if (/^688|^689/.test(code)) return { board: 'STAR20', price_limit_pct: 20 };
  if (/^30|^301/.test(code)) return { board: 'ChiNext20', price_limit_pct: 20 };
  if (/^8|^4|^920/.test(code)) return { board: 'BSE30', price_limit_pct: 30 };
  if (/^60/.test(code)) return { board: 'SH-Main10', price_limit_pct: 10 };
  if (/^000|^001|^002|^003/.test(code)) return { board: 'SZ-Main10', price_limit_pct: 10 };
  return { board: 'SZ-Main10', price_limit_pct: isST ? 5 : 10 };
}

/** 归一化单条记录为插入行；无法识别则返回 null */
function normalize(rec, fallbackType) {
  let code, name, type;
  if (Array.isArray(rec)) {
    code = rec[0]; name = rec[1];
  } else {
    code = rec.sec_code || rec.entity_code || rec.code || null;
    name = rec.sec_name || rec.entity_name || rec.name || null;
    if (rec.entity_type) {
      const t = String(rec.entity_type);
      type = /基金|fund|ETF|LOF/i.test(t) ? 'fund' : /指数|index/i.test(t) ? 'index' : 'stock';
    }
  }
  if (!code || !name) return null;
  type = type || fallbackType || 'stock';
  const bp = boardPrice(String(code), type, String(name));
  return {
    code: String(code),
    name: String(name),
    type,
    market: marketFromCode(String(code), type),
    board: bp.board,
    price_limit_pct: bp.price_limit_pct,
    is_st: /ST/i.test(String(name)) ? 1 : 0,
  };
}

async function main() {
  if (!fs.existsSync(importDir)) {
    console.error('导入目录不存在:', importDir);
    process.exit(1);
  }
  const files = fs.readdirSync(importDir).filter((f) => /\.json$/i.test(f)).sort();
  console.log(`读取 ${files.length} 个导入文件 from ${importDir}`);

  const rows = [];
  for (const f of files) {
    const type = typeFromFilename(f);
    const arr = JSON.parse(fs.readFileSync(path.join(importDir, f), 'utf8'));
    let count = 0;
    for (const rec of arr) {
      const n = normalize(rec, type);
      if (n) { rows.push(n); count++; }
    }
    console.log(`  ${f}: ${count} 条`);
  }
  console.log(`合计 ${rows.length} 条待写入`);

  const db = await openDatabase(DB_PATH);
  let inserted = 0;
  let skipped = 0;
  const tx = db.transaction(() => {
    for (const r of rows) {
      const res = db.run(
        `INSERT INTO securities (code, name, market, type, board, price_limit_pct, is_st, is_index_member, data_origin)
         VALUES (?,?,?,?,?,?,?,?,?)
         ON CONFLICT(code) DO NOTHING`,
        [r.code, r.name, r.market, r.type, r.board, r.price_limit_pct, r.is_st, 0, 'real'],
      );
      if (res.changes > 0) inserted += 1; else skipped += 1;
    }
  });
  tx();
  db.close();
  console.log(`写入完成: 新增 ${inserted}, 已存在跳过 ${skipped}`);
}

main().catch((e) => { console.error('导入失败:', e); process.exit(1); });
