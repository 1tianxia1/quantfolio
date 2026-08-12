// ============================================================
// 流水线运行服务（架构 §9 T05）—— ①选股 → ②择时 → ③回测 的数据总线
// 前序步骤产出（标的 / 信号）作为后序输入，实现「承前启后」。
//  - ①选股：手动指定 code，或 AI 自主选股（板块 → LLM 选龙头/潜力股）
//  - ②择时：timingService.signal_follow（跟随技术信号）
//  - ③回测：P2 占位（明确提示，不做空壳结果）
// 游客（user_id NULL）可用；run 归属校验：非本人且非游客则拒绝。
// ============================================================
import { createTimingService } from './timingService.js';
import { createIndicatorService } from '../indicatorService.js';
import { webSearchService } from '../webSearch/webSearchService.js';
import { resolveAiConfig } from '../../ai/resolveAiConfig.js';
import { createUserAiConfigModel } from '../../models/userAiConfigModel.js';
import { callLLM } from '../aiService.js';
import { jsonExtract } from './jsonExtract.js';
import { buildSelectPrompt } from './analysisPrompts.js';
import { tryNormalizeCode } from '../../util/codeUtil.js';
import { ApiError } from '../../util/errors.js';

/** 步骤固定序号（与 UI ①②③ 对齐） */
const STEP_SEQ = Object.freeze({ select: 1, timing: 2, backtest: 3 });

function safeParse(s) {
  try {
    return JSON.parse(s || '{}');
  } catch (_) {
    return {};
  }
}

/**
 * 流水线服务工厂
 * @param {import('../../db/driver.js').Database} db
 */
