// ============================================================
// QuantFolio 前后端共享常量（纯 ESM，无任何依赖）
// 后端：相对路径 import；前端：vite alias '@shared'
// 注意：任何常量变动必须同步更新 shared/constants.d.ts
// ============================================================

/** 资产类别枚举（holdings.asset_class） */
export const ASSET_CLASS = {
  STOCK: 'stock',
  FUND: 'fund',
  CASH: 'cash',
  BOND: 'bond',
  OTHER: 'other',
};

export const ASSET_CLASS_LABEL = {
  stock: '股票',
  fund: '基金',
  cash: '现金',
  bond: '债券',
  other: '其他',
};

/** 证券类型 */
export const SECURITY_TYPE = {
  STOCK: 'stock',
  FUND: 'fund',
  INDEX: 'index',
};

export const SECURITY_TYPE_LABEL = {
  stock: '股票',
  fund: '基金',
  index: '指数',
};

/** 市场代码 */
export const MARKET_LABEL = {
  SH: '沪',
  SZ: '深',
  BJ: '北',
};

/** 指标状态枚举 */
export const MACD_STATUS = {
  GOLD_CROSS: 'gold_cross',       // 金叉（DIF 上穿 DEA）
  DEAD_CROSS: 'dead_cross',       // 死叉
  DIF_POSITIVE: 'dif_positive',   // DIF > 0
  HIST_TURN_POSITIVE: 'hist_turn_positive', // MACD 柱由负转正
};

export const MA_PATTERN = {
  BULLISH: 'bullish',             // 多头排列 MA5>MA10>MA20
  BEARISH: 'bearish',             // 空头排列
  ABOVE_20: 'above_20',           // close > MA20
  CROSS_ABOVE_5: 'cross_above_5', // close 上穿 MA5
};

export const RSI_PRESET = {
  OVERSOLD: 'oversold',   // 超卖 <30
  NORMAL: 'normal',       // 正常 30~70
  OVERBOUGHT: 'overbought', // 超买 >70
};

export const KDJ_STATUS = {
  GOLD_CROSS: 'gold_cross',   // 低位金叉(K<30) / 金叉
  DEAD_CROSS: 'dead_cross',
  J_OVERSOLD: 'j_oversold',   // J<0
  J_OVERBOUGHT: 'j_overbought', // J>100
};

/** 策略类型 */
export const STRATEGY_TYPE = {
  MORNING: 'morning',                       // 通用早盘筛选
  CLOSING: 'closing',                       // 通用尾盘筛选
  PIPELINE_MORNING: 'pipeline_morning',     // 早盘七步法漏斗
  PIPELINE_CLOSING: 'pipeline_closing',     // 尾盘五步法漏斗
};

export const STRATEGY_TYPE_LABEL = {
  morning: '早盘',
  closing: '尾盘',
  pipeline_morning: '早盘七步法',
  pipeline_closing: '尾盘五步法',
};

/** 报告类型（ai_reports.report_type） */
export const REPORT_TYPE = {
  PORTFOLIO_DIAGNOSIS: 'portfolio_diagnosis',
  MORNING_COMMENT: 'morning_comment',
  CLOSING_INTERPRETATION: 'closing_interpretation',
};

/** 统一错误码（code 前三位 = HTTP 状态） */
export const ERROR_CODE = {
  OK: 0,
  BAD_REQUEST: 40000,       // 参数错误
  VALIDATION: 40001,        // zod 校验失败
  UNAUTHORIZED: 40100,      // 未登录
  LOGIN_FAILED: 40101,      // 账号或密码错误
  TOKEN_EXPIRED: 40102,     // token 过期
  FORBIDDEN: 40300,         // 无权限
  NOT_FOUND: 40400,         // 资源不存在
  SECURITY_NOT_FOUND: 40401, // 标的不存在（东财与本地均未命中）
  STALE_INTEL: 42401,       // 情报时效不达标（零结果 / 全部超期）→ 拒绝生成 AI 结论
  AI_NOT_CONFIGURED: 42402, // 登录用户未配置 AI Key
  CONFLICT: 40900,          // 唯一性冲突
  INTERNAL: 50000,          // 服务器内部错误
  NOT_IMPLEMENTED: 50100,   // 骨架已就位、实现排期在后续任务
  UPSTREAM_UNAVAILABLE: 50301, // 上游数据源不可用且降级也失败
  AI_TIMEOUT: 50400,        // AI 超时
};

