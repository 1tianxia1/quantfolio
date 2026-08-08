// ============================================================
// 证券解析器：本地优先 → 可选 Tongdaxin 桥接兜底 → 写回本地缓存
//
// 设计约束：运行中的后端 Node 进程无法直接调用 WorkBuddy 侧的 Tongdaxin MCP，
// 因此"实时解析"依赖两层：
//   1) 本地库预置（由 scripts/import-tdx-securities.mjs 从连接器批量灌入，data_origin='real'）；
//   2) 可选 TDX_BRIDGE_URL：指向一个能代理连接器 lookup 的 HTTP 服务，运行时按需解析并缓存。
//
// 红线：绝不编造数据。桥接失败或返回空时，如实返回 null（不伪造代码/名称/数字）。
// ============================================================
import env from '../config/env.js';

/** 判断是否为 A 股/基金/指数 6 位代码 */
export function looksLikeCode(q) {
  return /^\d{6}$/.test(String(q || '').trim());
}

/** 由代码前缀推断市场（SH/SZ/BJ），与 seed 约定一致 */
function marketFromCode(code, type) {
  if (type === 'index') return /^000/.test(code) ? 'SH' : 'SZ';
  if (/^[569]/.test(code) || /^900/.test(code) || /^688|^601|^603|^600|^604|^605|^689/.test(code)) return 'SH';
  if (/^[84]/.test(code) || /^920/.test(code)) return 'BJ';
  return 'SZ';
}

/** 将解析到的证券写回本地库（带缓存）。冲突时保留既有数据（DO NOTHING）。 */
function cacheSecurity(db, sec) {
  const market = sec.market || marketFromCode(sec.code, sec.type || 'stock');
  const type = sec.type || 'stock';
  try {
    db.run(
      `INSERT INTO securities (code, name, market, type, board, price_limit_pct, is_st, is_index_member, data_origin)
       VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT(code) DO NOTHING`,
      [sec.code, sec.name, market, type, sec.board || 'SZ-Main10', sec.price_limit_pct ?? 10, sec.is_st ? 1 : 0, 0, 'real'],
    );
  } catch (e) {
    // 写回失败（如约束异常）不影响主流程，本地优先结果仍可返回
    console.warn('[resolver] cacheSecurity 失败:', e.message);
  }
  return { code: sec.code, name: sec.name, type, sector: null, industry: null };
}

/**
 * 运行时解析：返回可被 /search 复用的最小结果对象，或 null。
 * @param {import('../db/driver.js').Database} db
 * @param {string} q 6 位代码（名称搜索走本地 LIKE 即可，本函数仅处理代码）
 */
export async function resolveSecurity(db, q) {
  const query = String(q || '').trim();
  if (!looksLikeCode(query)) return null;

  // 1) 本地已存在？
  const local = db.get('SELECT code, name, type, sector, industry FROM securities WHERE code = ?', [query]);
  if (local) return local;

  // 2) 可选桥接兜底（环境变量 TDX_BRIDGE_URL 配置时启用）
  const bridge = env.TDX_BRIDGE_URL;
  if (bridge) {
    try {
      const url = `${bridge.replace(/\/$/, '')}/lookup?code=${encodeURIComponent(query)}`;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      const res = await fetch(url, { signal: ctrl.signal });
      clearTimeout(timer);
      if (res.ok) {
        const data = await res.json();
        if (data && data.code) return cacheSecurity(db, data);
      }
    } catch (e) {
      console.warn('[resolver] 桥接解析失败:', e.message);
    }
  }
  return null;
}
