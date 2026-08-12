// ============================================================
// 存量证券类型清洗脚本
//
// 历史问题：早期 guessType() 把「非基金」一律写成 type='stock'，导致 3 万多只
// 债券（国债/地方债/企业债/可转债）被错误标记为股票，screener 股票池从
// 约 5.5K 被撑到 36K+，漏斗第一步产生大量「数据缺失」淘汰记录。
//
// 本脚本先迁移 securities 表的 CHECK 约束以允许 'bond'/'other'，
// 再基于 codeUtil 的 A 股/基金/债券前缀规则把存量 type 纠正正确。
// ============================================================
import env from '../src/config/env.js';
import { openDatabase } from '../src/db/driver.js';
import { isAShareStockCode, isFundCode, isBondCode, tryNormalizeCode } from '../src/util/codeUtil.js';

const db = await openDatabase(env.DB_PATH);

function tableAllowsTypes(types) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='securities'").get();
  if (!row || !row.sql) return false;
  return types.every((t) => row.sql.includes(`'${t}'`));
}

// 1) 迁移：若旧表 CHECK 不包含 bond/other，则重建表以放开约束
if (!tableAllowsTypes(['bond', 'other'])) {
  console.log('检测到旧版 securities 表约束，执行迁移…');
  db.run('PRAGMA foreign_keys=OFF');
  const tx = db.transaction(() => {
    db.run('ALTER TABLE securities RENAME TO securities_old');
    db.run(`
      CREATE TABLE securities (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        code            TEXT NOT NULL UNIQUE,
        name            TEXT NOT NULL,
        market          TEXT NOT NULL CHECK (market IN ('SH','SZ','BJ')),
        type            TEXT NOT NULL CHECK (type IN ('stock','fund','index','bond','other')),
        board           TEXT NOT NULL,
        price_limit_pct REAL NOT NULL,
        industry        TEXT,
        sector          TEXT,
        list_date       TEXT,
        is_st           INTEGER NOT NULL DEFAULT 0 CHECK (is_st IN (0,1)),
        is_index_member INTEGER NOT NULL DEFAULT 0 CHECK (is_index_member IN (0,1)),
        index_name      TEXT,
        float_share     REAL,
        total_share     REAL,
        circ_mv         REAL,
        total_mv        REAL,
        pe_ttm          REAL,
        pb              REAL,
        dividend_yield  REAL,
        fund_category   TEXT,
        fund_track      TEXT,
        data_origin     TEXT NOT NULL DEFAULT 'real' CHECK (data_origin IN ('real','derived','mixed')),
        created_at      TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    db.run(`
      INSERT INTO securities SELECT
        id, code, name, market, type, board, price_limit_pct, industry, sector, list_date,
        is_st, is_index_member, index_name, float_share, total_share, circ_mv, total_mv,
        pe_ttm, pb, dividend_yield, fund_category, fund_track, data_origin, created_at
      FROM securities_old
    `);
    db.run('DROP TABLE securities_old');
    db.run('CREATE INDEX IF NOT EXISTS idx_sec_type ON securities(type)');
    db.run('CREATE INDEX IF NOT EXISTS idx_sec_sector ON securities(sector)');
    db.run('CREATE INDEX IF NOT EXISTS idx_sec_industry ON securities(industry)');
    db.run('CREATE INDEX IF NOT EXISTS idx_sec_mv ON securities(circ_mv)');
  });
  tx();
  db.run('PRAGMA foreign_keys=ON');
  console.log('表迁移完成');
}

const before = db.prepare('SELECT type, COUNT(*) AS n FROM securities GROUP BY type').all();
console.log('清洗前:', before);

// 2) 按代码前缀重新归类
const rows = db.prepare('SELECT code, type FROM securities').all();
let updated = 0;
let unchanged = 0;
const tx2 = db.transaction(() => {
  const stmt = db.prepare('UPDATE securities SET type = ? WHERE code = ?');
  for (const { code, type } of rows) {
    const c = tryNormalizeCode(code);
    if (!c) continue;
    let expected = type;
    if (isAShareStockCode(c)) expected = 'stock';
    else if (isFundCode(c)) expected = 'fund';
    else if (isBondCode(c)) expected = 'bond';
    else expected = 'other';
    if (expected !== type) {
      stmt.run(expected, code);
      updated += 1;
    } else {
      unchanged += 1;
    }
  }
});
tx2();

const after = db.prepare('SELECT type, COUNT(*) AS n FROM securities GROUP BY type').all();
console.log('清洗后:', after);
console.log(`更新 ${updated} 条，未变 ${unchanged} 条`);
process.exit(0);
