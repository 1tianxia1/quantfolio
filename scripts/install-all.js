// 一键安装前后端依赖（根 postinstall 调用）
// 说明：使用 npm --prefix 逐个安装，避免 better-sqlite3 原生模块安装失败时阻塞前端依赖
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const root = path.resolve(__dirname, '..');
const targets = [
  { dir: path.join(root, 'server'), name: 'server' },
  { dir: path.join(root, 'client'), name: 'client' },
];

function run(dir, name) {
  if (!fs.existsSync(path.join(dir, 'package.json'))) {
    console.log(`[install-all] 跳过 ${name}（无 package.json）`);
    return;
  }
  console.log(`\n[install-all] 开始安装 ${name} 依赖 ...`);
  const r = spawnSync('npm', ['install'], { cwd: dir, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) {
    console.error(`[install-all] ${name} 依赖安装失败（exit=${r.status}）`);
    process.exitCode = 1;
  } else {
    console.log(`[install-all] ${name} 依赖安装完成`);
  }
}

for (const t of targets) run(t.dir, t.name);
console.log('\n[install-all] 全部完成');
