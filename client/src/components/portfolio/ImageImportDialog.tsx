// ============================================================
// ImageImportDialog：图片导入持仓弹窗
// 支持拖拽/选择图片、视觉模型识别、结果表格编辑、批量写入
// ============================================================
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, Button, Box, Typography,
  TextField, MenuItem, IconButton, Alert, Paper, Tooltip, Chip, ToggleButtonGroup,
  ToggleButton,
} from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import AddIcon from '@mui/icons-material/Add';
import ImageIcon from '@mui/icons-material/Image';
import PhotoCameraIcon from '@mui/icons-material/PhotoCamera';
import { ASSET_CLASS, ASSET_CLASS_LABEL } from '@shared/constants';
import type { Holding } from '../../api/portfolio';

export interface ImageImportCandidate {
  id: string;
  code: string | null;
  name: string;
  asset_class: Holding['asset_class'];
  quantity: number;
  cost_price: number;
  current_price?: number;
  profit?: number;
  profit_rate?: number;
  day_profit?: number;
  day_profit_rate?: number;
}

interface ImageImportDialogProps {
  open: boolean;
  onClose: () => void;
  onRecognize: (images: string[], hint?: 'stock' | 'fund') => Promise<{ candidates: Partial<Holding>[]; warnings: string[] }>;
  onImport: (rows: ImageImportCandidate[]) => Promise<{ imported: number; errors: { row: number; msg: string }[] }>;
}

const ASSET_OPTIONS = Object.values(ASSET_CLASS);

/** 生成短 ID */
function makeId() {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

/** 文件转 base64（不含 data URI 前缀） */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const idx = result.indexOf(',');
      resolve(idx >= 0 ? result.slice(idx + 1) : result);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/** 压缩图片：限制最大边长与质量，减少 base64 体积 */
function compressImage(file: File, maxSide = 1600, quality = 0.85): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      let { width, height } = img;
      if (width > maxSide || height > maxSide) {
        const ratio = Math.min(maxSide / width, maxSide / height);
        width = Math.round(width * ratio);
        height = Math.round(height * ratio);
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('Canvas 初始化失败'));
        return;
      }
      ctx.drawImage(img, 0, 0, width, height);
      const dataUrl = canvas.toDataURL('image/jpeg', quality);
      const idx = dataUrl.indexOf(',');
      resolve(idx >= 0 ? dataUrl.slice(idx + 1) : dataUrl);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('图片加载失败'));
    };
    img.src = url;
  });
}

