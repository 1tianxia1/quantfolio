// QuantFolio 共享常量 TypeScript 声明（供前端类型提示，须与 constants.js 同步）

export declare const ASSET_CLASS: {
  STOCK: 'stock';
  FUND: 'fund';
  CASH: 'cash';
  BOND: 'bond';
  OTHER: 'other';
};

export declare const ASSET_CLASS_LABEL: Record<string, string>;

export declare const SECURITY_TYPE: {
  STOCK: 'stock';
  FUND: 'fund';
  INDEX: 'index';
};

export declare const SECURITY_TYPE_LABEL: Record<string, string>;

export declare const MARKET_LABEL: Record<string, string>;

export declare const MACD_STATUS: {
  GOLD_CROSS: 'gold_cross';
  DEAD_CROSS: 'dead_cross';
  DIF_POSITIVE: 'dif_positive';
  HIST_TURN_POSITIVE: 'hist_turn_positive';
};

export declare const MA_PATTERN: {
  BULLISH: 'bullish';
  BEARISH: 'bearish';
  ABOVE_20: 'above_20';
  CROSS_ABOVE_5: 'cross_above_5';
};

export declare const RSI_PRESET: {
  OVERSOLD: 'oversold';
  NORMAL: 'normal';
  OVERBOUGHT: 'overbought';
};

export declare const KDJ_STATUS: {
  GOLD_CROSS: 'gold_cross';
  DEAD_CROSS: 'dead_cross';
  J_OVERSOLD: 'j_oversold';
  J_OVERBOUGHT: 'j_overbought';
};

export declare const STRATEGY_TYPE: {
  MORNING: 'morning';
  CLOSING: 'closing';
  PIPELINE_MORNING: 'pipeline_morning';
  PIPELINE_CLOSING: 'pipeline_closing';
};

export declare const STRATEGY_TYPE_LABEL: Record<string, string>;

export declare const REPORT_TYPE: {
  PORTFOLIO_DIAGNOSIS: 'portfolio_diagnosis';
  MORNING_COMMENT: 'morning_comment';
  CLOSING_INTERPRETATION: 'closing_interpretation';
};

export declare const ERROR_CODE: {
  OK: 0;
  BAD_REQUEST: 40000;
  VALIDATION: 40001;
  UNAUTHORIZED: 40100;
  LOGIN_FAILED: 40101;
  TOKEN_EXPIRED: 40102;
  FORBIDDEN: 40300;
  NOT_FOUND: 40400;
  SECURITY_NOT_FOUND: 40401;
  STALE_INTEL: 42401;
  AI_NOT_CONFIGURED: 42402;
  CONFLICT: 40900;
  INTERNAL: 50000;
  UPSTREAM_UNAVAILABLE: 50301;
  AI_TIMEOUT: 50400;
};

export declare const ANALYSIS_MODULE: {
  FUNDAMENTAL: 'fundamental';
  TECHNICAL: 'technical';
};

export declare const ANALYSIS_MODULE_LABEL: Record<string, string>;

export declare const PIPELINE_STEP: {
  SELECT: 'select';
  TIMING: 'timing';
  BACKTEST: 'backtest';
};

export declare const PIPELINE_STEP_LABEL: Record<string, string>;

export declare const PIPELINE_STEP_ORDER: readonly string[];

export declare const PIPELINE_RUN_STATUS: {
  DRAFT: 'draft';
  RUNNING: 'running';
  DONE: 'done';
  FAILED: 'failed';
};

export declare const PIPELINE_STEP_STATUS: {
  PENDING: 'pending';
  RUNNING: 'running';
  DONE: 'done';
  FAILED: 'failed';
  SKIPPED: 'skipped';
};

export declare const SEARCH_PROVIDER: {
  ZHIPU: 'zhipu';
  EASTMONEY: 'eastmoney';
  CUSTOM: 'custom';
};

export declare const SEARCH_PROVIDER_LABEL: Record<string, string>;

export declare const DEFAULT_FRESHNESS_DAYS: number;

export declare const COLORS: {
  UP: string;
  DOWN: string;
  FLAT: string;
  PRIMARY: string;
  BG_DARK: string;
  CARD_DARK: string;
};

export declare const DATA_ORIGIN: {
  REAL: 'real';
  DERIVED: 'derived';
  MIXED: 'mixed';
};

export declare const DATA_ORIGIN_LABEL: Record<string, string>;

export declare const DEFAULT_REBALANCE_THRESHOLD: number;

export declare const ACTIVE_DIMENSION: {
  ASSET_CLASS: 'asset_class';
  INDUSTRY: 'industry';
  CODE: 'code';
};

export declare const APP_NAME: string;
export declare const AI_DISCLAIMER: string;
export declare const SCREENER_DISCLAIMER: string;
