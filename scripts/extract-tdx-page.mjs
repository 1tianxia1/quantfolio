// ============================================================
// 从 tdx_screener 的工具结果文件（超长被落盘）中提取 data 数组，
// 写入 scripts/_tdx_import/<prefix>_p<pageNo>.json 供 import-tdx-securities.mjs 使用。
// 支持一次处理多个源文件：node scripts/extract-tdx-page.mjs <outDir> <prefix> <src1> [src2...]
// 文件名中的 pageNo 取自 meta.pageNo，无需手动对应。
// ============================================================
import fs from 'node:fs';
import path from 'node:path';

const [outDir, prefix, ...srcs] = process.argv.slice(2);
if (!outDir || !prefix || srcs.length === 0) {
  console.error('usage: node extract-tdx-page.mjs <outDir> <prefix> <src1> [src2...]');
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });
let total = 0;
for (const src of srcs) {
  let txt;
  try {
    txt = fs.readFileSync(src, 'utf8');
  } catch (e) {
    console.error('读取失败，跳过:', src, e.message);
    continue;
  }
  const m = txt.match(/```json\s*([\s\S]*?)```/);
  if (!m) {
    console.error('未找到 json 代码块，跳过:', src);
    continue;
  }
  let json;
  try {
    json = JSON.parse(m[1]);
  } catch (e) {
    console.error('JSON 解析失败，跳过:', src, e.message);
    continue;
  }
  const data = json.data;
  if (!Array.isArray(data)) {
    console.error('data 非数组，跳过:', src);
    continue;
  }
  const pageNo = (json.meta && json.meta.pageNo) || 1;
  const out = path.join(outDir, `${prefix}_p${pageNo}.json`);
  fs.writeFileSync(out, JSON.stringify(data));
  total += data.length;
  console.log(`wrote ${data.length} -> ${out} (page ${pageNo}, total=${(json.meta && json.meta.total) || '?'})`);
}
console.log(`本批合计 ${total} 条`);
