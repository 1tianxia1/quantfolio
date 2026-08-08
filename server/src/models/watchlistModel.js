// ============================================================
// watchlist 自选股 CRUD
// ============================================================

/**
 * 自选股模型工厂
 * @param {import('../db/driver.js').Database} db
 */
export function createWatchlistModel(db) {
  return {
    list(userId) {
      return db.all(
        `SELECT w.id, w.code, w.created_at, s.name, s.type, s.sector
         FROM watchlist w
         LEFT JOIN securities s ON s.code = w.code
         WHERE w.user_id = ? ORDER BY w.id DESC`,
        [userId],
      );
    },

    add(userId, code) {
      const existing = db.get('SELECT * FROM watchlist WHERE user_id = ? AND code = ?', [userId, code]);
      if (existing) return existing;
      const r = db.run('INSERT INTO watchlist (user_id, code) VALUES (?, ?)', [userId, code]);
      return db.get('SELECT * FROM watchlist WHERE id = ?', [Number(r.lastInsertRowid)]);
    },

    remove(userId, id) {
      db.run('DELETE FROM watchlist WHERE user_id = ? AND id = ?', [userId, id]);
    },
  };
}
