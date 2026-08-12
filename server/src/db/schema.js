// ============================================================
// 全部 DDL（20 张表）+ 种子元数据表初始化
// 与 docs/DESIGN.md §3 / docs/architecture-analysis-center.md §3.4 一致
//
// 1.1 → 1.2 变更：追加智能分析中心 3 张表
//   analysis_reports / pipeline_runs / pipeline_steps
// 全部 CREATE TABLE IF NOT EXISTS，initSchema 幂等 —— 存量库直接启动即可，
// 无需 drop、无需迁移脚本。
// ============================================================

export const SCHEMA_VERSION = '1.2';

const DDL = `
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

-- 1) 用户
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 2) 证券主表（97 个真实标的）
CREATE TABLE IF NOT EXISTS securities (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  code            TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  market          TEXT NOT NULL CHECK (market IN ('SH','SZ','BJ')),
  type            TEXT NOT NULL CHECK (type IN ('stock','fund','index','bond','other')),
  board           TEXT NOT NULL,
  price_limit_pct REAL NOT NULL,
  industry        TEXT,
  sector          TEXT,
  list_date       TEXT,
  is_st           INTEGER NOT NULL DEFAULT 0 CHECK (is_st IN (0,1)),
  is_index_member INTEGER NOT NULL DEFAULT 0 CHECK (is_index_member IN (0,1)),
  index_name      TEXT,
  float_share     REAL,
  total_share     REAL,
  circ_mv         REAL,
  total_mv        REAL,
  pe_ttm          REAL,
  pb              REAL,
  dividend_yield  REAL,
  fund_category   TEXT,
  fund_track      TEXT,
  data_origin     TEXT NOT NULL DEFAULT 'real' CHECK (data_origin IN ('real','derived','mixed')),
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sec_type   ON securities(type);
CREATE INDEX IF NOT EXISTS idx_sec_sector ON securities(sector);
CREATE INDEX IF NOT EXISTS idx_sec_industry ON securities(industry);
CREATE INDEX IF NOT EXISTS idx_sec_mv     ON securities(circ_mv);

-- 3) 真实形态标签（通达信 tags，双通道之一）
CREATE TABLE IF NOT EXISTS security_tags (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  code       TEXT NOT NULL,
  tag        TEXT NOT NULL,
  data_origin TEXT NOT NULL DEFAULT 'real',
  UNIQUE (code, tag),
  FOREIGN KEY (code) REFERENCES securities(code)
);
CREATE INDEX IF NOT EXISTS idx_tags_tag ON security_tags(tag);

-- 4) 日线行情（末根为真实锚定，前 249 根派生）
CREATE TABLE IF NOT EXISTS daily_quotes (
  code          TEXT NOT NULL,
  trade_date    TEXT NOT NULL,
  open          REAL, high REAL, low REAL, close REAL NOT NULL,
  pre_close     REAL,
  volume        REAL NOT NULL,
  amount        REAL,
  pct_chg       REAL,
  turnover_rate REAL,
  volume_ratio  REAL,
  pe_ttm        REAL, pb REAL,
  total_mv      REAL, circ_mv REAL,
  data_origin   TEXT NOT NULL DEFAULT 'derived' CHECK (data_origin IN ('real','derived','mixed')),
  PRIMARY KEY (code, trade_date),
  FOREIGN KEY (code) REFERENCES securities(code)
);
CREATE INDEX IF NOT EXISTS idx_dq_date ON daily_quotes(trade_date);
CREATE INDEX IF NOT EXISTS idx_dq_code_date ON daily_quotes(code, trade_date DESC);

-- 5) 技术指标（250 日全量，供图表/回测；含真实标签双通道）
CREATE TABLE IF NOT EXISTS tech_indicators (
  code        TEXT NOT NULL,
  trade_date  TEXT NOT NULL,
  ma5 REAL, ma10 REAL, ma20 REAL, ma60 REAL,
  macd_dif REAL, macd_dea REAL, macd_bar REAL,
  rsi6 REAL, rsi12 REAL, rsi24 REAL,
  kdj_k REAL, kdj_d REAL, kdj_j REAL,
  vol_ma5 REAL, vol_ratio_5 REAL,
  volume_streak INTEGER NOT NULL DEFAULT 0,
  high_60d_distance_pct REAL,
  macd_gold_cross INTEGER NOT NULL DEFAULT 0,
  macd_dead_cross INTEGER NOT NULL DEFAULT 0,
  macd_positive INTEGER NOT NULL DEFAULT 0,
  macd_hist_turn_positive INTEGER NOT NULL DEFAULT 0,
  kdj_gold_cross INTEGER NOT NULL DEFAULT 0,
  kdj_dead_cross INTEGER NOT NULL DEFAULT 0,
  ma_bullish INTEGER NOT NULL DEFAULT 0,
  ma_bearish INTEGER NOT NULL DEFAULT 0,
  ma_above_20 INTEGER NOT NULL DEFAULT 0,
  ma_cross_above_5 INTEGER NOT NULL DEFAULT 0,
  indicator_hit TEXT NOT NULL DEFAULT '[]',
  data_origin TEXT NOT NULL DEFAULT 'derived',
  PRIMARY KEY (code, trade_date),
  FOREIGN KEY (code) REFERENCES securities(code)
);
CREATE INDEX IF NOT EXISTS idx_ti_code_date ON tech_indicators(code, trade_date DESC);
CREATE INDEX IF NOT EXISTS idx_ti_date ON tech_indicators(trade_date);

-- 6) 资金流向（真实 19 只优先，其余派生；单位万元）
CREATE TABLE IF NOT EXISTS money_flow (
  code            TEXT NOT NULL,
  trade_date      TEXT NOT NULL,
  main_net_inflow REAL,
  net_inflow_3d   REAL,
  net_inflow_5d   REAL,
  data_origin     TEXT NOT NULL DEFAULT 'derived',
  PRIMARY KEY (code, trade_date),
  FOREIGN KEY (code) REFERENCES securities(code)
);

-- 7) 竞价数据（由派生 K 线 open 反推；含首笔量比）
CREATE TABLE IF NOT EXISTS auction_data (
  code               TEXT NOT NULL,
  trade_date         TEXT NOT NULL,
  auction_price      REAL,
  auction_pct        REAL,
  auction_volume     REAL,
  auction_amount     REAL,
  auction_vol_ratio  REAL,
  first_trade_vol_ratio REAL,
  data_origin        TEXT NOT NULL DEFAULT 'derived',
  PRIMARY KEY (code, trade_date),
  FOREIGN KEY (code) REFERENCES securities(code)
);

-- 8) 连板/涨停记录（21 只真实 + 补充派生）
CREATE TABLE IF NOT EXISTS limit_records (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  code             TEXT NOT NULL,
  trade_date       TEXT NOT NULL,
  limit_type       TEXT NOT NULL CHECK (limit_type IN ('limit_up','limit_down','break_board')),
  limit_up_streak  INTEGER NOT NULL DEFAULT 1,
  pattern          TEXT,
  reason           TEXT,
  seal_amount      REAL,
  first_limit_time TEXT,
  open_times       INTEGER,
  data_origin      TEXT NOT NULL DEFAULT 'real',
  FOREIGN KEY (code) REFERENCES securities(code)
);
CREATE INDEX IF NOT EXISTS idx_lr_code_date ON limit_records(code, trade_date);

-- 9) 热点板块（sector/industry 双维度聚合）
CREATE TABLE IF NOT EXISTS hot_sectors (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  dimension       TEXT NOT NULL CHECK (dimension IN ('sector','industry')),
  sector_name     TEXT NOT NULL,
  trade_date      TEXT NOT NULL,
  sector_pct_chg  REAL,
  hot_rank        INTEGER,
  leading_stock   TEXT,
  stock_count     INTEGER,
  total_amount    REAL,
  total_main_inflow REAL,
  data_origin     TEXT NOT NULL DEFAULT 'derived',
  UNIQUE (dimension, sector_name, trade_date)
);

-- 10) 持仓
CREATE TABLE IF NOT EXISTS holdings (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER,
  code        TEXT,
  name        TEXT NOT NULL,
  asset_class TEXT NOT NULL CHECK (asset_class IN ('stock','fund','cash','bond','other')),
  quantity    REAL NOT NULL CHECK (quantity >= 0),
  cost_price  REAL NOT NULL DEFAULT 0,
  -- 导入持仓时由截图 OCR 回填的「现价」：对本地行情库未覆盖的标的（如券商 App 截图里的
  -- 黄金ETF/小票），用它替代 daily_quotes 回退成本价，保证市值/盈亏与截图一致。可空。
  current_price REAL,
  -- 截图 OCR 回填的累计盈亏金额/率（优先于重新计算，保证与券商 App 截图完全一致）
  profit REAL,
  profit_rate REAL,
  -- 截图 OCR 回填的当日盈亏金额/率（优先于行情计算；无行情标的如黄金ETF 必须用它）
  day_profit REAL,
  day_profit_rate REAL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_holdings_user ON holdings(user_id);

-- 10.5) 场外基金净值（天天基金每日披露；与 daily_quotes 解耦，
--       按代码取各自最新 nav_date，天然支持「休息日显示最后一个交易日」）
--       场内 ETF 走 daily_quotes（市价），场外联接/LOF/QDII 走本表（净值）。
CREATE TABLE IF NOT EXISTS fund_nav (
  code         TEXT NOT NULL,
  nav_date     TEXT NOT NULL,
  nav          REAL NOT NULL,
  pre_nav      REAL,
  nav_chg_pct  REAL,
  is_estimate  INTEGER NOT NULL DEFAULT 0,
  data_origin  TEXT NOT NULL DEFAULT 'real' CHECK (data_origin IN ('real','derived','mixed')),
  PRIMARY KEY (code, nav_date),
  FOREIGN KEY (code) REFERENCES securities(code)
);
CREATE INDEX IF NOT EXISTS idx_fn_code_date ON fund_nav(code, nav_date DESC);

-- 11) 目标配置（同一 dimension 下 Σtarget_pct=100，应用层校验）
CREATE TABLE IF NOT EXISTS target_allocations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER,
  dimension  TEXT NOT NULL CHECK (dimension IN ('asset_class','industry','code')),
  target_key TEXT NOT NULL,
  target_pct REAL NOT NULL CHECK (target_pct >= 0 AND target_pct <= 100),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, dimension, target_key),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 12) 用户设置（再平衡阈值、激活维度）
CREATE TABLE IF NOT EXISTS user_settings (
  user_id            INTEGER PRIMARY KEY,
  rebalance_threshold REAL NOT NULL DEFAULT 5,
  active_dimension   TEXT NOT NULL DEFAULT 'asset_class',
  -- morning_loose_mode：仅前端持久化用户偏好；管线服务端不读此列（走请求体 loose_mode），
  -- 两条通道保持一致（saveSettings 归一化 0/1），避免后人误改为服务端读取导致口径分裂
  morning_loose_mode INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 13) 策略（conditions JSON）
CREATE TABLE IF NOT EXISTS strategies (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER,
  name       TEXT NOT NULL,
  type       TEXT NOT NULL CHECK (type IN ('morning','closing','pipeline_morning','pipeline_closing')),
  conditions TEXT NOT NULL,
  is_preset  INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_strategies_user ON strategies(user_id);

-- 14) AI 报告缓存
CREATE TABLE IF NOT EXISTS ai_reports (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER,
  report_type TEXT NOT NULL CHECK (report_type IN ('portfolio_diagnosis','morning_comment','closing_interpretation')),
  ref_key     TEXT NOT NULL,
  trade_date  TEXT NOT NULL,
  content     TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, report_type, ref_key, trade_date)
);

-- 15) 自选股
CREATE TABLE IF NOT EXISTS watchlist (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  code       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, code),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 16) 数据来源元信息（合规标注）
CREATE TABLE IF NOT EXISTS meta_kv (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

-- 17) 用户自定义 AI 配置（「自定义模型」功能：自选厂商 / Key / 模型）
CREATE TABLE IF NOT EXISTS user_ai_config (
  user_id    INTEGER PRIMARY KEY,
  provider   TEXT NOT NULL DEFAULT 'custom',
  api_key    TEXT,
  base_url   TEXT,
  model      TEXT,
  api_style  TEXT NOT NULL DEFAULT 'openai',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 18) 智能分析报告（模块 A/B 结果存档与同日缓存）
--     刻意不给 code 设外键：允许分析本地 securities 尚未收录的代码（东财实时可查）
CREATE TABLE IF NOT EXISTS analysis_reports (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER,
  module          TEXT NOT NULL CHECK (module IN ('fundamental','technical')),
  code            TEXT NOT NULL,
  trade_date      TEXT NOT NULL,
  payload         TEXT NOT NULL,
  model           TEXT,
  search_provider TEXT,
  retrieved_at    TEXT,
  data_origin     TEXT NOT NULL DEFAULT 'mixed' CHECK (data_origin IN ('real','derived','mixed')),
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, module, code, trade_date)
);
CREATE INDEX IF NOT EXISTS idx_ar_code ON analysis_reports(code, created_at DESC);

-- 19) 流水线运行（①选股 → ②择时 → ③回测 的数据总线）
CREATE TABLE IF NOT EXISTS pipeline_runs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER,
  name       TEXT,
  status     TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','running','done','failed')),
  context    TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 20) 流水线步骤
CREATE TABLE IF NOT EXISTS pipeline_steps (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id     INTEGER NOT NULL,
  step       TEXT NOT NULL CHECK (step IN ('select','timing','backtest')),
  seq        INTEGER NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','failed','skipped')),
  input      TEXT NOT NULL DEFAULT '{}',
  output     TEXT NOT NULL DEFAULT '{}',
  error      TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (run_id) REFERENCES pipeline_runs(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_ps_run ON pipeline_steps(run_id, seq);
`;

