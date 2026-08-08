// ============================================================
// Vitest 配置：外部化原生/内置模块（better-sqlite3 / node:sqlite / sql.js）
// ============================================================
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
    server: {
      deps: {
        // 原生模块与 Node 内置模块不经过 Vite 转换，避免解析失败
        external: ['better-sqlite3', 'sql.js', /^node:/],
      },
    },
    pool: 'forks',
    poolOptions: {
      forks: {
        // node:sqlite 在 worker 内可用
        singleFork: true,
      },
    },
  },
});
