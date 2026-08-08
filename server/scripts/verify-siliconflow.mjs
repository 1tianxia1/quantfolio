// 真调用验证：SiliconFlow deepseek-ai/DeepSeek-V4-Flash
// 用 managed node 运行：node scripts/verify-siliconflow.mjs
import { callLLM } from '../src/services/aiService.js';

const prompt = '用一句话向普通股民介绍什么是量化投资，不超过30字。';
console.log('调用 SiliconFlow deepseek-ai/DeepSeek-V4-Flash ...');
const t0 = Date.now();
const content = await callLLM(prompt);
const dt = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`耗时 ${dt}s，返回长度 ${content.length}`);
console.log('--- 模型前 120 字 ---');
console.log(content.slice(0, 120));

if (!content || content.trim().length === 0) {
  console.error('FAIL: 空响应');
  process.exit(1);
}
if (!/[一-龥]/.test(content)) {
  console.error('FAIL: 响应不含中文');
  process.exit(1);
}
console.log('PASS: 真实 AI 调用成功');
