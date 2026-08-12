// intradayPoller.js
// ============================================================
// 盘中实时行情定时拉取器
//
// 职责：交易时段每 15s 从持仓中提取股票/ETF 代码，通过东财批量快照
//       更新 daily_quotes 当天行（只更新 close/pre_close/pct_chg/volume/amount），
//       让前端轮询 portfolioApi.summary() 自动拿到盘中变化的盈亏。
//
// 不碰：不重算 tech_indicators、不触发 refreshJob。
// 场外基金：每 60s（与股票 15s 解耦）通过 fundNavService.syncFundNav 拉天天基金盘中估值（GSZ）刷新 fund_nav。
//         无股票、仅持有场外基金时，poll() 不会提前 return，仍会执行基金估值同步。
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
 * 场外基金估值同步节流控制。
 * 天天基金盘中估值（GSZ）刷新节奏远慢于股票快照，且与股票的 15s 轮询解耦，
 * 单独以 60s 间隔同步，避免频繁打天天基金接口。
 */
let lastFundSync = 0;
const FUND_SYNC_INTERVAL_MS = 60_000;

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
      // 被跳过的场外基金代码，收集起来供后续周期性同步盘中估值（GSZ）
      const fundCodes = [];

      for (const row of rows) {
        if (!row.code) continue;

        // 场外基金：type=fund 且不是 ETF 代码模式 → 收集起来，走 fundNavService 同步估值
        if (row.type === 'fund' && !isETFCode(row.code)) {
          fundCodes.push(row.code);
          continue;
        }

        stockCodes.push(row.code);
      }

      if (stockCodes.length === 0 && fundCodes.length === 0) return;

      // 4. 动态加载 provider（避免循环依赖，延迟到运行时 import）
      //    无股票时整段跳过：纯场外基金持仓不需要拉东财快照（但仍会执行第 7 步基金估值同步）。
      let updated = 0;
      if (stockCodes.length > 0) {
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

        // 6. upsert 到 daily_quotes 当天行
        //    快照为空时下方 for 循环自然 no-op，不会 return，第 7 步基金估值同步照常执行。
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

        for (const q of quotes) {
          if (!q || !q.code) continue;
          upsert.run(q.code, today, q.close ?? null, q.pre_close ?? null, q.pct_chg ?? null, q.volume ?? null, q.amount ?? null);
          updated++;
        }
      }

      // 7. 场外基金盘中估值同步（节流：每 60s 一次，避免频繁打天天基金接口）
      //    syncFundNav 内部会自动跳过已有 daily_quotes 的场内 ETF，故直接传 fundCodes 即可。
      //    非交易时段已在 poll 开头 return，此处二次防御仍保留 isMarketOpen() 判断。
      let fundSynced = 0;
      let fundSkipped = 0;
      if (
        isMarketOpen() &&
        fundCodes.length > 0 &&
        Date.now() - lastFundSync >= FUND_SYNC_INTERVAL_MS
      ) {
        try {
          const { createFundNavService } = await import('../services/fundNavService.js');
          const svc = createFundNavService(db);
          const res = await svc.syncFundNav({ codes: fundCodes });
          fundSynced = res.synced;
          fundSkipped = res.skipped;
          lastFundSync = Date.now();
        } catch (e) {
          // 单次基金估值同步失败不崩定时器，仅告警
          console.warn(`[intraday] 场外基金估值同步失败（已忽略）：${e.message}`);
        }
      }

      const elapsed = Date.now() - t0;
      console.log(
        `[intraday] 更新 ${updated} 只股票/ETF；收集到 ${fundCodes.length} 只场外基金` +
        `（本次同步 ${fundSynced} / 跳过 ${fundSkipped}），耗时 ${elapsed}ms`,
      );
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