/**
 * 初始化数据库（建表 + 基础 pragma）
 * @param {import('../db/driver.js').Database} db
 */
export function initSchema(db) {
  db.exec(DDL);

  // 存量库迁移：holdings 增加 current_price / profit / profit_rate / day_profit / day_profit_rate 列
  //（图片导入回填的截现价值与盈亏；幂等）
  const newHoldingsCols = ['current_price', 'profit', 'profit_rate', 'day_profit', 'day_profit_rate'];
  try {
    const cols = db.all("PRAGMA table_info(holdings)");
    for (const col of newHoldingsCols) {
      if (!cols.some((c) => c.name === col)) {
        db.exec(`ALTER TABLE holdings ADD COLUMN ${col} REAL`);
      }
    }
  } catch (e) {
    console.warn('[schema] holdings 列迁移跳过:', e.message);
  }

  // 1.3 自选模块增强：分组表 + watchlist.group_id/category/note（幂等迁移）
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS watchlist_groups (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id   INTEGER NOT NULL,
      name      TEXT NOT NULL,
      category  TEXT NOT NULL DEFAULT 'all' CHECK (category IN ('all','a_share','fund')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (user_id, name)
    )`);
    const wcols = db.all("PRAGMA table_info(watchlist)");
    if (!wcols.some((c) => c.name === 'group_id')) {
      db.exec(`ALTER TABLE watchlist ADD COLUMN group_id INTEGER REFERENCES watchlist_groups(id)`);
    }
    if (!wcols.some((c) => c.name === 'category')) {
      db.exec(`ALTER TABLE watchlist ADD COLUMN category TEXT NOT NULL DEFAULT 'a_share' CHECK (category IN ('a_share','fund'))`);
    }
    if (!wcols.some((c) => c.name === 'note')) {
      db.exec(`ALTER TABLE watchlist ADD COLUMN note TEXT`);
    }
  } catch (e) {
    console.warn('[schema] watchlist 1.3 迁移跳过:', e.message);
  }
}
