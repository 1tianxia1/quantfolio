// intradayPoller.js
// ============================================================
// 盘中实时行情定时拉取器
//
// 职责：交易时段每 15s 从持仓中提取股票/ETF 代码，通过东财批量快照
//       更新 daily_quotes 当天行（只更新 close/pre_close/pct_chg/volume/amount），
//       让前端轮询 portfolioApi.summary() 自动拿到盘中变化的盈亏。
//
// 三不碰：不重算 tech_indicators、不触发 refreshJob、不碰场外基金。
// ============================================================

/**
 * 判断当前是否在 A 股交易时段（北京时间周一~周五 09:30–11:30 或 13:00–15:00）
 * @returns {boolean}
 */
function isMarketOpen() {
  const now = new Date();
  // 北京时间偏移：UTC + 8 小时
  const offsetMs = 8 * 3600000;
  const beijing = new Date(now.getTime() + offsetMs);

  const day = beijing.getUTCDay();      // 0=Sun … 6=Sat
  const hours = beijing.getUTCHours();
  const minutes = beijing.getUTCMinutes();
  const t = hours * 60 + minutes;       // 当天分钟数（北京时间）

  // 周末不开盘
  if (day === 0 || day === 6) return false;

  // 上午盘 09:30–11:30
  if (t >= 9 * 60 + 30 && t <= 11 * 60 + 30) return true;

  // 下午盘 13:00–15:00
  if (t >= 13 * 60 && t <= 15 * 60) return true;

  return false;
}

/**
 * 获取北京时间 yyyy-MM-dd 字符串
 * @returns {string}
 */
function beijingToday() {
  const now = new Date();
  const beijing = new Date(now.getTime() + 8 * 3600000);
  return beijing.toISOString().slice(0, 10);
}

/**
 * 判断 code 是否为场内 ETF（上海 51/56/58 开头，深圳 159/16 开头）
 * @param {string} code 6 位代码
 * @returns {boolean}
 */
function isETFCode(code) {
  return /^(51|56|58|159|16)\d{4}$/i.test(code);
}

/**
 * 启动盘中轮询
 * @param {import('../db/driver.js').Database} db 数据库句柄
 * @returns {{ stop: () => void }} 返回含 stop 方法的控制器
 */
export function start(db) {
  let timer = null;

  /** 单次轮询逻辑 */
  async function poll() {
    const t0 = Date.now();

    try {
      // 1. 非交易时段直接跳过（不打日志）
      if (!isMarketOpen()) return;

      // 2. 获取持仓中所有有 code 的标的
      const rows = db.all(
        `SELECT DISTINCT h.code, s.type, s.market
         FROM holdings h
         LEFT JOIN securities s ON h.code = s.code
         WHERE h.code IS NOT NULL AND h.code != ''`,
      );

      if (rows.length === 0) return;

      // 3. 分离股票/ETF 与场外基金
      const stockCodes = [];
      let skippedFunds = 0;

      for (const row of rows) {
        if (!row.code) continue;

        // 场外基金：type=fund 且不是 ETF 代码模式 → 跳过
        if (row.type === 'fund' && !isETFCode(row.code)) {
          skippedFunds++;
          continue;
        }

        stockCodes.push(row.code);
      }

      if (stockCodes.length === 0) return;

      // 4. 动态加载 provider（避免循环依赖，延迟到运行时 import）
      const { getProvider } = await import('../providers/dataProvider.js');
      const provider = getProvider(db);

      // 5. 批量获取快照（每批最多 50，分批由 emClient 内部处理）
      const quotes = [];
      const BATCH = 50;
      for (let i = 0; i < stockCodes.length; i += BATCH) {
        const batch = stockCodes.slice(i, i + BATCH);
        const result = await provider.getQuotes(batch);
        if (result && Array.isArray(result)) {
          quotes.push(...result);
        }
      }

      if (quotes.length === 0) return;

      // 6. upsert 到 daily_quotes 当天行
      const today = beijingToday();
      // 注意：data_origin 受限于 CHECK 约束 ('real','derived','mixed')，使用 'real' 表示盘中实时
      const upsert = db.prepare(
        `INSERT INTO daily_quotes (code, trade_date, close, pre_close, pct_chg, volume, amount, data_origin)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'real')
         ON CONFLICT(code, trade_date) DO UPDATE SET
           close = excluded.close,
           pre_close = excluded.pre_close,
           pct_chg = excluded.pct_chg,
           volume = excluded.volume,
           amount = excluded.amount,
           data_origin = excluded.data_origin`,
      );

      let updated = 0;
      for (const q of quotes) {
        if (!q || !q.code) continue;
        upsert.run(q.code, today, q.close ?? null, q.pre_close ?? null, q.pct_chg ?? null, q.volume ?? null, q.amount ?? null);
        updated++;
      }

      const elapsed = Date.now() - t0;
      console.log(`[intraday] 更新 ${updated} 只 / ${skippedFunds} 跳过，耗时 ${elapsed}ms`);
    } catch (e) {
      // 单次拉取失败不崩定时器
      console.warn(`[intraday] 本轮失败：${e.message}`);
    }
  }

  // 启动定时器（每 15 秒，让前端轮询感知到"准实时"变化）
  timer = setInterval(poll, 15_000);

  // 启动后立即执行一次（如已在交易时段则立刻生效）
  poll();

  return {
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
