// ============================================================
// 再平衡建议：★ 先按 target_key 分组算缺口，再按市值等比分摊到行
//
// 历史 P1 缺陷（已修复）：
//   旧实现逐行遍历 holdings，每一行都拿「整个类别的 target_pct」算目标市值，
//   再减掉「单行的 market_value」。同一 asset_class 下有 N 行持仓时就会产生
//   N 条各自严重超额的重复建议（例：现金 50000 + 现金备用 30000，目标 cash 40%
//   → 输出 BUY 58000 + BUY 38000 = 96000，而真实类别缺口只有 8000）。
//
// 现实现口径：
//   分组 target_value  = totalAsset × target_pct / 100
//   分组 current_value = 该 key 下所有持仓 market_value 之和
//   分组 diff_value    = target_value − current_value
//   仅当 |group_deviation_pct| ≥ threshold 时才生成建议，
//   再把分组缺口按各行 market_value 等比分摊下去。
//
// 取整规则不变：A 股/场内基金 100 股向下取整，场外基金按份保留 2 位；
// 取整后 suggest_amount 用「取整后股数 × 现价」回算，残差在 summary 里对账。
// ============================================================
import { createPortfolioService } from './portfolioService.js';
import { createSecurityModel } from '../models/securityModel.js';
import { roundShares, round2, round4 } from '../util/money.js';
import { ASSET_CLASS } from '../../../shared/constants.js';

/** 金额小于该值视为噪声，不生成建议（元） */
const MIN_SUGGEST_AMOUNT = 1;

/**
 * 判断某个 target_key 代表的是不是「现金桶」。
 * 现金桶的买卖只是现金仓位本身的增减，不消耗/不需要外部资金：
 *   · BUY  现金桶 = 少持证券、多留现金 → 靠卖出证券兑现，不需要外部注资
 *   · SELL 现金桶 = 动用现金去买证券 → 现金流已由证券侧的 BUY 体现
 * @param {string} key target_key
 * @param {string} dimension 分组维度
 */
function isCashBucket(key, dimension) {
  if (dimension === 'industry') return key === '现金';
  return key === ASSET_CLASS.CASH; // asset_class / code 维度下现金键统一为 'cash'
}

/**
 * 再平衡服务工厂
 * @param {import('../db/driver.js').Database} db
 */
