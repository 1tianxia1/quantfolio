// ============================================================
// PipelinePanel：投研流水线面板（①选股 → ②择时 → ③回测）
// 前序步骤产出自动作为后序输入；选股支持手动 code 与 AI 自主选股（板块）。
// ============================================================
import { useEffect, useMemo, useState } from 'react';
import {
  Alert, Box, Button, Chip, MenuItem, Stack, Step, StepLabel, Stepper, TextField, Typography,
} from '@mui/material';
import { useAnalysisStore } from '../../store/analysisStore';
import StepContextCard from './StepContextCard';
import SignalBadge from './SignalBadge';
import { fmtDate } from '../../utils/analysisFormat';

interface Candidate {
  code: string;
  name: string;
  style: string;
  reason: string;
}

interface TimingOutput {
  strategy: string;
  implemented: boolean;
  action?: string;
  strength?: number;
  reasons?: string[];
  entry_advice?: string;
  exit_advice?: string;
  key_levels?: { price: number | null; ref_stop: number | null; ref_target: number | null };
  risk_notes?: string[];
  message?: string;
}

export default function PipelinePanel() {
  const { run, loading, error, createRun, select, timing, backtest } = useAnalysisStore();
  const [sector, setSector] = useState('');
  const [manualCode, setManualCode] = useState('');
  const [style, setStyle] = useState<'value' | 'trend'>('trend');
  const [target, setTarget] = useState<{ code: string; name: string } | null>(null);

  const stepOf = (name: string) => run?.steps.find((s) => s.step === name) || null;
  const selectStep = stepOf('select');
  const timingStep = stepOf('timing');
  const backtestStep = stepOf('backtest');

  // activeStep = 第一个未完成步骤的下标
  const activeStep = useMemo(() => {
    const order = ['select', 'timing', 'backtest'];
    const idx = order.findIndex((s) => {
      const st = stepOf(s);
      return !st || st.status !== 'done';
    });
    return idx === -1 ? 3 : idx;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run]);

  const candidates = (selectStep?.output?.candidates as Candidate[]) || [];
  const timingOut = timingStep?.output as TimingOutput | undefined;
  const selectTarget = selectStep?.output?.target as Candidate | undefined;

  // 手动确认的 target 直接作为后续标的；AI 候选需用户点击确认
  useEffect(() => {
    if (selectTarget) setTarget({ code: selectTarget.code, name: selectTarget.name });
  }, [selectTarget]);

  if (!run) {
    return (
      <Box sx={{ textAlign: 'center', py: 3 }}>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
          开启一条投研流水线：选股 → 择时 → 回测，前序结论自动作为后序输入。
        </Typography>
        <Button variant="contained" onClick={() => createRun()} disabled={loading}>
          {loading ? '创建中…' : '开始流水线'}
        </Button>
      </Box>
    );
  }

  return (
    <Box>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1.5, flexWrap: 'wrap' }}>
        <Typography variant="body2" color="text.secondary">
          流水线 #{run.id} · {run.name} · 更新于 {fmtDate(run.updated_at)}
        </Typography>
        <Button size="small" color="inherit" onClick={() => useAnalysisStore.getState().reset()}>
          重开
        </Button>
      </Stack>

      {error && <Alert severity="warning" sx={{ mb: 1.5 }}>{error.message}</Alert>}

      <Stepper activeStep={activeStep} alternativeLabel sx={{ mb: 2 }}>
        <Step completed={!!selectStep && selectStep.status === 'done'}>
          <StepLabel>① 选股</StepLabel>
        </Step>
        <Step completed={!!timingStep && timingStep.status === 'done'}>
          <StepLabel>② 择时</StepLabel>
        </Step>
        <Step completed={!!backtestStep && backtestStep.status === 'done'}>
          <StepLabel>③ 回测</StepLabel>
        </Step>
      </Stepper>

      {/* ① 选股 */}
      <StepContextCard step="select" status={selectStep?.status || 'pending'} error={selectStep?.error}>
        {!selectStep || selectStep.status !== 'done' ? (
          <Stack spacing={1.5}>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems="center">
              <TextField
                size="small"
                label="板块（AI 自主选股）"
                placeholder="如：铜 / 半导体 / 红利"
                value={sector}
                onChange={(e) => setSector(e.target.value)}
                sx={{ maxWidth: { sm: 210 } }}
              />
              <Typography variant="caption" color="text.secondary">或</Typography>
              <TextField
                size="small"
                label="直接输入代码"
                placeholder="600009 / 000878"
                value={manualCode}
                onChange={(e) => setManualCode(e.target.value)}
                sx={{ maxWidth: { sm: 180 } }}
              />
              <TextField
                select
                size="small"
                label="风格"
                value={style}
                onChange={(e) => setStyle(e.target.value as 'value' | 'trend')}
                sx={{ minWidth: 112 }}
              >
                <MenuItem value="trend">趋势投资</MenuItem>
                <MenuItem value="value">价值投资</MenuItem>
              </TextField>
              <Button
                variant="contained"
                disabled={loading}
                onClick={() => {
                  const c = manualCode.trim();
                  const s = sector.trim();
                  if (c) select({ code: c, style });
                  else if (s) select({ sector: s, style });
                }}
              >
                {loading ? '分析中…' : '选股'}
              </Button>
            </Stack>
            <Typography variant="caption" color="text.secondary">
              AI 自主选股：输入板块后由 AI 联网检索选出龙头/潜力股；也可手动输代码直接确认标的。
            </Typography>
          </Stack>
        ) : selectTarget ? (
          <Stack direction="row" spacing={1} alignItems="center" sx={{ flexWrap: 'wrap' }}>
            <Chip label={`已选标的：${selectTarget.name}（${selectTarget.code}）`} color="primary" variant="outlined" />
            <Typography variant="caption" color="text.secondary">来自手动指定</Typography>
          </Stack>
        ) : (
          <Box>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
              AI 候选（点击「确认」作为后续择时标的）：
            </Typography>
            <Stack spacing={0.75}>
              {candidates.map((c, i) => (
                <Stack key={i} direction="row" spacing={1} alignItems="center" sx={{ flexWrap: 'wrap' }}>
                  <Chip
                    size="small"
                    label={c.style}
                    color={c.style === '龙头' ? 'primary' : 'secondary'}
                    variant="outlined"
                  />
                  <Typography variant="body2" sx={{ fontWeight: 600 }}>
                    {c.name}（{c.code}）
                  </Typography>
                  <Typography variant="caption" color="text.secondary" sx={{ flex: 1, minWidth: 120 }}>
                    {c.reason}
                  </Typography>
                  <Button size="small" variant="outlined" disabled={loading} onClick={() => setTarget({ code: c.code, name: c.name })}>
                    确认
                  </Button>
                </Stack>
              ))}
            </Stack>
          </Box>
        )}
      </StepContextCard>

      {/* ② 择时 */}
      <StepContextCard step="timing" status={timingStep?.status || 'pending'} error={timingStep?.error}>
        {target ? (
          <Stack spacing={1}>
            <Stack direction="row" spacing={1} alignItems="center" sx={{ flexWrap: 'wrap' }}>
              <Chip label={`择时标的：${target.name}（${target.code}）`} color="primary" variant="outlined" />
              <Button
                size="small"
                variant="contained"
                disabled={loading}
                onClick={() => timing({ code: target.code, strategy: 'signal_follow' })}
              >
                {loading ? '分析中…' : '分析择时信号'}
              </Button>
            </Stack>
            {timingOut?.implemented ? (
              <Box>
                <Stack direction="row" spacing={1} alignItems="center" sx={{ flexWrap: 'wrap', mt: 0.5 }}>
                  <SignalBadge action={timingOut.action || 'hold'} strength={timingOut.strength ?? 0} />
                  <Typography variant="caption" color="text.secondary">策略 signal_follow</Typography>
                </Stack>
                {timingOut.entry_advice && (
                  <Typography variant="body2" sx={{ mt: 0.5 }}>
                    买入择时：{timingOut.entry_advice}
                  </Typography>
                )}
                {timingOut.exit_advice && (
                  <Typography variant="body2" sx={{ mt: 0.5 }}>
                    卖出择时：{timingOut.exit_advice}
                  </Typography>
                )}
                {timingOut.key_levels?.ref_stop != null && (
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                    参考止损 {timingOut.key_levels.ref_stop} · 参考止盈 {timingOut.key_levels.ref_target ?? '—'} · 现价{' '}
                    {timingOut.key_levels.price}
                  </Typography>
                )}
                {timingOut.risk_notes && timingOut.risk_notes.length > 0 && (
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                    {timingOut.risk_notes.join(' ')}
                  </Typography>
                )}
              </Box>
            ) : timingOut ? (
              <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                {timingOut.message}
              </Typography>
            ) : null}
          </Stack>
        ) : (
          <Typography variant="body2" color="text.secondary">
            请先在「① 选股」确认标的。
          </Typography>
        )}
      </StepContextCard>

      {/* ③ 回测 */}
      <StepContextCard step="backtest" status={backtestStep?.status || 'pending'} error={backtestStep?.error}>
        <Stack spacing={1}>
          <Button
            size="small"
            variant="outlined"
            disabled={loading || !target}
            onClick={() => target && backtest({ code: target.code })}
          >
            {loading ? '运行中…' : '运行回测（P2）'}
          </Button>
          {!!backtestStep?.output?.message && (
            <Typography variant="body2" color="text.secondary">{String(backtestStep.output.message)}</Typography>
          )}
        </Stack>
      </StepContextCard>
    </Box>
  );
}
