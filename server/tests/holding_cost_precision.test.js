// ============================================================
// 成本价精度校正单测（回归护栏）
//
// 守护的 Bug：券商截图导入丢失成本价精度，导致盈亏与同花顺对不上
//   同花顺「成本/现价」列只显示 3 位小数（5.966），但「盈亏 4.38」
//   是用未舍入的真实成本（5.9662）算出来的。若把展示值原样入库：
//     (6.01 − 5.966 ) × 100 = 4.40  ✗ 与券商差 0.02
//     (6.01 − 5.9662) × 100 = 4.38  ✓
//
// refineCostPrice 通过「现价 + 盈亏」反解真实成本价来修复该问题。
// 本文件是它唯一的自动化护栏 —— 改坏了必须在 CI 变红。
// ============================================================
import { describe, it, expect } from 'vitest';
import { __test__ } from '../src/services/holdingImageService.js';

const {
  refineCostPrice, decimalPlacesOf, normalizeCandidate, parseNumber, deriveFundCostPrice,
} = __test__;

describe('refineCostPrice —— 主场景（同花顺 000539 粤电力A）', () => {
  it('3 位展示成本 + 盈亏 → 反解出 4 位真实成本 5.9662', () => {
    expect(refineCostPrice(5.966, 6.01, 4.38, 100)).toBe(5.9662);
  });

  it('反解后重算盈亏应等于券商截图值 4.38（而不是 4.40）', () => {
    const cost = refineCostPrice(5.966, 6.01, 4.38, 100);
    const profit = Math.round((6.01 - cost) * 100 * 10000) / 10000;
    expect(profit).toBe(4.38);
    expect(profit).not.toBe(4.4);
  });

  it('反解后盈亏率与券商展示的 0.734% 对齐', () => {
    const cost = refineCostPrice(5.966, 6.01, 4.38, 100);
    const rate = ((6.01 - cost) / cost) * 100;
    expect(Number(rate.toFixed(4))).toBe(0.7341);
    expect(Number(rate.toFixed(3))).toBe(0.734);
  });
});

describe('refineCostPrice —— 亏损方向（负盈亏不能被反解到反方向）', () => {
  it('负盈亏保持负向：展示成本 95，盈亏 −1908 / 300 股', () => {
    // 88.64 − (−1908/300) = 95.00 → 与展示值一致，原样返回
    expect(refineCostPrice(95, 88.64, -1908, 300)).toBe(95);
  });

  it('亏损股的精度反解：真实成本高于展示值', () => {
    // 现价 10.00，亏损 −123.4 / 100 股 → 真实成本 11.234
    expect(refineCostPrice(11.23, 10.0, -123.4, 100)).toBe(11.234);
  });

  it('★ 若负号被误剥离，成本会被反解到相反方向（该用例锁死符号语义）', () => {
    const correct = refineCostPrice(11.23, 10.0, -123.4, 100); // 亏损 → 成本 > 现价
    const flipped = refineCostPrice(11.23, 10.0, 123.4, 100); // 误当盈利 → 应触发安全阀
    expect(correct).toBe(11.234);
    expect(correct).toBeGreaterThan(10.0);
    expect(flipped).toBe(11.23); // 超出容差，安全阀保留原值
  });
});

describe('refineCostPrice —— 安全阀（OCR 读错列时不得采信）', () => {
  it('把「盈亏率 0.734%」误读成盈亏金额 → 超出容差，保留 OCR 原值', () => {
    expect(refineCostPrice(5.966, 6.01, 0.734, 100)).toBe(5.966);
  });

  it('盈亏量级离谱（多读一位）→ 保留 OCR 原值', () => {
    expect(refineCostPrice(5.966, 6.01, 43.8, 100)).toBe(5.966);
  });

  it('容差随展示位数收紧：3 位小数容差 0.0005', () => {
    // 偏差 0.0004（容差内）→ 采信
    expect(refineCostPrice(5.966, 6.01, 4.4 - 0.04 + 0.0, 100)).toBeCloseTo(5.9664, 6);
    // 偏差 0.0006（容差外）→ 拒绝
    expect(refineCostPrice(5.966, 6.01, 4.34, 100)).toBe(5.966);
  });

  it('2 位展示成本容差放宽到 0.005', () => {
    expect(refineCostPrice(12.34, 13.0, 66.2, 100)).toBe(12.338);
  });

  it('整数展示成本（0 位小数）容差 0.5', () => {
    expect(refineCostPrice(70, 75.11, 2555, 500)).toBe(70);
  });
});

