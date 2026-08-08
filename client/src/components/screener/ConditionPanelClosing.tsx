// ============================================================
// ConditionPanelClosing：尾盘指标面板（趋势/动能/量能/估值分组）
// ============================================================
import { Box, Typography, TextField, MenuItem, FormControlLabel, Checkbox, Button } from '@mui/material';
import { useState } from 'react';

export interface ClosingConditions {
  universe?: { excludeST: boolean; excludeNew: boolean; types?: string[] };
  macd?: { status?: string };
  ma?: { pattern?: string };
  rsi?: { period?: number; range?: [number, number]; preset?: string };
  kdj?: { status?: string };
  volRatio5?: { min?: number; max?: number };
  turnover?: [number, number];
  pe?: { range?: [number, number]; excludeNegative?: boolean };
  mv?: { range?: [number, number] };
  pctChg?: [number, number];
}

interface ConditionPanelClosingProps {
  value: ClosingConditions;
  onChange: (v: ClosingConditions) => void;
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Box sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 1.5, p: 1.5, mb: 1.5 }}>
      <Typography variant="subtitle2" sx={{ mb: 1, color: 'primary.main' }}>{title}</Typography>
      {children}
    </Box>
  );
}

export default function ConditionPanelClosing({ value, onChange }: ConditionPanelClosingProps) {
  const [enabled, setEnabled] = useState<Record<string, boolean>>({
    macd: false, ma: true, rsi: false, kdj: false, volRatio5: true, turnover: false, pe: false, mv: true, pctChg: false,
  });

  const set = (patch: Partial<ClosingConditions>) => onChange({ ...value, ...patch });
  const num = (v: string) => (v === '' ? undefined : Number(v));

  return (
    <Box>
      <Group title="趋势类">
        <FormControlLabel
          control={<Checkbox size="small" checked={enabled.macd} onChange={(e) => setEnabled((s) => ({ ...s, macd: e.target.checked }))} />}
          label={<Typography variant="caption">MACD</Typography>}
        />
        {enabled.macd && (
          <TextField select size="small" value={value.macd?.status || 'gold_cross'} onChange={(e) => set({ macd: { status: e.target.value } })} sx={{ ml: 2, width: 160 }}>
            <MenuItem value="gold_cross">金叉</MenuItem>
            <MenuItem value="dead_cross">死叉</MenuItem>
            <MenuItem value="dif_positive">DIF &gt; 0</MenuItem>
            <MenuItem value="hist_turn_positive">柱由负转正</MenuItem>
          </TextField>
        )}
        <Box sx={{ mt: 1 }}>
          <FormControlLabel
            control={<Checkbox size="small" checked={enabled.ma} onChange={(e) => setEnabled((s) => ({ ...s, ma: e.target.checked }))} />}
            label={<Typography variant="caption">均线</Typography>}
          />
          {enabled.ma && (
            <TextField select size="small" value={value.ma?.pattern || 'bullish'} onChange={(e) => set({ ma: { pattern: e.target.value } })} sx={{ ml: 2, width: 160 }}>
              <MenuItem value="bullish">多头排列</MenuItem>
              <MenuItem value="bearish">空头排列</MenuItem>
              <MenuItem value="above_20">站上 MA20</MenuItem>
              <MenuItem value="cross_above_5">上穿 MA5</MenuItem>
            </TextField>
          )}
        </Box>
      </Group>

      <Group title="动能类">
        <FormControlLabel
          control={<Checkbox size="small" checked={enabled.rsi} onChange={(e) => setEnabled((s) => ({ ...s, rsi: e.target.checked }))} />}
          label={<Typography variant="caption">RSI</Typography>}
        />
        {enabled.rsi && (
          <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', ml: 2, mt: 0.5 }}>
            <TextField select size="small" value={String(value.rsi?.period || 12)} onChange={(e) => set({ rsi: { ...value.rsi, period: Number(e.target.value) } })} sx={{ width: 90 }}>
              <MenuItem value="6">RSI6</MenuItem>
              <MenuItem value="12">RSI12</MenuItem>
              <MenuItem value="24">RSI24</MenuItem>
            </TextField>
            <TextField select size="small" value={value.rsi?.preset || 'normal'} onChange={(e) => set({ rsi: { ...value.rsi, preset: e.target.value } })} sx={{ width: 110 }}>
              <MenuItem value="oversold">超卖(&lt;30)</MenuItem>
              <MenuItem value="normal">正常(30~70)</MenuItem>
              <MenuItem value="overbought">超买(&gt;70)</MenuItem>
            </TextField>
          </Box>
        )}
        <Box sx={{ mt: 1 }}>
          <FormControlLabel
            control={<Checkbox size="small" checked={enabled.kdj} onChange={(e) => setEnabled((s) => ({ ...s, kdj: e.target.checked }))} />}
            label={<Typography variant="caption">KDJ</Typography>}
          />
          {enabled.kdj && (
            <TextField select size="small" value={value.kdj?.status || 'gold_cross'} onChange={(e) => set({ kdj: { status: e.target.value } })} sx={{ ml: 2, width: 160 }}>
              <MenuItem value="gold_cross">金叉</MenuItem>
              <MenuItem value="dead_cross">死叉</MenuItem>
              <MenuItem value="j_oversold">J&lt;0 超卖</MenuItem>
              <MenuItem value="j_overbought">J&gt;100 超买</MenuItem>
            </TextField>
          )}
        </Box>
      </Group>

      <Group title="量能类">
        <FormControlLabel
          control={<Checkbox size="small" checked={enabled.volRatio5} onChange={(e) => setEnabled((s) => ({ ...s, volRatio5: e.target.checked }))} />}
          label={<Typography variant="caption">放量倍数 ≥</Typography>}
        />
        {enabled.volRatio5 && (
          <TextField size="small" type="number" defaultValue={1.5} onChange={(e) => set({ volRatio5: { min: num(e.target.value) ?? 1.5 } })} sx={{ ml: 2, width: 110 }} />
        )}
        <Box sx={{ mt: 1 }}>
          <FormControlLabel
            control={<Checkbox size="small" checked={enabled.turnover} onChange={(e) => setEnabled((s) => ({ ...s, turnover: e.target.checked }))} />}
            label={<Typography variant="caption">换手率区间</Typography>}
          />
          {enabled.turnover && (
            <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', ml: 2, mt: 0.5 }}>
              <TextField size="small" type="number" defaultValue={2} onChange={(e) => set({ turnover: [num(e.target.value) ?? 2, value.turnover?.[1] ?? 12] })} sx={{ width: 80 }} />
              <span>~</span>
              <TextField size="small" type="number" defaultValue={12} onChange={(e) => set({ turnover: [value.turnover?.[0] ?? 2, num(e.target.value) ?? 12] })} sx={{ width: 80 }} />
            </Box>
          )}
        </Box>
      </Group>

      <Group title="估值 / 规模">
        <FormControlLabel
          control={<Checkbox size="small" checked={enabled.pe} onChange={(e) => setEnabled((s) => ({ ...s, pe: e.target.checked }))} />}
          label={<Typography variant="caption">PE(TTM)</Typography>}
        />
        {enabled.pe && (
          <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', ml: 2, mt: 0.5 }}>
            <TextField size="small" type="number" defaultValue={5} onChange={(e) => set({ pe: { ...value.pe, range: [num(e.target.value) ?? 5, value.pe?.range?.[1] ?? 30] } })} sx={{ width: 80 }} />
            <span>~</span>
            <TextField size="small" type="number" defaultValue={30} onChange={(e) => set({ pe: { ...value.pe, range: [value.pe?.range?.[0] ?? 5, num(e.target.value) ?? 30] } })} sx={{ width: 80 }} />
            <FormControlLabel
              control={<Checkbox size="small" checked={value.pe?.excludeNegative ?? true} onChange={(e) => set({ pe: { ...value.pe, excludeNegative: e.target.checked } })} />}
              label={<Typography variant="caption">剔除负PE</Typography>}
            />
          </Box>
        )}
        <Box sx={{ mt: 1 }}>
          <FormControlLabel
            control={<Checkbox size="small" checked={enabled.mv} onChange={(e) => setEnabled((s) => ({ ...s, mv: e.target.checked }))} />}
            label={<Typography variant="caption">流通市值区间(亿)</Typography>}
          />
          {enabled.mv && (
            <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', ml: 2, mt: 0.5 }}>
              <TextField size="small" type="number" defaultValue={50} onChange={(e) => set({ mv: { range: [num(e.target.value) ?? 50, value.mv?.range?.[1] ?? 5000] } })} sx={{ width: 90 }} />
              <span>~</span>
              <TextField size="small" type="number" defaultValue={5000} onChange={(e) => set({ mv: { range: [value.mv?.range?.[0] ?? 50, num(e.target.value) ?? 5000] } })} sx={{ width: 90 }} />
            </Box>
          )}
        </Box>
        <Box sx={{ mt: 1 }}>
          <FormControlLabel
            control={<Checkbox size="small" checked={enabled.pctChg} onChange={(e) => setEnabled((s) => ({ ...s, pctChg: e.target.checked }))} />}
            label={<Typography variant="caption">当日涨跌幅区间</Typography>}
          />
          {enabled.pctChg && (
            <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', ml: 2, mt: 0.5 }}>
              <TextField size="small" type="number" defaultValue={-2} onChange={(e) => set({ pctChg: [num(e.target.value) ?? -2, value.pctChg?.[1] ?? 7] })} sx={{ width: 80 }} />
              <span>~</span>
              <TextField size="small" type="number" defaultValue={7} onChange={(e) => set({ pctChg: [value.pctChg?.[0] ?? -2, num(e.target.value) ?? 7] })} sx={{ width: 80 }} />
            </Box>
          )}
        </Box>
      </Group>

      <Button size="small" variant="outlined" fullWidth onClick={() => onChange({ universe: { excludeST: true, excludeNew: true, types: ['stock'] } })}>
        重置条件
      </Button>
    </Box>
  );
}
