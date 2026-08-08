// ============================================================
// ai_reports 缓存读写
// ============================================================

/**
 * AI 报告模型工厂
 * @param {import('../db/driver.js').Database} db
 */
export function createAiReportModel(db) {
  return {
    getCached(userId, reportType, refKey, tradeDate) {
      return db.get(
        `SELECT * FROM ai_reports WHERE user_id IS ? AND report_type = ? AND ref_key = ? AND trade_date = ?`,
        [userId, reportType, refKey, tradeDate],
      );
    },

    upsert(userId, reportType, refKey, tradeDate, content) {
      const existing = this.getCached(userId, reportType, refKey, tradeDate);
      if (existing) {
        db.run(
          `UPDATE ai_reports SET content = ?, created_at = datetime('now') WHERE id = ?`,
          [content, existing.id],
        );
        return this.getCached(userId, reportType, refKey, tradeDate);
      }
      const r = db.run(
        `INSERT INTO ai_reports (user_id, report_type, ref_key, trade_date, content)
         VALUES (?, ?, ?, ?, ?)`,
        [userId, reportType, refKey, tradeDate, content],
      );
      return this.getCached(userId, reportType, refKey, tradeDate) ||
        db.get('SELECT * FROM ai_reports WHERE id = ?', [Number(r.lastInsertRowid)]);
    },
  };
}
