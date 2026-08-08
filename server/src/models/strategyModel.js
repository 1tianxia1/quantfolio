// ============================================================
// strategies 表 CRUD（conditions 为 JSON 字符串）
// ============================================================

/**
 * 策略模型工厂
 * @param {import('../db/driver.js').Database} db
 */
export function createStrategyModel(db) {
  return {
    list(userId, type) {
      // 游客：只返回预置模板（user_id IS NULL）
      // 登录用户：预置模板 + 我的策略
      if (type) {
        return db.all(
          `SELECT * FROM strategies WHERE (user_id IS ? OR is_preset = 1) AND type = ? ORDER BY is_preset DESC, id`,
          [userId, type],
        );
      }
      return db.all(
        `SELECT * FROM strategies WHERE user_id IS ? OR is_preset = 1 ORDER BY is_preset DESC, id`,
        [userId],
      );
    },

    getById(userId, id) {
      return db.get('SELECT * FROM strategies WHERE (user_id IS ? OR is_preset = 1) AND id = ?', [userId, id]);
    },

    create(userId, { name, type, conditions }) {
      const r = db.run(
        `INSERT INTO strategies (user_id, name, type, conditions, is_preset)
         VALUES (?, ?, ?, ?, 0)`,
        [userId, name, type, typeof conditions === 'string' ? conditions : JSON.stringify(conditions)],
      );
      return this.getById(userId, Number(r.lastInsertRowid));
    },

    update(userId, id, { name, conditions }) {
      const existing = this.getById(userId, id);
      if (!existing) return null;
      if (existing.is_preset) return null; // 预置不可改
      db.run(
        `UPDATE strategies SET name = COALESCE(?, name), conditions = COALESCE(?, conditions),
                updated_at = datetime('now')
         WHERE id = ? AND user_id IS ?`,
        [name ?? null, conditions !== undefined ? (typeof conditions === 'string' ? conditions : JSON.stringify(conditions)) : null, id, userId],
      );
      return this.getById(userId, id);
    },

    delete(userId, id) {
      const existing = this.getById(userId, id);
      if (!existing) return false;
      if (existing.is_preset) return false; // 预置不可删
      db.run('DELETE FROM strategies WHERE id = ? AND user_id IS ?', [id, userId]);
      return true;
    },

    /** 预置策略（seed 阶段使用） */
    insertPreset({ name, type, conditions }) {
      const r = db.run(
        `INSERT INTO strategies (user_id, name, type, conditions, is_preset)
         VALUES (NULL, ?, ?, ?, 1)`,
        [name, type, typeof conditions === 'string' ? conditions : JSON.stringify(conditions)],
      );
      return Number(r.lastInsertRowid);
    },
  };
}
