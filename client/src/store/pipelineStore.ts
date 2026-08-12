// ============================================================
// pipelineStore：投研流水线（①选股 → ②择时 → ③回测）前端状态
//
// 与后端 /analysis/pipeline/runs 端点对齐（T05）。
// PipelinePanel 依赖本 store 的 run / loading / error / createRun /
// select / timing / backtest / reset 契约。
// ============================================================
import { create } from 'zustand';
import {
  createPipelineRun,
  pipelineSelect,
  pipelineTiming,
  pipelineBacktest,
  type PipelineRun,
} from '../api/analysis';

interface AnalysisStoreState {
  run: PipelineRun | null;
  loading: boolean;
  error: Error | null;
  createRun: () => Promise<void>;
  select: (input: { sector?: string; code?: string; style?: 'value' | 'trend' }) => Promise<void>;
  timing: (input: { code: string; strategy?: string }) => Promise<void>;
  backtest: (input: { code: string }) => Promise<void>;
  reset: () => void;
}

export const useAnalysisStore = create<AnalysisStoreState>()((set, get) => ({
  run: null,
  loading: false,
  error: null,

  createRun: async () => {
    set({ loading: true, error: null });
    try {
      const run = await createPipelineRun();
      set({ run, loading: false });
    } catch (e) {
      set({ error: e as Error, loading: false });
    }
  },

  select: async (input) => {
    const { run } = get();
    if (!run) return;
    set({ loading: true, error: null });
    try {
      const updated = await pipelineSelect(run.id, input);
      set({ run: updated, loading: false });
    } catch (e) {
      set({ error: e as Error, loading: false });
    }
  },

  timing: async (input) => {
    const { run } = get();
    if (!run) return;
    set({ loading: true, error: null });
    try {
      const updated = await pipelineTiming(run.id, input);
      set({ run: updated, loading: false });
    } catch (e) {
      set({ error: e as Error, loading: false });
    }
  },

  backtest: async (input) => {
    const { run } = get();
    if (!run) return;
    set({ loading: true, error: null });
    try {
      const updated = await pipelineBacktest(run.id, input);
      set({ run: updated, loading: false });
    } catch (e) {
      set({ error: e as Error, loading: false });
    }
  },

  reset: () => set({ run: null, error: null, loading: false }),
}));
