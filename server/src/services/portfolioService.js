// ============================================================
// 组合服务：持仓 CRUD、估值、汇总卡片、资产配置偏离
// ============================================================
import { createPortfolioModel } from '../models/portfolioModel.js';
import { createSecurityModel } from '../models/securityModel.js';
import { ApiError } from '../util/errors.js';
import { round2, round4 } from '../util/money.js';
import { ASSET_CLASS } from '../../../shared/constants.js';

/**
 * 组合服务工厂
 * @param {import('../db/driver.js').Database} db
 */
export function createPortfolioService(db) {
  const portfolio = createPortfolioModel(db);
  const model = createSecurityModel(db);

  /** 估值：给持仓列表附加现价/市值/盈亏/占比 */
  function valuate(userId, holdings) {
    if (!holdings.length) {
      return {
        holdings: [],
        totalAsset: 0, totalCost: 0, totalProfit: 0, dayProfit: 0,
        asOf: model.latestTradeDate(),
      };
    }
    const codes = holdings.filter((h) => h.code).map((h) => h.code);
    const quoteMap = new Map(model.getQuotes(codes).map((q) => [q.code, q]));
    const secMap = new Map(model.list().map((s) => [s.code, s]));

    // 场外基金净值（按代码取各自最新披露日）+ 场内 ETF 最新市价（避免全局最大交易日漏匹配）
    const fundCodes = holdings
      .filter((h) => h.asset_class === ASSET_CLASS.FUND && h.code)
      .map((h) => h.code);
    const fundNavMap = new Map(model.getFundNav(fundCodes).map((f) => [f.code, f]));
    const fundQuoteMap = new Map(
      fundCodes
        .map((c) => [c, model.getLatestQuote(c)])
        .filter(([, v]) => v && Number.isFinite(v.close) && v.close > 0),
    );

    let totalAsset = 0;
    let totalCost = 0;
    let dayProfit = 0;

    const enriched = holdings.map((h) =>
      applyOcrProfitOverrides(
        h,
        (() => {
      // D5 防御：历史脏数据/极端数值（quantity 或 cost_price 非有限）不参与汇总，
      // 否则 totalAsset 溢出成 null，导致汇总与再平衡整体瘫痪。该行按 0 值处理并标记。
      if (!Number.isFinite(Number(h.quantity)) || !Number.isFinite(Number(h.cost_price))) {
        return {
          ...h,
          current_price: null,
          market_value: 0,
          cost_amount: 0,
          profit: 0,
          profit_rate: null,
          day_profit: 0,
          day_profit_rate: null,
          current_pct: 0,
          target_pct: null,
          deviation_pct: null,
          deviation_ratio: null,
          quote_date: null,
          data_origin: 'invalid',
        };
      }

      if (h.asset_class === ASSET_CLASS.CASH) {
        // 现金行：quantity 即金额，cost_price=1
        const marketValue = h.quantity;
        const costAmount = h.quantity * (h.cost_price || 1);
        totalAsset += marketValue;
        totalCost += costAmount;
        return {
          ...h,
          current_price: 1,
          market_value: marketValue,
          cost_amount: costAmount,
          profit: marketValue - costAmount,
          profit_rate: costAmount ? ((marketValue - costAmount) / costAmount) * 100 : 0,
          day_profit: 0,
          day_profit_rate: 0, // 现金无涨跌
          current_pct: 0, // 占比在汇总后统一回填
          target_pct: null,
          deviation_pct: null,
          deviation_ratio: null,
          quote_date: null,
          data_origin: 'real',
        };
      }

      // ★ 基金估值（三级口径）：
      //   1) 场外基金（联接/LOF/QDII）：用 fund_nav 净值作为现价，当日盈亏按净值日涨跌幅计
      //   2) 场内 ETF（已有 daily_quotes 市价）：沿用股票口径（现价=市价，昨收=pre_close）
      //   3) 兜底（图片导入金额模型 / 暂未同步净值）：current_price=1，当日盈亏置 0
      if (h.asset_class === ASSET_CLASS.FUND) {
        const fn = fundNavMap.get(h.code);
        if (fn && Number.isFinite(fn.nav) && fn.nav > 0) {
          const currentPrice = fn.nav;
          const marketValue = h.quantity * currentPrice;
          const costAmount = h.quantity * h.cost_price;
          const profit = marketValue - costAmount;
          const profitRate = costAmount ? (profit / costAmount) * 100 : 0;
          const prev = fn.pre_nav;
          const hasDay = Number.isFinite(prev) && prev > 0;
          const hDayProfit = hasDay ? h.quantity * (fn.nav - prev) : 0;
          const hDayProfitRate = hasDay
            ? (fn.nav - prev) / prev * 100
            : Number.isFinite(fn.nav_chg_pct) ? fn.nav_chg_pct : null;
          totalAsset += marketValue;
          totalCost += costAmount;
          dayProfit += hDayProfit;
          return {
            ...h,
            current_price: round4(currentPrice),
            market_value: round4(marketValue),
            cost_amount: round4(costAmount),
            profit: round4(profit),
            profit_rate: round4(profitRate),
            day_profit: round4(hDayProfit),
            day_profit_rate: round4(hDayProfitRate),
            current_pct: 0,
            target_pct: null,
            deviation_pct: null,
            deviation_ratio: null,
            industry: null,
            sector: null,
            quote_date: fn.nav_date,
            data_origin: fn.is_estimate ? 'mixed' : 'real',
          };
        }

        // 场内 ETF / 上市基金：以行情市价为现价（与股票同口径）
        const eq = fundQuoteMap.get(h.code) || quoteMap.get(h.code);
        if (eq && Number.isFinite(eq.close) && eq.close > 0) {
          const currentPrice = eq.close;
          const marketValue = h.quantity * currentPrice;
          const costAmount = h.quantity * h.cost_price;
          const profit = marketValue - costAmount;
          const profitRate = costAmount ? (profit / costAmount) * 100 : 0;
          const hasDay = eq.pre_close != null;
          const hDayProfit = hasDay ? h.quantity * (eq.close - eq.pre_close) : 0;
          const hDayProfitRate = hasDay && eq.pre_close
            ? (eq.close - eq.pre_close) / eq.pre_close * 100
            : null;
          totalAsset += marketValue;
          totalCost += costAmount;
          dayProfit += hDayProfit;
          return {
            ...h,
            current_price: round4(currentPrice),
            market_value: round4(marketValue),
            cost_amount: round4(costAmount),
            profit: round4(profit),
            profit_rate: round4(profitRate),
            day_profit: round4(hDayProfit),
            day_profit_rate: round4(hDayProfitRate),
            current_pct: 0,
            target_pct: null,
            deviation_pct: null,
            deviation_ratio: null,
            industry: eq.sector ?? null,
            sector: eq.sector ?? null,
            quote_date: eq.trade_date ?? null,
            data_origin: eq.data_origin ?? 'real',
          };
        }

        // 兜底：图片导入金额模型 / 暂未同步净值
        // 优先用导入回填的截现价（如场内 ETF 被当基金处理时），否则按 1（金额模型）
        const fundCurrent = h.current_price != null && Number.isFinite(Number(h.current_price)) && Number(h.current_price) > 0
          ? Number(h.current_price)
          : 1;
        const marketValue = h.quantity * fundCurrent;
        const costAmount = h.quantity * h.cost_price;
        const profit = marketValue - costAmount;
        const profitRate = costAmount ? (profit / costAmount) * 100 : 0;
        totalAsset += marketValue;
        totalCost += costAmount;
        return {
          ...h,
          current_price: round4(fundCurrent),
          market_value: round4(marketValue),
          cost_amount: round4(costAmount),
          profit: round4(profit),
          profit_rate: round4(profitRate),
          day_profit: 0,
          day_profit_rate: null,
          current_pct: 0,
          target_pct: null,
          deviation_pct: null,
          deviation_ratio: null,
          industry: null,
          sector: null,
          quote_date: null,
          data_origin: 'manual',
        };
      }

      const quote = quoteMap.get(h.code);
      const sec = secMap.get(h.code);
      // ★ 估值优先级：导入回填的截现价 > 行情市价 > 成本价
      // 对本地行情库未覆盖的标的（如券商 App 截图里的黄金ETF/小票），
      // 用截现价才能与用户导入的数据一致；否则会回退成本价，市值/盈亏失真。
      const importedPrice = h.current_price != null && Number.isFinite(Number(h.current_price)) && Number(h.current_price) > 0
        ? Number(h.current_price)
        : null;
      const currentPrice = importedPrice != null ? importedPrice : (quote?.close ?? h.cost_price);
      const marketValue = h.quantity * currentPrice;
      const costAmount = h.quantity * h.cost_price;
      const profit = marketValue - costAmount;
      const profitRate = costAmount ? (profit / costAmount) * 100 : 0;
      // 当日盈亏 = 数量 ×（今收 − 昨收）；当日盈亏率 =（今收 − 昨收）/ 昨收，与持仓数量无关
      const hasDayQuote = quote?.close != null && quote?.pre_close != null;
      const hDayProfit = hasDayQuote ? h.quantity * (quote.close - quote.pre_close) : 0;
      const hDayProfitRate = hasDayQuote && quote.pre_close ? ((quote.close - quote.pre_close) / quote.pre_close) * 100 : null;
      totalAsset += marketValue;
      totalCost += costAmount;
      dayProfit += hDayProfit;
      return {
        ...h,
        current_price: round4(currentPrice),
        market_value: round4(marketValue),
        cost_amount: round4(costAmount),
        profit: round4(profit),
        // 盈亏率/当日盈亏统一保留 4 位：round2 会把 0.7341% 抹成 0.73%，与券商对不上
        profit_rate: round4(profitRate),
        day_profit: round4(hDayProfit),
        day_profit_rate: round4(hDayProfitRate),
        current_pct: 0,
        target_pct: null,
        deviation_pct: null,
        deviation_ratio: null,
        industry: sec?.industry ?? null,
        sector: sec?.sector ?? null,
        quote_date: quote?.trade_date ?? null,
        data_origin: quote?.data_origin ?? sec?.data_origin ?? 'real',
      };
    })(),
      ),
    );

    /**
     * 截图 OCR 回填的盈亏字段优先于重新计算，保证「图片导入的持仓」与券商 App 截图完全一致。
     * 仅当该字段在 holdings 表确有有限值时才覆盖；否则保留计算值（行情 / 净值口径）。
     */
    function applyOcrProfitOverrides(h, v) {
      const ocrProfit = h.profit != null && Number.isFinite(Number(h.profit)) ? Number(h.profit) : null;
      const ocrProfitRate = h.profit_rate != null && Number.isFinite(Number(h.profit_rate)) ? Number(h.profit_rate) : null;
      const ocrDayProfit = h.day_profit != null && Number.isFinite(Number(h.day_profit)) ? Number(h.day_profit) : null;
      const ocrDayProfitRate = h.day_profit_rate != null && Number.isFinite(Number(h.day_profit_rate)) ? Number(h.day_profit_rate) : null;
      return {
        ...v,
        profit: ocrProfit != null ? round4(ocrProfit) : v.profit,
        profit_rate: ocrProfitRate != null ? round4(ocrProfitRate) : v.profit_rate,
        day_profit: ocrDayProfit != null ? round4(ocrDayProfit) : v.day_profit,
        day_profit_rate: ocrDayProfitRate != null ? round4(ocrDayProfitRate) : v.day_profit_rate,
      };
    }

    // 回填当前占比（先求和后舍入）
    for (const h of enriched) {
      h.current_pct = totalAsset ? round2((h.market_value / totalAsset) * 100) : 0;
    }

    return {
      holdings: enriched,
      totalAsset: round4(totalAsset),
      totalCost: round4(totalCost),
      totalProfit: round4(totalAsset - totalCost),
      dayProfit: round4(dayProfit),
      asOf: model.latestTradeDate(),
    };
  }

  return {
  /** 组合汇总（含配置偏离与集中度） */
  buildSummary(userId, dimension) {
    const holdings = portfolio.listHoldings(userId);
    const valued = valuate(userId, holdings);
    // ★ 顺序不可颠倒（R3-#2）：必须先解析出 activeDimension，再按该维度取目标。
    // 旧写法 listTargets(userId, dimension) 在 dimension 为 undefined 时，
    // model 会返回「所有维度」的目标行；叠加下方「零持仓目标 key 也建空分组」，
    // 其它维度的 target_key（如 code 维度的 601398）会被物化成幻影 allocation 条目，
    // 并被错误地标上 dimension='asset_class'。
    const activeDimension = dimension || portfolio.getSettings(userId)?.active_dimension || 'asset_class';
    const targets = portfolio.listTargets(userId, activeDimension);
    const targetMap = new Map(targets.map((t) => [t.target_key, t.target_pct]));

    // ------------------------------------------------------------
    // 目标占比 + 偏离（★ 分组口径）
    // 关键约定：target_pct 是「整个 target_key 分组」的目标百分比，
    // 因此偏离必须用「分组当前占比」去比，绝不能拿单行 current_pct 直接减。
    // 当 dimension='asset_class'/'industry' 时一个 key 下常有多行持仓，
    // 用行级口径会让每一行都各自套用完整的类别目标（历史 P1 缺陷）。
    // dimension='code' 时一 key 一行，分组自然退化为单行，行为与旧版一致。
    // ------------------------------------------------------------
    const groups = groupByTargetKey(valued.holdings, activeDimension, targetMap, valued.totalAsset);

    const withTarget = valued.holdings.map((h) => {
      const key = targetKeyOf(h, activeDimension);
      const g = key != null ? groups.get(key) : null;
      const targetPct = g ? g.target_pct : null;
      return {
        ...h,
        target_key: key,
        // 分组目标百分比（语义：整个 target_key 的目标）
        target_pct: targetPct,
        // 分组聚合值：该 key 下所有持仓的市值与占比之和
        group_current_pct: g ? g.current_pct : null,
        group_market_value: g ? g.market_value : null,
        // 分组偏离 = 分组当前占比 − 分组目标占比（再平衡与 UI 的唯一判定口径）
        group_deviation_pct: g ? g.deviation_pct : null,
        // deviation_pct 统一为分组口径，与 allocation / rebalance 同源，避免三处口径打架
        deviation_pct: g ? g.deviation_pct : null,
        deviation_ratio: g ? g.deviation_ratio : null,
        // 行级偏离（单行占比 − 分组目标）：仅供明细表参考展示，不参与任何再平衡判定
        row_deviation_pct: targetPct != null ? round2(h.current_pct - targetPct) : null,
      };
    });

    // 配置分布（维度切换）—— 与 withTarget 复用同一份分组结果，保证口径一致
    const allocation = buildAllocation(groups, activeDimension);

    // 集中度
    const byValue = [...withTarget].filter((h) => h.asset_class !== ASSET_CLASS.CASH).sort((a, b) => b.market_value - a.market_value);
    const cr3 = valued.totalAsset ? round2(((byValue[0]?.market_value || 0) + (byValue[1]?.market_value || 0) + (byValue[2]?.market_value || 0)) / valued.totalAsset * 100) : 0;
    const hhi = round2(withTarget.reduce((s, h) => s + h.current_pct * h.current_pct, 0));
    const industryMap = {};
    for (const h of withTarget) {
      const ind = h.industry || (h.asset_class === ASSET_CLASS.CASH ? '现金' : h.asset_class === ASSET_CLASS.FUND ? '基金' : '其他');
      industryMap[ind] = round2((industryMap[ind] || 0) + h.current_pct);
    }

    return {
      total_asset: valued.totalAsset,
      total_cost: valued.totalCost,
      total_profit: valued.totalProfit,
      total_profit_rate: valued.totalCost ? round4((valued.totalProfit / valued.totalCost) * 100) : 0,
      day_profit: valued.dayProfit,
      holding_count: valued.holdings.filter((h) => h.asset_class !== ASSET_CLASS.CASH).length,
      holdings: withTarget,
      allocation,
      as_of: valued.asOf,
      concentration: { cr3, hhi, industry_map: industryMap },
      active_dimension: activeDimension,
    };
  },

  // ---------- CRUD ----------
  listHoldings(userId) {
    const valued = valuate(userId, portfolio.listHoldings(userId));
    return { holdings: valued.holdings, as_of: valued.asOf };
  },

  addHolding(userId, payload) {
    const h = portfolio.createHolding(userId, payload);
    return h;
  },

  /**
   * 按 code 合并 upsert：同用户同 code 已存在时合并数量并重新计算加权成本价，否则新增。
   * 用于 CSV/图片导入等批量场景，避免同一证券出现多条持仓。
   * @returns {{ holding: object, created: boolean }}
   */
  upsertHolding(userId, payload) {
    const code = payload.code ?? null;
    const incomingQty = Number(payload.quantity) || 0;
    const incomingCost = Number(payload.cost_price) || 0;
    // 导入时可能携带截图现价/盈亏（图片导入），合并/新增都尽量保留
    const incomingCurrent = payload.current_price != null && Number.isFinite(Number(payload.current_price))
      ? Number(payload.current_price)
      : null;
    const incomingProfit = payload.profit != null && Number.isFinite(Number(payload.profit)) ? Number(payload.profit) : null;
    const incomingProfitRate = payload.profit_rate != null && Number.isFinite(Number(payload.profit_rate)) ? Number(payload.profit_rate) : null;
    const incomingDayProfit = payload.day_profit != null && Number.isFinite(Number(payload.day_profit)) ? Number(payload.day_profit) : null;
    const incomingDayProfitRate = payload.day_profit_rate != null && Number.isFinite(Number(payload.day_profit_rate)) ? Number(payload.day_profit_rate) : null;

    if (code) {
      const existing = portfolio.findHoldingByCode(userId, code);
      if (existing) {
        const existingQty = Number(existing.quantity) || 0;
        const existingCost = Number(existing.cost_price) || 0;
        const totalQty = existingQty + incomingQty;
        const blendedCost = totalQty > 0
          ? (existingQty * existingCost + incomingQty * incomingCost) / totalQty
          : incomingCost;
        // 现价/盈亏：以新导入的截图表为准（若有），否则保留原值
        const mergedCurrent = incomingCurrent != null ? incomingCurrent
          : (existing.current_price != null ? Number(existing.current_price) : null);
        const mergedProfit = incomingProfit != null ? incomingProfit
          : (existing.profit != null ? Number(existing.profit) : null);
        const mergedProfitRate = incomingProfitRate != null ? incomingProfitRate
          : (existing.profit_rate != null ? Number(existing.profit_rate) : null);
        const mergedDayProfit = incomingDayProfit != null ? incomingDayProfit
          : (existing.day_profit != null ? Number(existing.day_profit) : null);
        const mergedDayProfitRate = incomingDayProfitRate != null ? incomingDayProfitRate
          : (existing.day_profit_rate != null ? Number(existing.day_profit_rate) : null);
        const holding = portfolio.updateHolding(userId, existing.id, {
          code,
          name: payload.name || existing.name,
          asset_class: payload.asset_class || existing.asset_class,
          quantity: round4(totalQty),
          cost_price: round4(blendedCost),
          current_price: mergedCurrent,
          profit: mergedProfit,
          profit_rate: mergedProfitRate,
          day_profit: mergedDayProfit,
          day_profit_rate: mergedDayProfitRate,
        });
        return { holding, created: false };
      }
    }
    const holding = portfolio.createHolding(userId, {
      ...payload,
      current_price: incomingCurrent,
      profit: incomingProfit,
      profit_rate: incomingProfitRate,
      day_profit: incomingDayProfit,
      day_profit_rate: incomingDayProfitRate,
    });
    return { holding, created: true };
  },

  updateHolding(userId, id, payload) {
    const existing = portfolio.getHolding(userId, id);
    if (!existing) throw ApiError.notFound('持仓不存在');
    return portfolio.updateHolding(userId, id, payload);
  },

  removeHolding(userId, id) {
    const existing = portfolio.getHolding(userId, id);
    if (!existing) throw ApiError.notFound('持仓不存在');
    portfolio.deleteHolding(userId, id);
  },

  // ---------- 目标配置 ----------
  getTargets(userId, dimension) {
    const rows = portfolio.listTargets(userId, dimension);
    return { dimension: dimension || 'asset_class', items: rows.map((r) => ({ target_key: r.target_key, target_pct: r.target_pct })) };
  },

  saveTargets(userId, dimension, items) {
    const total = items.reduce((s, it) => s + Number(it.target_pct || 0), 0);
    if (Math.abs(total - 100) > 0.01) {
      throw ApiError.badRequest(`目标配置 Σ 必须 = 100（当前 ${round2(total)}）`);
    }
    portfolio.replaceTargets(userId, dimension, items);
    return null;
  },

  // ---------- 设置 ----------
  getSettings(userId) {
    const s = userId != null ? portfolio.getSettings(userId) : portfolio.demoSettings();
    return {
      rebalance_threshold: s.rebalance_threshold,
      active_dimension: s.active_dimension,
      morning_loose_mode: s.morning_loose_mode,
    };
  },

  saveSettings(userId, payload) {
    portfolio.upsertSettings(userId, {
      rebalance_threshold: payload.rebalance_threshold ?? undefined,
      active_dimension: payload.active_dimension ?? undefined,
      // SQLite 无布尔：布尔字段统一归一化为 0/1，
      // 避免直传 JS boolean 给 node:sqlite 绑定报错（HTTP 路由层也会预转，双保险）
      morning_loose_mode: payload.morning_loose_mode === undefined ? undefined : (payload.morning_loose_mode ? 1 : 0),
    });
    return this.getSettings(userId);
  },

  // ---------- 内部工具 ----------
  getRawHoldings(userId) {
    return portfolio.listHoldings(userId);
  }
  };
}

