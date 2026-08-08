// ============================================================
// StrategySaveDialog：保存为我的策略
// ============================================================
import { useState } from 'react';
import { Dialog, DialogTitle, DialogContent, DialogActions, Button, TextField, Typography, FormControlLabel, Checkbox } from '@mui/material';

interface StrategySaveDialogProps {
  open: boolean;
  defaultName: string;
  onClose: () => void;
  onSave: (name: string, savePipeline: boolean) => Promise<void>;
}

export default function StrategySaveDialog({ open, defaultName, onClose, onSave }: StrategySaveDialogProps) {
  const [name, setName] = useState(defaultName);
  const [savePipeline, setSavePipeline] = useState(true);
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      await onSave(name.trim(), savePipeline);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>保存为我的策略</DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: 2 }}>
        <TextField label="策略名称" value={name} onChange={(e) => setName(e.target.value)} size="small" fullWidth autoFocus />
        <FormControlLabel
          control={<Checkbox size="small" checked={savePipeline} onChange={(e) => setSavePipeline(e.target.checked)} />}
          label={<Typography variant="caption">保存漏斗步骤（当前为模板管线）</Typography>}
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>取消</Button>
        <Button onClick={handleSave} variant="contained" disabled={saving || !name.trim()}>
          {saving ? '保存中…' : '保存'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