export function createPipelineRunService(db) {
  const timing = createTimingService(db);
  const indicators = createIndicatorService(db);
  const userAiConfig = createUserAiConfigModel(db);

  function assertOwner(run, userId) {
    if (run.user_id != null && run.user_id !== userId) throw ApiError.forbidden('无权访问该流水线');
  }

  function getRunRow(runId) {
    const run = db.get('SELECT * FROM pipeline_runs WHERE id = ?', [runId]);
    if (!run) throw ApiError.notFound('流水线不存在');
    return run;
  }

  function stepsOf(runId) {
    return db.all('SELECT * FROM pipeline_steps WHERE run_id = ? ORDER BY seq ASC', [runId]);
  }

  function serializeRun(run) {
    return {
      id: run.id,
      name: run.name,
      status: run.status,
      context: safeParse(run.context),
      created_at: run.created_at,
      updated_at: run.updated_at,
      steps: stepsOf(run.id).map((s) => ({
        id: s.id,
        step: s.step,
        seq: s.seq,
        status: s.status,
        input: safeParse(s.input),
        output: safeParse(s.output),
        error: s.error,
      })),
    };
  }

  /** 落一步（幂等 upsert）+ 更新 run 时间与状态 */
  function saveStep(runId, step, input, output, userId, error = null) {
    const status = error ? 'failed' : 'done';
    const existing = db.get('SELECT id FROM pipeline_steps WHERE run_id = ? AND step = ?', [runId, step]);
    if (existing) {
      db.run(
        'UPDATE pipeline_steps SET seq=?, status=?, input=?, output=?, error=? WHERE id=?',
        [STEP_SEQ[step], status, JSON.stringify(input || {}), JSON.stringify(output || {}), error, existing.id],
      );
    } else {
      db.run(
        'INSERT INTO pipeline_steps (run_id, step, seq, status, input, output, error) VALUES (?,?,?,?,?,?,?)',
        [runId, step, STEP_SEQ[step], status, JSON.stringify(input || {}), JSON.stringify(output || {}), error],
      );
    }
    db.run("UPDATE pipeline_runs SET updated_at = datetime('now'), status = ? WHERE id = ?", [error ? 'failed' : 'running', runId]);
    return serializeRun(getRunRow(runId));
  }

  // ---------- 基础 ----------

  function createRun(userId, name = '') {
    const info = db.run('INSERT INTO pipeline_runs (user_id, name) VALUES (?, ?)', [userId ?? null, String(name || '').trim() || '未命名流水线']);
    return serializeRun(getRunRow(info.lastInsertRowid));
  }

  function getRun(runId, userId) {
    const run = getRunRow(runId);
    assertOwner(run, userId);
    return serializeRun(run);
  }

  function listRuns(userId) {
    const rows = db.all(
      'SELECT * FROM pipeline_runs WHERE user_id IS NULL OR user_id = ? ORDER BY id DESC LIMIT 20',
      [userId],
    );
    return rows.map((r) => ({ id: r.id, name: r.name, status: r.status, updated_at: r.updated_at }));
  }

  // ---------- ① 选股 ----------

  /**
   * @param {number} runId
   * @param {number|null} userId
   * @param {{sector?:string, code?:string, style?:string}} input
   */
  async function select(runId, userId, { sector, code, style }) {
    const run = getRunRow(runId);
    assertOwner(run, userId);

    // 方式一：手动指定代码
    if (code) {
      const normalized = tryNormalizeCode(code);
      if (!normalized) throw ApiError.badRequest(`无效证券代码：${code}`);
      const snap = indicators.getLatestSnapshot([normalized])[0];
      if (!snap) throw ApiError.securityNotFound(`标的不存在或暂无行情：${normalized}`);
      const target = { code: normalized, name: snap.name, style: style || 'manual', source: 'manual' };
      return saveStep(runId, 'select', { code: normalized, style: style || 'manual' }, { target, candidates: [target] }, userId);
    }

    // 方式二：AI 自主选股（板块）
    if (!sector || !String(sector).trim()) {
      throw ApiError.badRequest('选股需要 code（手动）或 sector（AI 自主选股）');
    }
    const resolved = resolveAiConfig(userAiConfig, userId);
    if (resolved.notConfigured) throw ApiError.aiNotConfigured();

    const query = `${sector} 板块 龙头股 潜力股 近期表现 资金流向`;
    const bundle = await webSearchService.searchOrThrow(query, { aiResolution: resolved });

    const prompt = buildSelectPrompt({ sector, style, bundle });
    let content = null;
    let llmError = null;
    try {
      content = await callLLM(prompt, { aiConfig: resolved.aiConfig, temperature: 0.3, maxTokens: 2048 });
    } catch (e) {
      llmError = String(e?.message || e);
    }

    let candidates = [];
    if (content) {
      const parsed = jsonExtract(content);
      if (parsed && Array.isArray(parsed.candidates)) {
        candidates = parsed.candidates
          .filter((c) => c && String(c.code || '').trim())
          .slice(0, 6)
          .map((c) => ({
            code: String(c.code).trim(),
            name: String(c.name || '').trim(),
            style: String(c.style || '') === '潜力' ? '潜力' : '龙头',
            reason: String(c.reason || '').trim().slice(0, 120),
          }));
      }
    }

    if (!candidates.length) {
      // 红线：AI 没选出有效候选时绝不编造，明确提示改用手动输入
      throw ApiError.upstreamUnavailable(`AI 选股暂不可用${llmError ? `：${llmError}` : ''}，请改用「手动输入代码」方式`);
    }

    return saveStep(
      runId,
      'select',
      { sector, style: style || 'trend' },
      {
        candidates,
        query: bundle.query,
        sources: (bundle.results || []).map((r) => ({ title: r.title, url: r.url, published_at: r.publishedAt })),
        search_meta: { providers_used: bundle.providersUsed, retrieved_at: bundle.retrievedAt },
      },
      userId,
    );
  }

  // ---------- ② 择时 ----------

  /**
   * @param {number} runId
   * @param {number|null} userId
   * @param {{code:string, strategy?:string}} input
   */
  async function timingStep(runId, userId, { code, strategy }) {
    const run = getRunRow(runId);
    assertOwner(run, userId);
    const normalized = tryNormalizeCode(code);
    if (!normalized) throw ApiError.badRequest(`无效证券代码：${code}`);
    const result = await timing.timing(normalized, strategy || 'signal_follow');
    return saveStep(runId, 'timing', { code: normalized, strategy: strategy || 'signal_follow' }, result, userId);
  }

  // ---------- ③ 回测（P2 占位） ----------

  /**
   * @param {number} runId
   * @param {number|null} userId
   * @param {{code:string}} input
   */
  async function backtestStep(runId, userId, { code }) {
    const run = getRunRow(runId);
    assertOwner(run, userId);
    const normalized = tryNormalizeCode(code);
    if (!normalized) throw ApiError.badRequest(`无效证券代码：${code}`);
    const output = { implemented: false, code: normalized, message: '回测引擎将在 P2 提供（2/5/10 年年化回报与达标判定）' };
    return saveStep(runId, 'backtest', { code: normalized }, output, userId);
  }

  return { createRun, getRun, listRuns, select, timing: timingStep, backtest: backtestStep };
}

export default createPipelineRunService;
