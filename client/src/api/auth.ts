// ============================================================
// 认证 API
// ============================================================
import http, { unwrap } from './http';

export interface UserInfo {
  id: number;
  username: string;
  email: string;
  created_at?: string;
}

export interface AuthResult {
  token: string;
  user: UserInfo;
}

export const authApi = {
  register(data: { username: string; email: string; password: string }) {
    return unwrap<AuthResult>(http.post('/auth/register', data));
  },
  login(data: { account: string; password: string }) {
    return unwrap<AuthResult>(http.post('/auth/login', data));
  },
  logout() {
    return unwrap<null>(http.post('/auth/logout'));
  },
  me() {
    return unwrap<UserInfo>(http.get('/auth/me'));
  },
  changePassword(data: { old_password: string; new_password: string }) {
    return unwrap<null>(http.put('/auth/password', data));
  },
};