export function createRebalanceService(db) {
  const portfolio = createPortfolioService(db);
  const securities = createSecurityModel(db);

  /**
   * code 维度下解析「目标已配置但一股未持有」的标的：名称 + 现价 + 资产类别。
   * 取价口径与 portfolioService.valuate 完全一致（同一 MAX(trade_date) 快照），
   * 保证建仓建议的折股价与持仓估值价同源。
   * @param {string} code 证券代码
   * @returns {{name:string, price:number, assetClass:string, isEtf:boolean}|null}
   */
  function resolveNewPosition(code) {
    const sec = securities.findByCode(code);
    if (!sec) return null;
    const quote = securities.getQuotes([code])[0] || securities.getLatestQuote(code);
    const price = Number(quote?.close) || 0;
    if (price <= 0) return null;
    const assetClass = sec.type === ASSET_CLASS.FUND ? ASSET_CLASS.FUND : ASSET_CLASS.STOCK;
    // 与行级分摊保持同一口径：fund 一律按场内（100 份一手）处理
    return { name: sec.name || code, price, assetClass, isEtf: assetClass === ASSET_CLASS.FUND };
  }

  return {
  /**
   * 计算再平衡建议
   * @param {number|null} userId
   * @param {object} opts { threshold?, dimension? }
   */
  suggest(userId, opts = {}) {
    const settings = portfolio.getSettings(userId);
    const threshold = opts.threshold != null ? Number(opts.threshold) : settings.rebalance_threshold;
    const dimension = opts.dimension || settings.active_dimension;

    const summary = portfolio.buildSummary(userId, dimension);
    const totalAsset = summary.total_asset;
    const holdings = summary.holdings;
    if (!totalAsset || !holdings.length) {
      return {
        items: [],
        summary: {
          buy_total: 0, sell_total: 0, need_cash: 0, balance_ok: true,
          cash_available: 0, threshold, dimension,
          planned_buy_total: 0, planned_sell_total: 0,
          rounding_residual_buy: 0, rounding_residual_sell: 0,
        },
      };
    }

    // 现金可用额 = 全部 cash 行 quantity 之和（现金行 quantity 即金额），
    // 必须在循环外聚合，避免多行现金时只取最后一行
    const cashAvailable = holdings
      .filter((h) => h.asset_class === ASSET_CLASS.CASH)
      .reduce((s, h) => s + (Number(h.quantity) || 0), 0);

    // ---------- 第 1 步：按 target_key 分组 ----------
    const groups = buildRebalanceGroups(holdings, summary.allocation);

    const items = [];
    let buyTotal = 0;      // 取整分摊后实际买入合计
    let sellTotal = 0;     // 取整分摊后实际卖出合计
    let plannedBuy = 0;    // 分摊前的分组买入缺口合计（对账基准）
    let plannedSell = 0;   // 分摊前的分组卖出缺口合计（对账基准）
    // ★ 现金流口径（R3-#1 衍生）：只有「买入证券」才真正消耗现金、
    //   只有「卖出证券」才真正兑现现金。买入/卖出现金桶本身不产生外部资金需求，
    //   若把它们计入 need_cash，会出现「持有 2 万现金、目标 cash 50%」这种
    //   纯内部腾挪场景被谎报成「外部还缺 3 万」的误导性提示。
    let assetBuyTotal = 0;   // 真正消耗现金的证券买入合计
    let assetSellTotal = 0;  // 真正兑现现金的证券卖出合计

    // ---------- 第 2 步：逐分组判定 + 分摊 ----------
    for (const g of groups.values()) {
      if (g.target_pct == null) continue;                       // 无目标不参与
      const groupDeviation = g.group_deviation_pct ?? 0;
      if (Math.abs(groupDeviation) < threshold) continue;        // 分组偏离未超阈值

      const groupTargetValue = (totalAsset * g.target_pct) / 100;
      const groupDiffValue = groupTargetValue - g.current_value; // >0 需买入，<0 需卖出
      if (Math.abs(groupDiffValue) < MIN_SUGGEST_AMOUNT) continue;

      const action = groupDiffValue > 0 ? 'BUY' : 'SELL';
      const groupGap = Math.abs(groupDiffValue);
      if (action === 'BUY') plannedBuy += groupGap; else plannedSell += groupGap;

      // 分摊基数：该分组下各行的市值（谁大分摊谁多）
      const baseTotal = g.rows.reduce((s, r) => s + (Number(r.market_value) || 0), 0);

      const groupMeta = {
        target_key: g.key,
        group_target_value: round2(groupTargetValue),
        group_current_value: round2(g.current_value),
        group_diff_value: round2(groupDiffValue),
        group_current_pct: g.group_current_pct,
        group_deviation_pct: g.group_deviation_pct,
        target_pct: g.target_pct,
        // 向后兼容字段：target_value / deviation_pct 均为分组口径
        target_value: round2(groupTargetValue),
        deviation_pct: g.group_deviation_pct,
      };

      // 该 key 下无持仓行（或全部零市值）→ 输出一条分组整体建议
      if (!g.rows.length || (action === 'BUY' && baseTotal <= 0)) {
        // R3-#3：code 维度的 target_key 本身就是证券代码，不该退化成「类别整体」。
        // 回填 code + 按现价折算股数，前端才能跳转详情、用户才拿得到可执行股数。
        const isCodeSecurity = dimension === 'code' && !isCashBucket(g.key, dimension);
        const newPos = isCodeSecurity ? resolveNewPosition(g.key) : null;

        if (newPos && action === 'BUY') {
          const shares = roundShares(groupGap / newPos.price, newPos.assetClass, newPos.isEtf, false);
          if (shares > 0) {
            // 取整后回算金额，与行级口径一致；差额落在 rounding_residual_buy 里对账
            const amount = round2(shares * newPos.price);
            buyTotal += amount;
            assetBuyTotal += amount; // 建仓买证券 → 真实消耗现金
            items.push({
              ...groupMeta,
              action,
              code: g.key,
              name: `${newPos.name} 建仓`,
              diff_value: round2(groupDiffValue),
              suggest_shares: shares,
              suggest_amount: amount,
              current_price: newPos.price,
              current_pct: g.group_current_pct,
              unit: newPos.assetClass === ASSET_CLASS.FUND ? '份' : '股',
              is_group_level: true,
              is_new_position: true,
            });
            continue;
          }
          // 缺口不足 1 手 → 落到下方金额口径，但仍回填 code，保留可跳转与可见性
        }

        // 金额口径兜底：asset_class/industry 维度的类别整体，或 code 维度取不到价/不足一手
        if (action === 'BUY') {
          buyTotal += groupGap;
          if (!isCashBucket(g.key, dimension)) assetBuyTotal += groupGap;
        } else {
          sellTotal += groupGap;
          if (!isCashBucket(g.key, dimension)) assetSellTotal += groupGap;
        }
        items.push({
          ...groupMeta,
          action,
          code: isCodeSecurity ? g.key : null,
          name: isCodeSecurity ? `${newPos?.name ?? g.key} 建仓` : `${g.key} 类别整体`,
          diff_value: round2(groupDiffValue),
          suggest_shares: 0,
          suggest_amount: round2(groupGap),
          current_pct: g.group_current_pct,
          unit: '元',
          is_group_level: true,
          ...(isCodeSecurity ? { is_new_position: true } : {}),
        });
        continue;
      }

      // 按市值等比分摊到行
      for (const row of g.rows) {
        const rowValue = Number(row.market_value) || 0;
        const weight = baseTotal > 0 ? rowValue / baseTotal : 1 / g.rows.length;
        let rowGap = groupGap * weight;

        // SELL 时单行卖出不得超过其持仓市值
        if (action === 'SELL') rowGap = Math.min(rowGap, rowValue);
        if (rowGap < 0.01) continue;

        const rowBase = {
          ...groupMeta,
          action,
          code: row.code ?? null,
          name: row.name,
          current_pct: row.current_pct,
          is_group_level: false,
        };

        if (row.asset_class === ASSET_CLASS.CASH) {
          // 现金类别：保持金额建议语义，多行现金按金额等比分摊
          if (rowGap < MIN_SUGGEST_AMOUNT) continue;
          const amount = round2(rowGap);
          // 现金行的增减不计入 assetBuy/assetSell（不产生外部资金需求）
          if (action === 'BUY') buyTotal += amount; else sellTotal += amount;
          items.push({
            ...rowBase,
            diff_value: round2(action === 'BUY' ? rowGap : -rowGap),
            suggest_shares: 0,
            suggest_amount: amount,
            unit: '元',
          });
          continue;
        }

        const price = row.current_price || 0;
        if (price <= 0) continue;
        const isEtf = row.asset_class === ASSET_CLASS.FUND;
        // 分摊额已覆盖整行市值 → 视为清仓，允许破整手
        const allowBreakLot = action === 'SELL' && rowGap >= rowValue - 0.01;
        const shares = roundShares(rowGap / price, row.asset_class, isEtf, allowBreakLot);
        if (shares <= 0) continue;
        if (shares < 1 && row.asset_class !== ASSET_CLASS.FUND) continue; // 不足 1 手跳过

        // 取整后回算金额，保证 suggest_amount === suggest_shares × current_price
        const amount = round2(shares * price);
        if (action === 'BUY') { buyTotal += amount; assetBuyTotal += amount; }
        else { sellTotal += amount; assetSellTotal += amount; }
        items.push({
          ...rowBase,
          diff_value: round2(action === 'BUY' ? rowGap : -rowGap),
          suggest_shares: shares,
          suggest_amount: amount,
          unit: row.asset_class === ASSET_CLASS.FUND ? '份' : '股',
        });
      }
    }

    items.sort((a, b) => Math.abs(b.diff_value) - Math.abs(a.diff_value));

    const buyTotalR = round2(buyTotal);
    const sellTotalR = round2(sellTotal);
    // 资金校验只看「证券侧」现金流：需要多少现金买证券 vs 手上现金 + 卖证券回款。
    // 现金桶自身的增减是记账的另一半，计入会重复统计并谎报缺口。
    const needCash = Math.max(0, round2(assetBuyTotal - cashAvailable));
    const balanceOk = assetBuyTotal <= assetSellTotal + cashAvailable + 1; // 允许 1 元浮点误差

    return {
      items,
      summary: {
        buy_total: buyTotalR,
        sell_total: sellTotalR,
        need_cash: needCash,
        balance_ok: balanceOk,
        cash_available: round2(cashAvailable),
        threshold,
        dimension,
        // 对账口径：planned_* 是分摊前的分组缺口，residual 为取整造成的残差
        planned_buy_total: round2(plannedBuy),
        planned_sell_total: round2(plannedSell),
        rounding_residual_buy: round2(plannedBuy - buyTotal),
        rounding_residual_sell: round2(plannedSell - sellTotal),
      },
    };
  }
  };
}

