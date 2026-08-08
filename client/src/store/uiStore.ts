// ============================================================
// uiStore：主题切换/全局 loading/侧栏折叠
// ============================================================
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface UiState {
  mode: 'dark' | 'light';
  sidebarCollapsed: boolean;
  globalLoading: boolean;
  toggleMode: () => void;
  toggleSidebar: () => void;
  setSidebar: (v: boolean) => void;
  setGlobalLoading: (v: boolean) => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set, get) => ({
      mode: 'dark',
      sidebarCollapsed: false,
      globalLoading: false,
      toggleMode: () => set({ mode: get().mode === 'dark' ? 'light' : 'dark' }),
      toggleSidebar: () => set({ sidebarCollapsed: !get().sidebarCollapsed }),
      setSidebar: (v) => set({ sidebarCollapsed: v }),
      setGlobalLoading: (v) => set({ globalLoading: v }),
    }),
    { name: 'quantfolio-ui' },
  ),
);
