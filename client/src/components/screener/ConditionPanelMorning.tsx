// ============================================================
// ConditionPanelMorning：早盘 7 类条件面板（通用筛选 M-01~M-02）
// ============================================================
import { Box, Typography, TextField, FormControlLabel, Checkbox, Button, Chip } from '@mui/material';
import { useState } from 'react';

export interface MorningConditions {
  universe?: { excludeST?: boolean; excludeNew?: boolean; mvRange?: [number, number]; priceRange?: [number, number] };
  prevPctChg?: [number, number];
  volumeRatio?: { min: number };
  turnover?: [number, number];
  auction?: { pct?: [number, number]; volRatio?: { min: number } };
  limitUp?: { minStreak?: number; maxStreak?: number };
  sectors?: string[];
  netInflow3d?: { minWanYuan: number };
}

interface ConditionPanelMorningProps {
  value: MorningConditions;
  onChange: (v: MorningConditions) => void;
  hotSectors: string[];
}

export default function ConditionPanelMorning({ value, onChange, hotSectors }: ConditionPanelMorningProps) {
  const [enabled, setEnabled] = useState<Record<string, boolean>>({
    prevPctChg: true, volumeRatio: true, turnover: true, auction: true, limitUp: false, sectors: false, netInflow3d: true,
  });

  const set = (patch: Partial<MorningConditions>) => onChange({ ...value, ...patch });
  const num = (v: string) => (v === '' ? undefined : Number(v));

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
      <Box>
        <Typography variant="subtitle2">通用过滤</Typography>
        <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', alignItems: 'center' }}>
          <FormControlLabel
            control={<Checkbox size="small" checked={value.universe?.excludeST ?? true} onChange={(e) => set({ universe: { ...value.universe, excludeST: e.target.checked } })} />}
            label={<Typography variant="caption">排除 ST</Typography>}
          />
          <FormControlLabel
            control={<Checkbox size="small" checked={value.universe?.excludeNew ?? true} onChange={(e) => set({ universe: { ...value.universe, excludeNew: e.target.checked } })} />}
            label={<Typography variant="caption">排除次新股(&lt;60日)</Typography>}
          />
        </Box>
      </Box>

      <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1.5 }}>
        <FormControlLabel
          control={<Checkbox size="small" checked={enabled.prevPctChg} onChange={(e) => setEnabled((s) => ({ ...s, prevPctChg: e.target.checked }))} />}
          label={<Typography variant="caption">昨日涨跌幅</Typography>}
        />
        {enabled.prevPctChg && (
          <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
            <TextField size="small" label="下限%" type="number" defaultValue={-3} onChange={(e) => set({ prevPctChg: [num(e.target.value) ?? -3, value.prevPctChg?.[1] ?? 7] })} />
            <span>~</span>
            <TextField size="small" label="上限%" type="number" defaultValue={7} onChange={(e) => set({ prevPctChg: [value.prevPctChg?.[0] ?? -3, num(e.target.value) ?? 7] })} />
          </Box>
        )}

        <FormControlLabel
          control={<Checkbox size="small" checked={enabled.volumeRatio} onChange={(e) => setEnabled((s) => ({ ...s, volumeRatio: e.target.checked }))} />}
          label={<Typography variant="caption">量比 ≥</Typography>}
        />
        {enabled.volumeRatio && (
          <TextField size="small" label="量比" type="number" defaultValue={1.5} onChange={(e) => set({ volumeRatio: { min: num(e.target.value) ?? 1.5 } })} />
        )}

        <FormControlLabel
          control={<Checkbox size="small" checked={enabled.turnover} onChange={(e) => setEnabled((s) => ({ ...s, turnover: e.target.checked }))} />}
          label={<Typography variant="caption">换手率区间</Typography>}
        />
        {enabled.turnover && (
          <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
            <TextField size="small" label="下限%" type="number" defaultValue={3} onChange={(e) => set({ turnover: [num(e.target.value) ?? 3, value.turnover?.[1] ?? 15] })} />
            <span>~</span>
            <TextField size="small" label="上限%" type="number" defaultValue={15} onChange={(e) => set({ turnover: [value.turnover?.[0] ?? 3, num(e.target.value) ?? 15] })} />
          </Box>
        )}

        <FormControlLabel
          control={<Checkbox size="small" checked={enabled.auction} onChange={(e) => setEnabled((s) => ({ ...s, auction: e.target.checked }))} />}
          label={<Typography variant="caption">竞价涨幅区间</Typography>}
        />
        {enabled.auction && (
          <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
            <TextField size="small" label="下限%" type="number" defaultValue={0} onChange={(e) => set({ auction: { ...value.auction, pct: [num(e.target.value) ?? 0, value.auction?.pct?.[1] ?? 5] } })} />
            <span>~</span>
            <TextField size="small" label="上限%" type="number" defaultValue={5} onChange={(e) => set({ auction: { ...value.auction, pct: [value.auction?.pct?.[0] ?? 0, num(e.target.value) ?? 5] } })} />
          </Box>
        )}

        <FormControlLabel
          control={<Checkbox size="small" checked={enabled.limitUp} onChange={(e) => setEnabled((s) => ({ ...s, limitUp: e.target.checked }))} />}
          label={<Typography variant="caption">连板数</Typography>}
        />
        {enabled.limitUp && (
          <TextField size="small" label="最少连板" type="number" defaultValue={1} onChange={(e) => set({ limitUp: { minStreak: num(e.target.value) ?? 1, maxStreak: 0 } })} />
        )}

        <FormControlLabel
          control={<Checkbox size="small" checked={enabled.sectors} onChange={(e) => setEnabled((s) => ({ ...s, sectors: e.target.checked }))} />}
          label={<Typography variant="caption">热点板块</Typography>}
        />
        {enabled.sectors && (
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
            {hotSectors.slice(0, 10).map((s) => (
              <Chip
                key={s}
                label={s}
                size="small"
                variant={value.sectors?.includes(s) ? 'filled' : 'outlined'}
                color={value.sectors?.includes(s) ? 'primary' : 'default'}
                onClick={() => {
                  const cur = value.sectors || [];
                  set({ sectors: cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s] });
                }}
              />
            ))}
          </Box>
        )}

        <FormControlLabel
          control={<Checkbox size="small" checked={enabled.netInflow3d} onChange={(e) => setEnabled((s) => ({ ...s, netInflow3d: e.target.checked }))} />}
          label={<Typography variant="caption">3日主力净流入 ≥</Typography>}
        />
        {enabled.netInflow3d && (
          <TextField size="small" label="万元" type="number" defaultValue={3000} onChange={(e) => set({ netInflow3d: { minWanYuan: num(e.target.value) ?? 3000 } })} />
        )}
      </Box>

      <Button size="small" variant="outlined" onClick={() => onChange({ universe: { excludeST: true, excludeNew: true } })}>
        重置条件
      </Button>
    </Box>
  );
}
