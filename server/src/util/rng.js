// ============================================================
// 确定性伪随机工具：mulberry32（以 code 字符串为种子）
// 同一 code 每次生成完全一致的序列（幂等，QA 可写断言）
// ============================================================

/** 字符串 -> 32 位整数种子（FNV-1a 哈希） */
export function hashSeed(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * mulberry32 伪随机数生成器（返回函数，每次调用产生 [0,1) 的确定序列）
 * @param {number|string} seed 数字种子或字符串（自动哈希）
 */
export function mulberry32(seed) {
  let a = typeof seed === 'string' ? hashSeed(seed) : (seed >>> 0);
  return function next() {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 以 code 为种子创建确定性随机数工厂
 * 提供多种分布采样：
 *   .next()            [0,1)
 *   .range(min,max)    均匀区间
 *   .int(min,max)      整数（含两端）
 *   .choice(arr)       从数组随机取一项
 */
export function seededRandom(code) {
  const rng = mulberry32(hashSeed(String(code)));
  return {
    next: rng,
    range(min, max) {
      return min + (max - min) * rng();
    },
    int(min, max) {
      return Math.floor(min + (max - min + 1) * rng());
    },
    choice(arr) {
      if (!arr || arr.length === 0) return undefined;
      return arr[Math.floor(rng() * arr.length)];
    },
  };
}
