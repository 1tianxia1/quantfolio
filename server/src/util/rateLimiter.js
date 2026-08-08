// ============================================================
// 限频器：令牌桶（QPS）+ 端点级子桶 + 信号量（并发上限）
//
// 为什么自研（架构 §1.2）：单进程本地服务，引 bottleneck / p-limit 属过度依赖。
// 用途：对东方财富公开接口自律限速，避免把本机 IP 打进黑名单（架构 §6.1）。
//
// 语义：
//   acquire(key) 会一直等到「全局令牌 + 端点令牌 + 并发名额」三者同时可用才 resolve，
//   调用方必须在 finally 中 release(key)，否则并发名额会泄漏。
//   推荐直接用 run(key, fn)，它保证成对释放。
// ============================================================

/** 单个令牌桶（匀速补充，容量 = 速率，突发不超过 1 秒的量） */
class TokenBucket {
  /**
   * @param {number} ratePerSec 每秒补充的令牌数（即 QPS 上限）
   * @param {number} [capacity] 桶容量，默认等于速率
   */
  constructor(ratePerSec, capacity) {
    this.rate = Math.max(0.001, Number(ratePerSec) || 1);
    this.capacity = Math.max(1, Number(capacity) || Math.max(1, Math.ceil(this.rate)));
    this.tokens = this.capacity;
    this.lastRefill = Date.now();
  }

  /** 按经过时间补充令牌 */
  refill() {
    const now = Date.now();
    const elapsedSec = (now - this.lastRefill) / 1000;
    if (elapsedSec <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.rate);
    this.lastRefill = now;
  }

  /**
   * 尝试取一个令牌
   * @returns {boolean} 是否取到
   */
  tryTake() {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  /**
   * 距离下一个令牌可用还需多少毫秒（用于精确休眠，避免忙等）
   * @returns {number} 毫秒
   */
  msUntilNext() {
    this.refill();
    if (this.tokens >= 1) return 0;
    return Math.max(1, Math.ceil(((1 - this.tokens) / this.rate) * 1000));
  }
}

/** 简单休眠 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 创建限频器
 * @param {object} [options] 配置
 * @param {number} [options.qps=5] 全局 QPS
 * @param {number} [options.endpointQps=2] 单端点 QPS
 * @param {number} [options.maxConcurrency=4] 最大并发数
 * @param {number} [options.maxWaitMs=30000] 单次 acquire 最长等待（超时抛错，防止请求无限堆积）
 * @returns {object} 限频器实例
 */
export function createRateLimiter(options = {}) {
  const qps = Number(options.qps) > 0 ? Number(options.qps) : 5;
  const endpointQps = Number(options.endpointQps) > 0 ? Number(options.endpointQps) : 2;
  const maxConcurrency = Number(options.maxConcurrency) > 0 ? Number(options.maxConcurrency) : 4;
  const maxWaitMs = Number(options.maxWaitMs) > 0 ? Number(options.maxWaitMs) : 30000;

  const globalBucket = new TokenBucket(qps);
  /** @type {Map<string, TokenBucket>} 端点级子桶 */
  const buckets = new Map();
  let inFlight = 0;

  /** 取（或创建）端点子桶 */
  function bucketFor(key) {
    const k = String(key || 'default');
    let b = buckets.get(k);
    if (!b) {
      b = new TokenBucket(endpointQps);
      buckets.set(k, b);
    }
    return b;
  }

  return {
    /** 配置快照（供日志与自测断言） */
    config: Object.freeze({ qps, endpointQps, maxConcurrency, maxWaitMs }),

    /** 当前在途请求数 */
    get inFlight() {
      return inFlight;
    },

    /**
     * 申请一个执行名额；成功后必须调用 release(key)
     * @param {string} key 端点键（用于端点级子桶）
     * @returns {Promise<void>}
     * @throws {Error} 等待超过 maxWaitMs 时抛错
     */
    async acquire(key) {
      const deadline = Date.now() + maxWaitMs;
      const endpointBucket = bucketFor(key);
      for (;;) {
        if (inFlight < maxConcurrency) {
          // 并发有名额，再看两级令牌桶
          const gWait = globalBucket.msUntilNext();
          const eWait = endpointBucket.msUntilNext();
          if (gWait === 0 && eWait === 0) {
            // 两个桶都必须真正扣减，避免只扣一个造成速率漂移
            const gOk = globalBucket.tryTake();
            if (gOk) {
              const eOk = endpointBucket.tryTake();
              if (eOk) {
                inFlight += 1;
                return;
              }
              // 端点桶失手（并发竞争），把全局令牌还回去
              globalBucket.tokens = Math.min(globalBucket.capacity, globalBucket.tokens + 1);
            }
          }
        }
        if (Date.now() >= deadline) {
          throw new Error(`限频等待超时（${maxWaitMs}ms）：endpoint=${key}，请降低并发或提高 EM_QPS`);
        }
        // 休眠到「最早可用时刻」，并发满时退化为固定小步轮询
        const waitCandidates = [globalBucket.msUntilNext(), endpointBucket.msUntilNext()];
        const wait = inFlight >= maxConcurrency
          ? 15
          : Math.max(1, Math.min(...waitCandidates.filter((n) => n > 0), 50) || 5);
        await sleep(Math.min(wait, Math.max(1, deadline - Date.now())));
      }
    },

    /**
     * 归还并发名额（令牌不归还，令牌代表已消耗的速率配额）
     * @param {string} [_key] 端点键（保留参数以对齐类图签名）
     * @returns {void}
     */
    release(_key) {
      inFlight = Math.max(0, inFlight - 1);
    },

    /**
     * 包裹执行：自动 acquire / release，推荐用法
     * @template T
     * @param {string} key 端点键
     * @param {() => Promise<T>} fn 实际任务
     * @returns {Promise<T>} 任务结果
     */
    async run(key, fn) {
      await this.acquire(key);
      try {
        return await fn();
      } finally {
        this.release(key);
      }
    },

    /** 重置内部状态（仅供测试） */
    reset() {
      buckets.clear();
      globalBucket.tokens = globalBucket.capacity;
      globalBucket.lastRefill = Date.now();
      inFlight = 0;
    },
  };
}
