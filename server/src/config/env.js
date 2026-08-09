// ============================================================
// 环境变量解析与校验
// ============================================================
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 优先加载项目根 .env，再加载 server/.env（后者覆盖）
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

/** 默认值兜底 + 基础解析 */
function str(name, fallback = '') {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}
function num(name, fallback = 0) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

const env = {
  NODE_ENV: str('NODE_ENV', 'development'),
  PORT: num('PORT', 3001),
  // CORS 白名单（逗号分隔；默认仅本地前端 dev 源）
  CLIENT_ORIGIN: str('CLIENT_ORIGIN', 'http://localhost:5173'),

  JWT_SECRET: str('JWT_SECRET', 'quantfolio-dev-secret-change-me'),
  JWT_EXPIRES_IN: num('JWT_EXPIRES_IN', 7 * 24 * 3600),

  DB_PATH: str('DB_PATH', path.resolve(__dirname, '../../data/quantfolio.db')),
  DATA_PROVIDER: str('DATA_PROVIDER', 'sqlite'),

  AI_PROVIDER: str('AI_PROVIDER', 'siliconflow'),
  AI_API_KEY: str('AI_API_KEY', ''),
  AI_MODEL: str('AI_MODEL', 'deepseek-ai/DeepSeek-V4-Flash'),
  AI_BASE_URL: str('AI_BASE_URL', 'https://api.siliconflow.cn/v1/chat/completions'),
  AI_TIMEOUT_MS: num('AI_TIMEOUT_MS', 20000),
  // 图片识别专用视觉模型（OpenAI 兼容 /chat/completions，支持 image_url）
  AI_VISION_MODEL: str('AI_VISION_MODEL', 'Qwen/Qwen3-VL-32B-Instruct'),
  AI_VISION_TIMEOUT_MS: num('AI_VISION_TIMEOUT_MS', 60000),

  MARKET_API_BASE: str('MARKET_API_BASE', ''),
  // 可选：指向一个能代理通达信连接器 lookup 的 HTTP 桥接服务；配置后后端可按代码实时解析并写回本地缓存
  TDX_BRIDGE_URL: str('TDX_BRIDGE_URL', ''),
  SEED_DATA_PATH: str('SEED_DATA_PATH', path.resolve(__dirname, '../../../data/seed-market.json')),

  // ---------- 网络代理（默认全关：东财/智谱均为境内域名，直连更快） ----------
  // 仅当 HTTP_PROXY_URL 非空 **且** 对应通道 *_USE_PROXY=true 时才会加载 undici。
  HTTP_PROXY_URL: str('HTTP_PROXY_URL', ''),
  EM_USE_PROXY: str('EM_USE_PROXY', 'false'),
  // httpAgent 未知通道会读 process.env.WEBSEARCH_USE_PROXY；此处显式声明便于文档化与单测覆盖
  WEB_SEARCH_USE_PROXY: str('WEB_SEARCH_USE_PROXY', 'false'),

  // ---------- 东方财富数据源（DATA_PROVIDER=eastmoney 时生效，全部免 KEY） ----------
  // 三道闸参数：限频 / 缓存 / 熔断。默认值按「本地单人使用、自律不扰民」设定。
  EM_QPS: num('EM_QPS', 5),                       // 全局令牌桶速率
  EM_ENDPOINT_QPS: num('EM_ENDPOINT_QPS', 3),     // 单端点子桶速率
  EM_MAX_CONCURRENCY: num('EM_MAX_CONCURRENCY', 4),
  EM_TIMEOUT_MS: num('EM_TIMEOUT_MS', 8000),
  EM_RETRIES: num('EM_RETRIES', 2),               // 不含首次的重试次数
  EM_RETRY_BASE_MS: num('EM_RETRY_BASE_MS', 400), // 指数退避基数
  EM_BREAKER_THRESHOLD: num('EM_BREAKER_THRESHOLD', 6),
  EM_BREAKER_COOLDOWN_MS: num('EM_BREAKER_COOLDOWN_MS', 30000),
  EM_QUOTE_TTL_MS: num('EM_QUOTE_TTL_MS', 15000),
  EM_KLINE_TTL_MS: num('EM_KLINE_TTL_MS', 300000),
  EM_LIST_TTL_MS: num('EM_LIST_TTL_MS', 60000),
  EM_CLIST_PAGE_SIZE: num('EM_CLIST_PAGE_SIZE', 100),
  EM_FQT: num('EM_FQT', 1),                       // 0 不复权 / 1 前复权 / 2 后复权
  EM_LIST_OVERLAY_MAX: num('EM_LIST_OVERLAY_MAX', 300), // listSecurities 实时覆盖条数上限
  EM_SNAPSHOT_FULL: str('EM_SNAPSHOT_FULL', 'false'),   // 全市场快照走东财（建议仅离线刷库开启）
  EM_SNAPSHOT_MAX_PAGES: num('EM_SNAPSHOT_MAX_PAGES', 60),
  EM_VERBOSE: str('EM_VERBOSE', 'false'),         // 打印每次东财请求耗时
  EM_NEWS_TTL_MS: num('EM_NEWS_TTL_MS', 180000),  // 东财新闻/公告/研报缓存 3 分钟

  // ---------- 实时联网检索（架构 §6.2 双路并联）----------
  // 路 1 智谱 Web Search（复用用户 BYOK Key）+ 路 2 东财财经信源（免 KEY 常驻兜底）
  WEB_SEARCH_ENABLED: str('WEB_SEARCH_ENABLED', 'true'),
  WEB_SEARCH_PRIMARY: str('WEB_SEARCH_PRIMARY', 'zhipu'),      // 主路（需 BYOK provider=zhipu）
  WEB_SEARCH_FALLBACK: str('WEB_SEARCH_FALLBACK', 'eastmoney'), // 常驻兜底
  WEB_SEARCH_FRESHNESS_DAYS: num('WEB_SEARCH_FRESHNESS_DAYS', 7), // 超过即 stale（时效闸阈值）
  WEB_SEARCH_TOPK: num('WEB_SEARCH_TOPK', 8),                  // 合并去重后保留条数
  WEB_SEARCH_TIMEOUT_MS: num('WEB_SEARCH_TIMEOUT_MS', 15000),  // 单路超时（并联互不阻塞）
  WEB_SEARCH_ZHIPU_URL: str('WEB_SEARCH_ZHIPU_URL', 'https://open.bigmodel.cn/api/paas/v4/web_search'),
  WEB_SEARCH_ZHIPU_ENGINE: str('WEB_SEARCH_ZHIPU_ENGINE', 'search_std'),
  WEB_SEARCH_CACHE_TTL_MS: num('WEB_SEARCH_CACHE_TTL_MS', 120000), // 同 query 2 分钟内复用

  // ---------- 分析中心 ----------
  ANALYSIS_KLINE_WINDOW: num('ANALYSIS_KLINE_WINDOW', 120),
  ANALYSIS_CACHE_SAME_DAY: str('ANALYSIS_CACHE_SAME_DAY', 'true'), // 同日同标的复用报告
};

export default env;
