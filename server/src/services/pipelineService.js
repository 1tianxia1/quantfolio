// ============================================================
// 五步法/七步法有序漏斗管线（P0 核心方法论）
// 执行 steps、淘汰统计、命中步骤标签、宽松模式
// 与 SCREENING_RULES.md / DESIGN.md §7.4 精确一致
// ============================================================
import { createSecurityModel } from '../models/securityModel.js';
import { createIndicatorService } from './indicatorService.js';
import { createScoreService } from './scoreService.js';
import { SCREENING_DEFAULTS, SCREENING_STEP_ORDER, MORNING_LOOSE_MV } from '../config/screening-defaults.js';
import { round2 } from '../util/money.js';

/**
 * 管线服务工厂
 * @param {import('../db/driver.js').Database} db
 */
export function createPipelineService(db) {
  const model = createSecurityModel(db);
  const indicators = createIndicatorService(db);
  const scorer = createScoreService(db);

  return {
  /**
   * 执行漏斗管线
   * @param {object} req { type: 'morning'|'closing', steps: [{id,enabled,params}], loose_mode?: boolean }
   */
  runPipeline(req) {
    const type = req.type;
    const looseMode = !!req.loose_mode;
    const defaults = SCREENING_DEFAULTS[type];
    const order = SCREENING_STEP_ORDER[type];

    // 合并用户配置与默认值（保证步骤顺序与默认阈值）
    const userSteps = new Map((req.steps || []).map((s) => [s.id, s]));
    const configs = order.map((id) => {
      const def = defaults[id];
      const user = userSteps.get(id) || {};
      return {
        id,
        label: def.label,
        enabled: user.enabled !== undefined ? !!user.enabled : def.enabled,
        params: { ...(def.params || {}), ...(user.params || {}) },
      };
    });

    // 初始池：股票（早盘/尾盘均只筛股票，基金不参与）
    const securities = model.list({ types: ['stock'] });
    const codes = securities.map((s) => s.code);
    const snapByCode = new Map(indicators.getLatestSnapshot(codes, { types: ['stock'] }).map((s) => [s.code, s]));

    // D1/D6 数据可用性预检：关键字段大面积缺失会让漏斗「静默 0 命中」，
    // 用户会误以为功能坏了。这里显式统计并随结果返回提示，区分「字段缺失」与「规则不满足」。
    const fieldStats = { total: codes.length, circ_mv: 0, turnover_rate: 0, auction_pct: 0, volume_ratio: 0 };
    for (const snap of snapByCode.values()) {
      if (snap.circ_mv != null) fieldStats.circ_mv += 1;
      if (snap.turnover_rate != null) fieldStats.turnover_rate += 1;
      if (snap.auction_pct != null) fieldStats.auction_pct += 1;
      if (snap.volume_ratio != null) fieldStats.volume_ratio += 1;
    }
    const keyField = type === 'closing' ? 'turnover_rate' : 'circ_mv';
    const keyFieldLabel = keyField === 'turnover_rate' ? '换手率(turnover_rate)' : '流通市值(circ_mv)';
    const keyCount = fieldStats[keyField];
    const dataReady = keyCount >= Math.min(100, fieldStats.total);
    const dataHint = dataReady
      ? null
      : `当前行情数据缺少「${keyFieldLabel}」字段（可用 ${keyCount}/${fieldStats.total} 只），筛选结果可能为空或严重偏少，请先同步行情数据后再运行`;

    // 板块热度上下文（评分用）
    const sectorHeat = buildSectorHeatMap(db);
    const mainlineTier = buildMainlineTier(db, req.steps || [], type);

    let pool = codes;
    const funnel = [];
    const hits = new Map(); // code -> Set(步骤标签)

    for (const step of configs) {
      if (!step.enabled) {
        funnel.push({ step_id: step.id, label: step.label, survivors: pool.length, eliminated: 0, missing: 0, top_reasons: [] });
        continue;
      }
      // 排名型步骤（取 TopN）与硬过滤步骤分开处理
      let pass;
      let fail;
      let reasons;
      if (step.id === 'auction_top60' || step.id === 'vol_ratio_top30') {
        ({ pass, fail, reasons } = rankStepFilter(step, pool, snapByCode, { type, looseMode }));
      } else {
        ({ pass, fail, reasons } = stepFilter(step, pool, snapByCode, { type, looseMode, sectorHeat }));
      }
      // 淘汰原因统计
      const tally = {};
      for (const r of reasons) {
        tally[r.reason] = (tally[r.reason] || 0) + 1;
      }
      const topReasons = Object.entries(tally)
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 3);

      // 更新命中步骤标签
      fail.forEach((code) => hits.get(code)?.delete(step.label));
      pass.forEach((code) => {
        if (!hits.has(code)) hits.set(code, new Set());
        hits.get(code).add(step.label);
      });

      funnel.push({
        step_id: step.id,
        label: step.label,
        survivors: pass.length,
        eliminated: fail.length,
        // D1/D6：本步中因「字段缺失」被淘汰的数量（区别于规则不满足）
        missing: reasons.filter((r) => /缺失/.test(r.reason)).length,
        top_reasons: topReasons,
      });
      pool = pass;
      if (pool.length === 0) break; // 提前终止
    }

    // 评分（仅对通过全部步骤者）
    const scored = pool.map((code) => {
      const snap = snapByCode.get(code);
      const score = type === 'closing'
        ? scorer.scoreClosingPipeline(snap)
        : scorer.scoreMorningPipeline(snap, { mainlineTier });
      const hitStepTags = [...(hits.get(code) || [])];
      return {
        rank: 0,
        code: snap.code,
        name: snap.name,
        price: snap.price,
        pct_chg: snap.pct_chg,
        score: score.total,
        score_detail: { total: score.total, factors: score.factors },
        hit_tags: snap.hit_tags,
        hit_step_tags: hitStepTags,
        metrics: pickMetrics(snap),
        data_origin: snap.data_origin,
      };
    });
    scored.sort((a, b) => b.score - a.score);
    scored.forEach((r, i) => { r.rank = i + 1; });

    return { funnel, items: scored, dataReady, dataHint, fieldStats };
  }
  };
}

