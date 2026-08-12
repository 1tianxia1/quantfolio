// ============================================================
// HoldingsFilter：持仓明细多条件搜索/筛选栏
// ============================================================
import { Box, TextField, MenuItem, Button, Stack } from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import { ASSET_CLASS_LABEL } from '@shared/constants';
import type { Holding } from '../../api/portfolio';

export interface HoldingsFilters {
  keyword: string;
  asset_class: 'all' | Holding['asset_class'];
  profit_status: 'all' | 'profit' | 'loss' | 'flat';
  day_profit_status: 'all' | 'profit' | 'loss' | 'flat';
}

interface HoldingsFilterProps {
  filters: HoldingsFilters;
  onChange: (filters: HoldingsFilters) => void;
}

const ASSET_CLASS_OPTIONS: { value: 'all' | Holding['asset_class']; label: string }[] = [
  { value: 'all', label: '全部类别' },
  { value: 'stock', label: ASSET_CLASS_LABEL.stock },
  { value: 'fund', label: ASSET_CLASS_LABEL.fund },
  { value: 'bond', label: ASSET_CLASS_LABEL.bond },
  { value: 'cash', label: ASSET_CLASS_LABEL.cash },
  { value: 'other', label: ASSET_CLASS_LABEL.other },
];

const STATUS_OPTIONS: { value: 'all' | 'profit' | 'loss' | 'flat'; label: string }[] = [
  { value: 'all', label: '全部盈亏' },
  { value: 'profit', label: '盈利' },
  { value: 'loss', label: '亏损' },
  { value: 'flat', label: '持平' },
];

export const DEFAULT_FILTERS: HoldingsFilters = {
  keyword: '',
  asset_class: 'all',
  profit_status: 'all',
  day_profit_status: 'all',
};

export function matchesFilters(h: Holding, f: HoldingsFilters): boolean {
  // 1) 关键字：代码或名称包含即可（不区分大小写）
  const kw = f.keyword.trim();
  if (kw) {
    const lower = kw.toLowerCase();
    const codeMatch = (h.code || '').toLowerCase().includes(lower);
    const nameMatch = (h.name || '').toLowerCase().includes(lower);
    if (!codeMatch && !nameMatch) return false;
  }

  // 2) 类别
  if (f.asset_class !== 'all' && h.asset_class !== f.asset_class) return false;

  // 3) 累计盈亏状态
  if (f.profit_status !== 'all') {
    if (h.asset_class === 'cash') return false;
    const p = h.profit ?? 0;
    if (f.profit_status === 'profit' && p <= 0) return false;
    if (f.profit_status === 'loss' && p >= 0) return false;
    if (f.profit_status === 'flat' && p !== 0) return false;
  }

  // 4) 当日盈亏状态
  if (f.day_profit_status !== 'all') {
    if (h.asset_class === 'cash') return false;
    const dp = h.day_profit ?? 0;
    if (f.day_profit_status === 'profit' && dp <= 0) return false;
    if (f.day_profit_status === 'loss' && dp >= 0) return false;
    if (f.day_profit_status === 'flat' && dp !== 0) return false;
  }

  return true;
}

export default function HoldingsFilter({ filters, onChange }: HoldingsFilterProps) {
  const update = (patch: Partial<HoldingsFilters>) => onChange({ ...filters, ...patch });

  return (
    <Box sx={{ mb: 1.5 }}>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} alignItems="center">
        <TextField
          size="small"
          placeholder="搜索代码 / 名称"
          value={filters.keyword}
          onChange={(e) => update({ keyword: e.target.value })}
          InputProps={{ startAdornment: <SearchIcon fontSize="small" sx={{ mr: 0.5, color: 'text.secondary' }} /> }}
          sx={{ minWidth: 180, flex: 1 }}
        />
        <TextField
          select
          size="small"
          label="类别"
          value={filters.asset_class}
          onChange={(e) => update({ asset_class: e.target.value as HoldingsFilters['asset_class'] })}
          sx={{ minWidth: 120 }}
        >
          {ASSET_CLASS_OPTIONS.map((o) => (
            <MenuItem key={o.value} value={o.value}>{o.label}</MenuItem>
          ))}
        </TextField>
        <TextField
          select
          size="small"
          label="累计盈亏"
          value={filters.profit_status}
          onChange={(e) => update({ profit_status: e.target.value as HoldingsFilters['profit_status'] })}
          sx={{ minWidth: 120 }}
        >
          {STATUS_OPTIONS.map((o) => (
            <MenuItem key={o.value} value={o.value}>{o.label}</MenuItem>
          ))}
        </TextField>
        <TextField
          select
          size="small"
          label="当日盈亏"
          value={filters.day_profit_status}
          onChange={(e) => update({ day_profit_status: e.target.value as HoldingsFilters['day_profit_status'] })}
          sx={{ minWidth: 120 }}
        >
          {STATUS_OPTIONS.map((o) => (
            <MenuItem key={o.value} value={o.value}>{o.label}</MenuItem>
          ))}
        </TextField>
        <Button
          size="small"
          variant="outlined"
          startIcon={<RestartAltIcon />}
          onClick={() => onChange(DEFAULT_FILTERS)}
          sx={{ whiteSpace: 'nowrap' }}
        >
          重置
        </Button>
      </Stack>
    </Box>
  );
}
