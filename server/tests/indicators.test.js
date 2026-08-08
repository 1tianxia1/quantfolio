// ============================================================
// 技术指标纯函数单测
// ============================================================
import { describe, it, expect } from 'vitest';
import {
  sma, ema, macd, rsi, kdj, volumeStreak, high60dDistancePct,
  percentileScore, piecewise,
} from '../src/util/indicators.js';

describe('sma', () => {
  it('计算 5 日均线（前 4 个为 null）', () => {
    const out = sma([1, 2, 3, 4, 5, 6], 5);
    expect(out[0]).toBeNull();
    expect(out[3]).toBeNull();
    expect(out[4]).toBeCloseTo(3, 5);
    expect(out[5]).toBeCloseTo(4, 5);
  });
});

describe('ema', () => {
  it('EMA 首值取首个可用值，后续平滑', () => {
    const out = ema([1, 2, 3, 4], 3);
    expect(out[0]).toBe(1);
    expect(out[1]).toBeCloseTo(1.5, 5);
    expect(out[2]).toBeCloseTo(2.25, 5);
    expect(out[3]).toBeCloseTo(3.125, 5);
  });
});

describe('macd', () => {
  it('MACD 数组等长且 bar = (dif-dea)*2', () => {
    const closes = Array.from({ length: 40 }, (_, i) => 100 + Math.sin(i / 5) * 3);
    const { dif, dea, bar } = macd(closes);
    expect(dif).toHaveLength(40);
    expect(dea).toHaveLength(40);
    expect(bar).toHaveLength(40);
    const idx = 39;
    if (dif[idx] != null && dea[idx] != null) {
      expect(bar[idx]).toBeCloseTo((dif[idx] - dea[idx]) * 2, 5);
    }
  });
});

describe('rsi', () => {
  it('RSI 在 [0,100] 区间', () => {
    const closes = Array.from({ length: 30 }, (_, i) => 100 + (i % 5));
    const out = rsi(closes, 14);
    for (const v of out) {
      if (v != null) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(100);
      }
    }
    expect(out[13]).toBeNull();
    expect(out[14]).not.toBeNull();
  });
});

describe('kdj', () => {
  it('KDJ 基本形状：K/D/J 等长，J = 3K-2D', () => {
    const highs = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19];
    const lows = [8, 9, 9, 10, 11, 12, 13, 14, 15, 16];
    const closes = [9, 10, 11, 12, 13, 14, 15, 16, 17, 18];
    const { k, d, j } = kdj(highs, lows, closes);
    expect(k).toHaveLength(10);
    for (let i = 0; i < 10; i++) {
      if (k[i] != null && d[i] != null) {
        expect(j[i]).toBeCloseTo(3 * k[i] - 2 * d[i], 5);
      }
    }
  });
});

describe('volumeStreak', () => {
  it('连续放量天数：递增计连续，中断归零', () => {
    const out = volumeStreak([100, 120, 110, 130, 150, 160]);
    expect(out).toEqual([0, 1, 0, 1, 2, 3]);
  });
});

describe('high60dDistancePct', () => {
  it('空间百分比 = (60日最高-close)/close*100', () => {
    const highs = Array.from({ length: 60 }, () => 110);
    const closes = Array.from({ length: 60 }, () => 100);
    const out = high60dDistancePct(highs, closes, 60);
    expect(out[59]).toBeCloseTo(10, 5);
  });
});

describe('percentileScore', () => {
  it('值在池中的分位（0-100）', () => {
    const pool = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentileScore(1, pool)).toBe(0);
    expect(percentileScore(10, pool)).toBe(100);
    expect(percentileScore(5.5, pool)).toBeGreaterThan(40);
    expect(percentileScore(5.5, pool)).toBeLessThan(60);
    expect(percentileScore(null, pool)).toBeNull();
    expect(percentileScore(5, [])).toBeNull();
  });
});

describe('piecewise', () => {
  it('分段线性插值 + 边界钳制', () => {
    const bp = [[0, 0], [10, 100]];
    expect(piecewise(5, bp)).toBe(50);
    expect(piecewise(-5, bp)).toBe(0);
    expect(piecewise(20, bp)).toBe(100);
    expect(piecewise(null, bp)).toBeNull();
  });
});
