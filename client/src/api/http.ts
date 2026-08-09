// ============================================================
// axios 实例：baseURL=/api、token 注入、信封解包、401 跳登录
// ============================================================
import axios from 'axios';
import { useAuthStore } from '../store/authStore';

/** 统一响应信封 */
export interface ApiEnvelope<T = unknown> {
  success: boolean;
  data: T;
  message: string;
  code: number;
}

/** 创建带统一拦截器的 axios 实例 */
function createHttpClient(timeout: number) {
  const instance = axios.create({
    baseURL: '/api',
    timeout,
  });

  // 请求拦截：注入 token
  instance.interceptors.request.use((config) => {
    const token = useAuthStore.getState().token;
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  });

  // 响应拦截：信封解包 + 401 清 token 跳登录
  instance.interceptors.response.use(
    (response) => response,
    (error) => {
      const status = error.response?.status;
      const code = error.response?.data?.code;
      if (status === 401 || code === 40100 || code === 40102) {
        useAuthStore.getState().clearAuth();
        // 跳转登录（保留回跳地址）
        const current = window.location.pathname + window.location.search;
        if (!current.startsWith('/login')) {
          window.location.href = `/login?redirect=${encodeURIComponent(current)}`;
        }
      }
      return Promise.reject(error);
    },
  );

  return instance;
}

/** 常规请求（30s） */
const http = createHttpClient(30000);

/**
 * 长超时实例（90s）：图片识别等视觉模型接口专用（D8）。
 * 后端视觉超时为 60s，若用默认 30s 前端必然先报错。
 */
export const httpLong = createHttpClient(90000);

/** 解包统一信封；非 success 抛错 */
export async function unwrap<T>(promise: Promise<{ data: ApiEnvelope<T> }>): Promise<T> {
  const res = await promise;
  const env = res.data;
  if (!env.success) {
    const err = new Error(env.message || '请求失败') as Error & { code?: number };
    err.code = env.code;
    throw err;
  }
  return env.data;
}

export default http;
