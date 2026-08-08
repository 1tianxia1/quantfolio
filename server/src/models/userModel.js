// ============================================================
// users 表 CRUD + bcrypt 哈希
// ============================================================
import bcrypt from 'bcryptjs';

const SALT_ROUNDS = 10;

/**
 * 用户模型工厂
 * @param {import('../db/driver.js').Database} db
 */
export function createUserModel(db) {
  return {
    /** 创建用户（密码自动 bcrypt 哈希） */
    create({ username, email, password }) {
      const passwordHash = bcrypt.hashSync(password, SALT_ROUNDS);
      const r = db.run(
        'INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)',
        [username, email, passwordHash],
      );
      return this.findById(Number(r.lastInsertRowid));
    },

    findByUsername(username) {
      return db.get('SELECT * FROM users WHERE username = ?', [username]);
    },

    findByEmail(email) {
      return db.get('SELECT * FROM users WHERE email = ?', [email]);
    },

    /** 登录查找：支持 username 或 email */
    findByAccount(account) {
      return db.get('SELECT * FROM users WHERE username = ? OR email = ?', [account, account]);
    },

    findById(id) {
      return db.get('SELECT id, username, email, created_at, updated_at FROM users WHERE id = ?', [id]);
    },

    /** 校验密码（供登录 / 改密） */
    verifyPassword(user, password) {
      if (!user || !user.password_hash) return false;
      return bcrypt.compareSync(password, user.password_hash);
    },

    /** 更新密码 */
    updatePassword(id, newPassword) {
      const passwordHash = bcrypt.hashSync(newPassword, SALT_ROUNDS);
      db.run(
        "UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?",
        [passwordHash, id],
      );
      return this.findById(id);
    },
  };
}
