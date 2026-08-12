// ============================================================
// 模块 A 量化分析（AI 基本面 + 消息面）主编排（架构 §9 T03）
// 输入 code → 盘面快照 + 联网检索（42401 硬闸）→ GLM/BYOK 生成结构化结论
// 红线（架构 §7.5）：检索零结果/全部超期 → 42401，**绝不调用 LLM**。
// LLM 失败/返回非法 JSON → degraded 规则版摘要（如实标注，不编造）。
// ============================================================
import { createIndicatorService } from '../indicatorService.js';
import { createSecurityModel } from '../../models/securityModel.js';
import { createFundNavService } from '../fundNavService.js';
import { webSearchService } from '../webSearch/webSearchService.js';
import { resolveAiConfig } from '../../ai/resolveAiConfig.js';
import { callLLM } from '../aiService.js';
import { jsonExtract, normalizeConclusion } from './jsonExtract.js';
import { buildQuantPrompt } from './analysisPrompts.js';
import { createUserAiConfigModel } from '../../models/userAiConfigModel.js';
import { ApiError } from '../../util/errors.js';

/**
 * 模块 A 量化分析服务工厂
 * @param {import('../../db/driver.js').Database} db
 */
export function createFundamentalAnalysisService(db) {
  const indicators = createIndicatorService(db);
  const model = createSecurityModel(db);
  const fundNav = createFundNavService(db);
  const userAiConfig = createUserAiConfigModel(db);

  /**
   * 分析单个标的（AI 基本面 + 消息面）
   * @param {string} code 6 位裸码
   * @param {number|null} userId 登录用户 id（决定 BYOK 配置）
   * @returns {Promise<object>} FundamentalReport
   */
  /**
   * 场外基金净值兜底：daily_quotes 无数据（场外基金不在交易所交易）时，
   * 先查本地 fund_nav，没有则调天天基金接口取真实净值并落地，杜绝 40401。
   * @returns {Promise<object|null>} 基金快照；无法解析返回 null
   */
  async function resolveOtcFundSnapshot(code) {
    // 1) 本地 fund_nav 优先（已被同步过）
    const local = model.getFundNav([code])[0];
    if (local) return buildFundSnapshot(code, local);

    // 2) 否则调天天基金接口取真实净值（syncFundNav 仅对无上市行情的代码抓取并落地）
    try {
      const summary = await fundNav.syncFundNav({ codes: [code] });
      if (summary && summary.synced > 0 && Array.isArray(summary.navs) && summary.navs.length > 0) {
        return buildFundSnapshot(code, summary.navs[0]);
      }
    } catch (e) {
      console.warn('[fundamental] OTC 基金净值获取失败:', code, e.message);
    }
    return null;
  }

  /**
   * 用场外基金净值拼一个与 getLatestSnapshot 同构的快照，供提示词/规则版复用。
   * 技术面字段对基金无意义，统一填 null / 0。
   */
  function buildFundSnapshot(code, nav) {
    const sec = safeGetSecurity(code);
    const name = (sec && sec.name) || nav.name || code;
    const market = (sec && sec.market) || 'SZ';
    return {
      code,
      name,
      type: 'fund',
      market,
      sector: null,
      industry: null,
      board: 'OTC',
      is_st: 0,
      list_date: null,
      price: nav.nav,
      pre_close: nav.pre_nav,
      open: nav.nav,
      high: nav.nav,
      low: nav.nav,
      pct_chg: nav.nav_chg_pct,
      turnover_rate: null,
      volume: null,
      amount: null,
      volume_ratio: null,
      circ_mv: null,
      total_mv: null,
      pe_ttm: null,
      pb: null,
      trade_date: nav.nav_date,
      data_origin: nav.is_estimate ? 'mixed' : 'fund_nav',
      // 技术指标（基金无意义）
      ma5: null, ma10: null, ma20: null, ma60: null,
      macd_dif: null, macd_dea: null, macd_bar: null,
      rsi6: null, rsi12: null, rsi24: null,
      kdj_k: null, kdj_d: null, kdj_j: null,
      vol_ma5: null, vol_ratio_5: null, volume_streak: 0, high_60d_distance_pct: null,
      macd_gold_cross: 0, macd_dead_cross: 0, macd_positive: 0, macd_hist_turn_positive: 0,
      kdj_gold_cross: 0, kdj_dead_cross: 0, ma_bullish: 0, ma_bearish: 0, ma_above_20: 0, ma_cross_above_5: 0,
      indicator_hit: [], seed_tags: [], hit_tags: [],
      main_net_inflow: null, net_inflow_3d: null, net_inflow_5d: null,
      auction_price: null, auction_pct: null, auction_volume: null, auction_amount: null,
      auction_vol_ratio: null, first_trade_vol_ratio: null,
      limit_today: null, limit_streak: 0, limit_pattern: null, limit_reason: null, limit_recent_20d: false,
      is_otc_fund: true,
    };
  }

  /** 安全读取 securities 主记录（拿名称/市场），失败返回 null 不阻断分析 */
  function safeGetSecurity(code) {
    try {
      return db.get('SELECT code, name, market, type, fund_category FROM securities WHERE code = ?', [code]) || null;
    } catch (_) {
      return null;
    }
  }

  /**
   * 分析单个标的（AI 基本面 + 消息面）
   * @param {string} code 6 位裸码
   * @param {number|null} userId 登录用户 id（决定 BYOK 配置）
   * @param {{onProgress?: (e: object) => void}} [opts] 流式进度回调
   * @returns {Promise<object>} FundamentalReport
   */
  async function analyze(code, userId = null, { onProgress } = {}) {
    const emit = (e) => {
      try { onProgress && onProgress(e); } catch (_) { /* ignore */ }
    };

    // 1) 盘面快照（本地 daily_quotes：A 股 / 场内 ETF）
    emit({ type: 'status', step: 'fetching', message: '正在获取标的最新行情快照…' });
    let snap = indicators.getLatestSnapshot([code])[0];
    let isOtcFund = false;

    // 场外基金兜底：daily_quotes 无数据 → 取 fund_nav / 调天天基金接口
    if (!snap) {
      emit({ type: 'status', step: 'fetching', message: '本地行情缺失，尝试获取场外基金真实净值…' });
      snap = await resolveOtcFundSnapshot(code);
      if (snap) isOtcFund = true;
    }

    if (!snap) throw ApiError.securityNotFound(`标的不存在或暂无行情：${code}`);

    // 2) BYOK 解析：未配置 Key → 42402（引导跳「模型设置」）
    emit({ type: 'status', step: 'resolving', message: '校验 AI 模型配置…' });
    const resolved = resolveAiConfig(userAiConfig, userId);
    if (resolved.notConfigured) throw ApiError.aiNotConfigured();

    // 3) 联网检索（42401 硬闸：零结果/全 stale 直接抛错，不调 LLM）
    emit({ type: 'status', step: 'searching', message: `正在联网检索 ${snap.name} 的财报、资金流与新闻…` });
    const query = `${snap.name}(${code}) 最新财报 业绩 资金流向 所属板块表现 相关新闻 产业链`;
    const bundle = await webSearchService.searchOrThrow(query, { code, aiResolution: resolved });

    // 4) 组装提示词 → LLM；失败走 degraded 规则版
    emit({ type: 'status', step: 'generating', message: 'AI 正在生成分析结论…' });
    const prompt = buildQuantPrompt({ snap, bundle });
    let content;
    let degraded = false;
    let llmError = null;
    try {
      content = await callLLM(prompt, { aiConfig: resolved.aiConfig, temperature: 0.3, maxTokens: 2048 });
    } catch (e) {
      degraded = true;
      llmError = String(e?.message || e);
    }

    let conclusion;
    if (!degraded) {
      const parsed = jsonExtract(content);
      if (parsed && typeof parsed === 'object') {
        conclusion = normalizeConclusion(parsed);
      } else {
        degraded = true;
        llmError = llmError || '模型返回无法解析的结构化数据';
        conclusion = ruleBasedConclusion(snap, bundle);
      }
    } else {
      conclusion = ruleBasedConclusion(snap, bundle);
    }

    emit({ type: 'status', step: 'done', message: '分析完成' });

    // 5) 组装报告：来源只取自情报 bundle（绝不信任 LLM 编造的链接）
    return {
      code: snap.code,
      name: snap.name,
      type: snap.type,
      trade_date: snap.trade_date,
      is_otc_fund: isOtcFund,
      conclusion,
      sources: (bundle.results || []).map((r) => ({
        title: r.title || '(无标题)',
        url: r.url,
        published_at: r.publishedAt || null,
        retrieved_at: r.retrievedAt || bundle.retrievedAt,
        stale: Boolean(r.stale),
      })),
      search: {
        query: bundle.query,
        providers_used: bundle.providersUsed || [],
        degraded_channels: bundle.degradedChannels || [],
        freshness: bundle.freshness || null,
        retrieved_at: bundle.retrievedAt,
      },
      meta: {
        degraded,
        degrade_reason: degraded ? llmError : null,
        ai_provider: resolved.aiMeta?.provider ?? null,
        ai_model: resolved.aiConfig?.model ?? null,
        generated_at: new Date().toISOString(),
      },
    };
  }

  return { analyze };
}

