// ============================================================
// 认证服务：注册/登录/登出/改密/me；JWT 签发
// ============================================================
import jwt from 'jsonwebtoken';
import env from '../config/env.js';
import { ApiError } from '../util/errors.js';
import { createUserModel } from '../models/userModel.js';

/**
 * 认证服务工厂
 * @param {import('../db/driver.js').Database} db
 */
export function createAuthService(db) {
  const users = createUserModel(db);

  function signToken(user) {
    return jwt.sign({ id: user.id, username: user.username }, env.JWT_SECRET, {
      expiresIn: env.JWT_EXPIRES_IN,
    });
  }

  function publicUser(user) {
    return { id: user.id, username: user.username, email: user.email, created_at: user.created_at };
  }

  return {
    /** 注册：唯一性冲突 -> 409 */
    register({ username, email, password }) {
      if (users.findByUsername(username)) {
        throw ApiError.conflict('用户名已被注册');
      }
      if (users.findByEmail(email)) {
        throw ApiError.conflict('邮箱已被注册');
      }
      const user = users.create({ username, email, password });
      return { token: signToken(user), user: publicUser(user) };
    },

    /** 登录：支持 email 或 username */
    login({ account, password }) {
      if (!account || !password) {
        throw ApiError.loginFailed('请输入账号和密码');
      }
      const user = users.findByAccount(account);
      if (!user || !users.verifyPassword(user, password)) {
        throw ApiError.loginFailed('账号或密码错误');
      }
      return { token: signToken(user), user: publicUser(user) };
    },

    /** 登出：语义接口（JWT 无状态，前端清 token 即可） */
    logout() {
      return null;
    },

    /** 获取当前用户 */
    me(userId) {
      const user = users.findById(userId);
      if (!user) throw ApiError.notFound('用户不存在');
      return user;
    },

    /** 修改密码 */
    changePassword(userId, { old_password, new_password }) {
      const user = db.get('SELECT * FROM users WHERE id = ?', [userId]);
      if (!user) throw ApiError.notFound('用户不存在');
      if (!users.verifyPassword(user, old_password)) {
        throw ApiError.badRequest('旧密码错误');
      }
      if (!new_password || new_password.length < 8) {
        throw ApiError.badRequest('新密码长度不能少于 8 位');
      }
      users.updatePassword(userId, new_password);
      return null;
    },
  };
}
