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

/**
 * 解包统一信封；非 success 抛错。
 * 关键点：axios 对非 2xx 响应会直接 reject，因此这里用 try/catch 包裹 await，
 * 在 catch 中优先读取后端信封的 message（而非 axios 原始的 "409 Conflict" 文案）。
 */
export async function unwrap<T>(promise: Promise<{ data: ApiEnvelope<T> }>): Promise<T> {
  let res: { data: ApiEnvelope<T> };
  try {
    res = await promise;
  } catch (error) {
    // axios 抛出的错误，可能携带后端错误信封（error.response.data）
    const axiosError = error as {
      response?: { status?: number; data?: Partial<ApiEnvelope> };
    };
    const env = axiosError.response?.data;
    const backendMessage =
      typeof env?.message === 'string' && env.message.trim().length > 0
        ? env.message
        : '';
    if (backendMessage) {
      // 优先使用后端返回的 message，并附带 code 与 status 字段
      const err = new Error(backendMessage) as Error & {
        code?: number;
        status?: number;
      };
      err.code = env?.code;
      err.status = axiosError.response?.status;
      throw err;
    }
    // 无可解析信封（网络错误/超时/500 无 JSON body）：保留原始 axios 错误兜底，不吞错
    throw error;
  }

  const env = res.data;
  if (!env.success) {
    // 兼容后端返回 2xx + success:false 的情况
    const err = new Error(env.message || '请求失败') as Error & { code?: number };
    err.code = env.code;
    throw err;
  }
  return env.data;
}

export default http;