export default function ImageImportDialog({ open, onClose, onRecognize, onImport }: ImageImportDialogProps) {
  const [images, setImages] = useState<{ file: File; preview: string; base64: string }[]>([]);
  const [candidates, setCandidates] = useState<ImageImportCandidate[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [hint, setHint] = useState<'stock' | 'fund' | 'auto'>('auto');
  const [recognizing, setRecognizing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{ imported: number; errors: { row: number; msg: string }[] } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setImages([]);
      setCandidates([]);
      setWarnings([]);
      setHint('auto');
      setImportResult(null);
    }
  }, [open]);

  const handleFiles = useCallback(async (files: FileList | null) => {
    if (!files) return;
    const imageFiles = Array.from(files).filter((f) => f.type.startsWith('image/'));
    if (imageFiles.length === 0) return;

    const newImages = await Promise.all(
      imageFiles.slice(0, 5).map(async (file) => {
        const base64 = await compressImage(file);
        return { file, preview: URL.createObjectURL(file), base64 };
      }),
    );

    setImages((prev) => {
      const combined = [...prev, ...newImages].slice(0, 5);
      return combined;
    });
    setCandidates([]);
    setWarnings([]);
    setImportResult(null);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      handleFiles(e.dataTransfer.files);
    },
    [handleFiles],
  );

  const handlePaste = useCallback(
    async (e: ClipboardEvent) => {
      if (!open) return;
      const items = e.clipboardData?.items;
      if (!items) return;
      const files: File[] = [];
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) files.push(file);
        }
      }
      if (files.length > 0) {
        const list = new DataTransfer();
        files.forEach((f) => list.items.add(f));
        await handleFiles(list.files);
      }
    },
    [open, handleFiles],
  );

  useEffect(() => {
    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, [handlePaste]);

  const removeImage = (index: number) => {
    setImages((prev) => {
      const next = [...prev];
      URL.revokeObjectURL(next[index].preview);
      next.splice(index, 1);
      return next;
    });
    setCandidates([]);
    setWarnings([]);
    setImportResult(null);
  };

  const handleRecognize = async () => {
    if (images.length === 0) return;
    setRecognizing(true);
    setCandidates([]);
    setWarnings([]);
    setImportResult(null);
    try {
      const hintValue = hint === 'auto' ? undefined : hint;
      const { candidates: rawCandidates, warnings: rawWarnings } = await onRecognize(
        images.map((i) => i.base64),
        hintValue,
      );
      const mapped = rawCandidates.map((c) => ({
        id: makeId(),
        code: c.code ?? null,
        name: c.name ?? '',
        asset_class: (c.asset_class as Holding['asset_class']) || 'stock',
        quantity: Number.isFinite(Number(c.quantity)) ? Number(c.quantity) : 0,
        cost_price: Number.isFinite(Number(c.cost_price)) ? Number(c.cost_price) : 0,
        current_price: Number.isFinite(Number(c.current_price)) ? Number(c.current_price) : undefined,
        profit: Number.isFinite(Number(c.profit)) ? Number(c.profit) : undefined,
        profit_rate: Number.isFinite(Number(c.profit_rate)) ? Number(c.profit_rate) : undefined,
        day_profit: Number.isFinite(Number(c.day_profit)) ? Number(c.day_profit) : undefined,
        day_profit_rate: Number.isFinite(Number(c.day_profit_rate)) ? Number(c.day_profit_rate) : undefined,
      }));
      setCandidates(mapped);
      setWarnings(rawWarnings || []);
    } finally {
      setRecognizing(false);
    }
  };

  const updateCandidate = (id: string, patch: Partial<ImageImportCandidate>) => {
    setCandidates((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  };

  const deleteCandidate = (id: string) => {
    setCandidates((prev) => prev.filter((c) => c.id !== id));
  };

  const addCandidate = () => {
    setCandidates((prev) => [
      ...prev,
      { id: makeId(), code: null, name: '', asset_class: 'stock', quantity: 0, cost_price: 0 },
    ]);
  };

  const validCandidates = candidates.filter(
    (c) => c.name.trim() && c.quantity > 0 && c.cost_price >= 0,
  );

  const handleImport = async () => {
    if (validCandidates.length === 0) return;
    setImporting(true);
    try {
      const result = await onImport(validCandidates);
      setImportResult(result);
      // 全部导入成功后关闭弹窗；有失败则保留弹窗展示错误
      if (result.errors.length === 0) {
        handleClose();
      }
    } finally {
      setImporting(false);
    }
  };

  const handleClose = () => {
    images.forEach((i) => URL.revokeObjectURL(i.preview));
    onClose();
  };

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="lg" fullWidth>
      <DialogTitle>图片导入持仓</DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: 2 }}>
        <Typography variant="body2" color="text.secondary">
          支持拖拽、点击选择或 Ctrl+V 粘贴截图。识别结果可在下方表格中编辑、删除后确认导入。
        </Typography>

        <Box sx={{ display: 'flex', gap: 2, alignItems: 'center', flexWrap: 'wrap' }}>
          <ToggleButtonGroup
            size="small"
            value={hint}
            exclusive
            onChange={(_e, v) => v && setHint(v)}
          >
            <ToggleButton value="auto">自动识别</ToggleButton>
            <ToggleButton value="stock">股票截图</ToggleButton>
            <ToggleButton value="fund">基金截图</ToggleButton>
          </ToggleButtonGroup>
          <Typography variant="caption" color="text.secondary">
            提示：股票截图需识别「持仓数量」和「成本价」；基金截图给出「金额」，识别后会按最新净值自动换算成「份额」。
          </Typography>
        </Box>

        <Paper
          variant="outlined"
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          sx={{
            p: 2,
            textAlign: 'center',
            borderStyle: 'dashed',
            borderColor: dragOver ? 'primary.main' : 'divider',
            bgcolor: dragOver ? 'action.hover' : 'background.paper',
            cursor: 'pointer',
          }}
          onClick={() => fileInputRef.current?.click()}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => handleFiles(e.target.files)}
          />
          <PhotoCameraIcon sx={{ fontSize: 40, color: 'action.active', mb: 1 }} />
          <Typography variant="body2" color="text.secondary">
            拖拽图片到此处，或点击选择（最多 5 张）
          </Typography>
        </Paper>

        {images.length > 0 && (
          <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
            {images.map((img, idx) => (
              <Box
                key={idx}
                sx={{
                  position: 'relative',
                  width: 80,
                  height: 80,
                  borderRadius: 1,
                  overflow: 'hidden',
                  border: '1px solid',
                  borderColor: 'divider',
                }}
              >
                <img src={img.preview} alt="preview" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                <IconButton
                  size="small"
                  onClick={(e) => { e.stopPropagation(); removeImage(idx); }}
                  sx={{
                    position: 'absolute', top: 0, right: 0, p: 0.25,
                    bgcolor: 'rgba(0,0,0,0.5)', color: 'white',
                  }}
                >
                  <DeleteIcon fontSize="small" />
                </IconButton>
              </Box>
            ))}
          </Box>
        )}

        <Box>
          <Button
            variant="contained"
            startIcon={<ImageIcon />}
            onClick={handleRecognize}
            disabled={recognizing || images.length === 0}
          >
            {recognizing ? '识别中…' : '开始识别'}
          </Button>
        </Box>

        {warnings.length > 0 && (
          <Alert severity="warning" sx={{ whiteSpace: 'pre-line' }}>
            {warnings.slice(0, 5).join('\n')}
          </Alert>
        )}

        {candidates.length > 0 && (
          <Box>
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
              <Typography variant="subtitle2">识别结果（可编辑）</Typography>
              <Button size="small" startIcon={<AddIcon />} onClick={addCandidate}>
                添加行
              </Button>
            </Box>
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
              {candidates.map((c, idx) => (
                <Paper
                  key={c.id}
                  variant="outlined"
                  sx={{ p: 1, display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap' }}
                >
                  <Typography variant="caption" sx={{ minWidth: 24, color: 'text.secondary' }}>
                    {idx + 1}
                  </Typography>
                  <TextField
                    size="small"
                    label="名称"
                    value={c.name}
                    onChange={(e) => updateCandidate(c.id, { name: e.target.value })}
                    sx={{ flex: 2, minWidth: 160 }}
                  />
                  <TextField
                    size="small"
                    label="代码"
                    value={c.code ?? ''}
                    onChange={(e) => updateCandidate(c.id, { code: e.target.value || null })}
                    sx={{ flex: 1, minWidth: 90 }}
                  />
                  <TextField
                    select
                    size="small"
                    label="类别"
                    value={c.asset_class}
                    onChange={(e) => updateCandidate(c.id, { asset_class: e.target.value as Holding['asset_class'] })}
                    sx={{ flex: 1, minWidth: 100 }}
                  >
                    {ASSET_OPTIONS.map((a) => (
                      <MenuItem key={a} value={a}>{ASSET_CLASS_LABEL[a]}</MenuItem>
                    ))}
                  </TextField>
                  <TextField
                    size="small"
                    label={c.asset_class === 'fund' ? '份额' : '数量'}
                    type="number"
                    value={c.quantity}
                    onChange={(e) => updateCandidate(c.id, { quantity: Number(e.target.value) })}
                    sx={{ flex: 1, minWidth: 110 }}
                  />
                  <TextField
                    size="small"
                    label={c.asset_class === 'fund' ? '成本净值' : '成本价'}
                    type="number"
                    value={c.cost_price}
                    disabled={c.asset_class === 'fund'}
                    onChange={(e) => updateCandidate(c.id, { cost_price: Number(e.target.value) })}
                    sx={{ flex: 1, minWidth: 110 }}
                  />
                  {/* 实时盈亏预览：市值 / 成本 / 盈亏率（编辑时即可见，无需先导入） */}
                  {(() => {
                    const fundPrice = c.asset_class === 'fund' && Number.isFinite(Number(c.current_price)) ? Number(c.current_price) : 1;
                    const marketValue = c.asset_class === 'fund' ? c.quantity * fundPrice : c.quantity * c.cost_price;
                    const costAmount = c.quantity * c.cost_price;
                    const profitRate = costAmount > 0 ? ((marketValue - costAmount) / costAmount) * 100 : 0;
                    return (
                      <>
                        <TextField
                          size="small"
                          label="市值（元）"
                          type="number"
                          value={Number.isFinite(marketValue) ? Math.round(marketValue * 100) / 100 : 0}
                          disabled
                          sx={{ flex: 1, minWidth: 110 }}
                        />
                        <TextField
                          size="small"
                          label="成本（元）"
                          type="number"
                          value={Number.isFinite(costAmount) ? Math.round(costAmount * 100) / 100 : 0}
                          disabled
                          sx={{ flex: 1, minWidth: 110 }}
                        />
                        <TextField
                          size="small"
                          label="盈亏率（%）"
                          type="number"
                          value={Number.isFinite(profitRate) ? Math.round(profitRate * 100) / 100 : 0}
                          disabled
                          sx={{ flex: 1, minWidth: 110 }}
                        />
                      </>
                    );
                  })()}
                  <Tooltip title="删除">
                    <IconButton size="small" color="error" onClick={() => deleteCandidate(c.id)}>
                      <DeleteIcon />
                    </IconButton>
                  </Tooltip>
                </Paper>
              ))}
            </Box>
            <Box sx={{ mt: 1, display: 'flex', gap: 1, flexWrap: 'wrap' }}>
              <Chip size="small" label={`共 ${candidates.length} 行`} />
              <Chip size="small" color="success" label={`有效 ${validCandidates.length} 行`} />
            </Box>
          </Box>
        )}

        {importResult && (
          <Alert severity={importResult.errors.length === 0 ? 'success' : 'info'}>
            成功导入 {importResult.imported} 条
            {importResult.errors.length > 0 && `，失败 ${importResult.errors.length} 条`}
            {importResult.errors.slice(0, 5).map((e, i) => (
              <Typography key={i} variant="caption" color="error" display="block">
                第 {e.row} 行：{e.msg}
              </Typography>
            ))}
          </Alert>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose}>关闭</Button>
        <Button
          variant="contained"
          onClick={handleImport}
          disabled={importing || validCandidates.length === 0}
        >
          {importing ? '导入中…' : `确认导入（${validCandidates.length}）`}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
