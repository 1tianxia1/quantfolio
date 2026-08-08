// ============================================================
// 内存 TTL 缓存 + 容量淘汰 + getOrLoad 单飞
//
// 为什么自研（架构 §1.2）：避免为几十行逻辑引入 lru-cache。
// 单飞（single-flight）：同一 key 的并发 miss 只会真正打一次源，
// 其余调用方复用同一个 Promise —— 这是东财限频下的关键保护。
// ============================================================

/**
 * 创建 TTL 缓存
 * @param {object} [options] 配置
 * @param {number} [options.maxSize=500] 最大条目数（超出按最久未访问淘汰）
 * @param {number} [options.defaultTtlMs=30000] 默认 TTL
 * @returns {object} 缓存实例
 */
export function createTtlCache(options = {}) {
  const maxSize = Number(options.maxSize) > 0 ? Number(options.maxSize) : 500;
  const defaultTtlMs = Number(options.defaultTtlMs) > 0 ? Number(options.defaultTtlMs) : 30000;

  /** @type {Map<string, {value: *, expireAt: number}>} Map 迭代顺序 = 插入顺序，用于近似 LRU */
  const store = new Map();
  /** @type {Map<string, Promise<*>>} 单飞在途表 */
  const inflight = new Map();
  const stats = { hit: 0, miss: 0, expired: 0, evicted: 0, coalesced: 0 };

  /** 淘汰最久未访问项直到容量达标 */
  function evictIfNeeded() {
    while (store.size > maxSize) {
      const oldestKey = store.keys().next().value;
      if (oldestKey === undefined) break;
      store.delete(oldestKey);
      stats.evicted += 1;
    }
  }

  return {
    /** 统计快照（供日志与自测） */
    get stats() {
      return { ...stats, size: store.size, inflight: inflight.size };
    },

    /** 当前条目数 */
    get size() {
      return store.size;
    },

    /**
     * 读缓存；未命中或已过期返回 undefined
     * @param {string} key 缓存键
     * @returns {*} 缓存值或 undefined
     */
    get(key) {
      const entry = store.get(key);
      if (!entry) {
        stats.miss += 1;
        return undefined;
      }
      if (entry.expireAt <= Date.now()) {
        store.delete(key);
        stats.expired += 1;
        stats.miss += 1;
        return undefined;
      }
      // 命中后重新插入，刷新 LRU 顺序
      store.delete(key);
      store.set(key, entry);
      stats.hit += 1;
      return entry.value;
    },

    /**
     * 是否存在有效缓存（不影响 LRU 顺序统计）
     * @param {string} key 缓存键
     * @returns {boolean}
     */
    has(key) {
      const entry = store.get(key);
      return !!entry && entry.expireAt > Date.now();
    },

    /**
     * 写缓存
     * @param {string} key 缓存键
     * @param {*} value 缓存值
     * @param {number} [ttlMs] TTL，缺省用 defaultTtlMs；<=0 表示不缓存
     * @returns {void}
     */
    set(key, value, ttlMs) {
      const ttl = Number(ttlMs) > 0 ? Number(ttlMs) : defaultTtlMs;
      if (ttl <= 0) return;
      if (store.has(key)) store.delete(key);
      store.set(key, { value, expireAt: Date.now() + ttl });
      evictIfNeeded();
    },

    /**
     * 删除单个 key
     * @param {string} key 缓存键
     * @returns {boolean} 是否删除了条目
     */
    delete(key) {
      return store.delete(key);
    },

    /** 清空全部缓存与在途表 */
    clear() {
      store.clear();
      inflight.clear();
    },

    /**
     * 读缓存，未命中则调用 loader 并写回；同 key 并发只打一次源（单飞）
     * @template T
     * @param {string} key 缓存键
     * @param {number} ttlMs TTL（毫秒）
     * @param {() => Promise<T>} loader 回源函数
     * @returns {Promise<T>} 缓存值或回源结果
     */
    async getOrLoad(key, ttlMs, loader) {
      const cached = this.get(key);
      if (cached !== undefined) return cached;

      const pending = inflight.get(key);
      if (pending) {
        stats.coalesced += 1;
        return pending;
      }

      const task = (async () => {
        const value = await loader();
        // undefined 视为「无结果」，不落缓存，避免把瞬时失败固化住
        if (value !== undefined) this.set(key, value, ttlMs);
        return value;
      })();

      inflight.set(key, task);
      try {
        return await task;
      } finally {
        inflight.delete(key);
      }
    },
  };
}
