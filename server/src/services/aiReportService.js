// ============================================================
// AI 报告服务：缓存命中 / 强制刷新 / 游客 ref_key
// AI 配置来源（优先级）：
//   1. 登录用户且已配置 user_ai_config（自定义模型）→ 使用该配置
//   2. 游客（未登录）→ 回落服务端 .env 默认（保证演示可用）
//   3. 登录用户但未配置 AI Key → 强制要求先配置，返回 notConfigured，不可使用 AI 功能
// ============================================================
import { createAiReportModel } from '../models/aiReportModel.js';
import { createPortfolioService } from './portfolioService.js';
import { createSecurityModel } from '../models/securityModel.js';
import { createUserAiConfigModel } from '../models/userAiConfigModel.js';
import { callLLM, localFallback } from './aiService.js';
import { resolveAiConfig } from '../ai/resolveAiConfig.js';
import {
  portfolioDiagnosisPrompt, morningCommentPrompt, closingInterpretationPrompt,
} from '../ai/prompts.js';
import { REPORT_TYPE } from '../../../shared/constants.js';

/** 快照哈希：组合明细 -> 短哈希（用于缓存键） */
export function snapshotHash(holdings) {
  const str = JSON.stringify(holdings.map((h) => ({ c: h.code, n: h.name, q: h.quantity, p: h.cost_price })));
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return 'snap' + (h >>> 0).toString(16);
}

// 注：resolveAiConfig 已抽取至 ../ai/resolveAiConfig.js（架构 §6.3），
//     与智能分析中心共用同一条 BYOK 解析链；此处行为保持不变。

/** 未配置 AI Key 时返回的标准响应（告知用户去「模型设置」配置） */
function notConfiguredResponse() {
  return {
    id: 0,
    report_type: '',
    ref_key: '',
    trade_date: '',
    content:
      '⚠️ 你尚未配置 AI 模型。请前往「模型设置」填写你自己的 API Key 后，方可使用 AI 分析（组合诊断 / 早盘点评 / 尾盘解读）功能。',
    cached: false,
    generated_at: new Date().toISOString(),
    ai_meta: null,
    notConfigured: true,
  };
}

/**
 * AI 报告服务工厂
 * @param {import('../db/driver.js').Database} db
 */
export function createAiReportService(db) {
  const reports = createAiReportModel(db);
  const portfolio = createPortfolioService(db);
  const model = createSecurityModel(db);
  const userAiConfig = createUserAiConfigModel(db);

  /** 组合诊断 */
  async function diagnose(userId, { force_refresh = false } = {}) {
    const resolved = resolveAiConfig(userAiConfig, userId);
    if (resolved.notConfigured) return notConfiguredResponse();

    const tradeDate = model.latestTradeDate() || new Date().toISOString().slice(0, 10);
    const summary = portfolio.buildSummary(userId);
    const hash = snapshotHash(summary.holdings);
    const refKey = `${hash}`;

    if (!force_refresh) {
      const cached = reports.getCached(userId, REPORT_TYPE.PORTFOLIO_DIAGNOSIS, refKey, tradeDate);
      if (cached) return toReport(cached, true);
    }

    const prompt = portfolioDiagnosisPrompt({ summary, concentration: summary.concentration });
    const { aiConfig, aiMeta } = resolved;
    let content;
    let generatedAt = new Date().toISOString();
    try {
      content = await callLLM(prompt, { aiConfig });
    } catch (_e) {
      content = localFallback(REPORT_TYPE.PORTFOLIO_DIAGNOSIS, { summary, concentration: summary.concentration });
    }
    const row = reports.upsert(userId, REPORT_TYPE.PORTFOLIO_DIAGNOSIS, refKey, tradeDate, content);
    return toReport(row, false, generatedAt, aiMeta);
  }

  /** 早盘点评（按交易日缓存，ref_key='daily'） */
  async function morningComment(userId, { items = [], force_refresh = false } = {}) {
    const resolved = resolveAiConfig(userAiConfig, userId);
    if (resolved.notConfigured) return notConfiguredResponse();

    const tradeDate = model.latestTradeDate() || new Date().toISOString().slice(0, 10);
    const refKey = 'daily';
    if (!force_refresh) {
      const cached = reports.getCached(userId, REPORT_TYPE.MORNING_COMMENT, refKey, tradeDate);
      if (cached) return toReport(cached, true);
    }
    const overview = model.overview();
    const auctionTop = model.auctionLeaderboard(15);
    const prompt = morningCommentPrompt({ overview, topItems: items, auctionTop });
    const { aiConfig, aiMeta } = resolved;
    let content;
    let generatedAt = new Date().toISOString();
    try {
      content = await callLLM(prompt, { aiConfig });
    } catch (_e) {
      content = localFallback(REPORT_TYPE.MORNING_COMMENT, { overview, topItems: items });
    }
    const row = reports.upsert(userId, REPORT_TYPE.MORNING_COMMENT, refKey, tradeDate, content);
    return toReport(row, false, generatedAt, aiMeta);
  }

  /** 尾盘解读（按 用户+策略+交易日 缓存） */
  async function closingInterpret(userId, { items = [], conditions = null, strategy_id = null, force_refresh = false } = {}) {
    const resolved = resolveAiConfig(userAiConfig, userId);
    if (resolved.notConfigured) return notConfiguredResponse();

    const tradeDate = model.latestTradeDate() || new Date().toISOString().slice(0, 10);
    const refKey = strategy_id ? `strategy:${strategy_id}` : `cond:${snapshotHash([{ n: JSON.stringify(conditions || {}) }])}`;
    if (!force_refresh) {
      const cached = reports.getCached(userId, REPORT_TYPE.CLOSING_INTERPRETATION, refKey, tradeDate);
      if (cached) return toReport(cached, true);
    }
    const prompt = closingInterpretationPrompt({ conditions, topItems: items });
    const { aiConfig, aiMeta } = resolved;
    let content;
    let generatedAt = new Date().toISOString();
    try {
      content = await callLLM(prompt, { aiConfig });
    } catch (_e) {
      content = localFallback(REPORT_TYPE.CLOSING_INTERPRETATION, { topItems: items, total: items.length });
    }
    const row = reports.upsert(userId, REPORT_TYPE.CLOSING_INTERPRETATION, refKey, tradeDate, content);
    return toReport(row, false, generatedAt, aiMeta);
  }

  function toReport(row, cached, generatedAt = row?.created_at, aiMeta = {}) {
    return {
      id: row.id,
      report_type: row.report_type,
      ref_key: row.ref_key,
      trade_date: row.trade_date,
      content: row.content,
      cached,
      generated_at: generatedAt || row.created_at,
      ai_meta: aiMeta,
    };
  }

  return { diagnose, morningComment, closingInterpret };
}
