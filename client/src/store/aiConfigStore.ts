// ============================================================
// aiConfigStore：记录当前生效的 AI 模型，用于 AI 面板展示「由 xx 模型生成」
// 两个来源：
//  1. 报告 ai_meta（setFromMeta）——最准确，反映本次报告实际使用的模型（含服务端默认）
//  2. 个人配置保存（setFromMasked）——兜底，保存后立即反馈
// 此外维护 hasKey：登录用户是否已配置 AI Key（用于「登录后必须配置才能用 AI」的强制拦截）
// 注意：不保存任何 Key 明文，仅展示模型标识。
// ============================================================
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { AiConfigMasked } from '../api/ai';
import { aiApi } from '../api/ai';
import { useAuthStore } from './authStore';

interface AiMeta {
  provider?: string;
  providerLabel?: string;
  model?: string;
  custom?: boolean;
}

interface AiConfigState {
  displayLabel: string;
  displayActive: boolean;
  configured: boolean; // 用户是否已配置自定义模型
  hasKey: boolean | null; // 登录用户是否已配置 AI Key（null=尚未探知）
  setFromMeta: (meta: AiMeta | undefined) => void;
  setFromMasked: (cfg: AiConfigMasked | null) => void;
  setHasKey: (v: boolean) => void;
  /** 根据报告响应同步 hasKey（notConfigured→false；使用自定义模型→true） */
  syncFromReport: (r: { notConfigured?: boolean; ai_meta?: AiMeta }) => void;
  /** 登录后拉取个人配置，确定 hasKey（游客置 null） */
  init: () => Promise<void>;
  clear: () => void;
}

function labelOf(meta: AiMeta | undefined): string {
  if (!meta) return '';
  const p = meta.providerLabel || meta.provider || '';
  const m = meta.model || '';
  return [p, m].filter(Boolean).join(' / ');
}

export const useAiConfigStore = create<AiConfigState>()(
  persist(
    (set) => ({
      displayLabel: '',
      displayActive: false,
      configured: false,
      hasKey: null,
      setFromMeta: (meta) => {
        const label = labelOf(meta);
        set({ displayLabel: label, displayActive: !!label, configured: !!meta?.custom });
      },
      setFromMasked: (cfg) => {
        if (!cfg) {
          set({ configured: false });
          return;
        }
        if (cfg.hasKey && cfg.model) {
          set({ displayLabel: `${cfg.provider} / ${cfg.model}`, displayActive: true, configured: true });
        } else {
          set({ configured: false });
        }
      },
      setHasKey: (v: boolean) => set({ hasKey: v }),
      syncFromReport: (r) => {
        if (r?.notConfigured) {
          set({ hasKey: false });
          return;
        }
        if (r?.ai_meta?.custom) set({ hasKey: true });
      },
      init: async () => {
        if (!useAuthStore.getState().isLoggedIn()) {
          set({ hasKey: null });
          return;
        }
        try {
          const cfg = await aiApi.getConfig();
          set({ hasKey: !!cfg.hasKey });
        } catch {
          set({ hasKey: null });
        }
      },
      clear: () => set({ displayLabel: '', displayActive: false, configured: false, hasKey: null }),
    }),
    { name: 'quantfolio-ai-config' },
  ),
);
