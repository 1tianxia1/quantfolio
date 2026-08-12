// 验证 callVisionLLM 的超时/5xx/网络错误重试（图片导入偶发超时的核心修复）
import { describe, it, expect, vi, afterEach } from 'vitest';
import { callVisionLLM } from '../src/services/aiService.js';

const CFG = { apiKey: 'test-key', baseUrl: 'http://fake.local/v1/chat/completions', model: 'test-model' };

afterEach(() => {
  vi.restoreAllMocks();
});

/** 模拟上游正常 JSON 文本回复（非流式，避免构造 SSE 流） */
function okTextResponse(text) {
  return new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('callVisionLLM 超时/5xx 重试', () => {
  it('单次超时（AbortError）后重试成功，不再直接报超时', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      return okTextResponse('[{"type":"stock","name":"重试成功","code":"000001","quantity":100,"cost_price":1}]');
    }));

    const text = await callVisionLLM('p', ['b64'], {
      aiConfig: CFG,
      stream: false,
      timeoutMs: 100, // 仅用于驱动逻辑，fetch mock 同步抛出，不会真等 100ms
    });

    expect(calls).toBe(2); // 1 次失败 + 1 次成功
    expect(text).toContain('重试成功');
  });

  it('上游 5xx 过载时同样重试成功', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls += 1;
      if (calls === 1) return new Response('overloaded', { status: 503 });
      return okTextResponse('[{"type":"stock","name":"5xx恢复","code":"000002","quantity":10,"cost_price":5}]');
    }));

    const text = await callVisionLLM('p', ['b64'], { aiConfig: CFG, stream: false, timeoutMs: 100 });
    expect(calls).toBe(2);
    expect(text).toContain('5xx恢复');
  });

  it('连续超时耗尽重试次数后，抛出带重试次数的超时错误', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    }));

    await expect(
      callVisionLLM('p', ['b64'], { aiConfig: CFG, stream: false, timeoutMs: 100 }),
    ).rejects.toThrow(/已重试/);
  });

  it('认证错误（4xx）不可重试，立即抛出原错误', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls += 1;
      return new Response('unauthorized', { status: 401 });
    }));

    await expect(
      callVisionLLM('p', ['b64'], { aiConfig: CFG, stream: false, timeoutMs: 100 }),
    ).rejects.toThrow(/401/);
    expect(calls).toBe(1); // 只调用一次，未重试
  });
});