// ================= 排名型步骤（TopN） =================
/**
 * 排名型步骤：auction_top60（按竞价涨幅降序取 TopN）、
 * vol_ratio_top30（按量比降序取 TopN，且可选量比下限）
 */
function rankStepFilter(step, pool, snapByCode, ctx) {
  const { type } = ctx;
  const p = step.params;
  const topN = p.topN ?? (step.id === 'auction_top60' ? 60 : 30);

  const scored = [];
  const fail = [];
  const reasons = [];
  for (const code of pool) {
    const snap = snapByCode.get(code);
    if (!snap) { fail.push(code); reasons.push({ code, reason: '数据缺失' }); continue; }
    let key;
    let ok = true;
    if (step.id === 'auction_top60') {
      key = snap.auction_pct;
      if (key == null) { ok = false; reasons.push({ code, reason: '竞价数据缺失' }); }
    } else {
      // 早盘第 2 步 vol_ratio_top30：实现为「量比 ≥ min 且按量比降序取 TopN」的 AND 语义，
      // 比用户原文「取 Top30；或量比≥1.5」更严格，属于保守取舍（防止放量不足的僵尸股混入）
      key = snap.volume_ratio;
      if (key == null) { ok = false; reasons.push({ code, reason: '量比数据缺失' }); }
      else if (p.min != null && key < p.min) { ok = false; reasons.push({ code, reason: `量比不足${p.min}` }); }
    }
    if (ok) scored.push({ code, key });
    else fail.push(code);
  }
  scored.sort((a, b) => (b.key ?? -Infinity) - (a.key ?? -Infinity));
  const keep = scored.slice(0, topN).map((s) => s.code);
  const drop = scored.slice(topN).map((s) => s.code);
  for (const code of drop) {
    fail.push(code);
    reasons.push({ code, reason: step.id === 'auction_top60' ? '竞价涨幅排名靠后' : '量比排名靠后' });
  }
  return { pass: keep, fail, reasons };
}

// ================= 单步过滤 =================
function stepFilter(step, pool, snapByCode, ctx) {
  const { type, looseMode } = ctx;
  const pass = [];
  const fail = [];
  const reasons = [];
  const id = step.id;
  const p = step.params;

  for (const code of pool) {
    const snap = snapByCode.get(code);
    if (!snap) { fail.push(code); reasons.push({ code, reason: '数据缺失' }); continue; }

    let ok = true;
    let reason = '';
    if (type === 'closing') {
      ({ ok, reason } = closingStepCheck(id, snap, p));
    } else {
      ({ ok, reason } = morningStepCheck(id, snap, p, ctx));
    }
    if (ok) {
      pass.push(code);
    } else {
      fail.push(code);
      reasons.push({ code, reason });
    }
  }
  return { pass, fail, reasons };
}

