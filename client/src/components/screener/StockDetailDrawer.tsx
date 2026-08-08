// ============================================================
// StockDetailDrawer：个股详情抽屉（K线+雷达+数据来源+加入自选）
// ============================================================
import { Drawer, Box, Typography, IconButton, Button, Divider, Chip, CircularProgress } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import StarIcon from '@mui/icons-material/Star';
import { useEffect, useState } from 'react';
import KlineChart from '../charts/KlineChart';
import RadarChart from '../charts/RadarChart';
import DataOriginBadge from '../common/DataOriginBadge';
import { marketApi } from '../../api/market';
import type { KlineData } from '../../api/market';
import type { ScreenerResult } from '../../api/screener';
import { useSnackbar } from '../common/SnackbarProvider';
import { formatPercent, colorOf, formatYi, formatMoney, formatWan } from '../../utils/format';

interface StockDetailDrawerProps {
  open: boolean;
  stock: ScreenerResult | null;
  onClose: () => void;
  onAddWatchlist?: (code: string) => Promise<void>;
}

export default function StockDetailDrawer({ open, stock, onClose, onAddWatchlist }: StockDetailDrawerProps) {
  const [kline, setKline] = useState<KlineData | null>(null);
  const [loading, setLoading] = useState(false);
  const [adding, setAdding] = useState(false);
  const snackbar = useSnackbar();

  useEffect(() => {
    if (open && stock) {
      setLoading(true);
      setKline(null);
      marketApi
        .kline(stock.code, 120)
        .then(setKline)
        .catch(() => snackbar.show('K线加载失败', 'error'))
        .finally(() => setLoading(false));
    }
  }, [open, stock, snackbar]);

  const m = stock?.metrics || {};

  const handleAdd = async () => {
    if (!stock || !onAddWatchlist) return;
    setAdding(true);
    try {
      await onAddWatchlist(stock.code);
      snackbar.show(`已加入自选：${stock.name}`, 'success');
    } finally {
      setAdding(false);
    }
  };

  return (
    <Drawer anchor="right" open={open} onClose={onClose} sx={{ '& .MuiDrawer-paper': { width: { xs: '100%', sm: 560 } } }}>
      <Box sx={{ p: 2 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <Typography variant="h6">{stock?.name}</Typography>
            <Typography variant="body2" color="text.secondary">{stock?.code}</Typography>
            <DataOriginBadge origin={stock?.data_origin} />
          </Box>
          <IconButton onClick={onClose}>
            <CloseIcon />
          </IconButton>
        </Box>

        {stock && (
          <>
            <Box sx={{ display: 'flex', gap: 3, mt: 1, alignItems: 'baseline' }}>
              <Typography variant="h5" sx={{ fontWeight: 700 }}>{stock.price != null ? stock.price.toFixed(2) : '—'}</Typography>
              <Typography variant="body1" sx={{ color: colorOf(stock.pct_chg) }}>
                {formatPercent(stock.pct_chg)}
              </Typography>
              <Chip label={`评分 ${stock.score}`} color={stock.score >= 80 ? 'error' : stock.score >= 60 ? 'warning' : 'default'} size="small" />
              {onAddWatchlist && (
                <Button size="small" startIcon={<StarIcon />} onClick={handleAdd} disabled={adding}>
                  加入自选
                </Button>
              )}
            </Box>

            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 2, mt: 1.5, fontSize: 13, color: 'text.secondary' }}>
              <span>换手 {m.turnover_rate != null ? `${m.turnover_rate.toFixed(2)}%` : '—'}</span>
              <span>量比 {m.volume_ratio != null ? m.volume_ratio.toFixed(2) : '—'}</span>
              <span>流通市值 {m.circ_mv != null ? formatYi(m.circ_mv) : '—'}</span>
              <span>PE {m.pe_ttm != null ? m.pe_ttm.toFixed(1) : '—'}</span>
              <span>3日净流入 {m.net_inflow_3d != null ? formatWan(m.net_inflow_3d) : '—'}</span>
              <span>上方60日空间 {m.high_60d_distance_pct != null ? formatPercent(m.high_60d_distance_pct) : '—'}</span>
              <span>连续放量 {m.volume_streak != null ? `${m.volume_streak}日` : '—'}</span>
            </Box>

            <Divider sx={{ my: 1.5 }} />

            {/* K线 */}
            {loading ? (
              <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}><CircularProgress /></Box>
            ) : kline ? (
              kline.bars && kline.bars.length > 0 ? (
                <KlineChart bars={kline.bars} />
              ) : (
                <Box sx={{ py: 6, textAlign: 'center', color: 'text.secondary', fontSize: 14 }}>
                  暂无行情数据（当前为演示数据，未接入真实行情）
                </Box>
              )
            ) : null}

            <Divider sx={{ my: 1.5 }} />

            {/* 评分雷达 */}
            {stock.score_detail?.factors?.length ? (
              <>
                <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 1 }}>评分分项</Typography>
                <RadarChart factors={stock.score_detail.factors} />
                <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 0.5, mt: 1 }}>
                  {stock.score_detail.factors.map((f) => (
                    <Box key={f.key} sx={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                      <span style={{ color: 'text.secondary' }}>{f.label}</span>
                      <span style={{ fontWeight: 600 }}>{f.score.toFixed(0)} <span style={{ color: 'text.secondary', fontWeight: 400 }}>{f.note}</span></span>
                    </Box>
                  ))}
                </Box>
              </>
            ) : null}
          </>
        )}
      </Box>
    </Drawer>
  );
}