describe('refineCostPrice —— 缺字段 / 非法输入保护', () => {
  it('缺 current_price 与 profit → 原样返回 OCR 成本', () => {
    expect(refineCostPrice(5.966, NaN, NaN, 100)).toBe(5.966);
  });

  it('只有 current_price 没有 profit → 原样返回', () => {
    expect(refineCostPrice(5.966, 6.01, NaN, 100)).toBe(5.966);
  });

  it('只有 profit 没有 current_price → 原样返回', () => {
    expect(refineCostPrice(5.966, NaN, 4.38, 100)).toBe(5.966);
  });

  it('数量为 0 → 不做除零，原样返回', () => {
    expect(refineCostPrice(5.966, 6.01, 4.38, 0)).toBe(5.966);
  });

  it('数量为负 → 原样返回', () => {
    expect(refineCostPrice(5.966, 6.01, 4.38, -100)).toBe(5.966);
  });

  it('OCR 成本为 0（未识别到）→ 原样返回，不产生假成本', () => {
    expect(refineCostPrice(0, 6.01, 4.38, 100)).toBe(0);
  });

  it('反解结果为负或 0（脏数据）→ 原样返回', () => {
    expect(refineCostPrice(5.966, 6.01, 700, 100)).toBe(5.966);
  });
});

describe('refineCostPrice —— 幂等性', () => {
  it('对已经是真值的成本price 再校正一次，结果不变', () => {
    const once = refineCostPrice(5.966, 6.01, 4.38, 100);
    const twice = refineCostPrice(once, 6.01, 4.38, 100);
    expect(twice).toBe(once);
    expect(twice).toBe(5.9662);
  });

  it('连续三次校正保持稳定（不漂移）', () => {
    let cost = 5.966;
    for (let i = 0; i < 3; i += 1) cost = refineCostPrice(cost, 6.01, 4.38, 100);
    expect(cost).toBe(5.9662);
  });
});

describe('deriveFundCostPrice —— 基金成本价反推', () => {
  it('用持有收益金额反推：亏损基金成本价 > 1', () => {
    expect(deriveFundCostPrice(4028, -163.92, -0.0391)).toBeCloseTo((4028 + 163.92) / 4028, 10);
  });

  it('用持有收益金额反推：盈利基金成本价 < 1', () => {
    expect(deriveFundCostPrice(5000, 250, 0.05)).toBeCloseTo(0.95, 10);
  });

  it('缺 profit 时用 profit_rate 兜底', () => {
    expect(deriveFundCostPrice(4028, NaN, -0.0391)).toBeCloseTo(1.0391, 10);
  });

  it('profit 与 profit_rate 都缺 → null（调用方回退到 1）', () => {
    expect(deriveFundCostPrice(4028, NaN, NaN)).toBeNull();
  });

  it('金额为 0 或负 → null，不做除零', () => {
    expect(deriveFundCostPrice(0, 100, 0.05)).toBeNull();
    expect(deriveFundCostPrice(-100, 10, 0.05)).toBeNull();
  });

  it('收益大于本金（脏数据）导致成本价 ≤ 0 → 走 profit_rate 兜底', () => {
    // (1000 − 2000)/1000 = −1 ≤ 0，被拒绝后用 rate 兜底
    expect(deriveFundCostPrice(1000, 2000, 0.1)).toBeCloseTo(0.9, 10);
  });
});

describe('decimalPlacesOf', () => {
  it('正确识别小数位数', () => {
    expect(decimalPlacesOf(5.9662)).toBe(4);
    expect(decimalPlacesOf(5.966)).toBe(3);
    expect(decimalPlacesOf(12.34)).toBe(2);
    expect(decimalPlacesOf(70)).toBe(0);
  });
});

describe('parseNumber —— 负号必须保留', () => {
  it('剥离千分位、正号、百分号', () => {
    expect(parseNumber('1,234.5')).toBe(1234.5);
    expect(parseNumber('+4.38')).toBe(4.38);
    expect(parseNumber('0.734%')).toBe(0.734);
  });

  it('★ 负号不得被剥离（亏损持仓依赖它）', () => {
    expect(parseNumber('-0.62')).toBe(-0.62);
    expect(parseNumber('-1,908')).toBe(-1908);
    expect(parseNumber('-6.69%')).toBe(-6.69);
  });

  it('空值 / 非数字 → NaN', () => {
    expect(parseNumber('')).toBeNaN();
    expect(parseNumber(null)).toBeNaN();
    expect(parseNumber(undefined)).toBeNaN();
    expect(parseNumber('abc')).toBeNaN();
  });
});

