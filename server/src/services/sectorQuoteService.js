// ============================================================
// 场外基金关联板块/指数行情同步（腾讯行情）
//
// 背景：fundgz（天天基金盘中估值）对部分网络/数据中心 IP 反爬拦截，
// 且场外基金收盘后 FundMNFInfo 的 GSZ=null → 拿不到"今日涨跌"。
// 养基宝的做法：显示基金跟踪的"关联板块今日涨跌幅"作为当日收益预估。
//   例：国证有色金属今日 +1.17%（sz399395）→ 鹏华国证有色基金当日盈亏率预估 +1.17%。
//
// 本服务：
//   1. 维护 场外基金代码 → 关联指数/板块（腾讯行情代码）映射表
//   2. 调腾讯行情接口 qt.gtimg.cn/q=... 拉指数今日现价/涨跌幅
//   3. 写入 fund_estimate（data_origin='sector'，est_date=今日），
//      portfolioService.valuate 的 sector 分支据此估算当日盈亏
//
// 腾讯行情字段（v_xxx="..." 分号分隔）：
//   p[1]=名称 p[3]=现价 p[4]=昨收 p[31]=涨跌额 p[32]=涨跌幅(%)
//   注：指数与美股指数均适用此偏移。
// ============================================================
import https from 'node:https';

// 场外基金 → 关联指数/板块（腾讯行情代码）。
// 添加新基金时在此登记即可（可扩展为数据库表）。
export const FUND_SECTOR_MAP = {
  '017141': { code: 'sh000819', name: '中证有色金属' },
  '021297': { code: 'sz399395', name: '国证有色金属' },
  '021536': { code: 'sz399808', name: '中证软件服务' },
  '019175': { code: 'usNDX', name: '纳斯达克100' },
  '019174': { code: 'usNDX', name: '纳斯达克100' },
  '007467': { code: 'sh000922', name: '中证红利' },
  '008701': { code: 'sh518880', name: '黄金9999' },
  '021143': { code: 'hkHSI', name: '恒生指数' },
};

const TZ_OFFSET_MS = 8 * 3600_000;

function beijingToday() {
  return new Date(Date.now() + TZ_OFFSET_MS).toISOString().slice(0, 10);
}

function nowStr() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

/** 拉取腾讯行情（批量，逗号分隔），返回 { varName: {name,price,prev,pct} } */
function fetchTencent(tencentCodes) {
  return new Promise((resolve) => {
    if (!tencentCodes.length) { resolve({}); return; }
    const url = `https://qt.gtimg.cn/q=${tencentCodes.join(',')}`;
    const req = https.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      timeout: 6000,
    }, (res) => {
      let buf = '';
      res.on('data', (d) => (buf += d));
      res.on('end', () => {
        const out = {};
        const lines = buf.split(';');
        for (const line of lines) {
          const m = line.match(/v_(\w+)="([^"]*)"/);
          if (!m) continue;
          const [, varName, payload] = m;
          const p = payload.split('~');
          if (p.length < 33) continue;
          const pct = Number(p[32]);
          out[varName] = {
            name: p[1] || '',
            price: Number(p[3]) || 0,
            prev: Number(p[4]) || 0,
            pct: Number.isFinite(pct) ? pct : null,
          };
        }
        resolve(out);
      });
    });
    req.on('error', () => resolve({}));
    req.on('timeout', () => { req.destroy(); resolve({}); });
    setTimeout(() => { try { req.destroy(); } catch { /* noop */ } resolve({}); }, 8000);
  });
}

/**
 * 同步关联板块行情到 fund_estimate（data_origin='sector'）
 * @param {import('../db/driver.js').Database} db
 * @returns {Promise<{total:number, synced:number, skipped:number, detail:Array}>}
 */
export function createSectorQuoteService(db) {
  async function syncSectorEstimates(codes = []) {
    const mapped = [...new Set((codes || []).map((c) => String(c).trim()))]
      .filter((c) => FUND_SECTOR_MAP[c]);
    const summary = { total: mapped.length, synced: 0, skipped: 0, detail: [] };
    if (!mapped.length) return summary;

    const tencentCodes = [...new Set(mapped.map((c) => FUND_SECTOR_MAP[c].code))];
    const quotes = await fetchTencent(tencentCodes);
    const today = beijingToday();

    const getNav = db.prepare('SELECT nav FROM fund_nav WHERE code = ? ORDER BY nav_date DESC LIMIT 1');
    const upsert = db.prepare(
      `INSERT INTO fund_estimate (code, est_date, gsz, gszzl, gztime, dwjz, jzrq, data_origin, updated_at)
       VALUES (?, ?, NULL, ?, NULL, ?, ?, 'sector', ?)
       ON CONFLICT(code, est_date) DO UPDATE SET
         gszzl = excluded.gszzl,
         dwjz = excluded.dwjz,
         jzrq = excluded.jzrq,
         data_origin = excluded.data_origin,
         updated_at = excluded.updated_at
       WHERE fund_estimate.data_origin != 'estimate'`,
    );

    for (const code of mapped) {
      const m = FUND_SECTOR_MAP[code];
      const q = quotes[m.code];
      if (!q || q.pct == null) {
        summary.skipped += 1;
        summary.detail.push({ code, sector: m.name, pct: null, reason: 'quote_unavailable' });
        continue;
      }
      const navRow = getNav.get(code);
      const dwjz = navRow && Number.isFinite(Number(navRow.nav)) ? Number(navRow.nav) : null;
      upsert.run(code, today, q.pct, dwjz, today, nowStr());
      summary.synced += 1;
      summary.detail.push({ code, sector: m.name, pct: q.pct, price: q.price });
    }
    return summary;
  }

  return { syncSectorEstimates, FUND_SECTOR_MAP };
}
