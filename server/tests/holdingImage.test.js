// ============================================================
// 持仓图片导入：名称→代码「精确匹配」回归测试（严过关/Yan）
//
// 锁定的缺陷（已修复）：
//   旧实现 lookupSecurityByName(db, name, assetClass) 使用 LIKE 模糊匹配，
//   会把 A 标的错串成 B 标的代码：
//     · 云南铜业                  → 误得 000060（中金岭南），应为 000878
//     · 鹏华国证有色金属行业ETF联接C → 误得 华宝系某有色 ETF 的代码，应留空
//   现实现 lookupSecurityByNameExact(db, name) 仅做精确匹配，
//   匹配不到就返回 null（code 留空由用户补齐），宁可不填也不串码。
//
// 本用例刻意植入「诱饵行」（decoy）——即当年模糊匹配会命中的那些行——
// 若日后有人把模糊匹配改回来，这些断言会立刻变红。
// 测试自建内存库，不依赖 data/quantfolio.db。
// ============================================================
import { describe, it, expect, beforeAll } from 'vitest';
import { openMemoryDatabase } from '../src/db/driver.js';
import { initSchema } from '../src/db/schema.js';
import { lookupSecurityByNameExact } from '../src/services/holdingImageService.js';

let db;

/** 插入一行 securities（补齐 NOT NULL 列） */
function seedSecurity({ code, name, market, type, board }) {
  db.run(
    `INSERT INTO securities (code, name, market, type, board, price_limit_pct, data_origin)
     VALUES (?, ?, ?, ?, ?, 10, 'real')`,
    [code, name, market, type, board],
  );
}

beforeAll(async () => {
  db = await openMemoryDatabase();
  initSchema(db);

  // —— 目标行 ——
  seedSecurity({ code: '000878', name: '云南铜业', market: 'SZ', type: 'stock', board: 'SZ-Main10' });
  seedSecurity({ code: '518880', name: '华安黄金ETF', market: 'SH', type: 'fund', board: 'SH-Fund' });
  // A/C 份额后缀剥离用（服务内会把「…联接A」再试一次「…联接」）
  seedSecurity({ code: '008701', name: '华夏黄金ETF联接', market: 'SH', type: 'fund', board: 'SH-Fund' });

  // —— 诱饵行：旧模糊匹配正是错命中这些 ——
  // 中金岭南：与「云南铜业」同属有色板块，旧实现曾把云南铜业串成 000060
  seedSecurity({ code: '000060', name: '中金岭南', market: 'SZ', type: 'stock', board: 'SZ-Main10' });
  // 华宝系有色 ETF 联接 C：与「鹏华国证有色金属行业ETF联接C」共享「有色金属ETF联接C」子串，
  // 旧实现曾把鹏华的持仓串成华宝的代码。（代码值仅为夹具，用于证明「不应被命中」）
  seedSecurity({ code: '162411', name: '华宝中证有色金属ETF联接C', market: 'SZ', type: 'fund', board: 'SZ-Fund' });
});

describe('lookupSecurityByNameExact —— 精确匹配回填（防串码）', () => {
  it('断言1：云南铜业 → 000878（不得串成诱饵 000060 中金岭南）', () => {
    const r = lookupSecurityByNameExact(db, '云南铜业');
    expect(r).not.toBeNull();
    expect(r.code).toBe('000878');
    // 反向守卫：明确不是当年那个错码
    expect(r.code).not.toBe('000060');
  });

  it('断言2：鹏华国证有色金属行业ETF联接C → null（库中无此名，不得串成华宝 162411）', () => {
    const r = lookupSecurityByNameExact(db, '鹏华国证有色金属行业ETF联接C');
    expect(r).toBeNull();
  });

  it('断言3：华安黄金ETF → 518880（精确命中已播种基金）', () => {
    const r = lookupSecurityByNameExact(db, '华安黄金ETF');
    expect(r).not.toBeNull();
    expect(r.code).toBe('518880');
  });

  it('断言4：黄金ETF华安 → null（词序不同即不匹配，证明无模糊匹配）', () => {
    // 与已播种的「华安黄金ETF」字符集完全相同、仅词序不同；
    // 任何 LIKE/包含式匹配都可能命中，精确匹配必须返回 null。
    const r = lookupSecurityByNameExact(db, '黄金ETF华安');
    expect(r).toBeNull();
  });
});

describe('lookupSecurityByNameExact —— 核心不变量（与实现策略无关的防串码保险）', () => {
  // 上面的「诱饵」断言依赖于对旧模糊实现匹配键的假设；本仓库无 git 历史可复原旧代码，
  // 因此再加一条与实现策略无关的不变量：
  //   凡有返回，其 name 必须严格等于查询名（或等于剥离 A/B/C 份额后缀后的名）。
  // 任何模糊/包含式匹配只要对下列任一名称返回了「名字对不上」的行，此断言立即变红。
  const OCR_NAMES = [
    '鹏华国证有色金属行业ETF联接C',
    '云南铜业',
    '华安黄金ETF',
    '黄金ETF华安',
    '华宝中证有色金属ETF联接C',
    '有色金属',
    '中金岭南A',
    '华夏黄金ETF联接A',
    '铜业',
    '华安',
    'ETF',
    '联接C',
  ];

  it.each(OCR_NAMES)('「%s」的返回结果名称必须与查询名（或其剥离后缀名）完全一致', (queryName) => {
    const r = lookupSecurityByNameExact(db, queryName);
    if (r === null) return; // 匹配不到 → 留空，符合预期
    const stripped = queryName.replace(/[ＡＢＣABC]$/g, '').trim();
    // 绝不允许返回一个「名字对不上」的证券——那就是串码
    expect([queryName, stripped]).toContain(r.name);
  });

  it('返回的 code 必须真属于该 name（code 与 name 不得错配）', () => {
    for (const queryName of OCR_NAMES) {
      const r = lookupSecurityByNameExact(db, queryName);
      if (!r) continue;
      const row = db.get('SELECT code FROM securities WHERE name = ? LIMIT 1', [r.name]);
      expect(row.code).toBe(r.code);
    }
  });
});

describe('lookupSecurityByNameExact —— 边界与既有行为', () => {
  it('A/C 份额后缀剥离后仍是「精确」二次查找：华夏黄金ETF联接A → 008701', () => {
    const r = lookupSecurityByNameExact(db, '华夏黄金ETF联接A');
    expect(r).not.toBeNull();
    expect(r.code).toBe('008701');
  });

  it('后缀剥离不得成为串码后门：华宝中证有色金属ETF联接C 精确命中自身 162411', () => {
    // 该名本身在库中精确存在 → 必须命中自身，而不是被剥成「…联接」后另寻他人
    const r = lookupSecurityByNameExact(db, '华宝中证有色金属ETF联接C');
    expect(r.code).toBe('162411');
  });

  it('库中不存在的名称一律返回 null（留空由用户补齐）', () => {
    expect(lookupSecurityByNameExact(db, '完全不存在的某只基金XYZ')).toBeNull();
  });

  it('空字符串/未知名称不抛异常', () => {
    expect(() => lookupSecurityByNameExact(db, '')).not.toThrow();
    expect(lookupSecurityByNameExact(db, '')).toBeNull();
  });
});