describe('normalizeCandidate —— 端到端（OCR 行 → 入库候选）', () => {
  it('股票行带 current_price/profit 时自动校正成本精度', () => {
    const c = normalizeCandidate({
      type: 'stock',
      name: '粤电力A',
      code: '000539',
      quantity: 100,
      cost_price: 5.966,
      current_price: 6.01,
      profit: 4.38,
    });
    expect(c.code).toBe('000539');
    expect(c.asset_class).toBe('stock');
    expect(c.quantity).toBe(100);
    expect(c.cost_price).toBe(5.9662);
  });

  it('缺少 current_price/profit 时退回 OCR 成本价（不报错）', () => {
    const c = normalizeCandidate({
      type: 'stock', name: '粤电力A', code: '000539', quantity: 100, cost_price: 5.966,
    });
    expect(c.cost_price).toBe(5.966);
  });

  it('基金行走 deriveFundCostPrice 反推，不走股票的 refineCostPrice', () => {
    // 基金 quantity 记的是「持有金额」，成本价 = (金额 − 持有收益) / 金额
    const c = normalizeCandidate({
      type: 'fund',
      name: '华宝中证有色金属ETF联接C',
      quantity: 4028,
      cost_price: 1,
      profit: -163.92,
      profit_rate: -0.0391,
    });
    expect(c.asset_class).toBe('fund');
    expect(c.cost_price).toBeCloseTo((4028 + 163.92) / 4028, 10);
    expect(c.cost_price).toBeGreaterThan(1); // 亏损基金成本价 > 1
  });

  it('基金行无 profit/profit_rate 时退回 cost_price = 1', () => {
    const c = normalizeCandidate({
      type: 'fund', name: '华宝中证有色金属ETF联接C', quantity: 4028, cost_price: 1,
    });
    expect(c.cost_price).toBe(1);
  });

  it('名称含全角 Ａ 的 OCR 结果仍能提取代码', () => {
    const c = normalizeCandidate({
      type: 'stock', name: '000539 粤电力Ａ', quantity: 100, cost_price: 5.966,
      current_price: 6.01, profit: 4.38,
    });
    expect(c.code).toBe('000539');
    expect(c.cost_price).toBe(5.9662);
  });

  it('无名称行返回 null', () => {
    expect(normalizeCandidate({ type: 'stock', quantity: 100 })).toBeNull();
    expect(normalizeCandidate(null)).toBeNull();
  });
});

describe('inferAssetClass —— 场内 ETF vs 场外基金（防 ¥0.0000 回归）', () => {
  it('场内 ETF（黄金ETF华安）按股票口径 → stock，避免金额÷净值把份额算错', () => {
    const c = normalizeCandidate({ name: '黄金ETF华安', quantity: 600, cost_price: 9.173, current_price: 9.005 });
    expect(c.asset_class).toBe('stock');
    // 不被当作场外基金走 convertFundAmountToShares，份额保持截图原值
    expect(c.quantity).toBe(600);
  });

  it('场内 ETF（沪深300ETF）同样按股票口径 → stock', () => {
    const c = normalizeCandidate({ name: '沪深300ETF', quantity: 100, cost_price: 3.8, current_price: 3.9 });
    expect(c.asset_class).toBe('stock');
  });

  it('场外 ETF 联接（华宝…ETF联接C）仍是 fund，走金额÷净值换算', () => {
    const c = normalizeCandidate({ name: '华宝中证有色金属ETF联接C', quantity: 4028, cost_price: 1, profit: -163.92 });
    expect(c.asset_class).toBe('fund');
  });

  it('场外 QDII/LOF/FOF 仍是 fund', () => {
    expect(normalizeCandidate({ name: '某纳斯达克LOF', quantity: 100, cost_price: 1 }).asset_class).toBe('fund');
    expect(normalizeCandidate({ name: '某全球QDII', quantity: 100, cost_price: 1 }).asset_class).toBe('fund');
  });
});
