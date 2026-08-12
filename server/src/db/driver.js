// ============================================================
// 数据库驱动适配层 —— 全项目唯一允许 import better-sqlite3 的文件
//
// 降级链（按序尝试，Windows 原生模块失败时自动切换）：
//   1. better-sqlite3（同步原生模块，首选）
//   2. node:sqlite（Node >= 22.5 内置，零依赖）
//   3. sql.js（纯 JS 内存库 + 手动 flush 文件，最后兜底）
//
// 业务层只允许通过本文件暴露的 API 访问数据库：
//   db.exec(sql) / db.prepare(sql) / db.get(sql, params) /
//   db.all(sql, params) / db.run(sql, params) / db.transaction(fn) / db.pragma(sql)
// 约定：SQL 一律使用位置参数 `?`，参数传数组。
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

// 使用 createRequire 加载原生/内置模块，避免 Vite/Vitest 的 import 解析拦截
const require = createRequire(import.meta.url);

// 候选驱动（模块加载可能成功，但实例化时才暴露原生绑定缺失）
let betterModule = null;
let nodeSqliteModule = null;
let sqlJsModule = null;
let loadErrors = [];

try {
  betterModule = require('better-sqlite3');
} catch (e) {
  loadErrors.push(`better-sqlite3: ${e.message}`);
}

try {
  nodeSqliteModule = require('node:sqlite').DatabaseSync;
} catch (e) {
  loadErrors.push(`node:sqlite: ${e.message}`);
}

try {
  sqlJsModule = require('sql.js');
} catch (e) {
  loadErrors.push(`sql.js: ${e.message}`);
}

let DRIVER_NAME = 'none';

/** 候选列表（按优先级） */
function candidates() {
  const list = [];
  if (betterModule) list.push({ name: 'better-sqlite3', open: (fp) => new betterModule(fp) });
  if (nodeSqliteModule) list.push({ name: 'node:sqlite', open: (fp) => new nodeSqliteModule(fp) });
  return list;
}

/**
 * 统一的语句包装对象（屏蔽 better-sqlite3 / node:sqlite 差异）
 */
class Statement {
  constructor(stmt) {
    this.stmt = stmt;
  }

  get(...params) {
    return this.stmt.get(...params);
  }

  all(...params) {
    return this.stmt.all(...params);
  }

  /**
   * 流式迭代（逐行产出，不全量物化）—— 用于超大数据集扫描（如 264 万行 daily_quotes）
   * 原生 better-sqlite3 / node:sqlite 直接支持；sql.js 兜底路径退化为数组迭代（内存代价同 all）。
   * @returns {IterableIterator<object>}
   */
  iterate(...params) {
    if (typeof this.stmt.iterate === 'function') {
      return this.stmt.iterate(...params);
    }
    // 驱动不支持原生迭代（如 sql.js 兜底路径）：退化为数组迭代器
    return this.stmt.all(...params)[Symbol.iterator]();
  }

  run(...params) {
    const r = this.stmt.run(...params);
    return {
      changes: Number(r.changes ?? 0),
      lastInsertRowid: r.lastInsertRowid === undefined || r.lastInsertRowid === null
        ? null
        : Number(r.lastInsertRowid),
    };
  }
}

/**
 * 数据库句柄（统一 API）
 */
class Database {
  constructor(db, filepath, driverName) {
    this.db = db;
    this.filepath = filepath;
    this._driverName = driverName;
  }

  driverName() {
    return this._driverName;
  }

  exec(sql) {
    if (this._driverName === 'sql.js') {
      this.db.run(sql);
      return;
    }
    this.db.exec(sql);
  }

  prepare(sql) {
    if (this._driverName === 'sql.js') {
      return new Statement({
        get: (...p) => this._jsGet(sql, p),
        all: (...p) => this._jsAll(sql, p),
        run: (...p) => this._jsRun(sql, p),
      });
    }
    return new Statement(this.db.prepare(sql));
  }

  get(sql, params = []) {
    return this.prepare(sql).get(...params);
  }

  all(sql, params = []) {
    return this.prepare(sql).all(...params);
  }

  run(sql, params = []) {
    return this.prepare(sql).run(...params);
  }

  /**
   * 按 code 范围删除某张表的数据（用于「仅对同步标的做派生重算」时，
   * 不误删未同步标的的派生行）。分块执行以规避单条 IN 语句的绑定参数上限。
   * @param {string} table 表名（仅接受内部白名单，防注入）
   * @param {string[]} codes code 列表；空数组/undefined 时退化为整表删除
   */
  deleteByCodes(table, codes) {
    const ALLOWED = new Set([
      'tech_indicators', 'money_flow', 'auction_data', 'limit_records', 'hot_sectors',
    ]);
    if (!ALLOWED.has(table)) throw new Error(`deleteByCodes: 非法表名 ${table}`);
    if (!codes || !codes.length) {
      this.exec(`DELETE FROM ${table}`);
      return;
    }
    const CH = 400;
    for (let i = 0; i < codes.length; i += CH) {
      const slice = codes.slice(i, i + CH);
      const ph = slice.map(() => '?').join(',');
      this.run(`DELETE FROM ${table} WHERE code IN (${ph})`, slice);
    }
  }

