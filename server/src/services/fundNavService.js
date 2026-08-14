// ============================================================
// FundNavService —— 把天天基金净值落地到本地 fund_nav 表
//
// 职责：
//   1. 取持仓里的场外基金代码（asset_class='fund' 且无 daily_quotes 的上市行情）
//   2. 拉天天基金净值，幂等 upsert 进 fund_nav 表（复用现有 schema，不新增表外结构）
//   3. 保证 securities 中存在该代码主记录（fund_category='场外'），否则 daily_quotes 外键无碍
//      （fund_nav 也引用 securities，需主记录存在）
//
// 幂等性：全部 `ON CONFLICT(code, nav_date) DO UPDATE`，可重复跑。
// 红线（架构 §7 同源）：净值缺失直接跳过，绝不补 0 或估值占位。
//
// 口径：场外基金（联接/LOF/QDII）无日 K 线 → 走本服务；场内 ETF 已有 daily_quotes
//       → 在 syncFundNav 阶段直接跳过，估值时沿用市价口径。
// ============================================================
import { fetchFundNav } from '../providers/tiantianFundProvider.js';
import { tryNormalizeCode } from '../util/codeUtil.js';

const FN_COLS = ['code', 'nav_date', 'nav', 'pre_nav', 'nav_chg_pct', 'is_estimate', 'data_origin'];

/**
 * 创建场外基金净值服务
 * @param {import('../db/driver.js').Database} db 数据库句柄
 */
export function createFundNavService(db) {
  const fnSql =
    `INSERT INTO fund_nav (${FN_COLS.join(',')}) VALUES (${FN_COLS.map(() => '?').join(',')}) ` +
    `ON CONFLICT(code, nav_date) DO UPDATE SET ` +
    FN_COLS.filter((c) => c !== 'code' && c !== 'nav_date')
      .map((c) => `${c}=excluded.${c}`)
      .join(',');

  // securities 主记录：仅当该代码尚无「场外」标记时才写 fund_category，保护场内 ETF
  const secSql =
    `INSERT INTO securities (code, name, market, type, board, price_limit_pct, fund_category, data_origin) ` +
    `VALUES (?, ?, 'SZ', 'fund', 'OTC', 0, '场外', 'real') ` +
    `ON CONFLICT(code) DO UPDATE SET fund_category = '场外' ` +
    `WHERE securities.fund_category IS NULL OR securities.fund_category <> '场外'`;

  function ensureSecurity(code, name) {
    const c = tryNormalizeCode(code);
    if (!c) return false;
    try {
      db.run(secSql, [c, name || c]);
      return true;
    } catch (e) {
      console.warn(`[fundNav] ensureSecurity(${c}) 失败：${e.message}`);
      return false;
    }
  }

  /**
   * 同步场外基金净值
   * @param {{codes?: string[]}} [opts] 指定代码；缺省则取所有 fund 持仓代码（跳过已有上市行情者）
   * @returns {Promise<{total:number, synced:number, skipped:number, failed:number, failures:object[]}>}
   */
  async function syncFundNav(opts = {}) {
    let codes = opts.codes;
    if (!codes || !codes.length) {
      const rows = db.all(
        "SELECT DISTINCT code FROM holdings WHERE asset_class = 'fund' AND code IS NOT NULL",
      );
      codes = rows.map((r) => r.code);
    }
    const list = [...new Set(codes.map(tryNormalizeCode).filter(Boolean))];
    const summary = { total: list.length, synced: 0, skipped: 0, failed: 0, estimate: 0, failures: [] };
    if (list.length === 0) return summary;

    // 跳过已有上市行情（场内 ETF）：它们走 daily_quotes 市价口径，无需净值
    const placeholders = list.map(() => '?').join(',');
    const listedRows = db.all(
      `SELECT DISTINCT code FROM daily_quotes WHERE code IN (${placeholders})`,
      list,
    );
    const listed = new Set(listedRows.map((r) => r.code));

    const toFetch = list.filter((c) => !listed.has(c));
    summary.skipped = list.length - toFetch.length;
    if (toFetch.length === 0) return summary;

    const navs = await fetchFundNav(toFetch);
    const navByCode = new Map(navs.map((n) => [n.code, n]));

    for (const code of toFetch) {
      const n = navByCode.get(code);
      if (!n) {
        summary.failed += 1;
        summary.failures.push({ code, reason: '接口未返回该基金净值' });
        continue;
      }
      try {
        if (!ensureSecurity(code, n.name)) {
          summary.failed += 1;
          summary.failures.push({ code, reason: 'securities 主记录创建失败' });
          continue;
        }
        db.run(fnSql, [
          n.code,
          n.nav_date || new Date().toISOString().slice(0, 10),
          n.nav,
          n.pre_nav,
          n.nav_chg_pct,
          n.is_estimate ? 1 : 0,
          n.is_estimate ? 'mixed' : 'real',
        ]);
        summary.synced += 1;
        if (n.is_estimate) summary.estimate += 1;
      } catch (e) {
        summary.failed += 1;
        summary.failures.push({ code, reason: e.message });
      }
    }
    return { ...summary, navs };
  }

  return { name: 'fundNavService', syncFundNav };
}
