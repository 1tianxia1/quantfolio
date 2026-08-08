// ============================================================
// authStore：token/user 持久化（localStorage）+ 登录态
// ============================================================
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { UserInfo } from '../api/auth';

interface AuthState {
  token: string | null;
  user: UserInfo | null;
  setAuth: (token: string, user: UserInfo) => void;
  setUser: (user: UserInfo | null) => void;
  clearAuth: () => void;
  isLoggedIn: () => boolean;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      token: null,
      user: null,
      setAuth: (token, user) => set({ token, user }),
      setUser: (user) => set({ user }),
      clearAuth: () => set({ token: null, user: null }),
      isLoggedIn: () => !!get().token,
    }),
    { name: 'quantfolio-auth' },
  ),
);