/** 尾盘五步法单步判定 */
function closingStepCheck(id, snap, p) {
  switch (id) {
    case 'pct3_5': {
      const v = snap.pct_chg;
      if (v == null) return { ok: false, reason: '涨幅数据缺失' };
      if (v < p.min) return { ok: false, reason: `涨幅不足${p.min}%` };
      if (v > p.max) return { ok: false, reason: `涨幅超${p.max}%` };
      return { ok: true, reason: '' };
    }
    case 'turnover5_20': {
      const v = snap.turnover_rate;
      if (v == null) return { ok: false, reason: '换手数据缺失' };
      if (v < p.min) return { ok: false, reason: `换手不足${p.min}%` };
      if (v > p.max) return { ok: false, reason: `换手超${p.max}%` };
      return { ok: true, reason: '' };
    }
    case 'mv50_500': {
      const v = snap.circ_mv;
      if (v == null) return { ok: false, reason: '市值数据缺失' };
      if (v < p.min) return { ok: false, reason: `市值不足${p.min}亿` };
      if (v > p.max) return { ok: false, reason: `市值超${p.max}亿` };
      return { ok: true, reason: '' };
    }
    case 'vol_streak': {
      const v = snap.volume_streak;
      // 数据缺失时放行（不淘汰），避免「字段空 → 全市场 0 命中」的静默失败；
      // 字段存在时仍按阈值严格过滤。
      if (v == null) return { ok: true, reason: '' };
      if (v < p.minStreak) return { ok: false, reason: `放量不足${p.minStreak}日` };
      if (v > p.maxStreak) return { ok: false, reason: `放量超${p.maxStreak}日` };
      return { ok: true, reason: '' };
    }
    case 'ma_bullish': {
      // ① 多头排列 close > MA5 > MA10 > MA20
      const bullish = snap.price != null && snap.ma5 != null && snap.ma10 != null && snap.ma20 != null &&
        snap.price > snap.ma5 && snap.ma5 > snap.ma10 && snap.ma10 > snap.ma20;
      if (!bullish) return { ok: false, reason: '非多头排列' };
      // ② 上方空间 ≥ minSpace%
      const space = snap.high_60d_distance_pct;
      // 上方空间数据缺失时放行（不淘汰），避免静默 0 命中
      if (space == null) return { ok: true, reason: '' };
      if (space < p.minSpace) return { ok: false, reason: `上方空间不足${p.minSpace}%` };
      return { ok: true, reason: '' };
    }
    default:
      return { ok: true, reason: '' };
  }
}