/**
 * 兜底分组名：既没有维度键、又不是现金的脏数据行归到这里。
 * 存在的唯一理由是守恒律 —— 每一行持仓都必须落进某个分组，
 * 否则 allocation 市值合计会小于总资产（钱凭空消失）。
 */
export const UNCLASSIFIED_KEY = '未分类';

/**
 * 目标 key：按维度取持仓对应键
 *
 * ★ 守恒律（R3-#1）：本函数对任何一行持仓都必须返回非空键。
 *   现金行在 DB 里 code 为 NULL，若 code 分支直接 `return h.code`，
 *   现金会被 groupByTargetKey 的 `key == null → continue` 踢出所有分组，
 *   形成「分组黑洞」：allocation 市值合计 < 总资产。
 *   再叠加「零持仓目标 key 也建空分组」，用户配的 cash 目标会被物化成
 *   市值 0 的幻影分组，缺口按整个目标值输出 → 凭空造钱 + 谎报现金缺口。
 *   因此 code 分支与 industry 分支保持一致，统一给现金兜底。
 *
 * @param {object} h 持仓行
 * @param {string} dimension 分组维度 asset_class|industry|code
 * @returns {string} 非空的分组键
 */
export function targetKeyOf(h, dimension) {
  const isCash = h.asset_class === ASSET_CLASS.CASH;
  if (dimension === 'industry') return h.industry || (isCash ? '现金' : '其他');
  if (dimension === 'code') {
    // 现金没有证券代码 → 与 industry 分支同构，兜底成 'cash' 键
    if (isCash) return ASSET_CLASS.CASH;
    // 非现金却无 code 的脏数据：既不能进黑洞，也不能挂到真实代码上污染分组
    return h.code || UNCLASSIFIED_KEY;
  }
  // asset_class（默认维度）
  return h.asset_class || UNCLASSIFIED_KEY;
}