  transaction(fn) {
    return (...args) => {
      this.exec('BEGIN');
      try {
        const result = fn(...args);
        this.exec('COMMIT');
        return result;
      } catch (e) {
        try { this.exec('ROLLBACK'); } catch (_) { /* 忽略回滚失败 */ }
        throw e;
      }
    };
  }

  pragma(sql) {
    return this.all(sql);
  }

  close() {
    if (this._driverName === 'sql.js') {
      this._flushJs();
    }
    if (this.db && typeof this.db.close === 'function') {
      this.db.close();
    }
  }

  // ---------- sql.js 专用（内存库 + 手动持久化） ----------
  _jsGet(sql, params) {
    const rows = this._jsAll(sql, params);
    return rows[0];
  }
  _jsAll(sql, params) {
    const stmt = this.db.prepare(sql);
    if (params && params.length) stmt.bind(params);
    const out = [];
    while (stmt.step()) out.push(stmt.getAsObject());
    stmt.free();
    return out;
  }
  _jsRun(sql, params) {
    const stmt = this.db.prepare(sql);
    if (params && params.length) stmt.bind(params);
    stmt.step();
    const changes = this.db.getRowsModified();
    const rows = this.db.exec('SELECT last_insert_rowid() AS id');
    const lastInsertRowid = rows?.[0]?.values?.[0]?.[0] ?? null;
    stmt.free();
    return { changes: Number(changes ?? 0), lastInsertRowid: lastInsertRowid === null ? null : Number(lastInsertRowid) };
  }
  _flushJs() {
    if (!this.filepath) return;
    const data = this.db.export();
    fs.mkdirSync(path.dirname(this.filepath), { recursive: true });
    fs.writeFileSync(this.filepath, Buffer.from(data));
  }
}

/**
 * 打开（或创建）数据库文件；按候选驱动依次尝试，全部失败则抛错
 * @param {string} filepath SQLite 文件路径
 */
export async function openDatabase(filepath) {
  if (!filepath) throw new Error('DB_PATH 未配置');
  fs.mkdirSync(path.dirname(filepath), { recursive: true });

  // sql.js 优先尝试（内存库 + 文件持久化）
  if (sqlJsModule && !betterModule && !nodeSqliteModule) {
    let db;
    if (fs.existsSync(filepath)) {
      const buf = fs.readFileSync(filepath);
      db = new sqlJsModule.Database(new Uint8Array(buf));
    } else {
      db = new sqlJsModule.Database();
    }
    DRIVER_NAME = 'sql.js';
    return new Database(db, filepath, 'sql.js');
  }

  // better-sqlite3 / node:sqlite 依次实例化（构造失败自动降级）
  let lastErr = null;
  for (const cand of candidates()) {
    try {
      const db = cand.open(filepath);
      DRIVER_NAME = cand.name;
      return new Database(db, filepath, cand.name);
    } catch (e) {
      lastErr = e;
      console.warn(`[driver] ${cand.name} 打开失败，尝试下一个驱动: ${e.message.split('\n')[0]}`);
    }
  }

  // sql.js 作为最后兜底
  if (sqlJsModule) {
    let db;
    if (fs.existsSync(filepath)) {
      const buf = fs.readFileSync(filepath);
      db = new sqlJsModule.Database(new Uint8Array(buf));
    } else {
      db = new sqlJsModule.Database();
    }
    DRIVER_NAME = 'sql.js';
    return new Database(db, filepath, 'sql.js');
  }

  throw new Error(`SQLite 驱动全部不可用：\n${loadErrors.join('\n')}\n${lastErr ? `最后错误: ${lastErr.message}` : ''}`);
}

/**
 * 内存数据库（供测试使用）
 */
export async function openMemoryDatabase() {
  if (sqlJsModule && !betterModule && !nodeSqliteModule) {
    return new Database(new sqlJsModule.Database(), null, 'sql.js');
  }
  let lastErr = null;
  for (const cand of candidates()) {
    try {
      const db = cand.open(':memory:');
      DRIVER_NAME = cand.name;
      return new Database(db, null, cand.name);
    } catch (e) {
      lastErr = e;
      console.warn(`[driver] ${cand.name} 内存库打开失败: ${e.message.split('\n')[0]}`);
    }
  }
  if (sqlJsModule) {
    return new Database(new sqlJsModule.Database(), null, 'sql.js');
  }
  throw new Error(`SQLite 驱动全部不可用：\n${loadErrors.join('\n')}\n${lastErr ? `最后错误: ${lastErr.message}` : ''}`);
}

/** 当前实际生效的驱动名 */
export function getDriverName() {
  return DRIVER_NAME;
}
