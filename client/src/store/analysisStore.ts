// ============================================================
// analysisStore：分析请求状态外置单例
//
// 关键目的：让 AI 分析（量化 / 技术面）在**路由切换**（如离开 /analysis 去 /portfolio）
// 时**不中断**——请求与状态保存在本模块而非 React 组件内，
// 组件卸载时只取消订阅、不 abort 请求。回到页面时从本 store 恢复最新状态。
// ============================================================
import { useRef, useSyncExternalStore } from 'react';
import {
  fetchQuantAnalysisStream,
  fetchTechnicalSignal,
  type FundamentalReport,
  type TechnicalReport,
  type QuantStreamEvent,
} from '../api/analysis';

// 投研流水线（①选股 → ②择时 → ③回测）状态另存于 pipelineStore，
// 这里统一再导出，便于 PipelinePanel 从本模块引用。
export { useAnalysisStore } from './pipelineStore';

const MAX_WAIT = 180;

export type Status = 'idle' | 'running' | 'done' | 'error';

interface QuantSession {
  kind: 'quant';
  code: string;
  version: number;
  listeners: Set<() => void>;
  controller: AbortController | null;
  timer: ReturnType<typeof setInterval> | null;
  status: Status;
  report: FundamentalReport | null;
  error: { message: string; code?: number } | null;
  logs: string[];
  step: string;
  remaining: number;
}

interface TechSession {
  kind: 'tech';
  code: string;
  version: number;
  listeners: Set<() => void>;
  controller: AbortController | null;
  status: Status;
  report: TechnicalReport | null;
  error: string | null;
}

type Session = QuantSession | TechSession;

const sessions = new Map<string, Session>();

function k(kind: string, code: string) {
  return `${kind}:${code}`;
}

/** 取（或创建）指定会话；会话对象引用稳定，字段原地变更 */
function ensure(kind: 'quant' | 'tech', code: string): Session {
  const key = k(kind, code);
  let s = sessions.get(key);
  if (!s) {
    s =
      kind === 'quant'
        ? {
            kind: 'quant',
            code,
            version: 0,
            listeners: new Set(),
            controller: null,
            timer: null,
            status: 'idle',
            report: null,
            error: null,
            logs: [],
            step: '',
            remaining: MAX_WAIT,
          }
        : { kind: 'tech', code, version: 0, listeners: new Set(), controller: null, status: 'idle', report: null, error: null };
    sessions.set(key, s);
  }
  return s;
}

function emit(s: Session) {
  s.version += 1;
  s.listeners.forEach((l) => l());
}

function subscribe(kind: 'quant' | 'tech', code: string, cb: () => void) {
  const s = ensure(kind, code);
  s.listeners.add(cb);
  return () => {
    s.listeners.delete(cb);
  };
}

// ---------- 模块 A：量化分析 ----------
export function startQuant(code: string) {
  const s = ensure('quant', code) as QuantSession;
  // 总是重置并启动（允许重试 / 换标的重跑）
  stopTimer(s);
  s.controller?.abort();
  s.status = 'running';
  s.report = null;
  s.error = null;
  s.logs = [];
  s.step = 'fetching';
  s.remaining = MAX_WAIT;
  const controller = new AbortController();
  s.controller = controller;
  s.timer = setInterval(() => {
    s.remaining -= 1;
    if (s.remaining <= 0) {
      stopTimer(s);
      controller.abort();
      s.status = 'error';
      s.error = { message: `分析超时（${MAX_WAIT}s），请重试或检查网络 / 模型配置`, code: 50401 };
      emit(s);
      return;
    }
    emit(s);
  }, 1000);
  fetchQuantAnalysisStream(code, {
    onEvent: (e: QuantStreamEvent) => {
      if (e.type === 'ping') return;
      if (e.type === 'status' && e.message) {
        s.step = e.step || '';
        s.logs = [...s.logs, e.message];
        emit(s);
        return;
      }
      if (e.type === 'done' && e.report) {
        stopTimer(s);
        s.report = e.report;
        s.status = 'done';
        s.controller = null;
        emit(s);
        return;
      }
      if (e.type === 'error') {
        stopTimer(s);
        s.error = { message: e.message || '分析失败，请稍后重试', code: e.code };
        s.status = 'error';
        s.controller = null;
        emit(s);
      }
    },
    signal: controller.signal,
  });
  emit(s);
}

function stopTimer(s: QuantSession) {
  if (s.timer) {
    clearInterval(s.timer);
    s.timer = null;
  }
}

export function cancelQuant(code: string) {
  const s = ensure('quant', code) as QuantSession;
  stopTimer(s);
  s.controller?.abort();
  s.controller = null;
  s.status = 'idle';
  s.report = null;
  s.error = null;
  s.logs = [];
  s.step = '';
  s.remaining = MAX_WAIT;
  emit(s);
}

// ---------- 模块 B：技术面 ----------
export function startTech(code: string) {
  const s = ensure('tech', code) as TechSession;
  s.controller?.abort();
  s.status = 'running';
  s.report = null;
  s.error = null;
  const controller = new AbortController();
  s.controller = controller;
  fetchTechnicalSignal(code)
    .then((r) => {
      s.report = r;
      s.status = 'done';
      s.controller = null;
      emit(s);
    })
    .catch((e: unknown) => {
      const err = e as Error & { message?: string };
      s.error = err?.message || '技术面分析失败，请稍后重试';
      s.status = 'error';
      s.controller = null;
      emit(s);
    });
  emit(s);
}

export function cancelTech(code: string) {
  const s = ensure('tech', code) as TechSession;
  s.controller?.abort();
  s.controller = null;
  s.status = 'idle';
  s.report = null;
  s.error = null;
  emit(s);
}

// ---------- React 订阅 ----------
export function useQuantSession(code: string): QuantSession {
  const ref = useRef<QuantSession | null>(null);
  const version = useSyncExternalStore(
    (cb) => subscribe('quant', code, cb),
    () => ensure('quant', code).version,
  );
  void version;
  ref.current = ensure('quant', code) as QuantSession;
  return ref.current;
}

export function useTechSession(code: string): TechSession {
  const ref = useRef<TechSession | null>(null);
  const version = useSyncExternalStore(
    (cb) => subscribe('tech', code, cb),
    () => ensure('tech', code).version,
  );
  void version;
  ref.current = ensure('tech', code) as TechSession;
  return ref.current;
}
