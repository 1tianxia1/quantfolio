// ============================================================
// TargetDialog：目标配置弹窗（Σ=100 校验）
// ============================================================
import { useEffect, useState } from 'react';
import { Dialog, DialogTitle, DialogContent, DialogActions, Button, TextField, MenuItem, Box, Typography, IconButton } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/Delete';
import { useSnackbar } from '../common/SnackbarProvider';

interface TargetRow {
  target_key: string;
  target_pct: string;
}

interface TargetDialogProps {
  open: boolean;
  dimension: string;
  items: { target_key: string; target_pct: number }[];
  onClose: () => void;
  onSave: (dimension: string, items: { target_key: string; target_pct: number }[]) => Promise<void>;
}

const DIMENSION_LABEL: Record<string, string> = {
  asset_class: '资产类别',
  industry: '行业',
  code: '个股',
};

export default function TargetDialog({ open, dimension, items, onClose, onSave }: TargetDialogProps) {
  const [rows, setRows] = useState<TargetRow[]>([]);
  const [saving, setSaving] = useState(false);
  const snackbar = useSnackbar();

  useEffect(() => {
    if (open) {
      setRows(
        items.length
          ? items.map((i) => ({ target_key: i.target_key, target_pct: String(i.target_pct) }))
          : [{ target_key: '', target_pct: '' }],
      );
    }
  }, [open, items]);

  const total = rows.reduce((s, r) => s + (Number(r.target_pct) || 0), 0);

  const handleSave = async () => {
    const parsed = rows
      .filter((r) => r.target_key.trim())
      .map((r) => ({ target_key: r.target_key.trim(), target_pct: Number(r.target_pct) || 0 }));
    if (!parsed.length) {
      snackbar.show('至少填写一项目标配置', 'warning');
      return;
    }
    const sum = parsed.reduce((s, p) => s + p.target_pct, 0);
    if (Math.abs(sum - 100) > 0.01) {
      snackbar.show(`目标配置 Σ 必须 = 100（当前 ${sum.toFixed(2)}）`, 'error');
      return;
    }
    setSaving(true);
    try {
      await onSave(dimension, parsed);
      snackbar.show('目标配置已保存', 'success');
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>目标配置（{DIMENSION_LABEL[dimension] || dimension}）</DialogTitle>
      <DialogContent>
        <Typography variant="caption" color="text.secondary" sx={{ mb: 1, display: 'block' }}>
          同一维度下 Σ 目标比例必须 = 100
        </Typography>
        {rows.map((row, idx) => (
          <Box key={idx} sx={{ display: 'flex', gap: 1, mb: 1, alignItems: 'center' }}>
            <TextField
              label="目标项"
              value={row.target_key}
              onChange={(e) => setRows((rs) => rs.map((r, i) => (i === idx ? { ...r, target_key: e.target.value } : r)))}
              size="small"
              fullWidth
              placeholder={dimension === 'asset_class' ? 'stock / fund / cash…' : dimension === 'industry' ? '如 白酒 / 银行' : '如 600519'}
            />
            <TextField
              label="比例 %"
              type="number"
              value={row.target_pct}
              onChange={(e) => setRows((rs) => rs.map((r, i) => (i === idx ? { ...r, target_pct: e.target.value } : r)))}
              size="small"
              sx={{ width: 120 }}
            />
            <IconButton size="small" onClick={() => setRows((rs) => rs.filter((_, i) => i !== idx))}>
              <DeleteIcon fontSize="small" />
            </IconButton>
          </Box>
        ))}
        <Button size="small" startIcon={<AddIcon />} onClick={() => setRows((rs) => [...rs, { target_key: '', target_pct: '' }])}>
          添加一行
        </Button>
        <Typography variant="body2" sx={{ mt: 1 }} color={Math.abs(total - 100) > 0.01 ? 'error' : 'success.main'}>
          当前合计：{total.toFixed(2)}%
        </Typography>
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
