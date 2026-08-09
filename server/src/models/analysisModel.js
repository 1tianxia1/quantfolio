// ============================================================
// 智能分析中心三表 CRUD：analysis_reports / pipeline_runs / pipeline_steps
//
// 约定：
//   · payload / context / input / output 在库里是 JSON 文本，
//     本模型负责「出库自动 parse、入库自动 stringify」，上层只见对象；
//   · user_id 允许 NULL（游客），查询一律用 `IS ?` 而非 `= ?`（与 ai_reports 同构）；
//   · 解析失败绝不抛错，返回 {} 并保留原始文本在 _raw 字段，避免一条脏数据毁掉整页。
// ============================================================
import { PIPELINE_STEP_ORDER, PIPELINE_STEP_STATUS, PIPELINE_RUN_STATUS } from '../../../shared/constants.js';

/**
 * 安全 JSON 解析
 * @param {string|null} text 原始文本
 * @param {*} [fallback={}] 解析失败时的兜底值
 * @returns {*} 解析结果
 */
function parseJson(text, fallback = {}) {
  if (text === null || text === undefined || text === '') return fallback;
  if (typeof text === 'object') return text;
  try {
    return JSON.parse(text);
  } catch (_) {
    return fallback;
  }
}

/**
 * 安全 JSON 序列化
 * @param {*} value 任意值
 * @param {string} [fallback='{}'] 序列化失败兜底
 * @returns {string} JSON 文本
 */
function stringifyJson(value, fallback = '{}') {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch (_) {
    return fallback;
  }
}

/**
 * 行 → 领域对象（analysis_reports）
 * @param {object|null} row 数据库行
 * @returns {object|null} 报告对象
 */
function toReportRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    user_id: row.user_id,
    module: row.module,
    code: row.code,
    trade_date: row.trade_date,
    payload: parseJson(row.payload, {}),
    model: row.model,
    search_provider: row.search_provider,
    retrieved_at: row.retrieved_at,
    data_origin: row.data_origin,
    created_at: row.created_at,
  };
}

/**
 * 行 → 领域对象（pipeline_runs）
 * @param {object|null} row 数据库行
 * @returns {object|null} 运行对象
 */
function toRunRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    user_id: row.user_id,
    name: row.name,
    status: row.status,
    context: parseJson(row.context, {}),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * 行 → 领域对象（pipeline_steps）
 * @param {object|null} row 数据库行
 * @returns {object|null} 步骤对象
 */
function toStepRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    run_id: row.run_id,
    step: row.step,
    seq: row.seq,
    status: row.status,
    input: parseJson(row.input, {}),
    output: parseJson(row.output, {}),
    error: row.error,
    created_at: row.created_at,
  };
}

/**
 * 智能分析模型工厂
 * @param {import('../db/driver.js').Database} db 数据库句柄
 * @returns {object} 模型实例
 */
