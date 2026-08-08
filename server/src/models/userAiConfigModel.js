// ============================================================
// user_ai_config 表 CRUD（「自定义模型」功能）
// 安全约定：api_key 明文存于本地 SQLite（个人本地应用）；
//  读取时绝不回传明文，只返回 hasKey 与掩码预览（api_key_masked）。
// ============================================================

/**
 * 用户 AI 配置模型工厂
 * @param {import('../db/driver.js').Database} db
 */
export function createUserAiConfigModel(db) {
  /** api_key 掩码：保留前 3 后 4，中间打码 */
  function maskKey(key) {
    if (!key) return '';
    if (key.length <= 8) return '****';
    return `${key.slice(0, 3)}${'*'.repeat(Math.max(4, key.length - 7))}${key.slice(-4)}`;
  }

  return {
    /** 取用户配置（已脱敏，不含明文 key） */
    get(userId) {
      if (!userId) return null;
      const row = db.get(
        'SELECT user_id, provider, api_key, base_url, model, api_style, updated_at FROM user_ai_config WHERE user_id = ?',
        [userId],
      );
      if (!row) return null;
      return {
        userId: row.user_id,
        provider: row.provider || 'custom',
        apiKeyMasked: row.api_key ? maskKey(row.api_key) : '',
        hasKey: !!row.api_key,
        baseUrl: row.base_url || '',
        model: row.model || '',
        apiStyle: row.api_style || 'openai',
        updatedAt: row.updated_at,
      };
    },

    /**
     * 取用户原始配置（含明文 api_key）——仅供服务端内部调用 AI 使用，绝不外传前端。
     * @param {number} userId
     * @returns {{provider:string, apiKey:string|null, baseUrl:string, model:string, apiStyle:string}|null}
     */
    getRaw(userId) {
      if (!userId) return null;
      const row = db.get(
        'SELECT provider, api_key, base_url, model, api_style FROM user_ai_config WHERE user_id = ?',
        [userId],
      );
      if (!row) return null;
      return {
        provider: row.provider || 'custom',
        apiKey: row.api_key || null,
        baseUrl: row.base_url || '',
        model: row.model || '',
        apiStyle: row.api_style || 'openai',
      };
    },

    /**
     * 保存（upsert）。apiKey 为 null/空串表示「保留原 Key 不变」（用于只改模型/厂商的场景）。
     * @param {number} userId
     * @param {{provider?:string, apiKey?:string|null, baseUrl?:string, model?:string, apiStyle?:string}} data
     */
    upsert(userId, data = {}) {
      const existing = db.get('SELECT api_key FROM user_ai_config WHERE user_id = ?', [userId]);
      const apiKey = data.apiKey === undefined || data.apiKey === null || data.apiKey === ''
        ? (existing ? existing.api_key : null)
        : data.apiKey;

      if (existing) {
        db.run(
          `UPDATE user_ai_config SET
             provider = COALESCE(?, provider),
             api_key = ?,
             base_url = COALESCE(?, base_url),
             model = COALESCE(?, model),
             api_style = COALESCE(?, api_style),
             updated_at = datetime('now')
           WHERE user_id = ?`,
          [data.provider ?? null, apiKey, data.baseUrl ?? null, data.model ?? null, data.apiStyle ?? null, userId],
        );
      } else {
        db.run(
          `INSERT INTO user_ai_config (user_id, provider, api_key, base_url, model, api_style)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            userId,
            data.provider || 'custom',
            apiKey,
            data.baseUrl || '',
            data.model || '',
            data.apiStyle || 'openai',
          ],
        );
      }
      return this.get(userId);
    },
  };
}
