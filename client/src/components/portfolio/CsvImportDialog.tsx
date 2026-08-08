// ============================================================
// CsvImportDialog：CSV 导入弹窗
// 模板：代码,名称,资产类别,数量,成本价
// ============================================================
import { useState } from 'react';
import { Dialog, DialogTitle, DialogContent, DialogActions, Button, TextField, Typography, Box } from '@mui/material';

interface CsvImportDialogProps {
  open: boolean;
  onClose: () => void;
  onImport: (csvText: string) => Promise<{ imported: number; skipped: number; errors: { row: number; msg: string }[] }>;
}

export default function CsvImportDialog({ open, onClose, onImport }: CsvImportDialogProps) {
  const [csvText, setCsvText] = useState('');
  const [result, setResult] = useState<{ imported: number; skipped: number; errors: { row: number; msg: string }[] } | null>(null);
  const [importing, setImporting] = useState(false);

  const handleClose = () => {
    setCsvText('');
    setResult(null);
    onClose();
  };

  const handleImport = async () => {
    setImporting(true);
    try {
      const r = await onImport(csvText);
      setResult(r);
    } finally {
      setImporting(false);
    }
  };

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="sm" fullWidth>
      <DialogTitle>CSV 导入持仓</DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: 2 }}>
        <Typography variant="body2" color="text.secondary">
          模板（每行一条）：<code>代码,名称,资产类别,数量,成本价</code>
          <br />
          示例：<code>600519,贵州茅台,stock,100,1500.00</code>
          <br />
          资产类别：stock / fund / cash / bond / other；现金行代码与成本价留空。
        </Typography>
        <TextField
          multiline
          minRows={6}
          maxRows={14}
          placeholder={'600519,贵州茅台,stock,100,1500\n000858,五粮液,stock,200,70.5\n,现金,cash,100000,1'}
          value={csvText}
          onChange={(e) => setCsvText(e.target.value)}
          size="small"
        />
        {result && (
          <Box sx={{ p: 1.5, borderRadius: 1, bgcolor: 'action.hover' }}>
            <Typography variant="body2">
              成功 {result.imported} 条，跳过 {result.skipped} 条
            </Typography>
            {result.errors.slice(0, 5).map((e, i) => (
              <Typography key={i} variant="caption" color="error" display="block">
                第 {e.row} 行：{e.msg}
              </Typography>
            ))}
          </Box>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose}>关闭</Button>
        <Button onClick={handleImport} variant="contained" disabled={importing || !csvText.trim()}>
          {importing ? '导入中…' : '导入'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