/**
 * ★ 按 target_key 聚合持仓 —— 配置偏离与再平衡的唯一分组口径
 *
 * 设计要点：
 * 1. 分组当前占比由「分组市值 ÷ 总资产」直接算出，而不是把各行已 round2 的
 *    current_pct 相加，遵循 money.js「先求和后舍入，禁止逐项舍入再求和」的约定。
 * 2. 目标里存在但当前无持仓的 key（例如配了 bond 但一股没买）也会建组，
 *    market_value=0，这样再平衡才能给出「该类别整体需买入」的建议。
 * 3. ★ 守恒律：Σ(分组 market_value) === totalAsset。
 *    targetKeyOf 已保证每行都有非空键（现金在 code 维度兜底成 'cash'，
 *    其余脏数据兜底成 '未分类'），因此不会再有持仓被排除在分组之外。
 *    下面的 `key == null` 仅作防御性兜底，正常路径不会命中。
 *
 *
 * @param {Array<object>} holdings 已估值的持仓（含 market_value / current_pct）
 * @param {string} dimension 分组维度 asset_class|industry|code
 * @param {Map<string, number>} targetMap target_key → target_pct
 * @param {number} totalAsset 组合总资产
 * @returns {Map<string, {key:string, target_pct:number|null, market_value:number,
 *                        current_pct:number, deviation_pct:number|null,
 *                        deviation_ratio:number|null, rows:Array<object>}>}
 */