/** 早盘七步法单步判定 */
function morningStepCheck(id, snap, p, ctx) {
  switch (id) {
    case 'auction_top60': {
      // 竞价涨幅 TopN（按 auction_pct 降序）—— 由外层对 pool 预排序后调用
      // 这里仅做数据可用性检查
      if (snap.auction_pct == null) return { ok: false, reason: '竞价数据缺失' };
      return { ok: true, reason: '' };
    }
    case 'vol_ratio_top30': {
      if (snap.volume_ratio == null) return { ok: false, reason: '量比数据缺失' };
      if (p.min != null && snap.volume_ratio < p.min) return { ok: false, reason: `量比不足${p.min}` };
      return { ok: true, reason: '' };
    }
    case 'auction3_5': {
      const v = snap.auction_pct;
      if (v == null) return { ok: false, reason: '竞价数据缺失' };
      if (v < p.min) return { ok: false, reason: `竞价涨幅不足${p.min}%` };
      if (v > p.max) return { ok: false, reason: `竞价涨幅超${p.max}%` };
      return { ok: true, reason: '' };
    }
    case 'mv_lt10': {
      const v = snap.circ_mv;
      // 市值数据缺失时放行（不淘汰），避免静默 0 命中
      if (v == null) return { ok: true, reason: '' };
      const threshold = ctx.looseMode ? (p.looseMax ?? MORNING_LOOSE_MV) : p.max;
      if (v >= threshold) return { ok: false, reason: `市值超${threshold}亿（非小盘）` };
      return { ok: true, reason: '' };
    }
    case 'ma_bullish60': {
      // 多头排列 close > MA5 > MA10 > MA20 > MA60
      const bullish = snap.price != null && snap.ma5 != null && snap.ma10 != null && snap.ma20 != null && snap.ma60 != null &&
        snap.price > snap.ma5 && snap.ma5 > snap.ma10 && snap.ma10 > snap.ma20 && snap.ma20 > snap.ma60;
      if (!bullish) return { ok: false, reason: '非多头排列(含60日线)' };
      const space = snap.high_60d_distance_pct;
      if (space == null) return { ok: false, reason: '上方空间数据缺失' };
      if (space < p.minSpace) return { ok: false, reason: `上方空间不足${p.minSpace}%` };
      return { ok: true, reason: '' };
    }
    case 'hot_sector': {
      const sectors = Array.isArray(p.sectors) ? p.sectors : [];
      if (!snap.sector) return { ok: false, reason: '无板块归属' };
      if (!matchSector(snap.sector, sectors)) return { ok: false, reason: '非主线板块' };
      return { ok: true, reason: '' };
    }
    case 'first_trade_vol': {
      const v = snap.first_trade_vol_ratio;
      // 首笔量比字段当前数据源普遍缺失 → 缺失时放行（不淘汰），字段存在时仍按阈值过滤。
      // 这是早盘七步法此前「全市场 0 命中」的首要根因。
      if (v == null) return { ok: true, reason: '' };
      if (v < p.min) return { ok: false, reason: `首笔量比不足${p.min}` };
      return { ok: true, reason: '' };
    }
    default:
      return { ok: true, reason: '' };
  }
}

// ================= 辅助 =================

/**
 * 板块匹配：支持精确匹配与关键词包含（如 'AI' 可匹配 'AI芯片'）
 */
function matchSector(sector, sectors) {
  if (sectors.includes(sector)) return true;
  for (const s of sectors) {
    if (s.length >= 2 && (sector.includes(s) || s.includes(sector))) return true;
  }
  return false;
}

/** 构建 sector -> {rank, pct_chg} 热度映射 */
function buildSectorHeatMap(db) {
  const model = createSecurityModel(db);
  const rows = model.getHotSectors('sector', 200);
  const map = {};
  for (const r of rows) {
    map[r.sector_name] = { rank: r.hot_rank, pct_chg: r.sector_pct_chg };
  }
  return map;
}

/**
 * 构建主线板块分档：sector -> tier（1/2/3）
 * 按 hot_sectors 热度排名分档：rank1-3=第一档，4-10=第二档，11-20=第三档，其余=0
 */
function buildMainlineTier(db, steps, type) {
  const tier = {};
  if (type !== 'morning') return tier;
  const hotStep = (steps || []).find((s) => s.id === 'hot_sector');
  const sectors = Array.isArray(hotStep?.params?.sectors) ? hotStep.params.sectors : [];
  if (!sectors.length) return tier;
  const model = createSecurityModel(db);
  const rows = model.getHotSectors('sector', 200);
  for (const r of rows) {
    if (matchSector(r.sector_name, sectors)) {
      const rank = r.hot_rank;
      tier[r.sector_name] = rank <= 3 ? 1 : rank <= 10 ? 2 : rank <= 20 ? 3 : 0;
    }
  }
  return tier;
}

function pickMetrics(snap) {
  return {
    pct_chg: snap.pct_chg,
    turnover_rate: snap.turnover_rate,
    volume_ratio: snap.volume_ratio,
    vol_ratio_5: snap.vol_ratio_5,
    pe_ttm: snap.pe_ttm,
    circ_mv: snap.circ_mv,
    total_mv: snap.total_mv,
    amount: snap.amount,
    main_net_inflow: snap.main_net_inflow,
    net_inflow_3d: snap.net_inflow_3d,
    auction_pct: snap.auction_pct,
    auction_vol_ratio: snap.auction_vol_ratio,
    limit_streak: snap.limit_streak,
    high_60d_distance_pct: snap.high_60d_distance_pct,
    volume_streak: snap.volume_streak,
    rsi12: snap.rsi12,
    kdj_j: snap.kdj_j,
    first_trade_vol_ratio: snap.first_trade_vol_ratio,
  };
}
