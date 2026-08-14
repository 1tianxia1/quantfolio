// ============================================================
// 场外基金盘中估值采集（天天基金 fundgz JSONP）
//
// 为什么是前端采集？天天基金 fundgz.1234567.com.cn 估值接口按 IP 反爬，
// 数据中心 IP（腾讯云 CVM）直接返回"页面未找到"，只有浏览器（带 cookie/referer 的
// JSONP）能拿到。这与养基小宝(fund-baby) 同源 —— 由浏览器拉取 gsz/gszzl 后推回后端。
//
// 字段说明（来自 jsonpgz 回调）：
//   dwjz  = 最新官方单位净值（T-1 或最新披露日）
//   gsz   = 估算净值（盘中每分刷新，收盘后冻结在 15:00 估值）
//   gszzl = 估算涨跌幅(%)，即"今日实时收益"
//   gztime= 估值时间（YYYY-MM-DD HH:mm）
//   jzrq  = 官方净值日期
//
// 重要：fundgz 脚本回调名是固定的 window.jsonpgz；并发抓多只时如果每只各自覆盖
// window.jsonpgz，只有最后一只的回调能被触发，其余会被 6s 超时杀掉 —— 这就是
// fund_estimate 表一直空着的根因。本模块用全局 dispatcher 按 fundcode 派发。
// ============================================================
import http from './http';

export interface FundEstimate {
  code: string;
  gsz: number | null;
  gszzl: number | null;
  gztime: string | null;
  dwjz: number | null;
  jzrq: string | null;
}

function toNum(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ---------- 全局 jsonpgz dispatcher（一次性安装） ----------
type PendingResolver = {
  resolve: (v: FundEstimate | null) => void;
  cleanup: () => void;
};
const pendingGz = new Map<string, PendingResolver>();
let dispatcherInstalled = false;

function installDispatcher() {
  if (dispatcherInstalled || typeof window === 'undefined') return;
  dispatcherInstalled = true;
  (window as unknown as { jsonpgz: (j: unknown) => void }).jsonpgz = (json: any) => {
    if (json && json.fundcode) {
      const code = String(json.fundcode);
      const r = pendingGz.get(code);
      if (r) {
        const v: FundEstimate = {
          code,
          gsz: toNum(json.gsz),
          gszzl: toNum(json.gszzl),
          gztime: json.gztime || null,
          dwjz: toNum(json.dwjz),
          jzrq: json.jzrq || null,
        };
        pendingGz.delete(code);
        r.cleanup();
        r.resolve(v);
      }
    }
  };
}

const GZ_TIMEOUT_MS = 10_000;
const TC_TIMEOUT_MS = 6_000;

/** fundgz 单只采集（通过全局 dispatcher 派发） */
export function fetchFundGz(code: string): Promise<FundEstimate | null> {
  installDispatcher();
  return new Promise((resolve) => {
    if (typeof document === 'undefined') { resolve(null); return; }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const script = document.createElement('script');
    script.src = `https://fundgz.1234567.com.cn/js/${code}.js?rt=${Date.now()}`;
    script.async = true;
    const settle = (v: FundEstimate | null) => {
      if (!pendingGz.has(code)) return;
      clearTimeout(timer);
      if (script.parentNode) script.parentNode.removeChild(script);
      pendingGz.delete(code);
      resolve(v);
    };
    const cleanup = () => settle(null);
    pendingGz.set(code, { resolve: (v) => settle(v), cleanup });
    timer = setTimeout(() => settle(null), GZ_TIMEOUT_MS);
    script.onerror = () => settle(null);
    document.body.appendChild(script);
    console.debug(`[fundgz] → ${code}`);
  });
}

/**
 * 腾讯财经兜底（fundgz 完全失败时给一个稳定可用的官方净值来源）。
 * 字段（v_jj{code}）：
 *   ~5 单位净值 dwjz
 *   ~7 涨跌幅(%) zzl
 *   ~8 净值日期 jzrq (YYYYMMDD)
 * 注意：腾讯无盘中估值，所以只能当作"今日官方净值兜底"，不能用于"实时"标注。
 */
export function fetchFundTencent(code: string): Promise<FundEstimate | null> {
  return new Promise((resolve) => {
    if (typeof document === 'undefined') { resolve(null); return; }
    const varName = `v_jj${code}`;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const script = document.createElement('script');
    script.src = `https://qt.gtimg.cn/q=jj${code}&_t=${Date.now()}`;
    script.async = true;
    const cleanup = () => {
      clearTimeout(timer);
      if (script.parentNode) script.parentNode.removeChild(script);
    };
    const finish = (v: FundEstimate | null) => { cleanup(); resolve(v); };
    script.onload = () => {
      const raw = (window as unknown as Record<string, unknown>)[varName];
      if (typeof raw === 'string' && raw.length > 5) {
        const p = raw.split('~');
        const dwjz = toNum(p[5]);
        if (dwjz != null) {
          finish({
            code,
            gsz: null,
            gszzl: toNum(p[7]),
            gztime: null,
            dwjz,
            jzrq: p[8] ? String(p[8]).slice(0, 10) : null,
          });
          return;
        }
      }
      finish(null);
    };
    script.onerror = () => finish(null);
    timer = setTimeout(() => finish(null), TC_TIMEOUT_MS);
    document.body.appendChild(script);
    console.debug(`[fundtencent] → ${code}`);
  });
}

/** 批量采集：fundgz 并发抓，失败的逐个走腾讯兜底。腾讯兜底不返回估值只给官方净值。 */
export async function collectFundEstimates(codes: string[]): Promise<FundEstimate[]> {
  if (!codes.length) return [];
  const gzResults = await Promise.all(codes.map((c) => fetchFundGz(c)));
  const out: FundEstimate[] = [];
  for (let i = 0; i < codes.length; i++) {
    const primary = gzResults[i];
    if (primary && primary.gsz != null) {
      out.push(primary);
      continue;
    }
    // fundgz 失败或 gsz=null → 尝试腾讯兜底
    const tc = await fetchFundTencent(codes[i]);
    if (tc) out.push(tc);
  }
  console.debug(`[collect] ${codes.length} → fundgz ${gzResults.filter(Boolean).length} + tencent ${out.length - gzResults.filter(Boolean).length}`);
  return out;
}

/** 把采集到的估值推回后端落库（fundgz 真·估值 + 腾讯兜底都推；标记 data_origin 区分） */
export async function pushFundEstimates(estimates: FundEstimate[]): Promise<void> {
  if (!estimates.length) return;
  const payload = estimates.map((e) => ({
    code: e.code,
    gsz: e.gsz,
    gszzl: e.gszzl,
    gztime: e.gztime,
    dwjz: e.dwjz,
    jzrq: e.jzrq,
    // gsz 非空 → fundgz 真盘中估值；否则 → 腾讯兜底（估/兜在后端 valuate 分支选择）
    data_origin: e.gsz != null ? 'estimate' : 'tencent',
  }));
  await http.post('/portfolio/fund-estimate', payload);
}