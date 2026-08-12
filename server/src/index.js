// ============================================================
// 服务启动入口：读 env -> 建库 -> 注册路由 -> listen 3001
// ============================================================
import env from './config/env.js';
import { openDatabase, getDriverName } from './db/driver.js';
import { initSchema } from './db/schema.js';
import { createApp } from './app.js';
import { refreshRealData } from './services/realDataRefresher.js';
import { createFundNavService } from './services/fundNavService.js';
import { start as startIntradayPoller } from './services/intradayPoller.js';

async function main() {
  console.log('[QuantFolio] 正在初始化数据库 ...');
  const db = await openDatabase(env.DB_PATH);
  initSchema(db);
  console.log(`[QuantFolio] 数据库就绪（驱动: ${getDriverName()}，路径: ${env.DB_PATH}）`);

  // 数据库为空时提示先执行 seed
  const count = db.get('SELECT COUNT(*) AS n FROM securities')?.n ?? 0;
  if (count === 0) {
    console.warn('[QuantFolio] 提示：securities 表为空，请先执行 `npm run seed` 导入种子数据');
  }

  // 盘中实时行情轮询器（声明在 main 作用域，供优雅关闭使用）
  let intradayPoller = null;

  const app = createApp(db);
  const server = app.listen(env.PORT, () => {
    console.log(`[QuantFolio] 后端服务已启动: http://localhost:${env.PORT}`);
    console.log(`[QuantFolio] 健康检查: GET http://localhost:${env.PORT}/api/health`);

    // 启动盘中实时行情轮询（每 30s 更新持仓标的当天行情到 daily_quotes）
    intradayPoller = startIntradayPoller(db);

    // 启动后异步同步场外基金净值（不阻塞启动；失败仅告警，不影响主流程）
    (async () => {
      let syncDb = null;
      try {
        syncDb = await openDatabase(env.DB_PATH);
        const fn = createFundNavService(syncDb);
        const r = await fn.syncFundNav({});
        console.log(`[fundNav] 启动同步完成：成功 ${r.synced} / 跳过 ${r.skipped} / 失败 ${r.failed}`);
      } catch (e) {
        console.warn('[fundNav] 启动同步失败：', e.message);
      } finally {
        try { syncDb?.close(); } catch (_) { /* 忽略关闭失败 */ }
      }
    })();

    // 启动后若启用实时行情，后台轻量"抢跑"刷新（仅最近 5 天、最多 500 只），
    // 让顶栏/分析层尽快出现真实数据；全量回填由用户在设置页点"立即刷新"触发。
    // startRefresh 自行管理数据库连接（不依赖调用方传入的 db），避免 db 被提前关闭。
    (async () => {
      try {
        const pc = await import('./config/providerConfig.js');
        const rj = await import('./services/refreshJob.js');
        if (pc.isRealtimeEnabled(db)) {
          await rj.startRefresh({ limit: 5, max: 500, quiet: true });
          console.log('[market] 启动自动刷新已触发（实时行情）');
        }
      } catch (e) {
        console.warn('[market] 启动自动刷新失败：', e.message);
      }
    })();
  });

  // 可选的真实行情定时刷新（默认关闭，需在 server/.env 显式开启）
  // 独立开库执行：刷新是长事务重写，避免与在线请求共用同一句柄
  if (env.AUTO_REFRESH_ENABLED === 'true') {
    const intervalMs = Number(env.AUTO_REFRESH_INTERVAL_MS) || 6 * 3600 * 1000;
    setInterval(async () => {
      let refreshDb = null;
      try {
        refreshDb = await openDatabase(env.DB_PATH);
        await refreshRealData(refreshDb, { quiet: true });
        console.log('[autoRefresh] 真实行情刷新完成');
      } catch (e) {
        console.warn('[autoRefresh] 失败：', e.message);
      } finally {
        try { refreshDb?.close(); } catch (_) { /* 忽略关闭失败 */ }
      }
    }, intervalMs);
    console.log(`[autoRefresh] 已启用，每 ${intervalMs / 3600000}h 刷新一次`);
  }

  // 优雅关闭：SIGTERM（systemd/docker stop）/ SIGINT（Ctrl+C）
  const shutdown = (signal) => {
    console.log(`[QuantFolio] 收到 ${signal}，正在优雅关闭 ...`);
    if (intradayPoller) {
      intradayPoller.stop();
      console.log('[intraday] 盘中轮询已停止');
    }
    server.close(() => {
      console.log('[QuantFolio] HTTP 服务已关闭');
      try { db.close(); } catch (_) { /* 忽略关闭失败 */ }
      process.exit(0);
    });
    // 强制超时兜底：15s 后仍未退出则强杀
    setTimeout(() => {
      console.error('[QuantFolio] 优雅关闭超时，强制退出');
      process.exit(1);
    }, 15_000);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((e) => {
  console.error('[QuantFolio] 启动失败:', e);
  process.exit(1);
});
