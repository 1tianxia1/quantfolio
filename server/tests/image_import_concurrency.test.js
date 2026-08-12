// 验证 recognizeHoldingsFromImages 逐张并发识别 + 单图失败隔离
// （一张图超时/失败不应拖垮整批导入）
import { describe, it, expect, vi, beforeEach } from 'vitest';

// 用 mock 替换 callVisionLLM，精确控制每张图的成败，避免真实网络/AI 依赖
vi.mock('../src/services/aiService.js', async (importActual) => {
  const actual = await importActual();
  return { ...actual, callVisionLLM: vi.fn() };
});

import { recognizeHoldingsFromImages } from '../src/services/holdingImageService.js';
import { callVisionLLM } from '../src/services/aiService.js';

beforeEach(() => {
  callVisionLLM.mockReset();
});

describe('recognizeHoldingsFromImages 逐张并发隔离', () => {
  it('一张图识别失败（超时），另一张成功 → 成功图正常返回 + 失败图进入 warning', async () => {
    // 第 1 张（idx 0）超时失败；第 2 张（idx 1）正常返回一只股票
    callVisionLLM
      .mockRejectedValueOnce(new Error('AI 图片识别请求超时'))
      .mockResolvedValueOnce('[{"type":"stock","name":"成功股","code":"000001","quantity":100,"cost_price":1}]');

    const result = await recognizeHoldingsFromImages({}, ['img0.png', 'img1.png'], {});

    // 失败的图不应影响成功的图
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].name).toBe('成功股');
    // 失败图应在 warning 中提示用户，而非静默丢失
    expect(result.warnings.some((w) => w.includes('图片识别失败'))).toBe(true);
  });

  it('全部图片都失败 → 整体抛错（而非返回空结果误导用户）', async () => {
    callVisionLLM.mockRejectedValue(new Error('AI 图片识别请求超时'));

    await expect(
      recognizeHoldingsFromImages({}, ['a.png', 'b.png', 'c.png'], {}),
    ).rejects.toThrow(/图片识别失败|全部图片识别失败/);
  });

  it('逐张识别：每张图独立调用 callVisionLLM（而非整批一次调用）', async () => {
    callVisionLLM.mockResolvedValue('[]'); // 返回空数组，但调用次数应等于图片数
    await recognizeHoldingsFromImages({}, ['a.png', 'b.png', 'c.png', 'd.png'], {});
    expect(callVisionLLM).toHaveBeenCalledTimes(4);
  });
});
