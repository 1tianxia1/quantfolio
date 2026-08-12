// ============================================================
// T4 验收：「保存为策略」落库链路（后端 model 层）
//
// 验证 strategyModel.create + list 全通：
//   · create 返回含 id 的行，type 正确；
//   · conditions 以 JSON 字符串入库，list 查回后可反序列化为原对象（含 weights/model）；
//   · 游客（userId=null）创建的私有策略可被 list(null, type) 查回。
// 前端接线工程师已验证构建通过，此处只验后端落库 + 读取。
// ============================================================
import { describe, it, expect, beforeAll } from 'vitest';
import { openMemoryDatabase } from '../src/db/driver.js';
import { initSchema } from '../src/db/schema.js';
import { createStrategyModel } from '../src/models/strategyModel.js';

let db;
let m;

beforeAll(async () => {
  db = await openMemoryDatabase();
  initSchema(db);
  m = createStrategyModel(db);
});

describe("保存为策略 落库链路", () => {
  it('create + list：conditions JSON 入库、反序列化、list 可查回', () => {
    const conditions = { weights: { trend: 0.3, momentum: 0.2 }, model: 'closing' };
    const row = m.create(null, { name: 'T4验证策略', type: 'closing', conditions });

    // 1) 返回行含 id 且 type 正确
    expect(row).toBeTruthy();
    expect(row.id).toBeTruthy();
    expect(typeof row.id).toBe('number');
    expect(row.type).toBe('closing');
    expect(row.name).toBe('T4验证策略');

    // 2) conditions 以 JSON 字符串入库，反序列化后结构一致
    expect(typeof row.conditions).toBe('string');
    const parsed = JSON.parse(row.conditions);
    expect(parsed).toEqual(conditions);
    expect(parsed.weights).toEqual({ trend: 0.3, momentum: 0.2 });
    expect(parsed.model).toBe('closing');

    // 3) list(null, 'closing') 能查回该策略
    const list = m.list(null, 'closing');
    expect(Array.isArray(list)).toBe(true);
    const found = list.find((s) => s.id === row.id);
    expect(found).toBeTruthy();
    expect(found.name).toBe('T4验证策略');
    expect(found.type).toBe('closing');
    // list 查回的 conditions 同样可反序列化
    expect(JSON.parse(found.conditions)).toEqual(conditions);
  });

  it('morning 类型同样落库 + 查回（多类型隔离）', () => {
    const row = m.create(null, {
      name: 'T4早盘策略',
      type: 'morning',
      conditions: { weights: { volume_ratio: 0.4, net_inflow: 0.3 }, model: 'morning' },
    });
    expect(row.id).toBeTruthy();
    expect(row.type).toBe('morning');

    // closing 列表不应包含 morning 策略
    const closingList = m.list(null, 'closing');
    expect(closingList.find((s) => s.id === row.id)).toBeUndefined();

    // morning 列表应包含
    const morningList = m.list(null, 'morning');
    expect(morningList.find((s) => s.id === row.id)).toBeTruthy();
  });

  it('conditions 传字符串不二次序列化（幂等）', () => {
    const json = JSON.stringify({ weights: { trend: 0.5 }, model: 'closing' });
    const row = m.create(null, { name: 'T4字符串条件', type: 'closing', conditions: json });
    expect(JSON.parse(row.conditions)).toEqual({ weights: { trend: 0.5 }, model: 'closing' });
  });
});