/** 智能分析中心：分析模块（analysis_reports.module） */
export const ANALYSIS_MODULE = {
  FUNDAMENTAL: 'fundamental', // 模块 A：AI 基本面 + 消息面
  TECHNICAL: 'technical',     // 模块 B：技术面策略指标
};

export const ANALYSIS_MODULE_LABEL = {
  fundamental: '量化分析',
  technical: '策略指标',
};

/** 流水线步骤（pipeline_steps.step），顺序即执行顺序 */
export const PIPELINE_STEP = {
  SELECT: 'select',     // ① 选股
  TIMING: 'timing',     // ② 择时
  BACKTEST: 'backtest', // ③ 回测
};

export const PIPELINE_STEP_LABEL = {
  select: '选股',
  timing: '择时',
  backtest: '回测',
};

/** 流水线步骤顺序（供步骤导航与 seq 计算，唯一来源） */
export const PIPELINE_STEP_ORDER = ['select', 'timing', 'backtest'];

/** 流水线运行状态（pipeline_runs.status） */
export const PIPELINE_RUN_STATUS = {
  DRAFT: 'draft',
  RUNNING: 'running',
  DONE: 'done',
  FAILED: 'failed',
};

/** 流水线步骤状态（pipeline_steps.status） */
export const PIPELINE_STEP_STATUS = {
  PENDING: 'pending',
  RUNNING: 'running',
  DONE: 'done',
  FAILED: 'failed',
  SKIPPED: 'skipped',
};

/** 联网检索提供方 id（SearchResult.providerId / SearchBundle.providersUsed） */
export const SEARCH_PROVIDER = {
  ZHIPU: 'zhipu',         // 智谱 Web Search（需 BYOK provider=zhipu）
  EASTMONEY: 'eastmoney', // 东方财富新闻/公告/研报（免 KEY 常驻兜底）
  CUSTOM: 'custom',       // P2 预留：自建 SearxNG 等
};

export const SEARCH_PROVIDER_LABEL = {
  zhipu: '智谱 Web Search',
  eastmoney: '东方财富财经信源',
  custom: '自定义检索源',
};

/** 情报时效默认阈值（天）；超过即 stale，服务端以 WEB_SEARCH_FRESHNESS_DAYS 覆盖 */
export const DEFAULT_FRESHNESS_DAYS = 7;

/** 涨跌配色（A股习惯：红涨绿跌）—— 全站唯一来源，禁止硬编码色值 */
export const COLORS = {
  UP: '#F5222D',      // 涨 = 红
  DOWN: '#00B578',    // 跌 = 绿
  FLAT: '#8B949E',    // 平 = 灰
  PRIMARY: '#2E7CF6', // 主色冷蓝
  BG_DARK: '#0E1117', // 深色背景
  CARD_DARK: '#161B22',
};

/** 数据来源标注 */
export const DATA_ORIGIN = {
  REAL: 'real',
  DERIVED: 'derived',
  MIXED: 'mixed',
};

export const DATA_ORIGIN_LABEL = {
  real: '真实行情',
  derived: '派生数据',
  mixed: '真实+派生',
};

/** 再平衡默认阈值（百分点） */
export const DEFAULT_REBALANCE_THRESHOLD = 5;

/** 目标配置激活维度 */
export const ACTIVE_DIMENSION = {
  ASSET_CLASS: 'asset_class',
  INDUSTRY: 'industry',
  CODE: 'code',
};

/** 应用信息 */
export const APP_NAME = 'QuantFolio';
export const TRADE_DATE = '2026-08-07';
export const AI_DISCLAIMER = '本内容由 AI 生成，仅供研究参考，不构成投资建议';
export const SCREENER_DISCLAIMER = '本平台内容为量化模型输出，不构成投资建议，据此操作风险自担';
export const DATA_LINEAGE_NOTICE = '行情截至 2026-08-07 收盘，历史 K 线为模拟数据，最新价为真实行情';
