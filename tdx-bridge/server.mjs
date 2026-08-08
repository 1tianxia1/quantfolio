// ============================================================
// tdx-bridge — 通达信实时解析桥接服务（HTTP）
//
// 后端 securityResolver 在本地库未命中时，会请求：
//   GET {TDX_BRIDGE_URL}/lookup?code=XXXXXX
// 期望返回 JSON {code,name,market,type,board,price_limit_pct}，
// 否则（非 2xx）按"未找到"处理，绝不编造数据。
//
// 本服务用 pytdx（Python）直连通达信行情服务器拉全量证券列表，
// 在内存中建立 code -> 证券 的映射，按需解析。
// 后端本身已做本地优先，因此本服务只在本地 miss 时被触发 ——
// 对基金/指数/新上市代码也能实时解析。
// ============================================================
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.TDX_BRIDGE_PORT || '5599', 10);
const PY = process.env.TDX_PYTHON || 'python';
const CLIENT = path.join(__dirname, 'tdx_client.py');
const CACHE_TTL = (parseInt(process.env.BRIDGE_CACHE_TTL || '3600', 10)) * 1000;
const FAIL_BACKOFF = 30000; // 失败 30s 内不重复打 TDX，避免雪崩

let cache = null;
let cacheTime = 0;
let loading = null;
let lastFail = 0;

function loadAll() {
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    const p = spawn(PY, [CLIENT, 'all'], { windowsHide: true });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => {
      loading = null;
      if (code !== 0) return reject(new Error(err || 'pytdx exit ' + code));
      try {
        // pytdx 可能向 stdout 漏打探测日志，取最后一行作为 JSON 解析
        const lines = out.split('\n').filter(Boolean);
        const jsonLine = lines[lines.length - 1] || out;
        const arr = JSON.parse(jsonLine);
        const m = new Map();
        for (const s of arr) m.set(s.code, s);
        resolve(m);
      } catch (e) {
        reject(new Error('parse bridge output: ' + e.message + ' | raw=' + out.slice(0, 200)));
      }
    });
  });
  return loading;
}

async function ensureCache() {
  const now = Date.now();
  if (cache && now - cacheTime <= CACHE_TTL) return cache;
  if (now - lastFail < FAIL_BACKOFF) throw new Error('backoff');
  const m = await loadAll();
  cache = m;
  cacheTime = now;
  return cache;
}

function send(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  if (u.pathname === '/health') {
    return send(res, 200, { ok: true, cached: cache ? cache.size : 0 });
  }
  if (u.pathname === '/lookup') {
    const code = u.searchParams.get('code') || '';
    const name = u.searchParams.get('name') || '';
    const q = (code || name || '').trim();
    if (!q) return send(res, 400, { error: 'missing code or name' });
    try {
      const c = await ensureCache();
      let hit = null;
      if (/^\d{6}$/.test(q)) {
        hit = c.get(q) || null;
      } else {
        for (const s of c.values()) {
          if (s.name && s.name.includes(q)) { hit = s; break; }
        }
      }
      if (hit) return send(res, 200, hit);
      return send(res, 404, { error: 'not_found', note: '未从通达信行情获取到该证券，未编造数据' });
    } catch (e) {
      lastFail = Date.now();
      return send(res, 502, { error: 'bridge_unavailable', message: String(e.message || e) });
    }
  }
  return send(res, 404, { error: 'unknown_path' });
});

server.listen(PORT, () => {
  console.log(`[tdx-bridge] listening on http://localhost:${PORT}  (py=${PY}, cacheTTL=${CACHE_TTL / 1000}s)`);
  // 预热：后台拉一次全量，避免首个请求因 pytdx 连接耗时超过后端 8s 超时
  ensureCache()
    .then((c) => console.log(`[tdx-bridge] preloaded ${c.size} securities from TDX`))
    .catch((e) => console.warn('[tdx-bridge] preload failed:', e.message));
});