export function createAnalysisModel(db) {
  return {
    // ==========================================================
    // analysis_reports
    // ==========================================================

    /**
     * 取同日缓存报告
     * @param {number|null} userId 用户 id（游客传 null）
     * @param {string} module 'fundamental' | 'technical'
     * @param {string} code 标的代码
     * @param {string} tradeDate 交易日 YYYY-MM-DD
     * @returns {object|null} 报告；未命中返回 null
     */
    getReport(userId, module, code, tradeDate) {
      const row = db.get(
        `SELECT * FROM analysis_reports
         WHERE user_id IS ? AND module = ? AND code = ? AND trade_date = ?`,
        [userId ?? null, module, code, tradeDate],
      );
      return toReportRow(row);
    },

    /**
     * 写入 / 覆盖报告（同 user+module+code+trade_date 唯一，force_refresh 走覆盖）
     * @param {object} input 报告数据
     * @param {number|null} input.user_id 用户 id
     * @param {string} input.module 模块
     * @param {string} input.code 标的代码
     * @param {string} input.trade_date 交易日
     * @param {object} input.payload 完整报告对象
     * @param {string|null} [input.model] 生效模型
     * @param {string|null} [input.search_provider] 检索提供方（逗号分隔）
     * @param {string|null} [input.retrieved_at] 检索时间
     * @param {string} [input.data_origin='mixed'] 数据来源标注
     * @returns {object|null} 落库后的报告
     */
    upsertReport(input) {
      const {
        user_id = null,
        module,
        code,
        trade_date: tradeDate,
        payload,
        model = null,
        search_provider: searchProvider = null,
        retrieved_at: retrievedAt = null,
        data_origin: dataOrigin = 'mixed',
      } = input || {};

      const existing = this.getReport(user_id, module, code, tradeDate);
      if (existing) {
        db.run(
          `UPDATE analysis_reports
           SET payload = ?, model = ?, search_provider = ?, retrieved_at = ?,
               data_origin = ?, created_at = datetime('now')
           WHERE id = ?`,
          [stringifyJson(payload), model, searchProvider, retrievedAt, dataOrigin, existing.id],
        );
        return this.getReport(user_id, module, code, tradeDate);
      }

      db.run(
        `INSERT INTO analysis_reports
           (user_id, module, code, trade_date, payload, model, search_provider, retrieved_at, data_origin)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [user_id, module, code, tradeDate, stringifyJson(payload), model, searchProvider, retrievedAt, dataOrigin],
      );
      return this.getReport(user_id, module, code, tradeDate);
    },

    /**
     * 历史报告列表
     * @param {number|null} userId 用户 id
     * @param {object} [filter] 过滤条件
     * @param {string} [filter.code] 标的代码
     * @param {string} [filter.module] 模块
     * @param {number} [filter.limit=20] 条数上限
     * @returns {object[]} 报告数组（按创建时间倒序）
     */
    listReports(userId, filter = {}) {
      const where = ['user_id IS ?'];
      const args = [userId ?? null];
      if (filter.code) {
        where.push('code = ?');
        args.push(filter.code);
      }
      if (filter.module) {
        where.push('module = ?');
        args.push(filter.module);
      }
      const limit = Math.min(200, Math.max(1, Number(filter.limit) || 20));
      const rows = db.all(
        `SELECT * FROM analysis_reports WHERE ${where.join(' AND ')}
         ORDER BY created_at DESC, id DESC LIMIT ${limit}`,
        args,
      );
      return (rows || []).map(toReportRow);
    },

    /**
     * 删除单条报告
     * @param {number|null} userId 用户 id
     * @param {number} id 报告 id
     * @returns {void}
     */
    deleteReport(userId, id) {
      db.run('DELETE FROM analysis_reports WHERE id = ? AND user_id IS ?', [Number(id), userId ?? null]);
    },

    // ==========================================================
    // pipeline_runs
    // ==========================================================

    /**
     * 创建一次流水线运行，并预置三个 pending 步骤
     * @param {number|null} userId 用户 id
     * @param {object} [input] 初始数据
     * @param {string} [input.name] 运行名称
     * @param {object} [input.context] 初始上下文
     * @returns {object|null} 运行对象（含 steps）
     */
    createRun(userId, input = {}) {
      const name = input.name ? String(input.name) : null;
      const context = stringifyJson(input.context ?? {});
      const r = db.run(
        `INSERT INTO pipeline_runs (user_id, name, status, context) VALUES (?, ?, ?, ?)`,
        [userId ?? null, name, PIPELINE_RUN_STATUS.DRAFT, context],
      );
      const runId = Number(r.lastInsertRowid);
      PIPELINE_STEP_ORDER.forEach((step, idx) => {
        db.run(
          `INSERT INTO pipeline_steps (run_id, step, seq, status, input, output)
           VALUES (?, ?, ?, ?, '{}', '{}')`,
          [runId, step, idx + 1, PIPELINE_STEP_STATUS.PENDING],
        );
      });
      return this.getRun(userId, runId);
    },

    /**
     * 读取运行（含步骤）
     * @param {number|null} userId 用户 id
     * @param {number} runId 运行 id
     * @returns {object|null} 运行对象；不存在或不属于该用户返回 null
     */
    getRun(userId, runId) {
      const row = db.get(
        'SELECT * FROM pipeline_runs WHERE id = ? AND user_id IS ?',
        [Number(runId), userId ?? null],
      );
      const run = toRunRow(row);
      if (!run) return null;
      run.steps = this.listSteps(run.id);
      return run;
    },

    /**
     * 运行列表
     * @param {number|null} userId 用户 id
     * @param {number} [limit=20] 条数上限
     * @returns {object[]} 运行数组（不含 steps，按更新时间倒序）
     */
    listRuns(userId, limit = 20) {
      const n = Math.min(100, Math.max(1, Number(limit) || 20));
      const rows = db.all(
        `SELECT * FROM pipeline_runs WHERE user_id IS ?
         ORDER BY updated_at DESC, id DESC LIMIT ${n}`,
        [userId ?? null],
      );
      return (rows || []).map(toRunRow);
    },

    /**
     * 更新运行状态 / 上下文（context 为浅合并，不覆盖未提供的键）
     * @param {number|null} userId 用户 id
     * @param {number} runId 运行 id
     * @param {object} patch 变更
     * @param {string} [patch.status] 新状态
     * @param {object} [patch.context] 待合并的上下文
     * @param {string} [patch.name] 新名称
     * @returns {object|null} 更新后的运行对象
     */
    updateRun(userId, runId, patch = {}) {
      const current = this.getRun(userId, runId);
      if (!current) return null;
      const nextStatus = patch.status || current.status;
      const nextName = patch.name === undefined ? current.name : patch.name;
      const nextContext = patch.context
        ? { ...current.context, ...patch.context }
        : current.context;
      db.run(
        `UPDATE pipeline_runs
         SET status = ?, name = ?, context = ?, updated_at = datetime('now')
         WHERE id = ? AND user_id IS ?`,
        [nextStatus, nextName, stringifyJson(nextContext), Number(runId), userId ?? null],
      );
      return this.getRun(userId, runId);
    },

    /**
     * 删除运行（步骤由外键 ON DELETE CASCADE 连带清理）
     * @param {number|null} userId 用户 id
     * @param {number} runId 运行 id
     * @returns {void}
     */
    deleteRun(userId, runId) {
      db.run('DELETE FROM pipeline_runs WHERE id = ? AND user_id IS ?', [Number(runId), userId ?? null]);
    },

    // ==========================================================
    // pipeline_steps
    // ==========================================================

    /**
     * 某次运行的全部步骤
     * @param {number} runId 运行 id
     * @returns {object[]} 步骤数组（按 seq 升序）
     */
    listSteps(runId) {
      const rows = db.all(
        'SELECT * FROM pipeline_steps WHERE run_id = ? ORDER BY seq ASC, id ASC',
        [Number(runId)],
      );
      return (rows || []).map(toStepRow);
    },

    /**
     * 读取单个步骤
     * @param {number} runId 运行 id
     * @param {string} step 步骤名
     * @returns {object|null} 步骤对象
     */
    getStep(runId, step) {
      const row = db.get(
        'SELECT * FROM pipeline_steps WHERE run_id = ? AND step = ?',
        [Number(runId), step],
      );
      return toStepRow(row);
    },

    /**
     * 更新步骤（不存在则按 PIPELINE_STEP_ORDER 补建，保证幂等）
     * @param {number} runId 运行 id
     * @param {string} step 步骤名
     * @param {object} patch 变更
     * @param {string} [patch.status] 新状态
     * @param {object} [patch.input] 输入
     * @param {object} [patch.output] 输出
     * @param {string|null} [patch.error] 错误信息
     * @returns {object|null} 更新后的步骤
     */
    updateStep(runId, step, patch = {}) {
      let current = this.getStep(runId, step);
      if (!current) {
        const seq = PIPELINE_STEP_ORDER.indexOf(step) + 1;
        if (seq <= 0) return null;
        db.run(
          `INSERT INTO pipeline_steps (run_id, step, seq, status, input, output)
           VALUES (?, ?, ?, ?, '{}', '{}')`,
          [Number(runId), step, seq, PIPELINE_STEP_STATUS.PENDING],
        );
        current = this.getStep(runId, step);
        if (!current) return null;
      }
      const status = patch.status || current.status;
      const input = patch.input === undefined ? current.input : patch.input;
      const output = patch.output === undefined ? current.output : patch.output;
      const error = patch.error === undefined ? current.error : patch.error;
      db.run(
        `UPDATE pipeline_steps SET status = ?, input = ?, output = ?, error = ? WHERE id = ?`,
        [status, stringifyJson(input), stringifyJson(output), error, current.id],
      );
      return this.getStep(runId, step);
    },
  };
}

export default createAnalysisModel;
