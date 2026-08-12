// ============================================================
// watchlist 自选股 CRUD + 分组管理 + 实时行情 JOIN
// ============================================================

/**
 * 自选股模型工厂
 * @param {import('../db/driver.js').Database} db
 */
export function createWatchlistModel(db) {
  return {
    // ---------- 分组 ----------
    listGroups(userId) {
      return db.all(
        `SELECT id, user_id, name, category, created_at
         FROM watchlist_groups WHERE user_id = ? ORDER BY id`,
        [userId],
      );
    },

    createGroup(userId, name, category = 'all') {
      const r = db.run(
        `INSERT INTO watchlist_groups (user_id, name, category) VALUES (?, ?, ?)
         ON CONFLICT(user_id, name) DO NOTHING`,
        [userId, name, category],
      );
      if (r.changes === 0) {
        return db.get('SELECT * FROM watchlist_groups WHERE user_id = ? AND name = ?', [userId, name]);
      }
      return db.get('SELECT * FROM watchlist_groups WHERE id = ?', [Number(r.lastInsertRowid)]);
    },

    deleteGroup(userId, id) {
      // 该组下标的 group_id 置 NULL（回到「未分组」）
      db.run('UPDATE watchlist SET group_id = NULL WHERE user_id = ? AND group_id = ?', [userId, id]);
      db.run('DELETE FROM watchlist_groups WHERE user_id = ? AND id = ?', [userId, id]);
    },

    renameGroup(userId, id, name) {
      db.run('UPDATE watchlist_groups SET name = ? WHERE user_id = ? AND id = ?', [name, userId, id]);
      return db.get('SELECT * FROM watchlist_groups WHERE id = ?', [id]);
    },

    // ---------- 自选列表（含最新行情） ----------
    list(userId, { category, groupId } = {}) {
      const where = ['w.user_id = ?'];
      const params = [userId];
      if (category) {
        where.push('w.category = ?');
        params.push(category);
      }
      if (groupId != null) {
        where.push('(w.group_id = ? OR (w.group_id IS NULL AND ? = 1))');
        params.push(groupId, groupId == null ? 1 : 0);
      }
      return db.all(
        `SELECT w.id, w.user_id, w.code, w.group_id, w.note, w.created_at,
                s.name, s.type, s.sector,
                dq.close AS latest_close, dq.pre_close, dq.pct_chg, dq.volume, dq.amount,
                dq.trade_date AS quote_date
         FROM watchlist w
         LEFT JOIN securities s ON s.code = w.code
         LEFT JOIN daily_quotes dq ON dq.code = w.code
            AND dq.trade_date = (SELECT MAX(trade_date) FROM daily_quotes WHERE code = w.code)
         WHERE ${where.join(' AND ')}
         ORDER BY w.id DESC`,
        params,
      );
    },

    add(userId, code, { category, groupId, note } = {}) {
      let cat = category;
      if (!cat) {
        const sec = db.get('SELECT type FROM securities WHERE code = ?', [code]);
        cat = sec && sec.type === 'fund' ? 'fund' : 'a_share';
      }
      const existing = db.get('SELECT * FROM watchlist WHERE user_id = ? AND code = ?', [userId, code]);
      if (existing) {
        // 已存在则补充分组/备注（幂等）
        if (groupId != null || note != null) {
          db.run(
            'UPDATE watchlist SET group_id = COALESCE(?, group_id), note = COALESCE(?, note), category = ? WHERE id = ?',
            [groupId ?? null, note ?? null, cat, existing.id],
          );
        }
        return existing;
      }
      const r = db.run(
        `INSERT INTO watchlist (user_id, code, category, group_id, note) VALUES (?, ?, ?, ?, ?)`,
        [userId, code, cat, groupId ?? null, note ?? null],
      );
      return db.get('SELECT * FROM watchlist WHERE id = ?', [Number(r.lastInsertRowid)]);
    },

    setGroup(userId, id, groupId) {
      db.run('UPDATE watchlist SET group_id = ? WHERE user_id = ? AND id = ?', [groupId ?? null, userId, id]);
    },

    updateNote(userId, id, note) {
      db.run('UPDATE watchlist SET note = ? WHERE user_id = ? AND id = ?', [note ?? '', userId, id]);
    },

    remove(userId, id) {
      db.run('DELETE FROM watchlist WHERE user_id = ? AND id = ?', [userId, id]);
    },
  };
}
