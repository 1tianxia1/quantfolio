// ============================================================
// holdings / target_allocations / user_settings 数据访问
// ============================================================

/**
 * 把用户输入的证券代码清洗成纯代码（去掉空格、中文、特殊符号）。
 * 支持 A 股/基金/可转债（6 位数字）以及港股代码（字母数字混合）。
 * 例如 "000539 粤电力Ａ" → "000539"，"00700.HK" → "00700"。
 * @param {string|null|undefined} code
 * @returns {string|null}
 */
function normalizeCode(code) {
  if (code == null || code === '') return null;
  const m = String(code).match(/[A-Za-z0-9]+/);
  return m ? m[0].toUpperCase() : null;
}

/**
 * 组合模型工厂
 * @param {import('../db/driver.js').Database} db
 */
export function createPortfolioModel(db) {
  return {
    // ---------- holdings ----------
    listHoldings(userId, assetClass) {
      if (assetClass) {
        return db.all('SELECT * FROM holdings WHERE user_id IS ? AND asset_class = ? ORDER BY id', [userId, assetClass]);
      }
      return db.all('SELECT * FROM holdings WHERE user_id IS ? ORDER BY id', [userId]);
    },

    getHolding(userId, id) {
      return db.get('SELECT * FROM holdings WHERE user_id IS ? AND id = ?', [userId, id]);
    },

    findHoldingByCode(userId, code) {
      const normalized = normalizeCode(code);
      if (!normalized) return null;
      return db.get('SELECT * FROM holdings WHERE user_id IS ? AND code IS ?', [userId, normalized]);
    },

    createHolding(userId, { code, name, asset_class, quantity, cost_price, current_price, profit, profit_rate, day_profit, day_profit_rate }) {
      const r = db.run(
        `INSERT INTO holdings (user_id, code, name, asset_class, quantity, cost_price, current_price, profit, profit_rate, day_profit, day_profit_rate)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [userId, normalizeCode(code), name, asset_class, quantity, cost_price ?? 0,
         current_price != null && Number.isFinite(Number(current_price)) ? Number(current_price) : null,
         profit != null && Number.isFinite(Number(profit)) ? Number(profit) : null,
         profit_rate != null && Number.isFinite(Number(profit_rate)) ? Number(profit_rate) : null,
         day_profit != null && Number.isFinite(Number(day_profit)) ? Number(day_profit) : null,
         day_profit_rate != null && Number.isFinite(Number(day_profit_rate)) ? Number(day_profit_rate) : null],
      );
      return this.getHolding(userId, Number(r.lastInsertRowid));
    },

    updateHolding(userId, id, { code, name, asset_class, quantity, cost_price, current_price, profit, profit_rate, day_profit, day_profit_rate }) {
      db.run(
        `UPDATE holdings SET code = ?, name = ?, asset_class = ?, quantity = ?, cost_price = ?,
                current_price = ?, profit = ?, profit_rate = ?, day_profit = ?, day_profit_rate = ?,
                updated_at = datetime('now')
         WHERE user_id IS ? AND id = ?`,
        [normalizeCode(code), name, asset_class, quantity, cost_price ?? 0,
         current_price != null && Number.isFinite(Number(current_price)) ? Number(current_price) : null,
         profit != null && Number.isFinite(Number(profit)) ? Number(profit) : null,
         profit_rate != null && Number.isFinite(Number(profit_rate)) ? Number(profit_rate) : null,
         day_profit != null && Number.isFinite(Number(day_profit)) ? Number(day_profit) : null,
         day_profit_rate != null && Number.isFinite(Number(day_profit_rate)) ? Number(day_profit_rate) : null,
         userId, id],
      );
      return this.getHolding(userId, id);
    },

    deleteHolding(userId, id) {
      db.run('DELETE FROM holdings WHERE user_id IS ? AND id = ?', [userId, id]);
    },

    // ---------- target_allocations ----------
    listTargets(userId, dimension) {
      if (dimension) {
        return db.all('SELECT * FROM target_allocations WHERE user_id IS ? AND dimension = ?', [userId, dimension]);
      }
      return db.all('SELECT * FROM target_allocations WHERE user_id IS ?', [userId]);
    },

    /** 覆盖式保存某维度目标配置（先删后插，事务由调用方或此处完成） */
    replaceTargets(userId, dimension, items) {
      const tx = db.transaction(() => {
        db.run('DELETE FROM target_allocations WHERE user_id IS ? AND dimension = ?', [userId, dimension]);
        for (const it of items) {
          db.run(
            `INSERT INTO target_allocations (user_id, dimension, target_key, target_pct)
             VALUES (?, ?, ?, ?)`,
            [userId, dimension, it.target_key, it.target_pct],
          );
        }
      });
      tx();
    },

    // ---------- user_settings ----------
    getSettings(userId) {
      const row = db.get('SELECT * FROM user_settings WHERE user_id = ?', [userId]);
      if (row) return row;
      return {
        user_id: userId,
        rebalance_threshold: 5,
        active_dimension: 'asset_class',
        morning_loose_mode: 0,
      };
    },

    upsertSettings(userId, { rebalance_threshold, active_dimension, morning_loose_mode }) {
      const existing = db.get('SELECT user_id FROM user_settings WHERE user_id = ?', [userId]);
      if (existing) {
        db.run(
          `UPDATE user_settings SET
             rebalance_threshold = COALESCE(?, rebalance_threshold),
             active_dimension = COALESCE(?, active_dimension),
             morning_loose_mode = COALESCE(?, morning_loose_mode)
           WHERE user_id = ?`,
          [rebalance_threshold ?? null, active_dimension ?? null, morning_loose_mode ?? null, userId],
        );
      } else {
        db.run(
          `INSERT INTO user_settings (user_id, rebalance_threshold, active_dimension, morning_loose_mode)
           VALUES (?, ?, ?, ?)`,
          [userId, rebalance_threshold ?? 5, active_dimension ?? 'asset_class', morning_loose_mode ?? 0],
        );
      }
      return this.getSettings(userId);
    },

    /** demo 设置（游客默认值） */
    demoSettings() {
      return { rebalance_threshold: 5, active_dimension: 'asset_class', morning_loose_mode: 0 };
    },
  };
}
