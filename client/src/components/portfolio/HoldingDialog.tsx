// ============================================================
// HoldingDialog：添加/编辑持仓弹窗（代码搜索带出）
// ============================================================
import { useEffect, useState } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, Button, TextField, MenuItem, Box,
  Autocomplete, CircularProgress,
} from '@mui/material';
import { marketApi, SearchItem } from '../../api/market';
import { ASSET_CLASS, ASSET_CLASS_LABEL } from '@shared/constants';
import { useDebounce } from '../../hooks/useDebounce';
import type { Holding } from '../../api/portfolio';

interface HoldingDialogProps {
  open: boolean;
  initial?: Holding | null;
  onClose: () => void;
  onSave: (data: { code?: string | null; name: string; asset_class: string; quantity: number; cost_price: number }) => Promise<void>;
}

const ASSET_OPTIONS = Object.values(ASSET_CLASS);

export default function HoldingDialog({ open, initial, onClose, onSave }: HoldingDialogProps) {
  const [code, setCode] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [assetClass, setAssetClass] = useState<string>('stock');
  const [quantity, setQuantity] = useState<string>('');
  const [costPrice, setCostPrice] = useState<string>('');
  const [searchResults, setSearchResults] = useState<SearchItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [saving, setSaving] = useState(false);
  const searchQ = useDebounce(code || '', 300);

  useEffect(() => {
    if (open) {
      setCode(initial?.code ?? null);
      setName(initial?.name ?? '');
      setAssetClass(initial?.asset_class ?? 'stock');
      setQuantity(initial && initial.asset_class !== 'cash' ? String(initial.quantity) : initial?.asset_class === 'cash' ? String(initial.quantity) : '');
      setCostPrice(initial && initial.asset_class !== 'cash' ? String(initial.cost_price) : '');
      setSearchResults([]);
    }
  }, [open, initial]);

  // 代码搜索
  useEffect(() => {
    if (!searchQ || searchQ.length < 2 || assetClass === 'cash') {
      setSearchResults([]);
      return;
    }
    let cancelled = false;
    setSearching(true);
    marketApi
      .search(searchQ, 8)
      .then((r) => { if (!cancelled) setSearchResults(r); })
      .catch(() => undefined)
      .finally(() => { if (!cancelled) setSearching(false); });
    return () => { cancelled = true; };
  }, [searchQ, assetClass]);

  const handlePick = (item: SearchItem) => {
    setCode(item.code);
    setName(item.name);
  };

  const handleSave = async () => {
    const qty = Number(quantity);
    const price = Number(costPrice);
    if (assetClass === 'cash') {
      if (!qty || qty <= 0) return;
    } else if (!code || !name || !qty || qty <= 0 || price < 0) {
      return;
    }
    setSaving(true);
    try {
      await onSave({
        code: assetClass === 'cash' ? null : code,
        name: assetClass === 'cash' ? '现金' : name,
        asset_class: assetClass,
        quantity: qty,
        cost_price: assetClass === 'cash' ? 1 : price,
      });
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{initial ? '编辑持仓' : '添加持仓'}</DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: 2 }}>
        <TextField select label="资产类别" value={assetClass} onChange={(e) => setAssetClass(e.target.value)} size="small">
          {ASSET_OPTIONS.map((a) => (
            <MenuItem key={a} value={a}>{ASSET_CLASS_LABEL[a]}</MenuItem>
          ))}
        </TextField>

        {assetClass === 'cash' ? (
          <TextField
            label="现金金额（元）"
            type="number"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            size="small"
            helperText="现金行直接录入金额"
          />
        ) : (
          <>
            <Autocomplete
              freeSolo
              options={searchResults}
              getOptionLabel={(o) => (typeof o === 'string' ? o : `${o.code} ${o.name}`)}
              inputValue={code || ''}
              onInputChange={(_e, v) => setCode(v)}
              onChange={(_e, v) => { if (v && typeof v !== 'string') handlePick(v); }}
              renderInput={(params) => (
                <TextField
                  {...params}
                  label="证券代码"
                  size="small"
                  placeholder="输入代码或名称搜索"
                  InputProps={{
                    ...params.InputProps,
                    endAdornment: (
                      <>
                        {searching && <CircularProgress size={16} />}
                        {params.InputProps.endAdornment}
                      </>
                    ),
                  }}
                />
              )}
            />
            <TextField label="证券名称" value={name} onChange={(e) => setName(e.target.value)} size="small" />
            <Box sx={{ display: 'flex', gap: 2 }}>
              <TextField
                label="持仓数量（股/份）"
                type="number"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                size="small"
                fullWidth
              />
              {/* step="any" + 4 位小数提示：券商展示的成本价只有 2~3 位，
                  用展示值算出的盈亏会和券商对不上（如 5.966 vs 真实 5.9662），
                  这里必须允许录入 4 位小数，否则精度在入口就被卡掉 */}
              <TextField
                label="成本价（元）"
                type="number"
                value={costPrice}
                onChange={(e) => setCostPrice(e.target.value)}
                size="small"
                fullWidth
                inputProps={{ step: 'any' }}
                helperText="支持 4 位小数，与券商盈亏对齐"
              />
            </Box>
          </>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>取消</Button>
        <Button onClick={handleSave} variant="contained" disabled={saving}>
          {saving ? '保存中…' : '保存'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
