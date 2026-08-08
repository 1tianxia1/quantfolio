// ============================================================
// 服务启动入口：读 env -> 建库 -> 注册路由 -> listen 3001
// ============================================================
import env from './config/env.js';
import { openDatabase, getDriverName } from './db/driver.js';
import { initSchema } from './db/schema.js';
import { createApp } from './app.js';

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

  const app = createApp(db);
  app.listen(env.PORT, () => {
    console.log(`[QuantFolio] 后端服务已启动: http://localhost:${env.PORT}`);
    console.log(`[QuantFolio] 健康检查: GET http://localhost:${env.PORT}/api/health`);
  });
}

main().catch((e) => {
  console.error('[QuantFolio] 启动失败:', e);
  process.exit(1);
});