export function groupByTargetKey(holdings, dimension, targetMap, totalAsset) {
  const groups = new Map();

  for (const h of holdings) {
    const key = targetKeyOf(h, dimension);
    if (key == null) continue; // 无分组键的行不参与配置偏离
    let g = groups.get(key);
    if (!g) {
      g = { key, target_pct: targetMap.get(key) ?? null, market_value: 0, rows: [] };
      groups.set(key, g);
    }
    g.market_value += Number(h.market_value) || 0;
    g.rows.push(h);
  }

  // 目标中已配置但当前完全没有持仓的 key，也要建出空分组
  for (const [key, targetPct] of targetMap.entries()) {
    if (key == null || groups.has(key)) continue;
    groups.set(key, { key, target_pct: targetPct, market_value: 0, rows: [] });
  }

  for (const g of groups.values()) {
    g.market_value = round4(g.market_value);
    g.current_pct = totalAsset ? round2((g.market_value / totalAsset) * 100) : 0;
    g.deviation_pct = g.target_pct != null ? round2(g.current_pct - g.target_pct) : null;
    g.deviation_ratio = g.target_pct ? round2(((g.current_pct - g.target_pct) / g.target_pct) * 100) : null;
  }

  return groups;
}

/**
 * 构建配置分布（当前 vs 目标）
 * 直接消费 groupByTargetKey 的结果，确保与持仓行上的 group_* 字段完全同源。
 * @param {Map<string, object>} groups groupByTargetKey 的返回值
 * @param {string} dimension 分组维度
 */
function buildAllocation(groups, dimension) {
  const items = [];
  for (const g of groups.values()) {
    items.push({
      dimension,
      key: g.key,
      current_pct: g.current_pct,
      target_pct: g.target_pct,
      deviation_pct: g.deviation_pct,
      market_value: g.market_value,
    });
  }
  items.sort((a, b) => (b.current_pct || 0) - (a.current_pct || 0));
  return items;
}