/**
 * 由已带 group_* 字段的持仓行还原出再平衡分组。
 *
 * holdings 上的 target_key / target_pct / group_deviation_pct 由
 * portfolioService.buildSummary 统一计算，这里只做归拢，确保
 * 「UI 看到的偏离」与「再平衡判定用的偏离」是同一个数。
 *
 * @param {Array<object>} holdings buildSummary 返回的持仓行
 * @param {Array<object>} allocation buildSummary 返回的配置分布（用于补齐零持仓的目标 key）
 * @returns {Map<string, {key:string, target_pct:number|null, current_value:number,
 *                        group_current_pct:number|null, group_deviation_pct:number|null,
 *                        rows:Array<object>}>}
 */
function buildRebalanceGroups(holdings, allocation = []) {
  const groups = new Map();

  for (const h of holdings) {
    const key = h.target_key;
    if (key == null || h.target_pct == null) continue; // 无分组键或无目标的行不参与
    let g = groups.get(key);
    if (!g) {
      g = {
        key,
        target_pct: h.target_pct,
        group_current_pct: h.group_current_pct ?? null,
        group_deviation_pct: h.group_deviation_pct ?? null,
        current_value: 0,
        rows: [],
      };
      groups.set(key, g);
    }
    g.current_value += Number(h.market_value) || 0;
    g.rows.push(h);
  }

  // 目标里配置了、但当前一行持仓都没有的 key（例如目标含 bond 却从未买过）
  for (const a of allocation) {
    if (a.target_pct == null || a.key == null || groups.has(a.key)) continue;
    groups.set(a.key, {
      key: a.key,
      target_pct: a.target_pct,
      group_current_pct: a.current_pct,
      group_deviation_pct: a.deviation_pct,
      current_value: 0,
      rows: [],
    });
  }

  for (const g of groups.values()) {
    g.current_value = round4(g.current_value);
  }

  return groups;
}
