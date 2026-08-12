// ============================================================
// 智能分析中心格式化工具
// ============================================================

/** ISO 时间 → "YYYY-MM-DD HH:mm"；空值显示 — */
export function fmtDate(iso?: string | null): string {
  if (!iso) return '—';
  return iso.slice(0, 16).replace('T', ' ');
}

/** 买卖信号 → 中文 */
export function actionLabel(action: string): string {
  if (action === 'buy') return '买入';
  if (action === 'sell') return '卖出';
  return '观望';
}

/** 流水线步骤 → 中文带序号 */
export function stepLabel(step: string): string {
  if (step === 'select') return '① 选股';
  if (step === 'timing') return '② 择时';
  if (step === 'backtest') return '③ 回测';
  return step;
}

/** 步骤状态 → 中文 */
export function stepStatusLabel(status: string): string {
  const map: Record<string, string> = {
    done: '已完成',
    running: '进行中',
    failed: '失败',
    skipped: '已跳过',
    pending: '待执行',
  };
  return map[status] || status;
}