/**
 * degraded 规则版结论（AI 失败时兜底，如实标注，不编造）
 * 只基于盘面快照 + 情报标题做规则化摘要。
 */
function ruleBasedConclusion(snap, bundle) {
  const up = Number(snap.pct_chg) > 0;
  const inflow = Number(snap.net_inflow_5d) > 0;
  const view = up && inflow ? '乐观' : up || inflow ? '中性' : '谨慎';
  const keys = [
    `现价 ${snap.price}，当日 ${snap.pct_chg ?? '—'}%，5 日主力${Number(snap.net_inflow_5d) > 0 ? '净流入' : '净流出/持平'} ${snap.net_inflow_5d ?? '—'} 万。`,
    `MACD ${snap.macd_gold_cross === 1 ? '金叉' : snap.macd_dead_cross === 1 ? '死叉' : '中性'}，量比 ${snap.volume_ratio ?? '—'}。`,
  ];
  const titles = (bundle.results || []).slice(0, 3).map((r) => r.title || '(无标题)');
  if (titles.length) keys.push(`最新情报：${titles.join('；')}`);
  return {
    summary: 'AI 服务暂不可用，以下为本地规则版摘要（未调用大模型）。',
    view,
    action: view === '乐观' ? 'HOLD' : view === '谨慎' ? 'SELL' : 'HOLD',
    target_price: null,
    stop_loss: null,
    confidence: 30,
    key_points: keys,
    risks: ['AI 未能生成结论，请稍后重试或检查模型配置。', '规则版摘要仅基于盘面与情报标题，未做深度分析。'],
  };
}

export default createFundamentalAnalysisService;
