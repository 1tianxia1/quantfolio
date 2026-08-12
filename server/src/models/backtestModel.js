// ============================================================
// backtests 表 CRUD（仅存汇总 + 参数，逐笔 trades 不入）
// params / summary / best_weights 以 JSON 字符串存储
// ============================================================

/** JSON 字符串化（已为字符串则原样返回） */
function jsonStr(v) {
  if (v === null || v === undefined) return null;
  return typeof v === 'string' ? v : JSON.stringify(v);
}

/**
 * 回测结果模型工厂
 * @param {import('../db/driver.js').Database} db
 */
export function createBacktestModel(db) {
  return {
    /**
     * 落库一条回测 / 调参记录
     * @param {object} row
     * @param {number|null} row.userId
     * @param {'backtest'|'tune'} row.kind
     * @param {string} row.model
     * @param {object|string} row.params
     * @param {object|string} row.summary
     * @param {string|null} [row.objective]
     * @param {object|string|null} [row.bestWeights]
     * @returns {number} 新记录 id
     */
    save({ userId, kind, model, params, summary, objective = null, bestWeights = null }) {
      const r = db.run(
        `INSERT INTO backtests (user_id, kind, model, params, summary, objective, best_weights)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          userId ?? null,
          kind,
          model,
          jsonStr(params),
          jsonStr(summary),
          objective ?? null,
          jsonStr(bestWeights),
        ],
      );
      return Number(r.lastInsertRowid);
    },

    /**
     * 列出某用户的回测/调参记录
     * @param {number|null} userId
     * @param {'backtest'|'tune'} [kind]
     */
    list(userId, kind) {
      if (kind) {
        return db.all(
          `SELECT * FROM backtests WHERE (user_id IS ? OR user_id IS NULL) AND kind = ? ORDER BY created_at DESC, id DESC`,
          [userId, kind],
        );
      }
      return db.all(
        `SELECT * FROM backtests WHERE user_id IS ? OR user_id IS NULL ORDER BY created_at DESC, id DESC`,
        [userId],
      );
    },

    /** 按 id 获取单条记录 */
    getById(id) {
      return db.get('SELECT * FROM backtests WHERE id = ?', [id]);
    },
  };
}
